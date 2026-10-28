import { admin, adminState, currentTime, expect, join, liveLink, stats, test, uid, viewerByNick, waitPlaying } from './fixtures.js';

const INVALID = /no longer valid/;

test.describe.configure({ mode: 'serial' });

test('a viewer joins with the live link, picks a nickname and watches', async ({ browser }) => {
  const nick = uid('play');
  const { context, page } = await join(browser, nick);
  await waitPlaying(page);
  await expect(page.locator('#status')).toHaveText('Live');
  // "Help the stream (P2P)" is off by default (opt-in).
  await expect(page.locator('#p2p')).not.toBeChecked();
  await expect.poll(async () => (await viewerByNick(nick))?.connected).toBe(true);
  // The secret never stays in the address bar.
  expect(page.url()).not.toContain('/join/');
  await context.close();
});

test('a fresh viewer starts with P2P off and can turn it on (the choice is remembered)', async ({ browser }) => {
  const { context, page } = await join(browser, uid('optin'));
  await waitPlaying(page);
  const p2p = page.locator('#p2p');
  await expect(p2p).not.toBeChecked();
  await expect(p2p).toBeEnabled();
  expect((await stats(page)).p2pEnabled).toBe(false);
  await p2p.check();
  await expect.poll(async () => (await stats(page)).p2pEnabled).toBe(true);
  await expect(page.locator('#p2p-stats')).toContainText('P2P on');
  // Same browser, next visit: still on.
  await page.reload();
  await expect(page.locator('#p2p')).toBeChecked();
  await expect.poll(async () => (await stats(page)).p2pEnabled).toBe(true);
  await context.close();
});

test('opening the site without the link is refused', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(INVALID);
  await page.goto('/watch');
  await expect(page.locator('body')).toContainText(INVALID);
  await page.goto('/join/not-the-secret');
  await expect(page.locator('body')).toContainText(INVALID);
});

test('kicking stops playback and the viewer cannot come back with the same link', async ({ browser }) => {
  const nick = uid('kick');
  const link = await liveLink();
  const { context, page } = await join(browser, nick, link);
  await waitPlaying(page);
  const v = await viewerByNick(nick);
  await admin(`/api/viewers/${v!.sessionId}/kick`);
  await expect(page.locator('#ended')).toBeVisible();
  await expect(page.locator('#ended-title')).toHaveText('You were removed');
  const t = await currentTime(page);
  await page.waitForTimeout(2500);
  expect(await currentTime(page)).toBeLessThanOrEqual(t + 0.3);
  // Same device, same link: refused.
  await page.goto(link);
  await expect(page.locator('body')).toContainText(INVALID);
  await page.goto('/watch');
  await expect(page.locator('body')).toContainText(INVALID);
  await context.close();
});

test('after "Generate new link" the old link no longer works, the new one does', async ({ browser }) => {
  const old = await liveLink();
  await admin('/api/link/rotate');
  const fresh = (await adminState()).liveLink!;
  expect(fresh).not.toBe(old);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(old);
  await expect(page.locator('body')).toContainText(INVALID);
  await ctx.close();
  const { context, page: p2 } = await join(browser, uid('fresh'), fresh);
  await waitPlaying(p2);
  await context.close();
});

test('"Go live" appears after pausing and brings the viewer back near the live edge', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  const { context, page } = await join(browser, uid('golive'));
  await waitPlaying(page);
  const goLive = page.getByTestId('go-live');
  await expect(goLive).toHaveText('LIVE');
  await page.evaluate(() => document.querySelector('video')!.pause());
  await expect(goLive).toContainText('Go live');
  // "Behind" counts from the live sync point (live edge − target delay). A viewer who joined a
  // young stream starts closer to live than that delay, so the pause first uses up the gap:
  // wait until it reads more than 5 s instead of a fixed time. The playhead must not move.
  const pausedAt = await currentTime(page);
  await expect.poll(async () => Number(await goLive.getAttribute('data-behind')), { timeout: 45_000, intervals: [1000] }).toBeGreaterThan(5);
  await expect(goLive).toContainText('Go live');
  expect(Math.abs((await currentTime(page)) - pausedAt)).toBeLessThan(0.5);
  await goLive.click();
  await expect(goLive).toHaveText('LIVE', { timeout: 15_000 });
  const behind = await page.evaluate(() => {
    const hls = (window as unknown as { __hls: { liveSyncPosition: number | null } }).__hls;
    return (hls.liveSyncPosition ?? 0) - document.querySelector('video')!.currentTime;
  });
  expect(behind).toBeLessThan(4);
  expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
  await context.close();
});

test('viewers see how many people are watching', async ({ browser }) => {
  // Start from an empty audience so the expected number is exact.
  await admin('/api/viewers/disconnect-all');
  const a = await join(browser, uid('countA'));
  const b = await join(browser, uid('countB'));
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId('viewer-count')).toHaveText('2 watching', { timeout: 20_000 });
  }
  await a.context.close();
  await b.context.close();
});
