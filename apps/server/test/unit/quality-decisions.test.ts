import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessPc, decideSoftware, planLadder, shedRung, supportedHeights, viewersAt, type CpuTestResult, type EncoderProbeResult } from '@swarmcast/shared';
import { configSchema, defaultConfig } from '../../src/core/config.js';
import { cpuTestArgs, parseBenchmark, testCpu, type FfmpegRun } from '../../src/quality/encoders.js';
import { installedFfmpegPath, installedPinMatches, pinStamp, resolveFfmpeg } from '../../src/quality/ffmpeg.js';
import { CpuSampler, LoadGuard, SpeedWindow } from '../../src/quality/load-guard.js';
import { buildLadderArgs } from '../../src/quality/transcoder.js';
import { silentLog, tempDir } from './helpers.js';
import { SOURCE_1080P, qualitySettings } from './helpers-b.js';

// What the quality ladder decides on its own, and what it keeps of the streamer's choices:
// - Automatic default: with a working hardware encoder, 720p/480p/360p; without one, a single
//   CPU rendition when the CPU test shows this PC can afford it (at least 6 threads, at least
//   1.5× real time, at most 1 core including a 1.3× content margin), trying veryfast, then
//   superfast, then 360p. The reasons are in plain words (viewers still get the Stable buffer).
// - Her manual choice is saved in the config and always wins; picks this PC cannot make safely
//   are left out with a reason. Old configs (allowSoftwareEncoder, no "enabled") still load.
// - At runtime the load guard drops the most expensive rendition (never the source) when the
//   converter falls behind (speed < 1.0× for 10 s) or the whole machine stays saturated (OBS would
//   drop frames), then waits 30 s before another drop. A short CPU spike is fine.
// - ffmpeg is found in <data>/tools/ffmpeg (start scripts, panel); SWARMCAST_FFMPEG and the
//   config's path win over it.

const NVENC: EncoderProbeResult = { id: 'h264_nvenc', hardware: true, ok: true, fps: 600, cpuSeconds: 0.12, videoSeconds: 1 };
const QSV_BROKEN: EncoderProbeResult = { id: 'h264_qsv', hardware: true, ok: false, error: 'no device' };
const X264: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 200 };
const OPENH264: EncoderProbeResult = { id: 'libopenh264', hardware: false, ok: true, fps: 150 };

/** A CPU test result: `speed` × real time, `cores` CPU seconds per video second (before the content margin). */
function cpuTest(height: 480 | 360, preset: 'veryfast' | 'superfast' | undefined, speed: number, cores: number, ok = true): CpuTestResult {
  return { encoder: 'libx264', height, ...(preset ? { preset } : {}), videoSeconds: 3, realSeconds: 3 / speed, cpuSeconds: 3 * cores, ok };
}

/** A CPU test result that passes: 3× real time at 0.4 core. */
const PASSING = [cpuTest(480, 'veryfast', 3, 0.4)];

/** ffmpeg on a PC where the veryfast test is too slow and superfast fits; every call is kept in `calls`. */
function ffmpegWhereSuperfastFits(): { run: (args: string[]) => Promise<FfmpegRun>; calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<FfmpegRun> => {
    calls.push(args);
    const preset = args[args.indexOf('-preset') + 1];
    return preset === 'veryfast' ? { code: 0, ms: 2500, stderr: '', cpuSeconds: 3.3, realSeconds: 2.5 } : { code: 0, ms: 1000, stderr: '', cpuSeconds: 1.8, realSeconds: 1 };
  };
  return { run, calls };
}

describe('automatic default (what this PC can do)', () => {
  it('ffmpeg installed + a working hardware encoder: this PC can make 720p/480p/360p cheaply', () => {
    // Act
    const pc = assessPc({ ffmpegAvailable: true, encoders: [QSV_BROKEN, NVENC, X264], cpuCores: 8, cpuTests: null });
    // Assert
    expect(pc.hardware).toBe('h264_nvenc');
    expect(pc.safeHeights).toEqual([720, 480, 360]);
    expect(pc.costCores).toBeCloseTo(0.4, 1);
    expect(pc.costPercent).toBe(5);
  });

  it('ffmpeg installed + a working hardware encoder: on, with 720p/480p/360p preselected', () => {
    // Act
    const plan = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [QSV_BROKEN, NVENC, X264], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(plan.rungs.map((r) => r.height)).toEqual([1080, 720, 480, 360]);
    expect(plan.encoder).toBe('h264_nvenc');
    expect(plan.reasons[0]!.code).toBe('quality.reason.autoHardware');
    expect(plan.reasons[0]!.text).toContain('NVIDIA NVENC');
  });

  it('ffmpeg missing: this PC can make nothing, and says why', () => {
    // Act
    const pc = assessPc({ ffmpegAvailable: false, encoders: [], cpuCores: 16, cpuTests: null });
    // Assert
    expect(pc.safeHeights).toEqual([]);
    expect(pc.reason.code).toBe('quality.reason.noFfmpeg');
  });

  it('ffmpeg missing: off, with the reason', () => {
    // Act
    const plan = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [], ffmpegAvailable: false, cpuCores: 16 });
    // Assert
    expect(plan.rungs).toHaveLength(1);
    expect(plan.encoder).toBeNull();
    expect(plan.reasons.map((r) => r.code)).toEqual(['quality.reason.noFfmpeg']);
  });

  it('no hardware encoder: on with one CPU rendition when the CPU test passes', () => {
    // Act
    const on = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: PASSING });
    // Assert
    expect(on.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(on.encoder).toBe('libx264');
    expect(on.preset).toBe('veryfast');
    expect(on.reasons[0]!.code).toBe('quality.reason.cpuOk');
  });

  it('no hardware encoder and a CPU too slow for it: off, in plain words (viewers still get the Stable buffer)', () => {
    // Arrange
    const slow = [cpuTest(480, 'veryfast', 1.1, 1.2), cpuTest(480, 'superfast', 1.3, 0.95), cpuTest(360, 'superfast', 1.4, 0.9)];
    // Act
    const off = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: slow });
    // Assert
    expect(off.rungs).toHaveLength(1);
    expect(off.reasons[0]!.code).toBe('quality.reason.cpuTooSlow');
    expect(off.reasons[0]!.text).toMatch(/Stable buffer/);
  });

  it('no hardware encoder and too few CPU threads: off, with the reason', () => {
    // Act
    const few = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 4, cpuTests: null });
    // Assert
    expect(few.rungs).toHaveLength(1);
    expect(few.reasons[0]!.code).toBe('quality.reason.cpuFewThreads');
  });

  it('her "off" on a PC with a GPU encoder is saved, reloaded and still off', () => {
    // Arrange
    const cfg = defaultConfig();
    cfg.quality.ladder = { ...cfg.quality.ladder, mode: 'manual', enabled: false };
    // Act
    const reloaded = configSchema.parse(JSON.parse(JSON.stringify(cfg)));
    const plan = planLadder({ source: SOURCE_1080P, settings: reloaded.quality, encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(reloaded.quality.ladder).toMatchObject({ mode: 'manual', enabled: false });
    expect(plan.rungs).toHaveLength(1);
    expect(plan.reasons.map((r) => r.code)).toEqual(['quality.reason.manualOff']);
  });

  it('her pick of only 480p is kept after a reload, although auto would add 720p and 360p', () => {
    // Arrange
    const cfg = defaultConfig();
    cfg.quality.ladder = { ...cfg.quality.ladder, mode: 'manual', enabled: true, heights: [480] };
    // Act
    const reloaded = configSchema.parse(JSON.parse(JSON.stringify(cfg)));
    const plan = planLadder({ source: SOURCE_1080P, settings: reloaded.quality, encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(plan.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(plan.reasons[0]!.code).toBe('quality.reason.manual');
  });

  it('old configs (allowSoftwareEncoder, no "enabled") still load', () => {
    // Act
    const legacy = configSchema.parse({ quality: { ladder: { mode: 'auto', heights: [720, 480], encoder: 'auto', allowSoftwareEncoder: false } } });
    // Assert
    expect(legacy.quality.ladder).toEqual({ mode: 'auto', enabled: true, heights: [720, 480], encoder: 'auto' });
  });

  it('manual picks this PC cannot make safely are left out, with the reason', () => {
    // Arrange
    const s = qualitySettings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [720, 480];
    });
    // Act
    const p = planLadder({ source: SOURCE_1080P, settings: s, encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: PASSING });
    // Assert
    expect(p.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(p.reasons.map((r) => r.code)).toEqual(['quality.reason.manual', 'quality.reason.manualDropped']);
  });

  it.each([
    ['a CPU rendition, 1080p source', [X264], 12, PASSING, 1080, [480]],
    ['a CPU rendition, 480p source', [X264], 12, PASSING, 480, []],
    ['a hardware encoder, 720p source', [NVENC], 8, null, 720, [480, 360]],
  ])('the heights she may pick follow what this PC makes safely: %s', (_what, encoders, cpuCores, cpuTests, sourceHeight, heights) => {
    // Arrange
    const pc = assessPc({ ffmpegAvailable: true, encoders, cpuCores, cpuTests });
    // Act
    const supported = supportedHeights(pc, sourceHeight);
    // Assert
    expect(supported).toEqual(heights);
  });
});

describe('CPU fallback decision', () => {
  it.each([
    ['4 threads are too few', 4, cpuTest(480, 'veryfast', 5, 0.2), null],
    ['6 threads, fast and cheap: picked', 6, cpuTest(480, 'veryfast', 5, 0.2), { encoder: 'libx264', height: 480, preset: 'veryfast' }],
    ['0.8 core × 1.3 = 1.04 cores is too expensive, even though it is fast', 16, cpuTest(480, 'veryfast', 4, 0.8), null],
    ['cheap enough but not fast enough (the PC is busy)', 16, cpuTest(480, 'veryfast', 1.2, 0.3), null],
  ])('needs ≥ 6 threads, ≥ 1.5× real time and ≤ 1 core (with the content margin): %s', (_what, threads, test, pick) => {
    // Act
    const d = decideSoftware(threads, ['libx264'], [test]);
    // Assert
    expect(d.pick).toEqual(pick);
  });

  it('falls back to superfast, then 360p', () => {
    // Act
    const d = decideSoftware(8, ['libx264'], [cpuTest(480, 'veryfast', 1.2, 1.1), cpuTest(480, 'superfast', 1.4, 0.85), cpuTest(360, 'superfast', 2.2, 0.5)]);
    // Assert
    expect(d.pick).toEqual({ encoder: 'libx264', height: 360, preset: 'superfast' });
    expect(d.coresNeeded).toBeCloseTo(0.7, 1);
  });

  it('reports the best attempt when none fits', () => {
    // Act
    const none = decideSoftware(8, ['libx264'], [cpuTest(480, 'veryfast', 1, 2), cpuTest(360, 'superfast', 1.2, 1.5)]);
    // Assert
    expect(none.pick).toBeNull();
    expect(none.reason.code).toBe('quality.reason.cpuTooSlow');
    expect(none.reason.params).toMatchObject({ cores: 2, budget: 1 });
  });

  it.each([
    ['no software encoder', [], null, 'quality.reason.cpuNoEncoder'],
    ['a CPU test that failed', ['libx264'], [cpuTest(480, 'veryfast', 3, 0.2, false)], 'quality.reason.cpuTestFailed'],
  ] as const)('says why with %s', (_what, encoders, tests, code) => {
    // Act
    const d = decideSoftware(8, [...encoders], tests ? [...tests] : null);
    // Assert
    expect(d.reason.code).toBe(code);
  });

  it('runs the test plan with one thread at the configured preset and stops at the first pass', async () => {
    // Arrange
    const ffmpeg = ffmpegWhereSuperfastFits();
    // Act
    const tests = await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads: 8, run: ffmpeg.run }, [X264]);
    // Assert
    expect(tests).toHaveLength(2);
    expect(ffmpeg.calls[0]!.join(' ')).toContain('threads=1:lookahead-threads=1');
    expect(ffmpeg.calls[0]!.join(' ')).toContain('scale=-2:480');
    expect(ffmpeg.calls[1]![ffmpeg.calls[1]!.indexOf('-preset') + 1]).toBe('superfast');
    expect(decideSoftware(8, ['libx264'], tests).pick).toEqual({ encoder: 'libx264', height: 480, preset: 'superfast' });
  });

  it.each([
    ['with a working hardware encoder', 8, [NVENC, X264]],
    ['with too few threads', 4, [X264]],
    ['without a software encoder', 8, [QSV_BROKEN]],
  ])('does not run the CPU test %s', async (_what, cpuThreads, encoders) => {
    // Arrange
    const ffmpeg = ffmpegWhereSuperfastFits();
    // Act
    const tests = await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads, run: ffmpeg.run }, encoders);
    // Assert
    expect(tests).toBeNull();
    expect(ffmpeg.calls).toEqual([]);
  });

  it('tests OpenH264 (the Windows/Linux LGPL builds have no x264)', () => {
    // Act
    const args = cpuTestArgs('libopenh264', 360);
    // Assert
    expect(args.join(' ')).toContain('-c libopenh264');
  });

  it('uses OpenH264 when its CPU test passes', () => {
    // Act
    const pc = assessPc({ ffmpegAvailable: true, encoders: [OPENH264], cpuCores: 8, cpuTests: [{ encoder: 'libopenh264', height: 480, videoSeconds: 3, realSeconds: 1, cpuSeconds: 1, ok: true }] });
    // Assert
    expect(pc.encoder).toBe('libopenh264');
    expect(pc.safeHeights).toEqual([480]);
  });

  it.each([
    ['[info] bench: utime=0.229s stime=0.004s rtime=0.112s', { cpuSeconds: 0.233, realSeconds: 0.112 }],
    ['frame=30', null],
  ])('parses ffmpeg -benchmark output: %s', (line, expected) => {
    // Act
    const r = parseBenchmark(line);
    // Assert
    expect(r).toEqual(expected);
  });

  it('the CPU rendition is encoded with its preset and one thread', () => {
    // Arrange
    const plan = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 8, cpuTests: [cpuTest(480, 'superfast', 2, 0.5)] });
    // Act
    const a = buildLadderArgs({ inputUrl: 'rtmp://x', outDir: '/tmp/x', runId: 'r', rungs: plan.rungs, encoder: plan.encoder!, preset: plan.preset, hasAudio: true }).join(' ');
    // Assert
    expect(a).toContain('-preset:v:1 superfast');
    expect(a).toContain('threads=1');
  });
});

describe('runtime CPU protection', () => {
  it('drops the most expensive rendition first and never the source', () => {
    // Arrange
    let { rungs } = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    const dropped: Array<number | null> = [];
    // Act
    for (let i = 0; i < 4; i++) {
      const r = shedRung(rungs);
      dropped.push(r.dropped === null ? null : r.dropped.height);
      rungs = r.rungs;
    }
    // Assert
    expect(dropped).toEqual([720, 480, 360, null]);
    expect(rungs.map((x) => x.height)).toEqual([1080]);
  });

  it('measures speed over a sliding window from out_time_us', () => {
    // Arrange
    const w = new SpeedWindow(10_000);
    // Act
    for (let t = 0; t <= 12_000; t += 1000) w.add(t, t * 1000 * 0.9);
    // Assert
    expect(w.speed).toBeCloseTo(0.9, 2);
    expect(w.spanMs).toBeLessThanOrEqual(11_000);
  });

  it('starts the speed over when ffmpeg restarts (its clock starts at 0 again)', () => {
    // Arrange
    const w = new SpeedWindow(10_000);
    for (let t = 0; t <= 12_000; t += 1000) w.add(t, t * 1000 * 0.9);
    // Act
    w.add(13_000, 0);
    // Assert
    expect(w.speed).toBeUndefined();
  });

  it('sheds when the converter falls behind (speed < 1.0×) for 10 s', () => {
    // Arrange
    const g = new LoadGuard();
    const behind = { speed: 0.9, speedSpanMs: 10_000, cpuBusyPercent: 40 };
    // Act
    const verdicts = [0, 9_000, 10_000].map((t) => g.check(t, behind));
    // Assert
    expect(verdicts).toEqual([null, null, 'behind']);
  });

  it('waits 30 s after a drop before another', () => {
    // Arrange
    const g = new LoadGuard();
    const behind = { speed: 0.9, speedSpanMs: 10_000, cpuBusyPercent: 40 };
    for (const t of [0, 9_000, 10_000]) g.check(t, behind);
    g.shed(10_000);
    // Act
    const verdicts = [20_000, 39_000, 41_000].map((t) => g.check(t, behind));
    // Assert
    expect(verdicts).toEqual([null, null, 'behind']);
  });

  it.each([
    ['keeping up (0.99×)', { speed: 0.99, speedSpanMs: 10_000 }],
    ['a window still warming up', { speed: 0.5, speedSpanMs: 3_000 }],
  ])('never sheds for %s', (_what, sample) => {
    // Arrange
    const g = new LoadGuard();
    // Act
    const verdicts = [0, 20_000].map((t) => g.check(t, sample));
    // Assert
    expect(verdicts).toEqual([null, null]);
  });

  it('sheds when the whole machine stays saturated (OBS would drop frames); a short spike is fine', () => {
    // Arrange
    const g = new LoadGuard();
    const busy = [
      [0, 97],
      [4_000, 60],
      [6_000, 95],
      [14_000, 93],
      [16_000, 91],
    ] as const;
    // Act
    const verdicts = busy.map(([t, cpuBusyPercent]) => g.check(t, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent }));
    // Assert
    expect(verdicts).toEqual([null, null, null, null, 'cpu']);
  });

  it('samples whole-machine CPU from os.cpus() deltas', () => {
    // Arrange
    let busy = 0;
    let idle = 0;
    const cpus = () => [{ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }];
    const s = new CpuSampler(cpus);
    const first = s.sample();
    busy += 900;
    idle += 100;
    // Act
    const second = s.sample();
    // Assert
    expect(first).toBeUndefined();
    expect(second).toBe(90);
  });
});

describe('upload budget per rendition', () => {
  it.each([
    [10, 6000 - 128, 1],
    [10, 1400, 5],
    [10, 800, 9],
    [0, 800, 0],
  ])('a %i Mbps cap serves %i kbps to %i viewer(s) (with audio and overhead)', (capMbps, kbps, viewers) => {
    // Act
    const n = viewersAt(capMbps, kbps);
    // Assert
    expect(n).toBe(viewers);
  });
});

describe('ffmpeg location', () => {
  /** A data folder, with ffmpeg installed in <data>/tools/ffmpeg when `installed`. */
  function dataDir(installed: boolean): { data: string; o: { binDir: string; dataDir: string; env: NodeJS.ProcessEnv }; bin: string } {
    const data = tempDir('sc-ff-');
    const bin = installedFfmpegPath(data);
    if (installed) {
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '');
    }
    return { data, o: { binDir: path.join(data, 'nobin'), dataDir: data, env: {} }, bin };
  }

  /** The pinned build as ffmpeg.ts describes it (only its sha256 goes into the PIN stamp). */
  const PIN = { url: 'https://example.invalid/f.zip', asset: 'f.zip', sha256: 'a'.repeat(64), binary: 'ffmpeg', license: 'LGPL' };

  it('is <data>/tools/ffmpeg/ffmpeg[.exe] when installed by the start scripts or the panel', () => {
    // Arrange
    const { data } = dataDir(false);
    // Act
    const bin = installedFfmpegPath(data);
    // Assert
    expect(bin).toBe(path.join(data, 'tools', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  });

  it('none is found before it is installed', () => {
    // Arrange
    const { o } = dataDir(false);
    // Act
    const found = resolveFfmpeg(o);
    // Assert
    expect(found).toBeNull();
  });

  it('the installed one is found', () => {
    // Arrange
    const { o, bin } = dataDir(true);
    // Act
    const found = resolveFfmpeg(o);
    // Assert
    expect(found).toBe(bin);
  });

  it('the config path wins over the installed one', () => {
    // Arrange
    const { o } = dataDir(true);
    // Act
    const found = resolveFfmpeg({ ...o, configPath: 'ffmpeg' });
    // Assert
    expect(found).toBe('ffmpeg');
  });

  it('SWARMCAST_FFMPEG wins over the config path', () => {
    // Arrange
    const { o, bin } = dataDir(true);
    // Act
    const found = resolveFfmpeg({ ...o, configPath: 'ffmpeg', env: { SWARMCAST_FFMPEG: bin } });
    // Assert
    expect(found).toBe(bin);
  });

  it('a configured path that does not exist gives none', () => {
    // Arrange
    const { data, o } = dataDir(true);
    // Act
    const found = resolveFfmpeg({ ...o, configPath: path.join(data, 'missing') });
    // Assert
    expect(found).toBeNull();
  });

  it('the installed build matches the pin only once its PIN stamp says so', () => {
    // Arrange
    const { data } = dataDir(true);
    const before = installedPinMatches(data, PIN);
    // Act
    fs.writeFileSync(path.join(data, 'tools', 'ffmpeg', 'PIN'), `${pinStamp(PIN)}\n`);
    // Assert
    expect(before).toBe(false);
    expect(installedPinMatches(data, PIN)).toBe(true);
  });
});
