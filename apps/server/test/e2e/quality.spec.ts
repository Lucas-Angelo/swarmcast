import type { QualityState } from '@swarmcast/shared';
import { adminApi, expect, join, ladderUpdate as update, reconnectObs, test, uid, waitPlaying } from './fixtures.js';

type Hls = { levels: Array<{ height: number }>; currentLevel: number; autoLevelEnabled: boolean; targetLatency: number; url: string | null; loadSource(url: string): void };

// The server goes back to one quality and the default feed at the next test's gate.
test('with the quality ladder on, the viewer menu lists the renditions; switching quality and profile keeps playing', { tag: '@media' }, async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(180_000);

  // Turn on 480p + 360p (manual, x264 forced: `auto` keeps only the original on a PC without a
  // GPU encoder and with fewer than 6 CPU threads, like the CI runners), then OBS reconnects at
  // 720p (a pre-encoded clip: the runner's CPU goes to the ladder, not to the fake OBS).
  await adminApi('PUT', '/api/quality', update(q0, { mode: 'manual', enabled: true, heights: [480, 360], encoder: 'libx264' }));
  await reconnectObs({ size: '1280x720', kbps: 2500 });
  await expect
    .poll(async () => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height), { timeout: 120_000, intervals: [1000] })
    .toEqual([720, 480, 360]);

  const { context, page } = await join(browser, uid('quality'));
  await waitPlaying(page);
  const menu = page.locator('.quality-menu');
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await menu.locator('option').allTextContents()).slice(1)).toEqual(['720p', '480p', '360p']);
  await expect(menu.locator('option').first()).toContainText('Auto');
  // The tooltip next to the menu is there too.
  await expect(page.locator('.quality-group .tip-btn')).toHaveCount(1);

  // Pick 360p: hls.js switches at the next segment, playback goes on.
  const playing360 = (): Promise<unknown> =>
    page.waitForFunction(() => {
      const h = (window as unknown as { __hls: Hls }).__hls;
      return h.levels[h.currentLevel]?.height === 360 && !h.autoLevelEnabled;
    }, null, { timeout: 30_000 });
  await menu.selectOption({ label: '360p' });
  await playing360();

  // B9: the stall watchdog's last resort (and the player's answer to vanished playlists) loads
  // the source again, and hls.js starts that on automatic quality. The viewer's pick survives:
  // the menu puts it back when the playlists are parsed (from the remembered height).
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const h = (window as unknown as { __hls: Hls & { once(e: string, f: () => void): void } }).__hls;
        h.once('hlsManifestParsed', () => resolve());
        h.loadSource(h.url!);
      }),
  );
  await playing360();
  await expect(menu.locator('option:checked')).toHaveText('360p');
  const t1 = await page.evaluate(() => document.querySelector('video')!.currentTime);

  // Lower delay, then back to Stable: never stops playing.
  await page.check('.latency-toggle input[value="low-delay"]');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hls: Hls }).__hls.targetLatency)).toBe(8);
  await page.waitForFunction((t) => {
    const v = document.querySelector('video')!;
    return v.currentTime > t + 2 && !v.paused;
  }, t1, { timeout: 30_000 });
  await page.check('.latency-toggle input[value="stable"]');
  const t2 = await page.evaluate(() => document.querySelector('video')!.currentTime);
  await page.waitForFunction((t) => {
    const v = document.querySelector('video')!;
    return v.currentTime > t + 1 && !v.paused;
  }, t2, { timeout: 45_000 });
  expect(await page.evaluate(() => localStorage.getItem('sc.playback-profile'))).toBe('stable');
  await expect(page.locator('#status')).toHaveText('Live');
  await context.close();
});
