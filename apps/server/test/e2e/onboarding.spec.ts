import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { admin, expect, liveLink, test } from './fixtures.js';

// First-run setup tutorial in the admin panel (checked on Chromium).
function adminLoginUrl(): string {
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string };
  return env.adminLoginUrl;
}

async function openPanel(page: Page): Promise<void> {
  await page.goto(adminLoginUrl());
  await expect(page.getByTestId('status')).toBeVisible();
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'checked on Chromium');
});

test('the first panel open shows the tutorial; finishing it keeps it closed on reload', { tag: '@ui' }, async ({ page }) => {
  await admin('/api/onboarding', { done: false });
  // The e2e server is live with a synthetic OBS stream.
  await liveLink();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openPanel(page);
  const dialog = page.getByTestId('onboarding');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-step', 'welcome');
  await expect(page.getByTestId('onb-progress')).toHaveText('Step 1 of 9');
  // Focus starts inside the dialog.
  await expect(page.locator('#onb-heading')).toBeFocused();

  const next = page.getByTestId('onb-next');
  await next.click(); // PC check
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await next.click(); // OBS output
  await expect(dialog.locator('img').first()).toBeVisible();
  await next.click(); // choose
  await expect(page.getByTestId('onb-route-both')).toBeVisible();
  await next.click(); // connect, plugin route (default)
  await expect(page.getByTestId('onb-copy-server')).toBeVisible();
  await expect(page.getByTestId('onb-copy-key')).toBeVisible();
  await expect(page.getByTestId('onb-server-value')).toHaveText(/^rtmp:\/\/127\.0\.0\.1:\d+\/live$/);
  // The key is hidden until "Show".
  await expect(page.getByTestId('onb-key-value')).not.toContainText('sc_');
  await expect(page.getByTestId('onb-plugin-github')).toHaveAttribute('href', 'https://github.com/sorayuki/obs-multi-rtmp/releases');
  // "Only SwarmCast" route has the copy buttons too.
  await page.getByTestId('onb-back').click();
  await page.getByTestId('onb-route-only').click();
  await next.click();
  await expect(page.getByTestId('onb-copy-server')).toBeVisible();
  await expect(page.getByTestId('onb-copy-key')).toBeVisible();
  await next.click(); // test: OBS (ffmpeg) is already sending → green
  await expect(page.getByTestId('onb-test-status')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await expect(page.getByTestId('onb-test-status')).toContainText('It works');
  await next.click(); // share
  await expect(page.getByTestId('onb-copy-link')).toBeVisible();
  await next.click(); // tour
  await page.getByTestId('onb-area-viewers').click();
  await expect(page.locator('.onb-spot')).toHaveCount(1);
  await next.click(); // finish
  await expect(page.locator('.onb-spot')).toHaveCount(0);
  await page.getByTestId('onb-finish').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await page.request.get(new URL('/api/onboarding', page.url()).toString())).json()).toEqual({ done: true });

  // The panel decides from GET /api/onboarding: wait for that answer and the frame after it,
  // instead of a fixed second, before checking the tutorial stayed closed.
  const decided = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding' && r.request().method() === 'GET');
  await page.reload();
  await decided;
  await expect(page.getByTestId('status')).toBeVisible();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(dialog).toBeHidden();
  expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
});

test('"Redo setup tutorial" reopens it; Escape asks before closing', { tag: '@ui' }, async ({ page }) => {
  await admin('/api/onboarding', { done: true });
  await openPanel(page);
  const dialog = page.getByTestId('onboarding');
  await expect(dialog).toBeHidden();
  await page.getByTestId('redo-tutorial').click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-step', 'welcome');
  // Focus moves into the dialog (keyboard users land on the step title).
  await expect(page.locator('#onb-heading')).toBeFocused();
  // Escape → confirm dialog; dismissing keeps the tutorial open.
  const seen: string[] = [];
  page.once('dialog', (d) => {
    seen.push('dismiss');
    void d.dismiss();
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => seen).toEqual(['dismiss']);
  await expect(dialog).toBeVisible();
  // Tab stays inside the dialog (focus trap).
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="onboarding"]'))).toBe(true);
  page.once('dialog', (d) => {
    seen.push('accept');
    void d.accept();
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => seen).toEqual(['dismiss', 'accept']);
  await expect(dialog).toBeHidden();
});

test('the tutorial is translated (pt-BR)', { tag: '@ui' }, async ({ browser }) => {
  await admin('/api/onboarding', { done: false });
  const context = await browser.newContext({ locale: 'pt-BR' });
  const page = await context.newPage();
  await page.goto(adminLoginUrl());
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await expect(page.getByTestId('onb-progress')).toHaveText('Passo 1 de 9');
  await expect(page.getByTestId('onb-skip')).toHaveText('Pular tutorial');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('onb-skip').click();
  await expect(page.getByTestId('onboarding')).toBeHidden();
  await expect(page.getByTestId('redo-tutorial')).toHaveText('Refazer o tutorial de configuração');
  await context.close();
});

test('"Your PC check" shows the installer system check, with a fallback to live data', { tag: '@ui' }, async ({ page }) => {
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { dataDir: string };
  const file = path.join(env.dataDir, 'system-check.json');
  fs.rmSync(file, { force: true });
  await admin('/api/onboarding', { done: true });
  await openPanel(page);
  await page.getByTestId('redo-tutorial').click();
  await page.getByTestId('onb-next').click();
  // No file: live panel data only.
  await expect(page.getByTestId('onb-pc')).toBeVisible();
  await expect(page.getByTestId('onb-syscheck')).toHaveCount(0);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
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
    }),
  );
  // The step reads the file when it is shown.
  await page.getByTestId('onb-back').click();
  await page.getByTestId('onb-next').click();
  await expect(page.getByTestId('onb-syscheck')).toBeVisible();
  await expect(page.getByTestId('onb-sys-below')).toBeVisible();
  await expect(page.getByTestId('onb-sys-ram')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('onb-sys-upload')).toContainText('minimum 5 Mbps');
  await expect(page.getByTestId('onb-sys-upload')).toContainText('P2P');
  await expect(page.getByTestId('onb-sys-obs')).toContainText('obsproject.com');
  fs.rmSync(file, { force: true });
});
