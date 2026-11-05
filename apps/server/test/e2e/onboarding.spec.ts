// The first-run setup tutorial in the panel (checked on Chromium): it opens by itself until it
// is finished, walks through its ten steps (the chat name step checks the name as it is typed,
// keeps an invalid one on screen and saves a valid one with the chat settings, where the Chat
// card shows it; the OBS test step turns green because the e2e
// server is live with a synthetic OBS stream; the stream key stays hidden until "Show"; the
// "Only SwarmCast" route has the copy buttons too), keeps focus inside, asks before Escape
// closes it, is translated, and its "Your PC check" step shows the installer's system check
// (system-check.json in the data folder, read each time the step is shown), else live data.
//
// A first GET /api/onboarding the network lost (fetch() rejected, net::ERR_NO_BUFFER_SPACE on a
// Windows runner) is asked again: the tutorial still opens by itself.
//
// After a reload the panel decides from GET /api/onboarding whether to open the tutorial; that
// decision shows nothing when it stays closed, so the test waits for that answer to be fully
// received and for the two frames after it, then checks that the tutorial stayed closed.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AdminChatState } from '@swarmcast/shared';
import { admin, adminApi, expect, liveLink, loseFirstGet, openPanel, serverEnv, test as base } from './fixtures.js';

/** The installer's system check the "Your PC check" step reads; removed after the test. */
const test = base.extend<{ systemCheckFile: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function uses from its first argument
  systemCheckFile: async ({}, use) => {
    const file = path.join(serverEnv().dataDir, 'system-check.json');
    fs.rmSync(file, { force: true });
    await use(file);
    fs.rmSync(file, { force: true });
  },
});

test.skip(({ browserName }) => browserName !== 'chromium', 'checked on Chromium');

const SYSTEM_CHECK = {
  version: 1,
  os: 'macOS 27.0',
  arch: 'arm64',
  results: [
    { id: 'os', status: 'ok', value: 'macOS 27.0', min: 'macOS 12' },
    { id: 'ram', status: 'ok', value: '16 GB', min: '4 GB', recommended: '8 GB' },
    { id: 'cpu', status: 'ok', value: '8 cores', min: '4 cores', recommended: '8 cores' },
    { id: 'upload', status: 'warn', value: '8 Mbps', min: '5 Mbps', recommended: '20 Mbps' },
    { id: 'download', status: 'ok', value: '300 Mbps', min: '10 Mbps' },
    { id: 'disk', status: 'ok', value: '120 GB', min: '2 GB' },
    { id: 'ports', status: 'ok', value: 'free' },
    { id: 'obs', status: 'fail', value: 'not found' },
    { id: 'github', status: 'ok', value: 'reachable' },
    { id: 'release', status: 'skipped' },
  ],
  uploadMbps: 8,
  downloadMbps: 300,
  viewerEstimate: 2,
  belowMinimum: ['obs'],
};

/** Collects the console errors of `page` (the tutorial must not break the panel's CSP). */
function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** The streamer's chat name the server keeps (and reserves). */
const savedChatName = async (): Promise<string> => (await adminApi<AdminChatState>('GET', '/api/chat')).settings.streamerName;

test('the first panel open shows the tutorial; finishing it keeps it closed on reload', { tag: '@ui' }, async ({ page, chat }) => {
  // Arrange
  await admin('/api/onboarding', { done: false });
  // No chat name yet (the fixture puts the one before the test back afterwards).
  await chat.change({ streamerName: '' });
  await liveLink();
  const errors = consoleErrors(page);
  const dialog = page.getByTestId('onboarding');
  const next = page.getByTestId('onb-next');

  // Act
  await openPanel(page);

  // Assert
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-step', 'welcome');
  await expect(page.getByTestId('onb-progress')).toHaveText('Step 1 of 10');
  await expect(page.locator('#onb-heading')).toBeFocused();

  // Act
  await next.click();
  const nameInput = page.getByTestId('onb-name-input');
  const feedback = page.getByTestId('onb-name-feedback');

  // Assert
  await expect(dialog).toHaveAttribute('data-step', 'name');
  await expect(nameInput).toHaveValue('');
  await expect(feedback).toHaveAttribute('data-kind', 'empty');
  await expect(page.getByTestId('onb-name')).toContainText('Viewers cannot use this name or anything that looks like it.');

  // Act
  await nameInput.fill('Admin');

  // Assert
  await expect(feedback).toHaveAttribute('data-kind', 'error');
  await expect(feedback).toContainText('leave it empty');

  // Act
  await next.click();

  // Assert
  await expect(dialog).toHaveAttribute('data-step', 'name');
  await expect(nameInput).toBeFocused();
  expect(await savedChatName()).toBe('');

  // Act
  await nameInput.fill('  Tutorial   Tester ');

  // Assert
  await expect(feedback).toHaveAttribute('data-kind', 'ok');
  await expect(feedback).toHaveText('Your messages will show "Tutorial Tester".');

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await expect.poll(savedChatName).toBe('Tutorial Tester');

  // Act
  await page.getByTestId('onb-back').click();

  // Assert
  await expect(nameInput).toHaveValue('Tutorial Tester');

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-pc')).toBeVisible();

  // Act
  await next.click();

  // Assert
  await expect(dialog.locator('img').first()).toBeVisible();

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-route-both')).toBeVisible();

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-copy-server')).toBeVisible();
  await expect(page.getByTestId('onb-copy-key')).toBeVisible();
  await expect(page.getByTestId('onb-server-value')).toHaveText(/^rtmp:\/\/127\.0\.0\.1:\d+\/live$/);
  await expect(page.getByTestId('onb-key-value')).not.toContainText('sc_');
  await expect(page.getByTestId('onb-plugin-github')).toHaveAttribute('href', 'https://github.com/sorayuki/obs-multi-rtmp/releases');

  // Act
  await page.getByTestId('onb-back').click();
  await page.getByTestId('onb-route-only').click();
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-copy-server')).toBeVisible();
  await expect(page.getByTestId('onb-copy-key')).toBeVisible();

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-test-status')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('onb-test-status')).toContainText('It works');

  // Act
  await next.click();

  // Assert
  await expect(page.getByTestId('onb-copy-link')).toBeVisible();

  // Act
  await next.click();
  await page.getByTestId('onb-area-viewers').click();

  // Assert
  await expect(page.locator('.onb-spot')).toHaveCount(1);

  // Act
  await page.getByTestId('onb-area-chat').click();

  // Assert
  await expect(page.locator('.onb-spot')).toHaveCount(1);
  await expect(page.locator('.onb-spot')).toHaveAttribute('data-testid', /^chat-(live|card)$/);

  // Act
  await next.click();

  // Assert
  await expect(page.locator('.onb-spot')).toHaveCount(0);

  // Act
  await page.getByTestId('onb-finish').click();

  // Assert
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await page.request.get(new URL('/api/onboarding', page.url()).toString())).json()).toEqual({ done: true });
  // The Chat card's settings, where she changes it later, show the name the tutorial saved.
  await expect(page.getByTestId('chat-streamer-name')).toHaveValue('Tutorial Tester');

  // Act
  await page.getByTestId('chat-streamer-name').fill('Moderador');

  // Assert: the same check as in the tutorial, before anything is sent.
  await expect(page.getByTestId('chat-streamer-name-error')).toContainText('leave it empty');
  await expect(page.getByTestId('chat-save')).toBeDisabled();

  // Act
  const decided = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding' && r.request().method() === 'GET');
  await page.reload();
  await (await decided).finished();
  await expect(page.getByTestId('status')).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Assert
  await expect(dialog).toBeHidden();
  expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
});

test('a first answer the network lost is asked again: a fresh install still opens the tutorial', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await admin('/api/onboarding', { done: false });
  const lost = await loseFirstGet(page, '**/api/onboarding');
  const dialog = page.getByTestId('onboarding');

  // Act
  await openPanel(page);

  // Assert
  await expect(dialog).toBeVisible();
  expect(lost()).toBe(1);

  // Act
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('onb-skip').click();

  // Assert
  await expect(dialog).toBeHidden();
});

test('the name step starts from the "Your page" name; what the streamer types wins over a late answer', { tag: '@ui' }, async ({ page, chat }) => {
  // Arrange: "Your page" has a name (served by this route), the chat name is empty. While
  // `held` is set, the route answers only when `release` is called.
  await admin('/api/onboarding', { done: true });
  await chat.change({ streamerName: '' });
  let held: Promise<void> | null = null;
  let release = (): void => {};
  await page.route('**/api/branding', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as { branding: Record<string, unknown> };
    if (held) await held;
    await route.fulfill({ response: res, json: { ...body, branding: { ...body.branding, name: 'Lucas Plays' } } });
  });
  await openPanel(page);
  const nameInput = page.getByTestId('onb-name-input');
  held = new Promise((r) => (release = r));
  await page.getByTestId('redo-tutorial').click();
  const late = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/branding' && r.request().method() === 'GET');

  // Act
  await page.getByTestId('onb-next').click();
  await nameInput.fill('Ana Live');
  release();
  await (await late).finished();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Assert
  await expect(nameInput).toHaveValue('Ana Live');

  // Act
  await page.getByTestId('onb-next').click();

  // Assert
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await expect.poll(savedChatName).toBe('Ana Live');

  // Arrange
  held = null;
  await chat.change({ streamerName: '' });
  await page.reload();
  await page.getByTestId('redo-tutorial').click();

  // Act
  await page.getByTestId('onb-next').click();

  // Assert
  await expect(nameInput).toHaveValue('Lucas Plays');
  await expect(page.getByTestId('onb-name-feedback')).toHaveAttribute('data-kind', 'ok');

  // Act
  await page.getByTestId('onb-next').click();

  // Assert
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await expect.poll(savedChatName).toBe('Lucas Plays');
});

test('"Redo setup tutorial" reopens it; Escape asks before closing', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await admin('/api/onboarding', { done: true });
  await openPanel(page);
  const dialog = page.getByTestId('onboarding');
  await expect(dialog).toBeHidden();
  const answered: string[] = [];

  // Act
  await page.getByTestId('redo-tutorial').click();

  // Assert
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-step', 'welcome');
  await expect(page.locator('#onb-heading')).toBeFocused();

  // Act
  page.once('dialog', (d) => {
    answered.push('dismiss');
    void d.dismiss();
  });
  await page.keyboard.press('Escape');

  // Assert
  await expect.poll(() => answered).toEqual(['dismiss']);
  await expect(dialog).toBeVisible();

  // Act
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');

  // Assert
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="onboarding"]'))).toBe(true);

  // Act
  page.once('dialog', (d) => {
    answered.push('accept');
    void d.accept();
  });
  await page.keyboard.press('Escape');

  // Assert
  await expect.poll(() => answered).toEqual(['dismiss', 'accept']);
  await expect(dialog).toBeHidden();
});

test.describe('in a pt-BR browser', () => {
  test.use({ locale: 'pt-BR' });

  test('the tutorial is translated (pt-BR)', { tag: '@ui' }, async ({ page }) => {
    // Arrange
    await admin('/api/onboarding', { done: false });

    // Act
    await openPanel(page);

    // Assert
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await expect(page.getByTestId('onb-progress')).toHaveText('Passo 1 de 10');
    await expect(page.getByTestId('onb-skip')).toHaveText('Pular tutorial');

    // Act
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('onb-skip').click();

    // Assert
    await expect(page.getByTestId('onboarding')).toBeHidden();
    await expect(page.getByTestId('redo-tutorial')).toHaveText('Refazer o tutorial de configuração');
  });
});

test('"Your PC check" shows the installer system check, with a fallback to live data', { tag: '@ui' }, async ({ page, systemCheckFile }) => {
  // Arrange
  await admin('/api/onboarding', { done: true });
  await openPanel(page);
  await page.getByTestId('redo-tutorial').click();
  await page.getByTestId('onb-next').click();
  await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'name');

  // Act
  await page.getByTestId('onb-next').click();

  // Assert
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await expect(page.getByTestId('onb-syscheck')).toHaveCount(0);

  // Act
  fs.writeFileSync(systemCheckFile, JSON.stringify({ ...SYSTEM_CHECK, at: new Date().toISOString() }));
  await page.getByTestId('onb-back').click();
  await page.getByTestId('onb-next').click();

  // Assert
  await expect(page.getByTestId('onb-syscheck')).toBeVisible();
  await expect(page.getByTestId('onb-sys-below')).toBeVisible();
  await expect(page.getByTestId('onb-sys-ram')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('onb-sys-upload')).toContainText('minimum 5 Mbps');
  await expect(page.getByTestId('onb-sys-upload')).toContainText('P2P');
  await expect(page.getByTestId('onb-sys-obs')).toContainText('obsproject.com');
});
