// "Audio only (saves data)" (docs/QUALITY.md "Audio only"): a viewer picks it in the quality menu
// and the player loads /hls/audio-only.m3u8, the stream's own audio rendition alone, instead of
// index.m3u8. Checked while live, on every engine:
// - switching to it and back keeps playing near the live edge ("LIVE", not "Go live"); the video
//   area shows "Audio only" instead of a picture (no video track: videoWidth 0); the data used
//   drops (the fake OBS sends 1200 kbps video + 96 kbps audio, so audio alone is about 7 %; the bar
//   is a third, which a full 20 s buffer refill right after the switch stays under);
// - the choice is remembered per browser: after a reload the player starts on audio only, and an
//   OBS reconnect (the stream's next run) keeps it playing on audio only;
// - with the quality ladder on, when the streamer's PC drops its last converted quality, the
//   ladder's audio playlist (audio.m3u8) goes away with it and the stream goes on with the
//   original (MediaMTX's audio playlist): the audio-only viewer follows without a long freeze;
// - P2P (checked on Chromium): audio-only playback joins the swarm video viewers share their audio
//   track in (the same playlist, the same segments and hashes), so audio travels between the two,
//   every segment verified by hash.
// The server goes back to one quality and the default feed at the next test's gate.
import type { BrowserContext, Page } from '@playwright/test';
import { ADAPTIVE_DELAY, type QualityState } from '@swarmcast/shared';
import {
  adminApi,
  dropRendition,
  enableP2P,
  expect,
  ladderUpdate,
  measuredWindow,
  playsOn,
  reconnectObs,
  startStallMonitor,
  stallReport,
  stats,
  test,
  uid,
  unmute,
  waitForPlaylist,
  waitPlaying,
} from './fixtures.js';

const AUDIO_ONLY = 'Audio only (saves data)';

type Hls = { url: string | null; levels: Array<{ height?: number; url: string[] | string; videoCodec?: string; audioCodec?: string }>; currentLevel: number };

/** What the player plays: the source it loaded, its levels, and whether a picture is decoded. */
function player(page: Page): Promise<{ source: string; heights: number[]; media: string; videoWidth: number }> {
  return page.evaluate(() => {
    const h = (window as unknown as { __hls?: Hls }).__hls;
    if (!h) return { source: '', heights: [], media: '', videoWidth: 0 };
    const level = h.levels[Math.max(0, h.currentLevel)];
    const url = level ? (Array.isArray(level.url) ? level.url[0]! : level.url) : '';
    return {
      source: new URL(h.url ?? '', location.href).pathname,
      heights: h.levels.map((l) => l.height ?? 0),
      media: new URL(url || '/', location.href).pathname,
      videoWidth: document.querySelector('video')!.videoWidth,
    };
  });
}

/** Waits until the player plays the audio-only playlist: one level, no height, no picture. */
async function playingAudioOnly(page: Page): Promise<void> {
  await expect.poll(async () => {
    const p = await player(page);
    return { source: p.source, heights: p.heights, videoWidth: p.videoWidth };
  }).toEqual({ source: '/hls/audio-only.m3u8', heights: [0], videoWidth: 0 });
  await expect(page.getByTestId('audio-only')).toBeVisible();
  await expect(page.getByTestId('audio-only')).toContainText('Audio only');
  await expect(page.locator('.quality-menu option:checked')).toHaveText(AUDIO_ONLY);
}

/**
 * Counts the bytes `page` receives from /hls/ (playlists and segments), as the browser's network
 * reports them: the counter returned reads the total so far. P2P is off, so that is all it gets.
 */
function hlsBytes(page: Page): () => number {
  let total = 0;
  page.on('requestfinished', (r) => {
    if (!new URL(r.url()).pathname.startsWith('/hls/')) return;
    void r
      .sizes()
      .then((s) => {
        total += s.responseBodySize;
      })
      // The page went away (a reload) before its sizes were read: not part of a window measured.
      .catch(() => {});
  });
  return () => total;
}

/** Bytes counted by `counter` during `ms` of playback. */
async function bytesDuring(page: Page, counter: () => number, ms: number): Promise<number> {
  const before = counter();
  await measuredWindow(page, ms);
  return counter() - before;
}

/** Playing near the live edge: "LIVE", not "Go live −N s". */
async function atLive(page: Page): Promise<void> {
  await expect(page.locator('#golive')).toHaveClass(/at-live/);
  await expect(page.locator('#status')).toHaveText('Live');
}

/**
 * Records, in the page, the discontinuity counter (hls.js `frag.cc`: one per run of the stream,
 * HlsOrigin stitches an OBS reconnect as a new one) of every fragment the player buffers.
 */
async function followRuns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hls: { on(e: string, f: (e: string, d: { frag: { cc: number } }) => void): void }; __lastRun: number };
    w.__lastRun = -1;
    w.__hls.on('hlsFragBuffered', (_e, d) => {
      w.__lastRun = Math.max(w.__lastRun, d.frag.cc);
    });
  });
}

/** The newest run of the stream the player buffered audio from (followRuns). */
const lastRunBuffered = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __lastRun: number }).__lastRun);

/** The viewer's remembered choice. */
const savedChoice = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('sc.audio-only'));

/** In `context`, the player starts on audio only (the remembered choice). */
async function rememberAudioOnly(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem('sc.audio-only', 'on'));
}

const MEASURE_MS = 8000;

test('a viewer switches to audio only and back while live: far less data, no picture, the choice survives a reload and an OBS reconnect', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('audio'));
  const received = hlsBytes(page);
  await waitPlaying(page);
  await unmute(page);
  const menu = page.locator('.quality-menu');
  await expect(menu.locator('option').last()).toHaveText(AUDIO_ONLY);
  const videoBytes = await bytesDuring(page, received, MEASURE_MS);

  // Act
  await menu.selectOption({ label: AUDIO_ONLY });

  // Assert
  await playingAudioOnly(page);
  await playsOn(page, 3);
  await atLive(page);
  expect(await savedChoice(page)).toBe('on');
  const audioBytes = await bytesDuring(page, received, MEASURE_MS);
  console.log(`bytes in ${MEASURE_MS / 1000} s: video ${videoBytes}, audio only ${audioBytes} (${Math.round((audioBytes / videoBytes) * 100)} %)`);
  expect(audioBytes, 'audio only uses a fraction of the data').toBeLessThan(videoBytes / 3);
  expect(audioBytes, 'audio keeps arriving').toBeGreaterThan(0);

  // Act
  await page.reload();

  // Assert
  await playingAudioOnly(page);
  await waitPlaying(page);
  await atLive(page);

  // Act: OBS drops its connection and publishes again, as its own reconnect does.
  await followRuns(page);
  const runBefore = await lastRunBuffered(page);
  await reconnectObs(null);

  // Assert: the player goes on loading audio from the stream's new run, on audio only.
  await expect.poll(() => lastRunBuffered(page), { timeout: 30_000, message: 'audio of the run after the reconnect buffered' }).toBeGreaterThan(runBefore);
  await playsOn(page, 2);
  await playingAudioOnly(page);

  // Act
  await page.locator('.quality-menu').selectOption({ label: 'Auto' });

  // Assert
  await expect.poll(async () => (await player(page)).source).toBe('/hls/index.m3u8');
  await expect.poll(async () => (await player(page)).videoWidth).toBeGreaterThan(0);
  await expect(page.getByTestId('audio-only')).toBeHidden();
  await playsOn(page, 2);
  await atLive(page);
  expect(await savedChoice(page)).toBeNull();
  // Automatic quality (the one quality of the default feed, by its name: nothing else to choose).
  await expect(page.locator('.quality-menu')).toHaveValue('-1');
  await expect(page.locator('.quality-menu option')).toHaveText(['360p', AUDIO_ONLY]);
});

test('audio-only and video viewers share the audio over P2P, verified by hash', { tag: '@media' }, async ({ viewers, browserName }) => {
  // Which swarm audio-only playback joins is the same JavaScript on every engine (player-config.ts
  // swarmIdBuilderFor); WebRTC between engines is p2p.spec.ts's (Chromium, Firefox).
  test.skip(browserName !== 'chromium', 'checked on Chromium');
  // Arrange: a stream that has run for a while (p2p.spec.ts), a video viewer, then an audio-only one.
  await waitForPlaylist(32);
  const video = await viewers.join(uid('p2pVideo'));
  await waitPlaying(video.page);
  await enableP2P(video.page);
  const audio = await viewers.join(uid('p2pAudio'), { setup: rememberAudioOnly });
  await playingAudioOnly(audio.page);
  await waitPlaying(audio.page);

  // Act
  await enableP2P(audio.page);

  // Assert
  await expect.poll(async () => (await stats(audio.page)).peers.length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await stats(audio.page)).p2pDownBytes + (await stats(audio.page)).p2pUpBytes, { timeout: 90_000, intervals: [2000] }).toBeGreaterThan(0);
  expect((await stats(audio.page)).hashFailures + (await stats(video.page)).hashFailures).toBe(0);
  await playsOn(audio.page, 2);
});

const serverQualities = async (): Promise<number[]> => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height);

/** The Stable profile starts this far behind live: the most a viewer has buffered to bridge the switch (ms). */
const STARTING_DELAY_MS = ADAPTIVE_DELAY.stable.initial * 1000;

test('with the quality ladder on, audio only keeps playing when the PC drops its last converted quality', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(180_000);
  await adminApi('PUT', '/api/quality', ladderUpdate(q0, { mode: 'manual', enabled: true, heights: [480], encoder: 'libx264' }));
  await reconnectObs('hd');
  await expect.poll(serverQualities, { timeout: 120_000, intervals: [1000] }).toEqual([720, 480]);
  const { page } = await viewers.join(uid('audioLadder'), { setup: rememberAudioOnly });
  await playingAudioOnly(page);
  await waitPlaying(page);
  expect((await player(page)).media).toBe('/hls/audio.m3u8');
  await startStallMonitor(page);

  // Act
  await dropRendition();

  // Assert
  await expect.poll(serverQualities, { timeout: 30_000, intervals: [500] }).toEqual([720]);
  await expect.poll(async () => (await player(page)).media, { timeout: STARTING_DELAY_MS, intervals: [500] }).not.toBe('/hls/audio.m3u8');
  await playingAudioOnly(page);
  await playsOn(page, 2);
  const after = await stallReport(page);
  const s = await stats(page);
  console.log(`audio only, rendition dropped: longest stall ${Math.round(after.maxStallMs)} ms, ${s.reloads} source reloads (last: ${s.lastReload ?? 'none'})`);
  expect(after.maxStallMs, 'stall while the audio-only viewer moves to the original').toBeLessThan(4000);
  expect(await savedChoice(page)).toBe('on');
});
