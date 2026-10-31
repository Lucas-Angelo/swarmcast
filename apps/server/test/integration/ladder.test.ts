import crypto from 'node:crypto';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { variantInfoHashHex } from '../../src/tracker/tracker.js';
import { bootApp, FEEDS, FFMPEG_BIN, hasFfmpeg, isAlive, joinAs, startFeed, stopTracked, until, type Feed, type Jar, type Ports } from './helpers.js';

// The quality ladder with real ffmpeg renditions behind one multivariant playlist, from a 1080p
// fake OBS. Starting a ladder is the expensive part, so the checks share one, and each waits for
// the state it needs: an ffmpeg crash and an OBS reconnect leave the ladder running again (their
// own assertions), with more runs in the stitched playlist. "Stop everything" ends a ladder, so it
// gets one of its own.
//
// The load guard never drops a rendition here: these tests are about the ladder itself
// (renditions, crash recovery, reconnects). On a 3-vCPU CI runner, x264 720p + 480p keeps the
// machine at 90 % or more, so the guard would rightly drop 720p after 10 s and its playlist would
// disappear mid-test. The guard has its own unit tests (quality-decisions.test.ts). If it drops a
// rendition anyway, every wait fails at once, saying so. A wait that times out prints what the
// ladder, the origin and the live did and when, the warnings (ffmpeg's and MediaMTX's included)
// and how late this process ran its timers (the server runs in it).
// The ladder runs manual with the encoder forced to x264, so it also runs on machines without a
// GPU encoder and with fewer than 6 CPU threads (CI runners), where `encoder: 'auto'` keeps only
// the original quality to protect OBS. The ladder probes the encoders itself when OBS connects.
// The feed loops a 10 s clip: a ladder ffmpeg that cannot take the loop's timestamps crashes,
// and any crash a test did not cause fails the test it happened in.

const mediaSegments = (playlist: string): string[] => playlist.split('\n').filter((l) => l && !l.startsWith('#'));
const mediaSequence = (playlist: string): number => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)![1]);
/** The ladder run a segment belongs to (`<runId>_<n>.m4s`). */
const runOf = (seg: string): string => seg.split('_')[0]!;
const heightsOf = (multivariant: string): number[] => [...multivariant.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
/** The tag itself, not EXT-X-DISCONTINUITY-SEQUENCE (the ladder's first run already counts above 0: the original OBS run before it is run 0). */
const hasDiscontinuity = (playlist: string): boolean => /^#EXT-X-DISCONTINUITY$/m.test(playlist);

/** A live with the 720p + 480p ladder from the 1080p fake OBS, and a joined viewer. */
class LadderLive {
  feed: Feed | null = null;
  jar!: Jar;
  /** Ladder crashes a test caused on purpose. */
  deliberateCrashes = 0;
  /** What happened since the app started, with times (as in fake-obs.log): ladder status, origin availability, phase. */
  private readonly timeline: string[] = [];
  /** How late this process ran its timers (a stalled event loop or VM): the server runs in it. */
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });

  private constructor(
    readonly app: App,
    readonly ports: Ports,
  ) {
    this.loopDelay.enable();
    const mark = (what: string): void => void this.timeline.push(`${new Date().toISOString()} ${what}`);
    this.ladder.on('status', (s) => mark(`ladder ${s}`));
    app.live.origin.on('available', (v) => mark(`origin ${app.live.origin.sourceKind} available=${v}`));
    let phase = app.live.phase;
    app.live.on('state', () => {
      if (app.live.phase !== phase) mark(`phase ${(phase = app.live.phase)}`);
    });
  }

  static async start(): Promise<LadderLive> {
    const { app, ports } = await bootApp({
      loadGuard: { cpuSaturatedPercent: 101, behindSpeed: 0 },
      configOverrides: {
        ffmpegPath: FFMPEG_BIN,
        quality: {
          ladder: { mode: 'manual', enabled: true, heights: [720, 480], encoder: 'libx264' },
          upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
          obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
        },
      },
    });
    const l = new LadderLive(app, ports);
    try {
      l.push();
      await l.waitUntil(() => app.live.phase === 'live' && l.running(), 60_000, 'the ladder to become live');
      l.jar = await joinAs(`http://127.0.0.1:${app.live.publicPort}`, app.live.snapshot().liveLink!, 'Ladder');
    } catch (err) {
      await l.close();
      throw err;
    }
    return l;
  }

  get ladder() {
    return this.app.live.quality.transcoder;
  }

  /** The ladder runs with its own folder, and the origin serves it. */
  running(): boolean {
    const t = this.ladder;
    return t.status === 'running' && !!t.outDir && !!t.pid && this.app.live.origin.sourceKind === 'ladder';
  }

  state(): string {
    const t = this.ladder;
    return JSON.stringify({
      phase: this.app.live.phase,
      source: this.app.live.origin.sourceKind,
      transcoder: { status: t.status, pid: t.pid, outDir: t.outDir, launches: t.launches, crashes: t.crashes },
      quality: this.app.live.quality.state(),
      timeline: this.timeline.slice(-40),
      maxLoopDelayMs: Math.round(this.loopDelay.max / 1e6),
      activity: this.activity(),
    });
  }

  /**
   * The live's actions (OBS connected, live, not live) and every warning, ffmpeg's and
   * MediaMTX's included, with their times: what a failed wait needs to tell why the ladder is
   * not running.
   */
  activity(): string[] {
    return this.app.live.activity
      .list()
      .filter((e) => e.kind === 'action' || e.level !== 'info')
      .slice(-30)
      .map((e) => `${new Date(e.at).toISOString()} ${e.level} ${e.code ?? ''} ${e.text}`);
  }

  /** Throws when the load guard dropped a rendition: every later wait would be for playlists that no longer exist. */
  noShed(): void {
    const shed = this.app.live.quality.state().shed;
    if (shed) throw new Error(`the load guard dropped a rendition during the test: ${JSON.stringify(shed)} (${this.state()})`);
  }

  /**
   * Waits for `pred`, re-checked on every live, quality, ladder and origin change. Fails at once
   * if the feed dies (unless `feed: false`) or a rendition is dropped.
   */
  waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string, o: { feed?: boolean } = {}): Promise<void> {
    return until(() => (this.noShed(), pred()), {
      timeoutMs,
      what,
      detail: () => this.state(),
      abortOn: o.feed === false || !this.feed ? [] : [this.feed],
      on: [
        [this.app.live, 'state'],
        [this.app.live.quality, 'changed'],
        [this.ladder, 'status'],
        [this.app.live.origin, 'updated'],
      ],
    });
  }

  /** OBS starts (again) sending the 1080p feed. */
  push(): Feed {
    this.feed = startFeed(`rtmp://127.0.0.1:${this.ports.rtmp}/live/${this.app.live.snapshot().streamKey}`, FEEDS.hd);
    return this.feed;
  }

  /** A media playlist by name ("v480" or "v480.m3u8"); '' while it is not served. */
  async playlist(name: string): Promise<string> {
    const res = await this.jar.fetch(`/hls/${name.replace(/\.m3u8$/, '')}.m3u8`);
    return res.ok ? res.text() : '';
  }

  async text(p: string): Promise<string> {
    return (await this.jar.fetch(p)).text();
  }

  /** The signed manifest's segment hashes. */
  async manifestHashes(): Promise<Record<string, string>> {
    const jws = await this.text('/hls/manifest.json');
    return (JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()) as { segments: Record<string, string> }).segments;
  }

  /** The signed hash of `seg` from `hashes`, or from the next manifest when the segment is newer than those. */
  async signedHash(seg: string, hashes: Record<string, string>): Promise<string | undefined> {
    return hashes[`/hls/${seg}`] ?? (await this.manifestHashes())[`/hls/${seg}`];
  }

  async close(): Promise<void> {
    this.loopDelay.disable();
    await this.feed?.stop();
    await this.app.close();
    await stopTracked();
  }
}

describe.skipIf(!hasFfmpeg)('quality ladder: ffmpeg renditions behind one multivariant playlist', () => {
  let l: LadderLive;
  beforeAll(async () => {
    l = await LadderLive.start();
  });
  afterEach(() => {
    l.noShed();
    expect(l.ladder.crashes, `ladder ffmpeg crashes nobody caused (${l.state()})`).toBe(l.deliberateCrashes);
  });
  afterAll(() => l?.close());

  it('serves 1080p (copied) + 720p + 480p, highest first, without an audio-only variant', async () => {
    // Act
    const multi = await l.text('/hls/index.m3u8');
    const state = l.app.live.quality.state();
    // Assert
    expect(heightsOf(multi)).toEqual([1080, 720, 480]);
    expect((multi.match(/#EXT-X-STREAM-INF/g) ?? []).length).toBe(3);
    expect(multi).toContain('TYPE=AUDIO');
    expect(state.transcoder.status).toBe('running');
    expect(state.plan.rungs.map((r) => r.height)).toEqual([1080, 720, 480]);
  });

  it('hashes the segments of every variant in the signed manifest', async () => {
    // Arrange
    await l.waitUntil(async () => mediaSegments(await l.playlist('v480')).length >= 2, 30_000, 'v480 segments');
    // Act
    const hashes = await l.manifestHashes();
    const latest = [];
    for (const name of ['v1080', 'v720', 'v480', 'audio']) {
      const pl = await l.playlist(name);
      const seg = mediaSegments(pl).pop()!;
      const body = Buffer.from(await (await l.jar.fetch(`/hls/${seg}`)).arrayBuffer());
      latest.push({ name, pl, signed: await l.signedHash(seg, hashes), actual: crypto.createHash('sha256').update(body).digest('hex') });
    }
    // Assert
    for (const v of latest) {
      expect(v.pl, v.name).toContain('#EXT-X-MAP');
      expect(v.pl, v.name).not.toContain('#EXT-X-ENDLIST');
      expect(v.signed, v.name).toBe(v.actual);
    }
  });

  it('measures each rendition near its target bitrate', async () => {
    // Arrange
    const names = l.app.live.origin.variants().map((x) => x.name);
    await l.waitUntil(async () => (await Promise.all(names.map((n) => l.playlist(n)))).every((pl) => mediaSegments(pl).length >= 3), 30_000, '3 segments in every variant');
    // Act
    const kbps = Object.fromEntries(l.app.live.origin.variants().map((x) => [x.height, x.measuredKbps]));
    // Assert
    expect(names).toHaveLength(3);
    expect(kbps[1080]).toBeGreaterThan(4500);
    expect(kbps[720]).toBeGreaterThan(1200);
    expect(kbps[720]).toBeLessThan(4500);
    expect(kbps[480]).toBeLessThan(2500);
  });

  it('allowlists one P2P swarm per variant height', () => {
    // Act
    const allowed = new Set(l.app.live.tracker.allowedInfoHashes());
    // Assert
    for (const h of [1080, 720, 480]) expect(allowed.has(variantInfoHashHex(l.app.live.access.liveId, h)), `${h}p`).toBe(true);
  });

  it('survives an ffmpeg crash: restarted, playlist continues with a discontinuity and a growing media sequence', async () => {
    // Arrange
    await l.waitUntil(() => l.running(), 30_000, 'the ladder running before the crash');
    const name = l.app.live.origin.variants().find((v) => v.height < 1080)!.name;
    const before = await l.playlist(name);
    const runsBefore = new Set(mediaSegments(before).map(runOf));
    const { launches, crashes } = l.ladder;
    // Act
    l.deliberateCrashes += 1;
    process.kill(l.ladder.pid!, 'SIGKILL');
    await l.waitUntil(async () => {
      if (!(l.ladder.crashes > crashes && l.ladder.launches > launches && l.running())) return false;
      const pl = await l.playlist(name);
      return hasDiscontinuity(pl) && mediaSegments(pl).some((s) => !runsBefore.has(runOf(s)));
    }, 40_000, `the ladder restarted, with a new run in ${name}`);
    const after = await l.playlist(name);
    // Assert
    expect(mediaSequence(after)).toBeGreaterThanOrEqual(mediaSequence(before));
    expect((after.match(/#EXT-X-MAP/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(l.ladder.crashes).toBe(crashes + 1);
    expect(l.ladder.launches).toBe(launches + 1);
  });

  it('OBS reconnecting: same playlist names, sequence keeps growing, a discontinuity marks the restart', async () => {
    // Arrange
    await l.waitUntil(() => l.running(), 30_000, 'the ladder running before OBS leaves');
    const before = await l.playlist('v480');
    const oldRun = runOf(mediaSegments(before).pop()!);
    const runsBefore = new Set(mediaSegments(before).map(runOf));
    const launches = l.ladder.launches;
    // Act
    await l.feed!.stop();
    await l.waitUntil(() => l.ladder.status === 'off' && l.app.live.origin.sourceKind !== 'ladder', 20_000, 'the ladder to stop after OBS left', { feed: false });
    l.push();
    await l.waitUntil(async () => l.ladder.launches > launches && l.running() && mediaSegments(await l.playlist('v480')).some((s) => !runsBefore.has(runOf(s))), 60_000, 'the ladder back after the reconnect');
    const after = await l.playlist('v480');
    const oldRunListed = mediaSegments(after).some((s) => s.startsWith(oldRun));
    const multi = await l.text('/hls/index.m3u8');
    // Assert
    expect(mediaSequence(after)).toBeGreaterThanOrEqual(mediaSequence(before));
    expect(oldRunListed ? hasDiscontinuity(after) : true, `segments of the previous session are listed, unmarked:\n${after}`).toBe(true);
    expect(heightsOf(multi)).toEqual([1080, 720, 480]);
  });
});

describe.skipIf(!hasFfmpeg)('quality ladder: "Stop everything"', () => {
  let l: LadderLive | undefined;
  afterEach(() => l?.close());

  it('also stops ffmpeg and deletes its files', async () => {
    // Arrange
    l = await LadderLive.start();
    const { pid, outDir } = l.ladder;
    await l.feed!.stop();
    // Act
    const verified = await l.app.live.stop();
    // Assert
    expect(verified).toBe(true);
    expect(pid).toEqual(expect.any(Number));
    expect(isAlive(pid!)).toBe(false);
    expect(outDir).toBeTruthy();
    expect(fs.existsSync(outDir!)).toBe(false);
    expect(l.app.live.origin.cachedFileCount).toBe(0);
  });
});
