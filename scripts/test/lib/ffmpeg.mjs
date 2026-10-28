// The ffmpeg the tests use, and the arguments of the synthetic OBS feed.
//
// CI pins a checksum-verified ffmpeg and exports its absolute path as FFMPEG_BIN. Elsewhere the
// first ffmpeg on PATH is used, resolved to an absolute path once, so every test (and its log)
// names the same binary and nothing on PATH can swap it between two spawns.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

const VIDEO = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'];
const AUDIO = ['-c:a', 'aac', '-b:a', '96k'];

/**
 * Arguments for a feed encoded live, in real time: the fallback when no pre-encoded clip fits
 * (x264 ultrafast, the lowest CPU cost; the picture quality of a test pattern does not matter).
 */
export function liveFeedArgs(rtmpUrl, o = {}) {
  return ['-hide_banner', '-loglevel', 'error', '-re', ...sourceArgs(o.size ?? '640x360'), ...VIDEO, ...rateArgs(o.kbps ?? 1200, !!o.cbr), ...AUDIO, '-f', 'flv', rtmpUrl];
}
