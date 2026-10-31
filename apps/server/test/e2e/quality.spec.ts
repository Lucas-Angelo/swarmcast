// The quality ladder as a viewer sees it (checked on Chromium): with 480p + 360p on (manual,
// x264 forced: `auto` keeps only the original on a PC without a GPU encoder and with fewer than
// 6 CPU threads, like the CI runners) and OBS reconnected at 720p (a pre-encoded clip: the
// runner's CPU goes to the ladder, not to the fake OBS), the viewer menu lists the renditions
// and an Auto entry, with its tooltip. Picking 360p switches at the next segment and playback
// goes on. B9: the stall watchdog's last resort (and the player's answer to vanished playlists)
// loads the source again, and hls.js starts that on automatic quality; the viewer's pick
// survives, because the menu puts it back when the playlists are parsed (from the remembered
// height). Lower delay, then back to Stable: playback never stops, and the choice is kept. A
// profile switch sets the profile's bounds and starting target, but the stall memory survives it
// (the network did not change), so a stall on a busy runner may already have raised the target
// inside those bounds: the check is the bounds in force and hls.js playing at a target no higher
// than their top (the growth limit may hold it under their floor), not one exact value.
// The server goes back to one quality and the default feed at the next test's gate.
import type { Page } from '@playwright/test';
import { ADAPTIVE_DELAY, type QualityState } from '@swarmcast/shared';
import { adminApi, expect, ladderUpdate, playsOn, reconnectObs, test, uid, waitPlaying } from './fixtures.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'checked on Chromium');

type Hls = { levels: Array<{ height: number }>; currentLevel: number; autoLevelEnabled: boolean; targetLatency: number; url: string | null; loadSource(url: string): void; once(e: string, f: () => void): void };

/** Waits until hls.js plays the 360p rendition as a manual pick (not automatic quality). */
function playing360(page: Page): Promise<unknown> {
  return page.waitForFunction(() => {
    const h = (window as unknown as { __hls: Hls }).__hls;
    return h.levels[h.currentLevel]?.height === 360 && !h.autoLevelEnabled;
  }, null, { timeout: 30_000 });
}

type DelayState = { initial: number; withinTop: boolean };

/** The profile whose bounds the delay controller applies now (by its starting target), and whether hls.js plays at a target no higher than their top. */
function delayProfile(page: Page): Promise<DelayState> {
  return page.evaluate(() => {
    const w = window as unknown as { __hls: Hls; __swarmcast: { delay: { bounds: { initial: number; max: number } } } };
    const { initial, max } = w.__swarmcast.delay.bounds;
    return { initial, withinTop: w.__hls.targetLatency <= max };
  });
}

const profileStart = (id: keyof typeof ADAPTIVE_DELAY): DelayState => ({ initial: ADAPTIVE_DELAY[id].initial, withinTop: true });

/** Loads the source again, as the stall watchdog's last resort does; resolves once the playlists are parsed. */
function reloadSource(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const h = (window as unknown as { __hls: Hls }).__hls;
        h.once('hlsManifestParsed', () => resolve());
        h.loadSource(h.url!);
      }),
  );
}

test('with the quality ladder on, the viewer menu lists the renditions; switching quality and profile keeps playing', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(180_000);
  await adminApi('PUT', '/api/quality', ladderUpdate(q0, { mode: 'manual', enabled: true, heights: [480, 360], encoder: 'libx264' }));
  await reconnectObs('hd');
  await expect
    .poll(async () => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height), { timeout: 120_000, intervals: [1000] })
    .toEqual([720, 480, 360]);

  // Act
  const { page } = await viewers.join(uid('quality'));
  await waitPlaying(page);

  // Assert
  const menu = page.locator('.quality-menu');
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await menu.locator('option').allTextContents()).slice(1)).toEqual(['720p', '480p', '360p']);
  await expect(menu.locator('option').first()).toContainText('Auto');
  await expect(page.locator('.quality-group .tip-btn')).toHaveCount(1);

  // Act
  await menu.selectOption({ label: '360p' });

  // Assert
  await playing360(page);

  // Act
  await reloadSource(page);

  // Assert
  await playing360(page);
  await expect(menu.locator('option:checked')).toHaveText('360p');

  // Act
  await page.check('.latency-toggle input[value="low-delay"]');

  // Assert
  await expect.poll(() => delayProfile(page)).toEqual(profileStart('low-delay'));
  await playsOn(page, 2);
  expect(await page.evaluate(() => localStorage.getItem('sc.playback-profile'))).toBe('low-delay');

  // Act
  await page.check('.latency-toggle input[value="stable"]');

  // Assert
  await expect.poll(() => delayProfile(page)).toEqual(profileStart('stable'));
  await playsOn(page, 1);
  expect(await page.evaluate(() => localStorage.getItem('sc.playback-profile'))).toBe('stable');
  await expect(page.locator('#status')).toHaveText('Live');
});
