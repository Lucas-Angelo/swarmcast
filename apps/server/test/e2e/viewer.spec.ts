import { expect, test } from '@playwright/test';
import { admin, adminState, currentTime, join, liveLink, viewerByNick, waitPlaying } from './fixtures.js';

const INVALID = /no longer valid/;

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await admin('/api/bans/clear');
});

test('a viewer joins with the live link, picks a nickname and watches', async ({ browser, browserName }) => {
  const nick = `play-${browserName}`;
  const { context, page } = await join(browser, nick);
  await waitPlaying(page);
  await expect(page.locator('#status')).toHaveText('Live');
  // "Help the stream (P2P)" is on by default.
  await expect(page.locator('#p2p')).toBeChecked();
  await expect.poll(async () => (await viewerByNick(nick))?.connected).toBe(true);
  // The secret never stays in the address bar.
  expect(page.url()).not.toContain('/join/');
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

test('kicking stops playback and the viewer cannot come back with the same link', async ({ browser, browserName }) => {
  const nick = `kick-${browserName}`;
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

test('after "Generate new link" the old link no longer works, the new one does', async ({ browser, browserName }) => {
  const old = await liveLink();
  await admin('/api/link/rotate');
  const fresh = (await adminState()).liveLink!;
  expect(fresh).not.toBe(old);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(old);
  await expect(page.locator('body')).toContainText(INVALID);
  await ctx.close();
  const { context, page: p2 } = await join(browser, `fresh-${browserName}`, fresh);
  await waitPlaying(p2);
  await context.close();
});

test('"Go live" appears after pausing and brings the viewer back near the live edge', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  const { context, page } = await join(browser, `golive-${browserName}`);
  await waitPlaying(page);
  const goLive = page.getByTestId('go-live');
  await expect(goLive).toHaveText('LIVE');
  await page.evaluate(() => document.querySelector('video')!.pause());
  await page.waitForTimeout(10_000);
  await expect(goLive).toContainText('Go live');
  expect(Number(await goLive.getAttribute('data-behind'))).toBeGreaterThan(5);
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

test('viewers see how many people are watching', async ({ browser, browserName }) => {
  // Start from an empty audience so the expected number is exact.
  await admin('/api/viewers/disconnect-all');
  const a = await join(browser, `countA-${browserName}`);
  const b = await join(browser, `countB-${browserName}`);
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId('viewer-count')).toHaveText('2 watching', { timeout: 20_000 });
  }
  await a.context.close();
  await b.context.close();
});
