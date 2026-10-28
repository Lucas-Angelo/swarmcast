import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import { hasFfmpeg, joinAs, startFeed, stopTracked, tmpDir, until, type Feed } from './helpers.js';

// The fake OBS sends a pre-encoded clip in a loop (`-stream_loop -1 -c copy`). At every loop
// boundary ffmpeg shifts the timestamps by the clip's length; MediaMTX must take that as one
// continuous stream. This proves it with the ffmpeg of the machine (each CI OS has its own
// build), for a 4 s clip crossed three times.

const PORTS = { rtmp: 29150, public: 0, admin: 0, mediamtxHls: 29151 };
const CLIP_SECONDS = 4;
const LOOPS = 3;

const extinf = (pl: string): number[] => [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
const segments = (pl: string): string[] => pl.split('\n').filter((l) => l && !l.startsWith('#'));

describe.skipIf(!hasFfmpeg)('pre-encoded fake OBS across the loop boundary', () => {
  let app: App | undefined;
  let feed: Feed | undefined;
  let dataDir = '';

  afterAll(async () => {
    await feed?.stop();
    await app?.close();
    await stopTracked();
  });

  it(`MediaMTX keeps one stream through ${LOOPS} loops of a ${CLIP_SECONDS} s clip: same publisher, 2 s segments, no discontinuity, no warning`, async () => {
    dataDir = tmpDir();
    app = await createApp({ dataDir, noTunnel: true, noReaper: true, logToStdout: false, configOverrides: { ports: PORTS, speedTest: { enabled: false, intervalMinutes: 15 } } });
    const a = app;
    await a.live.start();
    let drops = 0;
    let wasConnected = false;
    a.live.on('state', () => {
      const c = a.live.snapshot().obsConnected;
      if (wasConnected && !c) drops += 1;
      wasConnected = c;
    });
    feed = startFeed(`rtmp://127.0.0.1:${PORTS.rtmp}/live/${a.live.snapshot().streamKey}`, { clipSeconds: CLIP_SECONDS });
    const f = feed;
    await until(() => a.live.phase === 'live', { timeoutMs: 30_000, what: 'stream to become live', abortOn: [f], on: [[a.live, 'state']] });
    const base = `http://127.0.0.1:${a.live.publicPort}`;
    const jar = await joinAs(base, a.live.snapshot().liveLink!, 'Loop');
    const media = segments(await (await jar.fetch('/hls/index.m3u8')).text())[0]!;

    // Every segment the origin listed: the clip's own first seconds (burst) and then LOOPS loops.
    const seen = new Set<string>();
    const durations = new Map<string, number>();
    let last = '';
    const needed = (LOOPS * CLIP_SECONDS) / 2 + 2;
    await until(
      async () => {
        last = await (await jar.fetch(`/hls/${media}`)).text();
        const names = segments(last);
        const d = extinf(last);
        names.forEach((n, i) => {
          seen.add(n);
          durations.set(n, d[i]!);
        });
        return seen.size >= needed;
      },
      { timeoutMs: 60_000, what: `${needed} segments`, abortOn: [f], on: [[a.live.origin, 'updated']], detail: () => `seen ${seen.size}; last playlist:\n${last}` },
    );

    expect(f.running).toBe(true);
    expect(drops).toBe(0);
    expect(last).not.toContain('#EXT-X-DISCONTINUITY');
    // Keyframes every 2 s across the boundary too (a broken boundary makes a short or long one).
    // The segment over a boundary is about 2.03 s: the clip lasts 31 ms more than its 4 s of
    // video (AAC priming), and ffmpeg shifts every loop by the whole length.
    for (const [name, d] of durations) {
      expect(d, name).toBeGreaterThan(1.9);
      expect(d, name).toBeLessThan(2.1);
    }
    // MediaMTX said nothing about timestamps or the publisher (its WAR/ERR lines go to the log).
    const logs = fs.readdirSync(path.join(dataDir, 'logs')).map((n) => fs.readFileSync(path.join(dataDir, 'logs', n), 'utf8')).join('\n');
    expect(logs.split('\n').filter((l) => l.includes('"mediamtx"'))).toEqual([]);
  });
});
