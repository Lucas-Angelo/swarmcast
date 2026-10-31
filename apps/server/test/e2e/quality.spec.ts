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
// When the streamer's PC cannot convert a quality in real time, the ladder drops it (here only
// when the spec asks: server.ts SpecLoadGuard), and with its last one the viewers get the
// original alone: the playlists of the ladder are gone. A viewer watching the dropped one must go
// on with the original before its buffer runs out (the most it holds is the Stable starting
// delay), with no long freeze: the server answers 404 for a playlist the stream no longer lists,
// and the player loads the stream again. Answered 503 ("not started yet", retried), the viewer was
// still on the old playlists 120 s later (measured locally), frozen.
// The server goes back to one quality and the default feed at the next test's gate.
import type { BrowserContext, Page } from '@playwright/test';
import { ADAPTIVE_DELAY, type QualityState } from '@swarmcast/shared';
import { adminApi, adminState, dropRendition, expect, ladderUpdate, playsOn, reconnectObs, startStallMonitor, stallReport, stats, test, uid, waitPlaying } from './fixtures.js';

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

/** In `context`, the player starts on the 480p rendition (the remembered pick). */
async function watch480(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem('sc.quality-height', '480'));
}

/** The heights the viewer's player can play now (its playlists) and the one it plays. */
function playerLevels(page: Page): Promise<{ heights: number[]; playing: number | null }> {
  return page.evaluate(() => {
    const h = (window as unknown as { __hls: Hls }).__hls;
    return { heights: h.levels.map((l) => l.height), playing: h.levels[h.currentLevel]?.height ?? null };
  });
}

const serverQualities = async (): Promise<number[]> => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height);

/** The Stable profile starts this far behind live: the most a viewer has buffered to bridge the switch (ms). */
const STARTING_DELAY_MS = ADAPTIVE_DELAY.stable.initial * 1000;

test('when the PC cannot convert a quality in real time, the viewer watching it goes on with the original', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(180_000);
  await adminApi('PUT', '/api/quality', ladderUpdate(q0, { mode: 'manual', enabled: true, heights: [480], encoder: 'libx264' }));
  await reconnectObs('hd');
  await expect.poll(serverQualities, { timeout: 120_000, intervals: [1000] }).toEqual([720, 480]);
  const { page } = await viewers.join(uid('shed'), { setup: watch480 });
  await waitPlaying(page);
  await expect.poll(() => playerLevels(page)).toEqual({ heights: [480, 720], playing: 480 });
  await startStallMonitor(page);

  // Act
  await dropRendition();

  // Assert
  await expect.poll(serverQualities, { timeout: 30_000, intervals: [500] }).toEqual([720]);
  await expect.poll(async () => (await adminState()).warnings.join(' ')).toMatch(/could not convert 480p in real time/);
  await expect.poll(() => playerLevels(page), { timeout: STARTING_DELAY_MS, intervals: [500] }).toEqual({ heights: [720], playing: 720 });
  await playsOn(page, 2);
  const after = await stallReport(page);
  const s = await stats(page);
  console.log(`rendition dropped: longest stall ${Math.round(after.maxStallMs)} ms, ${s.reloads} source reloads (last: ${s.lastReload ?? 'none'})`);
  expect(after.maxStallMs, 'stall while the viewer moves to the original quality').toBeLessThan(4000);
});
