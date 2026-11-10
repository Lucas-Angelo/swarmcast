// "Audio only (saves data)" (docs/QUALITY.md "Audio only"): a viewer picks it in the quality menu
// and the player loads /hls/audio-only.m3u8, the stream's own audio rendition alone, instead of
// index.m3u8. Checked while live, on every engine:
// - switching to it and back starts playing near the live edge ("LIVE", not "Go live") and plays
//   on (checked as the new source starts playing: a few seconds later, muted Chrome on the macOS
//   runner, which plays at about 0.6x real time, is rightly behind live; fixtures.ts
//   startsAtLive); the video area shows "Audio only" instead of a picture (no video track:
//   videoWidth 0); the data used drops (the fake OBS sends 1200 kbps video + 96 kbps audio, so
//   audio alone is about 7 %; the bar is a third, which a full 20 s buffer refill right after the
//   switch stays under);
// - the choice is remembered per browser: after a reload the player starts on audio only, and an
//   OBS reconnect (the stream's next run) keeps it playing on audio only;
// - on Linux WebKit, the switch and the reload never seek the new sound-only MediaSource before it
//   plays (a seek there kills the page's process now and then): it starts at the window start and
//   moves to live once it plays;
// - with the quality ladder on, when the streamer's PC drops its last converted quality, the
//   ladder's audio playlist (audio.m3u8) goes away with it and the stream goes on with the
//   original (MediaMTX's audio playlist): the audio-only viewer follows without a long freeze,
//   on the MediaSource it had (a new one for sound alone can crash Linux WebKit's page);
// - when a media playlist it plays goes away (a 404), audio only reads its playlist again on that
//   MediaSource and plays on from the live window it reads, never "ahead of live" on the timeline
//   of the window it joined;
// - with the sound on: where the device has a sound output, audio only plays on; where it has none
//   (Firefox on the Linux runners fails a sound-only element with "OnMediaSinkAudioError" once it
//   is unmuted, and hls.js used to reset and reload the whole audio playlist every 2 s, forever:
//   34 MB in 8 s), the video comes back after at most two resets and audio only is no longer
//   offered on that page. The other checks run muted, as a page starts, so they hold on every
//   runner;
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
  qualityMenu,
  reconnectObs,
  startStallMonitor,
  stallReport,
  startsAtLive,
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
  await expect(qualityMenu.checked(page)).toHaveText(AUDIO_ONLY);
  // No screen to keep on while only the sound plays: the wake lock lets go (or the browser has none).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __swarmcast: { wakeLock: string } }).__swarmcast.wakeLock)).toMatch(/^(off|unsupported)$/);
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

/** The blob: URL of the MediaSource the video element plays (a new one after every hls.js MediaSource reset). */
const mediaSourceUrl = (page: Page): Promise<string> => page.evaluate(() => document.querySelector('video')!.src);

/** The viewer's remembered choice. */
const savedChoice = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('sc.audio-only'));

/** In `context`, the player starts on audio only (the remembered choice). */
async function rememberAudioOnly(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem('sc.audio-only', 'on'));
}

const MEASURE_MS = 8000;

/**
 * Counts, in the page, the seeks made while the player loads the audio-only playlist and the
 * element has not started playing it (readyState below HAVE_FUTURE_DATA). Linux WebKit (GStreamer)
 * kills the page's process now and then when a new sound-only MediaSource is sought before it
 * plays, which every live start of hls.js does (it seeks to its live sync position right after
 * the first append); there the player starts sound alone at the window start instead and seeks
 * to live once it plays (audio-only.ts createWindowStart).
 */
const recordEarlySoundSeeks = (): void => {
  const w = window as unknown as { __earlySoundSeeks: number; __hls?: { url: string | null } };
  w.__earlySoundSeeks = 0;
  const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    ...ct,
    set(this: HTMLMediaElement, t: number) {
      const url = w.__hls?.url;
      if (this.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && url && new URL(url, location.href).pathname === '/hls/audio-only.m3u8') w.__earlySoundSeeks += 1;
      ct.set!.call(this, t);
    },
  });
};
const earlySoundSeeks = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __earlySoundSeeks: number }).__earlySoundSeeks);

/** Linux WebKit: sound alone on a new MediaSource is never sought before it plays (recordEarlySoundSeeks). */
async function noEarlySoundSeek(page: Page, browserName: string): Promise<void> {
  if (browserName !== 'webkit' || process.platform !== 'linux') return;
  expect(await earlySoundSeeks(page), 'seeks of the new sound-only MediaSource before it played').toBe(0);
}

test('a viewer switches to audio only and back while live: far less data, no picture, the choice survives a reload and an OBS reconnect', { tag: '@media' }, async ({ viewers, browserName }) => {
  // Arrange
  const { page } = await viewers.join(uid('audio'), { setup: async (c) => void (await c.addInitScript(recordEarlySoundSeeks)) });
  const received = hlsBytes(page);
  await waitPlaying(page);
  await expect(qualityMenu.entries(page).last()).toHaveText(AUDIO_ONLY);
  const videoBytes = await bytesDuring(page, received, MEASURE_MS);

  // Act
  await qualityMenu.pick(page, AUDIO_ONLY);

  // Assert
  await playingAudioOnly(page);
  await startsAtLive(page);
  await playsOn(page, 3);
  await noEarlySoundSeek(page, browserName);
  expect(await savedChoice(page)).toBe('on');
  const audioBytes = await bytesDuring(page, received, MEASURE_MS);
  console.log(`bytes in ${MEASURE_MS / 1000} s: video ${videoBytes}, audio only ${audioBytes} (${Math.round((audioBytes / videoBytes) * 100)} %)`);
  expect(audioBytes, 'audio only uses a fraction of the data').toBeLessThan(videoBytes / 3);
  expect(audioBytes, 'audio keeps arriving').toBeGreaterThan(0);

  // Act
  await page.reload();

  // Assert
  await playingAudioOnly(page);
  await startsAtLive(page);
  await waitPlaying(page);
  await noEarlySoundSeek(page, browserName);

  // Act: OBS drops its connection and publishes again, as its own reconnect does.
  await followRuns(page);
  const runBefore = await lastRunBuffered(page);
  await reconnectObs(null);

  // Assert: the player goes on loading audio from the stream's new run, on audio only.
  await expect.poll(() => lastRunBuffered(page), { timeout: 30_000, message: 'audio of the run after the reconnect buffered' }).toBeGreaterThan(runBefore);
  await playsOn(page, 2);
  await playingAudioOnly(page);

  // Act
  await qualityMenu.pick(page, 'Auto');

  // Assert
  await expect.poll(async () => (await player(page)).source).toBe('/hls/index.m3u8');
  await expect.poll(async () => (await player(page)).videoWidth).toBeGreaterThan(0);
  await expect(page.getByTestId('audio-only')).toBeHidden();
  await startsAtLive(page);
  await playsOn(page, 2);
  expect(await savedChoice(page)).toBeNull();
  // Automatic quality (the one quality of the default feed, by its name: nothing else to choose).
  await expect(qualityMenu.checked(page)).toHaveAttribute('data-value', '-1');
  await expect(qualityMenu.entries(page)).toHaveText(['360p', AUDIO_ONLY]);
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

test('with the sound on, audio only plays where the device has a sound output; where it has none, the video comes back without loading in a loop', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('audioSound'), { setup: rememberAudioOnly });
  await playingAudioOnly(page);
  await waitPlaying(page);
  await page.evaluate(() => {
    const w = window as unknown as { __hls: { on(e: string, f: (e: string, d: { details: string }) => void): void }; __resets: number };
    w.__resets = 0;
    w.__hls.on('hlsError', (_e, d) => {
      if (d.details === 'mediaSourceRequiresReset') w.__resets += 1;
    });
  });

  // Act
  await unmute(page);
  await measuredWindow(page, 15_000);

  // Assert
  const resets = await page.evaluate(() => (window as unknown as { __resets: number }).__resets);
  const now = await player(page);
  console.log(`audio only with the sound on: ${resets} MediaSource resets, playing ${now.source}`);
  expect(resets, 'MediaSource resets (each one loads the whole audio playlist again)').toBeLessThanOrEqual(2);
  if (now.source === '/hls/audio-only.m3u8') {
    expect(resets).toBe(0);
    await playingAudioOnly(page);
    await playsOn(page, 2);
  } else {
    // No sound output: the video is back, said why, and audio only is no longer offered here.
    expect(now.source).toBe('/hls/index.m3u8');
    expect((await stats(page)).lastReload).toBe('audio only cannot play here');
    await expect.poll(async () => (await player(page)).videoWidth).toBeGreaterThan(0);
    await expect(page.getByTestId('audio-only')).toBeHidden();
    await expect(qualityMenu.entries(page).filter({ hasText: AUDIO_ONLY })).toHaveCount(0);
    await playsOn(page, 2);
    expect(await savedChoice(page)).toBe('on');
  }
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
  const mediaSource = await mediaSourceUrl(page);
  await startStallMonitor(page);

  // Act
  await dropRendition();

  // Assert
  await expect.poll(serverQualities, { timeout: 30_000, intervals: [500] }).toEqual([720]);
  await expect.poll(async () => (await player(page)).media, { timeout: STARTING_DELAY_MS, intervals: [500] }).not.toBe('/hls/audio.m3u8');
  await playingAudioOnly(page);
  await playsOn(page, 2);
  // The same MediaSource plays on: a new one for sound alone can crash Linux WebKit (audio-only.ts reloadAudioOnlyInPlace).
  expect(await mediaSourceUrl(page), 'the element kept its MediaSource').toBe(mediaSource);
  const after = await stallReport(page);
  const s = await stats(page);
  console.log(`audio only, rendition dropped: longest stall ${Math.round(after.maxStallMs)} ms, ${s.reloads} source reloads (last: ${s.lastReload ?? 'none'})`);
  expect(after.maxStallMs, 'stall while the audio-only viewer moves to the original').toBeLessThan(4000);
  expect(await savedChoice(page)).toBe('on');
});

/** hls.js's view of the audio-only player: how far behind live it plays, and where the live window starts on the element's timeline. */
const liveWindow = (page: Page): Promise<{ latency: number; windowStart: number }> =>
  page.evaluate(() => {
    const h = (window as unknown as { __hls: { latency: number; levels: Array<{ details?: { fragmentStart: number } }> } }).__hls;
    return { latency: h.latency, windowStart: h.levels[0]?.details?.fragmentStart ?? 0 };
  });

/**
 * Counts, in the page, the seconds the element plays while hls.js reckons its playhead is past
 * the live edge (hls.js `latency` below 0): a player on the playlist's own timeline never is.
 */
async function countAheadOfLive(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __hls: { latency: number }; __ahead: number };
    const v = document.querySelector('video')!;
    let prev = v.currentTime;
    w.__ahead = 0;
    window.setInterval(() => {
      const step = v.currentTime - prev;
      prev = v.currentTime;
      if (step > 0 && step < 1 && w.__hls.latency < 0) w.__ahead += step;
    }, 100);
  });
  return () => page.evaluate(() => (window as unknown as { __ahead: number }).__ahead);
}

test('audio only reads a vanished playlist again on the same MediaSource and plays on from the live window it reads, not the one it joined', { tag: '@media' }, async ({ viewers }) => {
  // Arrange: hls.js places a playlist it reads afresh from the first segment its window lists
  // then; what the element holds sits where the window started when the viewer joined. Once the
  // window has moved on by more than the viewer's delay (+10 s), a reload that kept both would
  // leave the playhead that far "ahead of live" (audio-only.ts reloadAudioOnlyInPlace).
  test.setTimeout(180_000);
  const { page } = await viewers.join(uid('audioReread'), { setup: rememberAudioOnly });
  await playingAudioOnly(page);
  await waitPlaying(page);
  const media = (await player(page)).media;
  const mediaSource = await mediaSourceUrl(page);
  await expect
    .poll(async () => {
      const w = await liveWindow(page);
      return w.windowStart - w.latency;
    }, { timeout: 120_000, intervals: [1000], message: 'the live window moved on by more than the delay + 10 s' })
    .toBeGreaterThan(10);
  const reloads = (await stats(page)).reloads;
  const ahead = await countAheadOfLive(page);
  let answered404 = false;
  await page.route(
    (url) => url.pathname === media,
    async (route) => {
      if (answered404) return route.continue();
      answered404 = true;
      // As the ladder's audio playlist answers once the ladder fell back to the original.
      await route.fulfill({ status: 404, body: 'gone' });
    },
  );

  // Act
  await expect.poll(async () => (await stats(page)).reloads, { timeout: 15_000, message: 'the 404 reloaded the source' }).toBe(reloads + 1);

  // Assert
  expect((await stats(page)).lastReload).toBe('media playlists gone');
  await playsOn(page, 6);
  expect(await mediaSourceUrl(page), 'the element kept its MediaSource').toBe(mediaSource);
  const s = await ahead();
  const w = await liveWindow(page);
  console.log(`audio only, playlist read again: ${s.toFixed(1)} s played ahead of live; now ${w.latency.toFixed(1)} s behind live`);
  expect(s, 'seconds played "ahead of live" (on the timeline of the window the viewer joined)').toBeLessThan(0.5);
  expect(await savedChoice(page)).toBe('on');
});
