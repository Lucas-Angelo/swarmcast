import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import { isAlive } from '../../src/process/children.js';
import { LoadGuard } from '../../src/quality/load-guard.js';
import { variantInfoHashHex } from '../../src/tracker/tracker.js';
import { hasFfmpeg, joinAs, pushTestStream, tmpDir, waitFor, type Jar } from './helpers.js';

const PORTS = { rtmp: 29450, public: 28180, admin: 28181, mediamtxHls: 28988 };
const BASE = `http://127.0.0.1:${PORTS.public}`;

function mediaSegments(playlist: string): string[] {
  return playlist.split('\n').filter((l) => l && !l.startsWith('#'));
}

describe.skipIf(!hasFfmpeg)('quality ladder: ffmpeg renditions behind one multivariant playlist', () => {
  let app: App;
  let ffmpeg: ChildProcess | null = null;
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

  beforeAll(async () => {
    app = await createApp({
      dataDir: tmpDir(),
      noTunnel: true,
      noReaper: true,
      logToStdout: false,
      configOverrides: {
        ports: PORTS,
        speedTest: { enabled: false, intervalMinutes: 15 },
        // The system ffmpeg; manual ladder with the encoder forced to x264, so the test also runs
        // on machines without a GPU encoder and with fewer than 6 CPU threads (CI runners), where
        // `encoder: 'auto'` keeps only the original quality to protect OBS.
        ffmpegPath: 'ffmpeg',
        quality: {
          ladder: { mode: 'manual', enabled: true, heights: [720, 480], encoder: 'libx264' },
          upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
          obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
        },
      },
    });
    // These tests are about the ladder itself (renditions, crash recovery, reconnects). On a
    // 3-vCPU CI runner, x264 720p + 480p next to the test feed keeps the machine ≥ 90 % busy, so
    // the load guard rightly drops 720p after 10 s and the 720p playlist disappears mid-test.
    // The guard has its own unit tests (quality-decisions.test.ts): never shed here.
    (app.live.quality as unknown as { guard: LoadGuard }).guard = new LoadGuard({ cpuSaturatedPercent: 101, behindSpeed: 0 });
    await app.live.quality.probe();
    await app.live.start();
    ffmpeg = pushTestStream(`rtmp://127.0.0.1:${PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, { size: '1920x1080', kbps: 6000, cbr: true });
    await waitFor(() => app.live.phase === 'live' && app.live.origin.sourceKind === 'ladder' && app.live.quality.transcoder.status === 'running', 60_000, 'ladder to become live', state);
    jar = await joinAs(BASE, app.live.snapshot().liveLink!, 'Ladder');
  });

  afterAll(async () => {
    ffmpeg?.kill('SIGKILL');
    await app?.close();
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
    await waitFor(async () => {
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
    await new Promise((r) => setTimeout(r, 4000));
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
    const before = await (await jar.fetch('/hls/v720.m3u8')).text();
    const seqBefore = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(before)![1]);
    const pid = app.live.quality.transcoder.pid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(async () => {
      const pl = await (await jar.fetch('/hls/v720.m3u8')).text();
      return pl.includes('#EXT-X-DISCONTINUITY') && app.live.quality.transcoder.status === 'running';
    }, 40_000, 'ladder restart', state);
    const after = await (await jar.fetch('/hls/v720.m3u8')).text();
    expect(Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(after)![1])).toBeGreaterThanOrEqual(seqBefore);
    expect((after.match(/#EXT-X-MAP/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(app.live.quality.transcoder.restarts).toBe(1);
  });

  it('OBS reconnecting: same playlist names, sequence keeps growing, a discontinuity marks the restart', async () => {
    await waitFor(ladderRunning, 30_000, 'ladder running before OBS leaves', state);
    const before = await (await jar.fetch('/hls/v480.m3u8')).text();
    const seqBefore = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(before)![1]);
    const lastBefore = mediaSegments(before).pop()!;
    // Every run listed so far (the crash test leaves two in the stitched playlist): "back after
    // the reconnect" means a segment of a run that did not exist before, never an old one.
    const run = (seg: string): string => seg.split('_')[0]!;
    const runsBefore = new Set(mediaSegments(before).map(run));
    const launches = ladder().launches;
    ffmpeg?.kill('SIGKILL');
    await waitFor(() => ladder().status === 'off' && app.live.origin.sourceKind !== 'ladder', 20_000, 'ladder stop after OBS left', state);
    ffmpeg = pushTestStream(`rtmp://127.0.0.1:${PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, { size: '1920x1080', kbps: 6000, cbr: true });
    const oldRun = run(lastBefore);
    await waitFor(async () => {
      if (!(ladder().launches > launches && ladderRunning())) return false;
      const res = await jar.fetch('/hls/v480.m3u8');
      return res.ok && mediaSegments(await res.text()).some((s) => !runsBefore.has(run(s)));
    }, 60_000, 'ladder back after reconnect', state);
    const after = await (await jar.fetch('/hls/v480.m3u8')).text();
    expect(Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(after)![1])).toBeGreaterThanOrEqual(seqBefore);
    // If segments of the previous session are still listed, the restart is marked.
    if (mediaSegments(after).some((s) => s.startsWith(oldRun))) expect(after).toContain('#EXT-X-DISCONTINUITY');
    const multi = await (await jar.fetch('/hls/index.m3u8')).text();
    expect([...multi.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]))).toEqual([1080, 720, 480]);
  });

  it('"Stop everything" also stops ffmpeg and deletes its files', async () => {
    await waitFor(ladderRunning, 30_000, 'ladder running before "Stop everything"', state);
    const pid = ladder().pid;
    const dir = ladder().outDir;
    ffmpeg?.kill('SIGKILL');
    expect(await app.live.stop()).toBe(true);
    if (pid) expect(isAlive(pid)).toBe(false);
    expect(dir).toBeTruthy();
    const fs = await import('node:fs');
    expect(fs.existsSync(dir!)).toBe(false);
    expect(app.live.origin.cachedFileCount).toBe(0);
  });
});
