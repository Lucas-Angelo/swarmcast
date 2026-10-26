import os from 'node:os';
import {
  CPU_TEST_PLAN,
  HARDWARE_ENCODERS,
  SOFTWARE_MIN_THREADS,
  decideSoftware,
  softwareEncodersIn,
  type CpuTestResult,
  type EncoderId,
  type EncoderProbeResult,
  type SoftwareEncoderId,
  type X264Preset,
} from '@swarmcast/shared';
import type { Logger } from '../core/logger.js';
import { ManagedChild, type Reaper } from '../process/children.js';

/** Encoders worth trying on each OS, best first. */
export function candidateEncoders(platform: NodeJS.Platform = process.platform): EncoderId[] {
  switch (platform) {
    case 'darwin':
      return ['h264_videotoolbox', 'libx264', 'libopenh264'];
    case 'win32':
      return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'libopenh264'];
    default:
      return ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264', 'libopenh264'];
  }
}

/** Arguments that must come before `-i` (device setup). */
export function encoderInputArgs(id: EncoderId): string[] {
  if (id === 'h264_vaapi') return ['-vaapi_device', '/dev/dri/renderD128'];
  return [];
}

/**
 * Filter chain tail and encoder options for one output video stream. `spec` is the output
 * stream specifier (e.g. "v:1"), empty for a single-output command.
 * All encoders get CBR-like rate control (live), no B-frame pyramids that confuse old
 * decoders, and keyframes where the source has them so every rendition cuts segments at the
 * same instants as the pass-through copy. Software encoders get one thread by default: the
 * CPU fallback is budgeted at one core (docs/QUALITY.md).
 */
export function encoderArgs(
  id: EncoderId,
  spec: string,
  o: { kbps: number; height: number; fps: number; threads?: number; preset?: X264Preset },
): { filter: string; args: string[] } {
  const s = spec ? `:${spec}` : '';
  const scale = `scale=-2:${o.height}:flags=bicubic`;
  const gop = String(Math.max(2, Math.round(o.fps * 2)));
  const rate = [`-b${s}`, `${o.kbps}k`, `-maxrate${s}`, `${Math.round(o.kbps * 1.1)}k`, `-bufsize${s}`, `${o.kbps}k`];
  const common = [`-g${s}`, gop, `-force_key_frames${s}`, 'source'];
  switch (id) {
    case 'h264_videotoolbox':
      // allow_sw 0: fail the probe instead of silently using Apple's software encoder.
      return { filter: `${scale},format=nv12`, args: [`-c${s}`, id, ...rate, ...common, `-realtime${s}`, '1', `-allow_sw${s}`, '0', `-profile${s}`, 'high'] };
    case 'h264_nvenc':
      return { filter: `${scale},format=nv12`, args: [`-c${s}`, id, ...rate, ...common, `-preset${s}`, 'p4', `-tune${s}`, 'll', `-rc${s}`, 'cbr', `-forced-idr${s}`, '1', `-bf${s}`, '0'] };
    case 'h264_qsv':
      return { filter: `${scale},format=nv12`, args: [`-c${s}`, id, ...rate, ...common, `-preset${s}`, 'veryfast', `-forced_idr${s}`, '1', `-bf${s}`, '0'] };
    case 'h264_amf':
      return { filter: `${scale},format=nv12`, args: [`-c${s}`, id, ...rate, ...common, `-usage${s}`, 'lowlatency', `-rc${s}`, 'cbr', `-bf${s}`, '0'] };
    case 'h264_vaapi':
      return { filter: `${scale},format=nv12,hwupload`, args: [`-c${s}`, id, ...rate, ...common, `-bf${s}`, '0'] };
    case 'libopenh264':
      // rc_mode defaults to "quality", which ignores the bitrate (a 480p rendition came out at
      // ~2.5 Mbps on Windows); "bitrate" makes it honor -b.
      return { filter: `${scale},format=yuv420p`, args: [`-c${s}`, id, ...rate, ...common, `-rc_mode${s}`, 'bitrate', `-allow_skip_frames${s}`, '1', `-threads${s}`, String(o.threads ?? 1)] };
    case 'libx264':
    default:
      return {
        filter: `${scale},format=yuv420p`,
        args: [
          `-c${s}`, 'libx264', ...rate, ...common,
          `-preset${s}`, o.preset ?? 'veryfast', `-tune${s}`, 'zerolatency',
          `-x264-params${s}`, `threads=${o.threads ?? 1}:lookahead-threads=1:sliced-threads=0`,
        ],
      };
  }
}

export interface FfmpegRun {
  code: number | null;
  /** Wall-clock milliseconds. */
  ms: number;
  /** First error line (or the last lines when none is marked as an error). */
  stderr: string;
  /** From `-benchmark`: user + system CPU seconds and real seconds, when printed. */
  cpuSeconds?: number;
  realSeconds?: number;
}

export interface ProbeOptions {
  ffmpeg: string;
  reaper: Reaper | null;
  log: Logger;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Hardware threads (defaults to this machine's). */
  cpuThreads?: number;
  /** Override for tests. */
  run?: (args: string[], timeoutMs: number) => Promise<FfmpegRun>;
}

/** Parse `bench: utime=0.229s stime=0.004s rtime=0.112s` (ffmpeg -benchmark). */
export function parseBenchmark(line: string): { cpuSeconds: number; realSeconds: number } | null {
  const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(line);
  if (!m) return null;
  return { cpuSeconds: Number(m[1]) + Number(m[2]), realSeconds: Number(m[3]) };
}

function runFfmpeg(o: ProbeOptions, args: string[], timeoutMs: number, lowPriority = false): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = new ManagedChild('ffmpeg-probe', o.ffmpeg, args, {}, o.reaper, o.log);
    if (lowPriority && child.pid) {
      try {
        // Measured the way the ladder runs: OBS keeps priority.
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* best effort */
      }
    }
    const errors: string[] = [];
    const tail: string[] = [];
    let bench: { cpuSeconds: number; realSeconds: number } | null = null;
    child.on('line', (line, stream) => {
      if (stream !== 'stderr') return;
      bench = parseBenchmark(line) ?? bench;
      const text = line.replace(/^\[\w+\]\s*/, '');
      // -loglevel level+info prefixes every line with its level.
      if (/^\[(error|fatal|panic)\]/.test(line) && errors.length < 5) errors.push(text);
      tail.push(text);
      if (tail.length > 5) tail.shift();
    });
    const timer = setTimeout(() => void child.stop(500), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: performance.now() - t0, stderr: (errors.length ? errors : tail).join('\n'), ...(bench ?? {}) });
    });
  });
}

/** List of encoders compiled into this ffmpeg (`ffmpeg -encoders`). */
export async function listEncoders(o: ProbeOptions): Promise<Set<string>> {
  const names = new Set<string>();
  await new Promise<void>((resolve) => {
    const child = new ManagedChild('ffmpeg-encoders', o.ffmpeg, ['-hide_banner', '-encoders'], {}, o.reaper, o.log);
    child.on('line', (line) => {
      const m = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
      if (m) names.add(m[1]!);
    });
    const timer = setTimeout(() => void child.stop(500), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return names;
}

const TEST_INPUT = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'];
const PROBE_FRAMES = 30;
/** CPU test length: 3 s of video, long enough to average out start-up costs. */
const CPU_TEST_FRAMES = 90;

function firstLine(r: FfmpegRun): string {
  return (r.stderr.split('\n').find((l) => l.trim()) ?? `exit code ${r.code}`).slice(0, 200);
}

/**
 * Try each candidate encoder with a 1-second 720p30 test encode (30 frames, discarded).
 * A hardware encoder that is compiled in but has no device (no NVIDIA GPU, no driver)
 * fails here and is reported as not working. The frame rate tells how cheap it is, and
 * `-benchmark` how much CPU it used (pattern generation as a stand-in for decoding, scaling,
 * driver work), which gives the cost estimate in the panel.
 */
export async function probeEncoders(o: ProbeOptions): Promise<EncoderProbeResult[]> {
  const compiled = o.run ? null : await listEncoders(o);
  const results: EncoderProbeResult[] = [];
  let hardwareFound = false;
  for (const id of candidateEncoders(o.platform)) {
    const hardware = HARDWARE_ENCODERS.has(id);
    if (compiled && !compiled.has(id)) {
      results.push({ id, hardware, ok: false, error: 'not included in this ffmpeg' });
      continue;
    }
    // One working hardware encoder is enough (each test briefly wakes a GPU block).
    if (hardware && hardwareFound) {
      results.push({ id, hardware, ok: false, error: 'not tested (another hardware encoder works)' });
      continue;
    }
    const { filter, args } = encoderArgs(id, '', { kbps: 3000, height: 720, fps: 30, threads: 2 });
    const cmd = [
      '-hide_banner', '-loglevel', 'level+info', '-nostats', '-nostdin', '-benchmark',
      ...encoderInputArgs(id),
      ...TEST_INPUT,
      '-frames:v', String(PROBE_FRAMES), '-vf', filter, ...args,
      '-f', 'null', '-',
    ];
    const r = await (o.run ?? ((a, t) => runFfmpeg(o, a, t)))(cmd, o.timeoutMs ?? 15_000);
    if (r.code === 0) {
      results.push({
        id,
        hardware,
        ok: true,
        fps: Math.round((PROBE_FRAMES / Math.max(r.ms, 1)) * 1000),
        ...(r.cpuSeconds !== undefined ? { cpuSeconds: r.cpuSeconds, videoSeconds: PROBE_FRAMES / 30 } : {}),
      });
      if (hardware) hardwareFound = true;
    } else {
      results.push({ id, hardware, ok: false, error: firstLine(r) });
    }
  }
  o.log.info({ encoders: results.map((r) => `${r.id}:${r.ok ? `${r.fps}fps` : 'no'}`) }, 'video encoders probed');
  return results;
}

/** ffmpeg arguments of one CPU test: scale a 1080p30 pattern to `height` with one encoder thread. */
export function cpuTestArgs(encoder: SoftwareEncoderId, height: 480 | 360, preset?: X264Preset): string[] {
  const kbps = height === 480 ? 1400 : 800;
  const { filter, args } = encoderArgs(encoder, '', { kbps, height, fps: 30, threads: 1, ...(preset ? { preset } : {}) });
  return [
    '-hide_banner', '-loglevel', 'level+info', '-nostats', '-nostdin', '-benchmark',
    '-filter_threads', '1',
    ...TEST_INPUT,
    '-frames:v', String(CPU_TEST_FRAMES), '-vf', filter, ...args,
    '-f', 'null', '-',
  ];
}

/**
 * CPU headroom test for PCs without a working hardware encoder: short test encodes of one low
 * rendition (480p, then 360p; x264 veryfast, then superfast) at below-normal priority, measuring
 * wall time and CPU time. Stops at the first test that fits the budget (decideSoftware).
 * Returns null when it does not apply (a hardware encoder works, no software encoder, too few threads).
 */
export async function testCpu(o: ProbeOptions, encoders: EncoderProbeResult[]): Promise<CpuTestResult[] | null> {
  if (encoders.some((e) => e.hardware && e.ok)) return null;
  const threads = o.cpuThreads ?? cpuCores();
  const soft = softwareEncodersIn(encoders);
  if (soft.length === 0 || threads < SOFTWARE_MIN_THREADS) return null;
  const encoder = soft[0]!;
  const results: CpuTestResult[] = [];
  for (const step of CPU_TEST_PLAN[encoder]) {
    const r = await (o.run ?? ((a, t) => runFfmpeg(o, a, t, true)))(cpuTestArgs(encoder, step.height, step.preset), o.timeoutMs ?? 20_000);
    const videoSeconds = CPU_TEST_FRAMES / 30;
    results.push({
      encoder,
      height: step.height,
      ...(step.preset ? { preset: step.preset } : {}),
      videoSeconds,
      realSeconds: r.realSeconds ?? r.ms / 1000,
      cpuSeconds: r.cpuSeconds ?? r.ms / 1000,
      ok: r.code === 0,
      ...(r.code === 0 ? {} : { error: firstLine(r) }),
    });
    if (decideSoftware(threads, soft, results).pick) break;
  }
  o.log.info(
    { cpuTests: results.map((t) => `${t.encoder}/${t.height}p${t.preset ? `/${t.preset}` : ''}: ${t.ok ? `${(t.videoSeconds / t.realSeconds).toFixed(1)}x, ${(t.cpuSeconds / t.videoSeconds).toFixed(2)} cores` : 'failed'}`) },
    'CPU fallback tested',
  );
  return results;
}

export function cpuCores(): number {
  return os.availableParallelism?.() ?? os.cpus().length;
}
