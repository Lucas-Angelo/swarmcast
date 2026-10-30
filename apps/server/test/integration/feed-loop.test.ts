import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { App } from '../../src/app.js';
import { bootApp, hasFfmpeg, joinAs, startFeed, stopTracked, tmpDir, until } from './helpers.js';

// The fake OBS sends a pre-encoded clip in a loop (`-stream_loop -1 -c copy`). At every loop
// boundary ffmpeg shifts the timestamps by the clip's length; MediaMTX must take that as one
// continuous stream. This proves it with the ffmpeg of the machine (each CI OS has its own
// build), for a 2 s clip (one keyframe interval) crossed three times.

const CLIP_SECONDS = 2;
const LOOPS = 3;
/** Segments (2 s each) to see: the clip's own first seconds (the initial burst), then LOOPS loops of it. */
const SEGMENTS_NEEDED = (LOOPS * CLIP_SECONDS) / 2 + 2;
/**
 * Keyframes stay 2 s apart across a boundary (a broken boundary makes a short or a long
 * segment). One over a boundary lasts about 2.03 s: the clip is 31 ms longer than its 2 s of
 * video (AAC priming), and ffmpeg shifts every loop by the whole length.
 */
const SEGMENT_MIN_S = 1.9;
const SEGMENT_MAX_S = 2.1;

afterEach(stopTracked);

const extinf = (pl: string): number[] => [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
const segments = (pl: string): string[] => pl.split('\n').filter((l) => l && !l.startsWith('#'));

/** How many times OBS was seen to drop off (connected, then not), counted from now on. */
function countDrops(app: App): () => number {
  let drops = 0;
  let wasConnected = false;
  app.live.on('state', () => {
    const c = app.live.snapshot().obsConnected;
    if (wasConnected && !c) drops += 1;
    wasConnected = c;
  });
  return () => drops;
}

/** MediaMTX's own lines in the server log (it logs only warnings and errors there: timestamps, the publisher). */
function mediamtxLogLines(dataDir: string): string[] {
  const dir = path.join(dataDir, 'logs');
  return fs
    .readdirSync(dir)
    .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n'))
    .filter((l) => l.includes('"mediamtx"'));
}

describe.skipIf(!hasFfmpeg)('pre-encoded fake OBS across the loop boundary', () => {
  it(`MediaMTX keeps one stream through ${LOOPS} loops of a ${CLIP_SECONDS} s clip: same publisher, 2 s segments, no discontinuity, no warning`, async () => {
    // Arrange
    const dataDir = tmpDir();
    const { app, ports } = await bootApp({ dataDir });
    onTestFinished(() => app.close());
    const drops = countDrops(app);
    // Act
    const feed = startFeed(`rtmp://127.0.0.1:${ports.rtmp}/live/${app.live.snapshot().streamKey}`, { clipSeconds: CLIP_SECONDS });
    await until(() => app.live.phase === 'live', { timeoutMs: 30_000, what: 'stream to become live', abortOn: [feed], on: [[app.live, 'state']] });
    const jar = await joinAs(`http://127.0.0.1:${app.live.publicPort}`, app.live.snapshot().liveLink!, 'Loop');
    const media = segments(await (await jar.fetch('/hls/index.m3u8')).text())[0]!;
    const durations = new Map<string, number>();
    let last = '';
    await until(
      async () => {
        last = await (await jar.fetch(`/hls/${media}`)).text();
        const d = extinf(last);
        segments(last).forEach((n, i) => durations.set(n, d[i]!));
        return durations.size >= SEGMENTS_NEEDED;
      },
      { timeoutMs: 60_000, what: `${SEGMENTS_NEEDED} segments`, abortOn: [feed], on: [[app.live.origin, 'updated']], detail: () => `seen ${durations.size}; last playlist:\n${last}` },
    );
    // Assert
    expect(feed.running).toBe(true);
    expect(drops()).toBe(0);
    expect(last).not.toContain('#EXT-X-DISCONTINUITY');
    for (const [name, d] of durations) {
      expect(d, name).toBeGreaterThan(SEGMENT_MIN_S);
      expect(d, name).toBeLessThan(SEGMENT_MAX_S);
    }
    expect(mediamtxLogLines(dataDir)).toEqual([]);
  });
});
