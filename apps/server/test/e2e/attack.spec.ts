import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { admin, adminState, liveLink, waitPlaying } from './fixtures.js';

// Runs first (alphabetical order) so its flood starts with fresh rate-limit buckets, and waits
// for 127.0.0.1's join bucket to recover at the end so the other specs are not affected.
test.describe.configure({ mode: 'serial' });

test('a flood of invalid join links is detected, turns on the browser check, and real viewers still join', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  test.setTimeout(180_000);
  const link = await liveLink();
  const before = await adminState();
  expect(before.security).toMatchObject({ threat: 'normal', browserCheck: 0 });

  // Two viewers open the link before the attack (they hold a join ticket).
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(link);
  await expect(pageA).toHaveURL(/\/join$/);
  await expect(pageA.locator('#check')).toBeHidden();
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(link);
  await expect(pageB).toHaveURL(/\/join$/);

  // Flood: ~100 requests/s of made-up links for a few seconds.
  let flooding = true;
  let sent = 0;
  const flood = (async () => {
    while (flooding && sent < 3000) {
      await Promise.all(Array.from({ length: 30 }, () => fetch(`${baseURL}/join/not-a-real-link-${sent++}`).then((r) => r.arrayBuffer()).catch(() => null)));
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  await expect.poll(async () => (await adminState()).security.threat, { timeout: 30_000, intervals: [500] }).toBe('attack');
  flooding = false;
  await flood;
  const during = await adminState();
  expect(during.warningCodes[0]).toMatchObject({ code: 'warn.attackDetected' });
  expect(during.security.browserCheck).toBe(2);
  expect(during.security.reasonCode).toMatch(/^attack\.reason\./);

  // The panel shows it in the Protection card.
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string };
  const adminCtx = await browser.newContext();
  const panel = await adminCtx.newPage();
  await panel.goto(env.adminLoginUrl);
  await expect(panel.getByTestId('threat')).toHaveAttribute('data-threat', 'attack');
  await expect(panel.getByTestId('browser-check')).toHaveAttribute('data-level', '2');
  await expect(panel.locator('.warn').first()).toContainText('Possible attack');

  // Viewer A loaded the page before the check was on: the server asks for it, the page solves and retries.
  await pageA.fill('#nickname', 'BeforeAttack');
  const joinA = pageA.waitForResponse((r) => r.url().endsWith('/api/join') && r.status() === 403);
  await pageA.click('#join');
  expect(((await (await joinA).json()) as { code: string }).code).toBe('viewer.err.checkRequired');
  await expect(pageA).toHaveURL(/\/watch$/, { timeout: 20_000 });
  await waitPlaying(pageA);

  // Viewer B reloads the join page: it solves the check proactively ("Checking your browser…").
  const challenge = pageB.waitForResponse((r) => r.url().endsWith('/api/join/challenge'));
  await pageB.reload();
  expect(await (await challenge).json()).toMatchObject({ required: true });
  await pageB.fill('#nickname', 'DuringAttack');
  const request = pageB.waitForRequest((r) => r.url().endsWith('/api/join') && r.method() === 'POST');
  await pageB.click('#join');
  const body = (await request).postDataJSON() as { pow?: { solution?: { counter: number; time?: number } } };
  expect(body.pow?.solution?.counter).toBeGreaterThan(0);
  // Well under a second on a desktop browser.
  expect(body.pow?.solution?.time ?? 0).toBeLessThan(1000);
  await expect(pageB).toHaveURL(/\/watch$/);

  // The streamer ends the alert from the panel.
  await panel.getByTestId('end-alert').click();
  await expect(panel.getByTestId('threat')).toHaveAttribute('data-threat', 'normal');
  expect((await adminState()).security).toMatchObject({ threat: 'normal', browserCheck: 0, tightened: false });

  await ctxA.close();
  await ctxB.close();
  await adminCtx.close();
  await admin('/api/viewers/disconnect-all');
  // Let this IP's /join rate-limit window expire before the next spec joins viewers.
  await expect
    .poll(async () => (await fetch((await adminState()).liveLink!, { redirect: 'manual' })).status, { timeout: 75_000, intervals: [5_000] })
    .toBe(303);
});
