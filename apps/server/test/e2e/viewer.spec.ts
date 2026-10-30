// The viewer's way in and out: the live link, the nickname, playback, P2P opt-in, refused
// links, a kick (the player stops: paused, its media released, so nothing plays or loads any
// more), a new link, "Go live" and the audience count. "Help the stream (P2P)" is off by
// default (opt-in), and the join secret never stays in the address bar.
//
// "Go live": "behind" counts from the live sync point (live edge − target delay). A viewer who
// joined a young stream starts closer to live than that delay, so the pause first uses up the
// gap: the test waits until it reads more than 5 s instead of pausing for a fixed time.
import { admin, adminState, currentTime, expect, liveLink, playerStopped, stats, test, uid, viewerByNick, waitPlaying } from './fixtures.js';

const INVALID = /no longer valid/;

test('a viewer joins with the live link, picks a nickname and watches', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const nick = uid('play');

  // Act
  const { page } = await viewers.join(nick);
  await waitPlaying(page);

  // Assert
  await expect(page.locator('#status')).toHaveText('Live');
  await expect(page.locator('#p2p')).not.toBeChecked();
  await expect.poll(async () => (await viewerByNick(nick))?.connected).toBe(true);
  expect(page.url()).not.toContain('/join/');
});

test('a fresh viewer starts with P2P off and can turn it on (the choice is remembered)', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('optin'));
  await waitPlaying(page);
  const p2p = page.locator('#p2p');

  // Assert
  await expect(p2p).not.toBeChecked();
  await expect(p2p).toBeEnabled();
  expect((await stats(page)).p2pEnabled).toBe(false);

  // Act
  await p2p.check();

  // Assert
  await expect.poll(async () => (await stats(page)).p2pEnabled).toBe(true);
  await expect(page.locator('#p2p-stats')).toContainText('P2P on');

  // Act
  await page.reload();

  // Assert
  await expect(page.locator('#p2p')).toBeChecked();
  await expect.poll(async () => (await stats(page)).p2pEnabled).toBe(true);
});

test('opening the site without the link is refused', { tag: '@ui' }, async ({ page }) => {
  // Act
  await page.goto('/');

  // Assert
  await expect(page.locator('body')).toContainText(INVALID);

  // Act
  await page.goto('/watch');

  // Assert
  await expect(page.locator('body')).toContainText(INVALID);

  // Act
  await page.goto('/join/not-the-secret');

  // Assert
  await expect(page.locator('body')).toContainText(INVALID);
});

test('kicking stops playback and the viewer cannot come back with the same link', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const nick = uid('kick');
  const link = await liveLink();
  const { page } = await viewers.join(nick, { link });
  await waitPlaying(page);
  const v = await viewerByNick(nick);

  // Act
  await admin(`/api/viewers/${v!.sessionId}/kick`);

  // Assert
  await expect(page.locator('#ended')).toBeVisible();
  await expect(page.locator('#ended-title')).toHaveText('You were removed');
  await expect.poll(() => playerStopped(page)).toEqual({ paused: true, hasMedia: false });

  // Act
  await page.goto(link);

  // Assert
  await expect(page.locator('body')).toContainText(INVALID);

  // Act
  await page.goto('/watch');

  // Assert
  await expect(page.locator('body')).toContainText(INVALID);
});

test('after "Generate new link" the old link no longer works, the new one does', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const old = await liveLink();
  const stale = await (await viewers.browserContext()).newPage();

  // Act
  await admin('/api/link/rotate');
  const fresh = (await adminState()).liveLink!;
  await stale.goto(old);

  // Assert
  expect(fresh).not.toBe(old);
  await expect(stale.locator('body')).toContainText(INVALID);

  // Act
  const { page } = await viewers.join(uid('fresh'), { link: fresh });

  // Assert
  await waitPlaying(page);
});

test('"Go live" appears after pausing and brings the viewer back near the live edge', { tag: '@ui' }, async ({ viewers, browserName }) => {
  // Arrange
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  const { page } = await viewers.join(uid('golive'));
  await waitPlaying(page);
  const goLive = page.getByTestId('go-live');
  await expect(goLive).toHaveText('LIVE');

  // Act
  await page.locator('#video').click();

  // Assert
  await expect(goLive).toContainText('Go live');
  const pausedAt = await currentTime(page);
  await expect.poll(async () => Number(await goLive.getAttribute('data-behind')), { timeout: 45_000, intervals: [1000] }).toBeGreaterThan(5);
  await expect(goLive).toContainText('Go live');
  expect(Math.abs((await currentTime(page)) - pausedAt)).toBeLessThan(0.5);

  // Act
  await goLive.click();

  // Assert
  await expect(goLive).toHaveText('LIVE', { timeout: 15_000 });
  const behind = await page.evaluate(() => {
    const hls = (window as unknown as { __hls: { liveSyncPosition: number | null } }).__hls;
    return (hls.liveSyncPosition ?? 0) - document.querySelector('video')!.currentTime;
  });
  expect(behind).toBeLessThan(4);
  expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
});

test('viewers see how many people are watching', { tag: '@ui' }, async ({ viewers }) => {
  // Act
  const a = await viewers.join(uid('countA'));
  const b = await viewers.join(uid('countB'));

  // Assert
  for (const p of [a.page, b.page]) await expect(p.getByTestId('viewer-count')).toHaveText('2 watching', { timeout: 20_000 });
});
