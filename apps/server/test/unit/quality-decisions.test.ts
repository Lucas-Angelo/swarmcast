import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessPc,
  decideSoftware,
  defaultQualitySettings,
  planLadder,
  shedRung,
  supportedHeights,
  viewersAt,
  type CpuTestResult,
  type EncoderProbeResult,
  type QualitySettings,
  type SourceInfo,
} from '@swarmcast/shared';
import { configSchema, defaultConfig } from '../../src/core/config.js';
import { cpuTestArgs, parseBenchmark, testCpu, type FfmpegRun } from '../../src/quality/encoders.js';
import { installedFfmpegPath, installedPinMatches, pinStamp, resolveFfmpeg } from '../../src/quality/ffmpeg.js';
import { CpuSampler, LoadGuard, SpeedWindow } from '../../src/quality/load-guard.js';
import { buildLadderArgs } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';

const SRC: SourceInfo = { width: 1920, height: 1080, fps: 30, kbps: 6000, hasAudio: true };
const NVENC: EncoderProbeResult = { id: 'h264_nvenc', hardware: true, ok: true, fps: 600, cpuSeconds: 0.12, videoSeconds: 1 };
const QSV_BROKEN: EncoderProbeResult = { id: 'h264_qsv', hardware: true, ok: false, error: 'no device' };
const X264: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 200 };
const OPENH264: EncoderProbeResult = { id: 'libopenh264', hardware: false, ok: true, fps: 150 };

function settings(patch: (s: QualitySettings) => void = () => {}): QualitySettings {
  const s = defaultQualitySettings();
  patch(s);
  return s;
}

/** A CPU test result: `speed` × real time, `cores` CPU seconds per video second (before the content margin). */
function cpuTest(height: 480 | 360, preset: 'veryfast' | 'superfast' | undefined, speed: number, cores: number, ok = true): CpuTestResult {
  return { encoder: 'libx264', height, ...(preset ? { preset } : {}), videoSeconds: 3, realSeconds: 3 / speed, cpuSeconds: 3 * cores, ok };
}

describe('automatic default (what this PC can do)', () => {
  it('ffmpeg installed + a working hardware encoder: on, with 720p/480p/360p preselected', () => {
    const pc = assessPc({ ffmpegAvailable: true, encoders: [QSV_BROKEN, NVENC, X264], cpuCores: 8, cpuTests: null });
    expect(pc.hardware).toBe('h264_nvenc');
    expect(pc.safeHeights).toEqual([720, 480, 360]);
    expect(pc.costCores).toBeCloseTo(0.4, 1);
    expect(pc.costPercent).toBe(5);
    const plan = planLadder({ source: SRC, settings: settings(), encoders: [QSV_BROKEN, NVENC, X264], ffmpegAvailable: true, cpuCores: 8 });
    expect(plan.rungs.map((r) => r.height)).toEqual([1080, 720, 480, 360]);
    expect(plan.encoder).toBe('h264_nvenc');
    expect(plan.reasons[0]!.code).toBe('quality.reason.autoHardware');
    expect(plan.reasons[0]!.text).toContain('NVIDIA NVENC');
  });

  it('ffmpeg missing: off, with the reason', () => {
    const pc = assessPc({ ffmpegAvailable: false, encoders: [], cpuCores: 16, cpuTests: null });
    expect(pc.safeHeights).toEqual([]);
    expect(pc.reason.code).toBe('quality.reason.noFfmpeg');
    const plan = planLadder({ source: SRC, settings: settings(), encoders: [], ffmpegAvailable: false, cpuCores: 16 });
    expect(plan.rungs).toHaveLength(1);
    expect(plan.encoder).toBeNull();
    expect(plan.reasons.map((r) => r.code)).toEqual(['quality.reason.noFfmpeg']);
  });

  it('no hardware encoder: on with one rendition when the CPU test passes, off with a plain reason otherwise', () => {
    const passing = [cpuTest(480, 'veryfast', 3, 0.4)];
    const on = planLadder({ source: SRC, settings: settings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: passing });
    expect(on.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(on.encoder).toBe('libx264');
    expect(on.preset).toBe('veryfast');
    expect(on.reasons[0]!.code).toBe('quality.reason.cpuOk');

    const slow = [cpuTest(480, 'veryfast', 1.1, 1.2), cpuTest(480, 'superfast', 1.3, 0.95), cpuTest(360, 'superfast', 1.4, 0.9)];
    const off = planLadder({ source: SRC, settings: settings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: slow });
    expect(off.rungs).toHaveLength(1);
    expect(off.reasons[0]!.code).toBe('quality.reason.cpuTooSlow');
    // Plain words, and viewers still get the Stable buffer.
    expect(off.reasons[0]!.text).toMatch(/Stable buffer/);

    const few = planLadder({ source: SRC, settings: settings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 4, cpuTests: null });
    expect(few.rungs).toHaveLength(1);
    expect(few.reasons[0]!.code).toBe('quality.reason.cpuFewThreads');
  });

  it('the streamer’s manual choice persists in the config and always wins over the automatic default', () => {
    // She turned it off on a PC with a GPU encoder: saved, reloaded, still off.
    const cfg = defaultConfig();
    cfg.quality.ladder = { ...cfg.quality.ladder, mode: 'manual', enabled: false };
    const reloaded = configSchema.parse(JSON.parse(JSON.stringify(cfg)));
    expect(reloaded.quality.ladder).toMatchObject({ mode: 'manual', enabled: false });
    const off = planLadder({ source: SRC, settings: reloaded.quality, encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    expect(off.rungs).toHaveLength(1);
    expect(off.reasons.map((r) => r.code)).toEqual(['quality.reason.manualOff']);

    // She picked only 480p: kept, even though auto would add 720p and 360p.
    reloaded.quality.ladder = { ...reloaded.quality.ladder, enabled: true, heights: [480] };
    const again = configSchema.parse(JSON.parse(JSON.stringify(reloaded)));
    const only480 = planLadder({ source: SRC, settings: again.quality, encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    expect(only480.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(only480.reasons[0]!.code).toBe('quality.reason.manual');

    // Old configs (allowSoftwareEncoder, no "enabled") still load.
    const legacy = configSchema.parse({ quality: { ladder: { mode: 'auto', heights: [720, 480], encoder: 'auto', allowSoftwareEncoder: false } } });
    expect(legacy.quality.ladder).toEqual({ mode: 'auto', enabled: true, heights: [720, 480], encoder: 'auto' });
  });

  it('manual picks this PC cannot make safely are left out, with the reason', () => {
    const tests = [cpuTest(480, 'veryfast', 3, 0.4)];
    const s = settings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [720, 480];
    });
    const p = planLadder({ source: SRC, settings: s, encoders: [X264], ffmpegAvailable: true, cpuCores: 12, cpuTests: tests });
    expect(p.rungs.map((r) => r.height)).toEqual([1080, 480]);
    expect(p.reasons.map((r) => r.code)).toEqual(['quality.reason.manual', 'quality.reason.manualDropped']);
    const pc = assessPc({ ffmpegAvailable: true, encoders: [X264], cpuCores: 12, cpuTests: tests });
    expect(supportedHeights(pc, 1080)).toEqual([480]);
    expect(supportedHeights(pc, 480)).toEqual([]);
    expect(supportedHeights(assessPc({ ffmpegAvailable: true, encoders: [NVENC], cpuCores: 8, cpuTests: null }), 720)).toEqual([480, 360]);
  });
});

describe('CPU fallback decision', () => {
  it('needs ≥ 6 threads, ≥ 1.5× real time and ≤ 1 core (with the content margin)', () => {
    expect(decideSoftware(4, ['libx264'], [cpuTest(480, 'veryfast', 5, 0.2)]).pick).toBeNull();
    expect(decideSoftware(6, ['libx264'], [cpuTest(480, 'veryfast', 5, 0.2)]).pick).toEqual({ encoder: 'libx264', height: 480, preset: 'veryfast' });
    // 0.8 core × 1.3 = 1.04 > 1 core: too expensive even though it is fast.
    expect(decideSoftware(16, ['libx264'], [cpuTest(480, 'veryfast', 4, 0.8)]).pick).toBeNull();
    // Cheap enough but not fast enough (the PC is busy).
    expect(decideSoftware(16, ['libx264'], [cpuTest(480, 'veryfast', 1.2, 0.3)]).pick).toBeNull();
  });

  it('falls back to superfast, then 360p, and reports the best attempt', () => {
    const d = decideSoftware(8, ['libx264'], [cpuTest(480, 'veryfast', 1.2, 1.1), cpuTest(480, 'superfast', 1.4, 0.85), cpuTest(360, 'superfast', 2.2, 0.5)]);
    expect(d.pick).toEqual({ encoder: 'libx264', height: 360, preset: 'superfast' });
    expect(d.coresNeeded).toBeCloseTo(0.7, 1);
    const none = decideSoftware(8, ['libx264'], [cpuTest(480, 'veryfast', 1, 2), cpuTest(360, 'superfast', 1.2, 1.5)]);
    expect(none.pick).toBeNull();
    expect(none.reason.code).toBe('quality.reason.cpuTooSlow');
    expect(none.reason.params).toMatchObject({ cores: 2, budget: 1 });
    expect(decideSoftware(8, [], null).reason.code).toBe('quality.reason.cpuNoEncoder');
    expect(decideSoftware(8, ['libx264'], [cpuTest(480, 'veryfast', 3, 0.2, false)]).reason.code).toBe('quality.reason.cpuTestFailed');
  });

  it('runs the test plan with one thread at the configured preset and stops at the first pass', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<FfmpegRun> => {
      calls.push(args);
      const preset = args[args.indexOf('-preset') + 1];
      // veryfast is too slow on this PC; superfast fits.
      return preset === 'veryfast' ? { code: 0, ms: 2500, stderr: '', cpuSeconds: 3.3, realSeconds: 2.5 } : { code: 0, ms: 1000, stderr: '', cpuSeconds: 1.8, realSeconds: 1 };
    };
    const tests = await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads: 8, run }, [X264]);
    expect(tests).toHaveLength(2);
    expect(calls[0]!.join(' ')).toContain('threads=1:lookahead-threads=1');
    expect(calls[0]!.join(' ')).toContain('scale=-2:480');
    expect(calls[1]![calls[1]!.indexOf('-preset') + 1]).toBe('superfast');
    expect(decideSoftware(8, ['libx264'], tests).pick).toEqual({ encoder: 'libx264', height: 480, preset: 'superfast' });
    // Not run with a hardware encoder, too few threads, or without a software encoder.
    expect(await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads: 8, run }, [NVENC, X264])).toBeNull();
    expect(await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads: 4, run }, [X264])).toBeNull();
    expect(await testCpu({ ffmpeg: 'ffmpeg', reaper: null, log: silentLog, cpuThreads: 8, run }, [QSV_BROKEN])).toBeNull();
  });

  it('works with OpenH264 (the Windows/Linux LGPL builds have no x264)', () => {
    expect(cpuTestArgs('libopenh264', 360).join(' ')).toContain('-c libopenh264');
    const pc = assessPc({ ffmpegAvailable: true, encoders: [OPENH264], cpuCores: 8, cpuTests: [{ encoder: 'libopenh264', height: 480, videoSeconds: 3, realSeconds: 1, cpuSeconds: 1, ok: true }] });
    expect(pc.encoder).toBe('libopenh264');
    expect(pc.safeHeights).toEqual([480]);
  });

  it('parses ffmpeg -benchmark output', () => {
    expect(parseBenchmark('[info] bench: utime=0.229s stime=0.004s rtime=0.112s')).toEqual({ cpuSeconds: 0.233, realSeconds: 0.112 });
    expect(parseBenchmark('frame=30')).toBeNull();
  });

  it('the CPU rendition is encoded with its preset and one thread', () => {
    const plan = planLadder({ source: SRC, settings: settings(), encoders: [X264], ffmpegAvailable: true, cpuCores: 8, cpuTests: [cpuTest(480, 'superfast', 2, 0.5)] });
    const a = buildLadderArgs({ inputUrl: 'rtmp://x', outDir: '/tmp/x', runId: 'r', rungs: plan.rungs, encoder: plan.encoder!, preset: plan.preset, hasAudio: true }).join(' ');
    expect(a).toContain('-preset:v:1 superfast');
    expect(a).toContain('threads=1');
  });
});

describe('runtime CPU protection', () => {
  it('drops the most expensive rendition first and never the source', () => {
    const plan = planLadder({ source: SRC, settings: settings(), encoders: [NVENC], ffmpegAvailable: true, cpuCores: 8 });
    let r = shedRung(plan.rungs);
    expect(r.dropped?.height).toBe(720);
    r = shedRung(r.rungs);
    expect(r.dropped?.height).toBe(480);
    r = shedRung(r.rungs);
    expect(r.dropped?.height).toBe(360);
    expect(r.rungs.map((x) => x.height)).toEqual([1080]);
    expect(shedRung(r.rungs).dropped).toBeNull();
  });

  it('measures speed over a sliding window from out_time_us', () => {
    const w = new SpeedWindow(10_000);
    for (let t = 0; t <= 12_000; t += 1000) w.add(t, t * 1000 * 0.9);
    expect(w.speed).toBeCloseTo(0.9, 2);
    expect(w.spanMs).toBeLessThanOrEqual(11_000);
    w.add(13_000, 0); // ffmpeg restarted: its clock starts at 0 again
    expect(w.speed).toBeUndefined();
  });

  it('sheds when the converter falls behind (speed < 1.0×) for 10 s, then waits 30 s before another drop', () => {
    const g = new LoadGuard();
    const behind = { speed: 0.9, speedSpanMs: 10_000, cpuBusyPercent: 40 };
    expect(g.check(0, behind)).toBeNull();
    expect(g.check(9_000, behind)).toBeNull();
    expect(g.check(10_000, behind)).toBe('behind');
    g.shed(10_000);
    expect(g.check(20_000, behind)).toBeNull();
    expect(g.check(39_000, behind)).toBeNull();
    expect(g.check(41_000, behind)).toBe('behind');
    // Keeping up (0.99) or a window still warming up never counts.
    const ok = new LoadGuard();
    expect(ok.check(0, { speed: 0.99, speedSpanMs: 10_000 })).toBeNull();
    expect(ok.check(20_000, { speed: 0.99, speedSpanMs: 10_000 })).toBeNull();
    expect(ok.check(0, { speed: 0.5, speedSpanMs: 3_000 })).toBeNull();
    expect(ok.check(20_000, { speed: 0.5, speedSpanMs: 3_000 })).toBeNull();
  });

  it('sheds when the whole machine stays saturated (OBS would drop frames); a short spike is fine', () => {
    const g = new LoadGuard();
    expect(g.check(0, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent: 97 })).toBeNull();
    expect(g.check(4_000, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent: 60 })).toBeNull(); // spike over
    expect(g.check(6_000, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent: 95 })).toBeNull();
    expect(g.check(14_000, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent: 93 })).toBeNull();
    expect(g.check(16_000, { speed: 1, speedSpanMs: 10_000, cpuBusyPercent: 91 })).toBe('cpu');
  });

  it('samples whole-machine CPU from os.cpus() deltas', () => {
    let busy = 0;
    let idle = 0;
    const cpus = () => [{ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }];
    const s = new CpuSampler(cpus);
    expect(s.sample()).toBeUndefined();
    busy += 900;
    idle += 100;
    expect(s.sample()).toBe(90);
  });
});

describe('upload budget per rendition', () => {
  it('viewers the cap can serve at a bitrate (with audio and overhead)', () => {
    expect(viewersAt(10, 6000 - 128)).toBe(1);
    expect(viewersAt(10, 1400)).toBe(5);
    expect(viewersAt(10, 800)).toBe(9);
    expect(viewersAt(0, 800)).toBe(0);
  });
});

describe('ffmpeg location', () => {
  it('finds <data>/tools/ffmpeg (start scripts, panel); SWARMCAST_FFMPEG and the config win', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ff-'));
    try {
      const o = { binDir: path.join(data, 'nobin'), dataDir: data, env: {} };
      expect(resolveFfmpeg(o)).toBeNull();
      const bin = installedFfmpegPath(data);
      expect(bin).toBe(path.join(data, 'tools', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '');
      expect(resolveFfmpeg(o)).toBe(bin);
      expect(resolveFfmpeg({ ...o, configPath: 'ffmpeg' })).toBe('ffmpeg');
      expect(resolveFfmpeg({ ...o, configPath: 'ffmpeg', env: { SWARMCAST_FFMPEG: bin } })).toBe(bin);
      expect(resolveFfmpeg({ ...o, configPath: path.join(data, 'missing') })).toBeNull();
      const pin = { url: 'https://example.invalid/f.zip', asset: 'f.zip', sha256: 'a'.repeat(64), binary: 'ffmpeg', license: 'LGPL' };
      expect(installedPinMatches(data, pin)).toBe(false);
      fs.writeFileSync(path.join(data, 'tools', 'ffmpeg', 'PIN'), `${pinStamp(pin)}\n`);
      expect(installedPinMatches(data, pin)).toBe(true);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});
