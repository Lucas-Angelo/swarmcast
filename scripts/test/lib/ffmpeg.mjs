// The ffmpeg the tests use, and the arguments of the synthetic OBS feed.
//
// CI pins a checksum-verified ffmpeg and exports its absolute path as FFMPEG_BIN. Elsewhere the
// first ffmpeg on PATH is used, resolved to an absolute path once, so every test (and its log)
// names the same binary and nothing on PATH can swap it between two spawns.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let resolved;

/** Absolute path of the test ffmpeg: $FFMPEG_BIN, else the first `ffmpeg` on PATH, else "ffmpeg". */
export function ffmpegBin() {
  if (resolved) return resolved;
  if (process.env.FFMPEG_BIN) return (resolved = process.env.FFMPEG_BIN);
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return (resolved = p);
      } catch {
        /* not here */
      }
    }
  }
  return (resolved = 'ffmpeg');
}

let available;

/** First line of `ffmpeg -version` ("ffmpeg version 9.0.2 ..."), or null when it does not run. */
export function ffmpegVersion() {
  if (available !== undefined) return available;
  try {
    available = execFileSync(ffmpegBin(), ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).toString().split('\n')[0].trim();
  } catch {
    available = null;
  }
  return available;
}

/**
 * True when the test ffmpeg runs. (An ffmpeg without libx264 still counts: its feeds die at
 * once, and the tests fail fast with ffmpeg's own message rather than skip.)
 */
export function hasFfmpeg() {
  return ffmpegVersion() !== null;
}

/** x264 rate control: average `kbps`, or constant (filler NALs, like OBS's CBR) with `cbr`. */
function rateArgs(kbps, cbr) {
  return ['-b:v', `${kbps}k`, ...(cbr ? ['-minrate', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`, '-x264-params', 'nal-hrd=cbr:filler=1'] : [])];
}

/** The test pattern and tone every feed shows: 30 fps, a 2 s keyframe interval (as OBS should be set up). */
function sourceArgs(size, seconds) {
  const t = seconds ? ['-t', String(seconds)] : [];
  return ['-f', 'lavfi', ...t, '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', ...t, '-i', 'sine=frequency=440:sample_rate=48000'];
}

const video = (preset = 'ultrafast') => ['-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'];
const VIDEO = video();
const AUDIO = ['-c:a', 'aac', '-b:a', '96k'];

/**
 * Arguments for a feed encoded live, in real time: the fallback when no pre-encoded clip fits
 * (x264 ultrafast, the lowest CPU cost; the picture quality of a test pattern does not matter).
 * `preset` and `vbv` (peaks capped at `kbps`, a two-second buffer, like a streamer's OBS) give
 * the system harnesses (scripts/test/windows, preflight) the feed they always sent.
 */
export function liveFeedArgs(rtmpUrl, o = {}) {
  const kbps = o.kbps ?? 1200;
  const vbv = o.vbv && !o.cbr ? ['-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`] : [];
  return ['-hide_banner', '-loglevel', 'error', '-re', ...sourceArgs(o.size ?? '640x360'), ...video(o.preset), ...rateArgs(kbps, !!o.cbr), ...vbv, ...AUDIO, '-f', 'flv', rtmpUrl];
}

// ---- Pre-encoded feeds -----------------------------------------------------------------------
//
// Encoding 1080p x264 in real time next to the ladder took a 3-vCPU runner to its limit (the
// load guard then rightly dropped a rendition). A clip is encoded once, faster than real time,
// and every feed sends it with `-c copy` in a loop: close to no CPU while the tests run.

/** Default clip length: a whole number of 2 s keyframe intervals, so the cadence holds across loops. */
export const CLIP_SECONDS = 10;

function clipSpec(o = {}) {
  const seconds = o.seconds ?? CLIP_SECONDS;
  if (!Number.isInteger(seconds / 2)) throw new Error(`clip length ${seconds} s is not a whole number of 2 s keyframe intervals`);
  return { size: o.size ?? '640x360', kbps: o.kbps ?? 1200, cbr: !!o.cbr, seconds };
}

/** The encode command of a clip (without the output file). */
function clipEncodeArgs(spec) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...sourceArgs(spec.size, spec.seconds), ...VIDEO, ...rateArgs(spec.kbps, spec.cbr), ...AUDIO, '-t', String(spec.seconds), '-f', 'flv'];
}

/** Where the clips are cached: $SC_TEST_CLIPS_DIR, else <tmp>/swarmcast-test-clips. */
export function clipsDir() {
  return process.env.SC_TEST_CLIPS_DIR || path.join(os.tmpdir(), 'swarmcast-test-clips');
}

/** The cache file of a clip: named after everything that shapes it (ffmpeg build and arguments). */
export function clipPath(o = {}) {
  const spec = clipSpec(o);
  const hash = crypto.createHash('sha256').update(JSON.stringify([ffmpegBin(), ffmpegVersion(), clipEncodeArgs(spec)])).digest('hex').slice(0, 12);
  return path.join(clipsDir(), `${spec.size}-${spec.kbps}k${spec.cbr ? '-cbr' : ''}-${spec.seconds}s-${hash}.flv`);
}

/**
 * How to encode `file`: into a temporary name first, renamed when complete, so a parallel encode
 * of the same clip or a crash never leaves half a clip under the cached name.
 */
function encodeJob(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.part`;
  const finish = (err, stderr) => {
    if (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`encoding the test clip ${path.basename(file)} with ${ffmpegBin()} failed: ${String(stderr ?? '').trim() || err.message}`);
    }
    fs.renameSync(tmp, file);
    return file;
  };
  return { tmp, finish };
}

/** The clip for these feed options, encoded now if it is not cached yet (blocks while encoding). */
export function ensureClipSync(o = {}) {
  const file = clipPath(o);
  if (fs.existsSync(file)) return file;
  const job = encodeJob(file);
  try {
    execFileSync(ffmpegBin(), [...clipEncodeArgs(clipSpec(o)), job.tmp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  } catch (err) {
    return job.finish(err, err.stderr);
  }
  return job.finish();
}

/** `ensureClipSync` without blocking: a global setup prepares several clips at once. */
export function ensureClip(o = {}) {
  const file = clipPath(o);
  if (fs.existsSync(file)) return Promise.resolve(file);
  const job = encodeJob(file);
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin(), [...clipEncodeArgs(clipSpec(o)), job.tmp], { timeout: 120_000 }, (err, _out, stderr) => {
      try {
        resolve(job.finish(err, stderr));
      } catch (e) {
        reject(e);
      }
    });
  });
}

let burst;

/**
 * True when this ffmpeg has `-readrate_initial_burst` (FFmpeg 6.1 and later): the first seconds
 * of a feed are sent at once, so the first segments exist right away; real time from then on.
 */
export function hasInitialBurst() {
  if (burst !== undefined) return burst;
  try {
    burst = execFileSync(ffmpegBin(), ['-hide_banner', '-h', 'long'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .includes('-readrate_initial_burst');
  } catch {
    burst = false;
  }
  return burst;
}

/**
 * Arguments that send a clip in a loop, in real time, without re-encoding. `burstSeconds`: send
 * that much at once first (ignored by an ffmpeg without -readrate_initial_burst).
 */
export function clipFeedArgs(clip, rtmpUrl, o = {}) {
  const b = o.burstSeconds && hasInitialBurst() ? ['-readrate_initial_burst', String(o.burstSeconds)] : [];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', ...b, '-stream_loop', '-1', '-i', clip, '-c', 'copy', '-f', 'flv', rtmpUrl];
}
