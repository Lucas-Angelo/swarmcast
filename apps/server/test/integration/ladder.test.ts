import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { isAlive } from '../../src/process/children.js';
import { variantInfoHashHex } from '../../src/tracker/tracker.js';
import { bootApp, FEEDS, FFMPEG_BIN, hasFfmpeg, joinAs, startFeed, stopTracked, until, type Feed, type Jar, type Ports } from './helpers.js';

function mediaSegments(playlist: string): string[] {
  return playlist.split('\n').filter((l) => l && !l.startsWith('#'));
}

const mediaSequence = (playlist: string): number => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)![1]);
/** The ladder run a segment belongs to (`<runId>_<n>.m4s`). */
const runOf = (seg: string): string => seg.split('_')[0]!;

describe.skipIf(!hasFfmpeg)('quality ladder: ffmpeg renditions behind one multivariant playlist', () => {
  let app: App;
  let ports: Ports;
  let feed: Feed | null = null;
  let jar: Jar;
  const ladder = () => app.live.quality.transcoder;
  const state = () =>
    JSON.stringify({
      phase: app.live.phase,
      source: app.live.origin.sourceKind,
      transcoder: { status: ladder().status, pid: ladder().pid, outDir: ladder().outDir, launches: ladder().launches, crashes: ladder().crashes },
      quality: app.live.quality.state(),
    });
  /** The ladder runs with its own folder, and the origin serves it. */
  const ladderRunning = (): boolean => ladder().status === 'running' && !!ladder().outDir && !!ladder().pid && app.live.origin.sourceKind === 'ladder';
  /**
   * The load guard never drops a rendition here (see beforeAll). If it does anyway, every test
   * after it would wait for playlists that no longer exist: fail at once, saying so.
   */
  const noShed = (): void => {
    const shed = app.live.quality.state().shed;
    if (shed) throw new Error(`the load guard dropped a rendition during the test: ${JSON.stringify(shed)} (${state()})`);
  };
  /**
   * Crashes the tests caused on purpose. Any other crash fails the test it happened in: the
   * feed loops a 10 s clip, so a ladder ffmpeg that cannot take the loop's timestamps shows here.
   */
  let deliberateCrashes = 0;
  /**
   * Wait for `pred`, re-checked on every live, quality, ladder and origin change. Fails at once
   * if the feed dies (unless `feed: false`) or a rendition is dropped.
   */
  const waitUntil = (pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string, o: { feed?: boolean } = {}): Promise<void> =>
    until(() => (noShed(), pred()), {
      timeoutMs,
      what,
      detail: state,
      abortOn: o.feed === false || !feed ? [] : [feed],
      on: [
        [app.live, 'state'],
        [app.live.quality, 'changed'],
        [ladder(), 'status'],
        [app.live.origin, 'updated'],
      ],
    });
  const push = (): Feed => (feed = startFeed(`rtmp://127.0.0.1:${ports.rtmp}/live/${app.live.snapshot().streamKey}`, FEEDS.hd));
  /** A media playlist by name ("v480" or "v480.m3u8"); '' while it is not served. */
  const playlist = async (name: string): Promise<string> => {
    const res = await jar.fetch(`/hls/${name.replace(/\.m3u8$/, '')}.m3u8`);
    return res.ok ? res.text() : '';
  };

  beforeAll(async () => {
    // The ladder probes the encoders itself when OBS connects.
    ({ app, ports } = await bootApp({
      // These tests are about the ladder itself (renditions, crash recovery, reconnects). On a
      // 3-vCPU CI runner, x264 720p + 480p keeps the machine ≥ 90 % busy, so the load guard
      // rightly drops 720p after 10 s and the 720p playlist disappears mid-test. The guard has
      // its own unit tests (quality-decisions.test.ts): never shed here.
      loadGuard: { cpuSaturatedPercent: 101, behindSpeed: 0 },
      configOverrides: {
        // The test ffmpeg; manual ladder with the encoder forced to x264, so the test also runs
        // on machines without a GPU encoder and with fewer than 6 CPU threads (CI runners), where
        // `encoder: 'auto'` keeps only the original quality to protect OBS.
        ffmpegPath: FFMPEG_BIN,
        quality: {
          ladder: { mode: 'manual', enabled: true, heights: [720, 480], encoder: 'libx264' },
          upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
          obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
        },
      },
    }));
    push();
    await waitUntil(() => app.live.phase === 'live' && app.live.origin.sourceKind === 'ladder' && app.live.quality.transcoder.status === 'running', 60_000, 'ladder to become live');
    jar = await joinAs(`http://127.0.0.1:${app.live.publicPort}`, app.live.snapshot().liveLink!, 'Ladder');
  });

  afterEach(() => {
    noShed();
    expect(ladder().crashes, `ladder ffmpeg crashes nobody caused (${state()})`).toBe(deliberateCrashes);
  });

  afterAll(async () => {
    await feed?.stop();
    await app?.close();
    await stopTracked();
  });

  it('serves 1080p (copied) + 720p + 480p, highest first, without an audio-only variant', async () => {
    const multi = await (await jar.fetch('/hls/index.m3u8')).text();
    const res = [...multi.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((m) => Number(m[2]));
    expect(res).toEqual([1080, 720, 480]);
    expect((multi.match(/#EXT-X-STREAM-INF/g) ?? []).length).toBe(3);
    expect(multi).toContain('TYPE=AUDIO');
    const state = app.live.quality.state();
    expect(state.transcoder.status).toBe('running');
    expect(state.plan.rungs.map((r) => r.height)).toEqual([1080, 720, 480]);
  });

  it('hashes the segments of every variant in the signed manifest', async () => {
    await waitUntil(async () => {
      const pl = await (await jar.fetch('/hls/v480.m3u8')).text();
      return mediaSegments(pl).length >= 2;
    }, 30_000, 'v480 segments');
    const jws = await (await jar.fetch('/hls/manifest.json')).text();
    const manifest = JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()) as { segments: Record<string, string> };
    for (const name of ['v1080', 'v720', 'v480', 'audio']) {
      const pl = await (await jar.fetch(`/hls/${name}.m3u8`)).text();
      expect(pl).toContain('#EXT-X-MAP');
      expect(pl).not.toContain('#EXT-X-ENDLIST');
      const seg = mediaSegments(pl).pop()!;
      const body = Buffer.from(await (await jar.fetch(`/hls/${seg}`)).arrayBuffer());
      expect(manifest.segments[`/hls/${seg}`] ?? (await refreshed(seg)), name).toBe(crypto.createHash('sha256').update(body).digest('hex'));
    }
    async function refreshed(seg: string): Promise<string | undefined> {
      const j = await (await jar.fetch('/hls/manifest.json')).text();
      return (JSON.parse(Buffer.from(j.split('.')[1]!, 'base64url').toString()) as { segments: Record<string, string> }).segments[`/hls/${seg}`];
    }
  });

  it('measures each rendition near its target bitrate', async () => {
    // The origin measures over the last (up to 5) segments of each playlist: wait until every
    // variant lists at least 3, instead of a fixed sleep.
    const names = app.live.origin.variants().map((x) => x.name);
    expect(names).toHaveLength(3);
    await waitUntil(async () => (await Promise.all(names.map(playlist))).every((pl) => mediaSegments(pl).length >= 3), 30_000, '3 segments in every variant');
    const v = Object.fromEntries(app.live.origin.variants().map((x) => [x.height, x.measuredKbps]));
    expect(v[1080]).toBeGreaterThan(4500);
    expect(v[720]).toBeGreaterThan(1200);
    expect(v[720]).toBeLessThan(4500);
    expect(v[480]).toBeLessThan(2500);
  });

  it('allowlists one P2P swarm per variant height', () => {
    const allowed = new Set(app.live.tracker.allowedInfoHashes());
    for (const h of [1080, 720, 480]) expect(allowed.has(variantInfoHashHex(app.live.access.liveId, h))).toBe(true);
  });

  it('survives an ffmpeg crash: restarted, playlist continues with a discontinuity and a growing media sequence', async () => {
    await waitUntil(ladderRunning, 30_000, 'ladder running before the crash');
    // A rendition the ladder encodes (not the copied source), whichever exists right now.
    const name = app.live.origin.variants().find((v) => v.height < 1080)!.name;
    const before = await playlist(name);
    const runsBefore = new Set(mediaSegments(before).map(runOf));
    const { launches, crashes } = ladder();
    deliberateCrashes += 1;
    process.kill(ladder().pid!, 'SIGKILL');
    // Restarted means: the crash was counted, a new ffmpeg was launched and runs, and the same
    // playlist lists a segment of the new run behind a discontinuity.
    await waitUntil(async () => {
      if (!(ladder().crashes > crashes && ladder().launches > launches && ladderRunning())) return false;
      const pl = await playlist(name);
      return pl.includes('#EXT-X-DISCONTINUITY') && mediaSegments(pl).some((s) => !runsBefore.has(runOf(s)));
    }, 40_000, `ladder restart (${name})`);
    const after = await playlist(name);
    expect(mediaSequence(after)).toBeGreaterThanOrEqual(mediaSequence(before));
    expect((after.match(/#EXT-X-MAP/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(ladder().crashes).toBe(crashes + 1);
    expect(ladder().launches).toBe(launches + 1);
  });

  it('OBS reconnecting: same playlist names, sequence keeps growing, a discontinuity marks the restart', async () => {
    await waitUntil(ladderRunning, 30_000, 'ladder running before OBS leaves');
    const before = await playlist('v480');
    const seqBefore = mediaSequence(before);
    const lastBefore = mediaSegments(before).pop()!;
    // Every run listed so far (the crash test leaves two in the stitched playlist): "back after
    // the reconnect" means a segment of a run that did not exist before, never an old one.
    const runsBefore = new Set(mediaSegments(before).map(runOf));
    const launches = ladder().launches;
    // OBS leaves abruptly: the whole feed process tree is gone when stop() returns.
    await feed!.stop();
    await waitUntil(() => ladder().status === 'off' && app.live.origin.sourceKind !== 'ladder', 20_000, 'ladder stop after OBS left', { feed: false });
    push();
    const oldRun = runOf(lastBefore);
    await waitUntil(async () => {
      if (!(ladder().launches > launches && ladderRunning())) return false;
      return mediaSegments(await playlist('v480')).some((s) => !runsBefore.has(runOf(s)));
    }, 60_000, 'ladder back after reconnect');
    const after = await playlist('v480');
    expect(mediaSequence(after)).toBeGreaterThanOrEqual(seqBefore);
    // If segments of the previous session are still listed, the restart is marked.
    if (mediaSegments(after).some((s) => s.startsWith(oldRun))) expect(after).toContain('#EXT-X-DISCONTINUITY');
    const multi = await (await jar.fetch('/hls/index.m3u8')).text();
    expect([...multi.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]))).toEqual([1080, 720, 480]);
  });

  it('"Stop everything" also stops ffmpeg and deletes its files', async () => {
    await waitUntil(ladderRunning, 30_000, 'ladder running before "Stop everything"');
    const pid = ladder().pid;
    const dir = ladder().outDir;
    await feed!.stop();
    expect(await app.live.stop()).toBe(true);
    if (pid) expect(isAlive(pid)).toBe(false);
    expect(dir).toBeTruthy();
    const fs = await import('node:fs');
    expect(fs.existsSync(dir!)).toBe(false);
    expect(app.live.origin.cachedFileCount).toBe(0);
  });
});
