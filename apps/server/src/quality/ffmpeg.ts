import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import versions from '../../../../scripts/build/versions.json' with { type: 'json' };
import type { Logger } from '../core/logger.js';
import { exe, isPackaged, platformTag } from '../core/paths.js';

const execFileP = promisify(execFile);

export interface FfmpegPin {
  url: string;
  asset: string;
  sha256: string;
  binary: string;
  license: string;
}

interface FfmpegSpec {
  version: string;
  assets: Record<string, FfmpegPin>;
}

export const FFMPEG_SPEC = (versions as unknown as { ffmpeg: FfmpegSpec }).ffmpeg;

export function ffmpegPin(target = platformTag()): FfmpegPin | undefined {
  return FFMPEG_SPEC.assets[target];
}

/**
 * Where the start scripts and the panel's "Install the video converter" button put ffmpeg:
 * `<data>/tools/ffmpeg/`, outside `app/`, so app updates never download it again.
 */
export function toolsFfmpegDir(dataDir: string): string {
  return path.join(dataDir, 'tools', 'ffmpeg');
}

export function installedFfmpegPath(dataDir: string): string {
  return path.join(toolsFfmpegDir(dataDir), exe('ffmpeg'));
}

/** Pin stamp written next to the binary (same format as the start scripts): "<version> <sha256>". */
export function pinStamp(pin: FfmpegPin, version = FFMPEG_SPEC.version): string {
  return `${version} ${pin.sha256}`;
}

/** True when `<data>/tools/ffmpeg` holds the build pinned for this platform. */
export function installedPinMatches(dataDir: string, pin = ffmpegPin()): boolean {
  if (!pin) return false;
  try {
    return fs.existsSync(installedFfmpegPath(dataDir)) && fs.readFileSync(path.join(toolsFfmpegDir(dataDir), 'PIN'), 'utf8').trim() === pinStamp(pin);
  } catch {
    return false;
  }
}

/**
 * Which ffmpeg to use, in order: `SWARMCAST_FFMPEG`, the config's `ffmpegPath`, bin/ffmpeg
 * shipped next to MediaMTX (a packager may bundle it), `<data>/tools/ffmpeg/ffmpeg[.exe]`
 * (start scripts or the panel), the older panel location `<data>/bin/ffmpeg-<version>/`.
 * Null when none.
 */
export function resolveFfmpeg(o: { configPath?: string; binDir: string; dataDir: string; env?: NodeJS.ProcessEnv }): string | null {
  const explicit = (o.env ?? process.env).SWARMCAST_FFMPEG || o.configPath;
  if (explicit) {
    // A bare command name ("ffmpeg") is looked up on PATH by spawn; only allowed from source checkouts.
    if (!explicit.includes(path.sep) && !explicit.includes('/')) return isPackaged() ? null : explicit;
    return fs.existsSync(explicit) ? explicit : null;
  }
  const legacy = path.join(o.dataDir, 'bin', `ffmpeg-${FFMPEG_SPEC.version}`, exe('ffmpeg'));
  for (const p of [path.join(o.binDir, exe('ffmpeg')), installedFfmpegPath(o.dataDir), legacy]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error';
  receivedBytes: number;
  totalBytes?: number;
  message?: string;
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Download the pinned ffmpeg build for this platform straight from its publisher, verify the
 * SHA-256, extract only the ffmpeg binary and check that it runs. Started only by the
 * streamer from the panel: SwarmCast itself does not redistribute ffmpeg (docs/QUALITY.md).
 */
export async function installFfmpeg(
  dataDir: string,
  log: Logger,
  onProgress: (p: InstallProgress) => void = () => {},
  opts: { pin?: FfmpegPin; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const pin = opts.pin ?? ffmpegPin();
  if (!pin) throw new Error(`No ffmpeg build is pinned for ${platformTag()}.`);
  const dest = installedFfmpegPath(dataDir);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ffmpeg-'));
  try {
    const archive = path.join(work, pin.asset);
    const res = await (opts.fetchImpl ?? fetch)(pin.url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || undefined;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(archive);
    let received = 0;
    let lastReport = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (received - lastReport > 1_000_000) {
        lastReport = received;
        onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    onProgress({ phase: 'verifying', receivedBytes: received, totalBytes: total });
    const actual = hash.digest('hex');
    if (actual !== pin.sha256) throw new Error(`Checksum mismatch for ${pin.asset}: expected ${pin.sha256}, got ${actual}.`);
    onProgress({ phase: 'extracting', receivedBytes: received, totalBytes: total });
    const ex = path.join(work, 'x');
    fs.mkdirSync(ex);
    // bsdtar (macOS, Windows 10+) reads zip and tar.xz; GNU tar (Linux) reads tar.xz.
    // On Windows, Git's GNU tar may come first in PATH and cannot read zip; use the OS's bsdtar.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await execFileP(tar, ['-xf', archive, '-C', ex], { windowsHide: true, timeout: 5 * 60_000 });
    const bin = findFile(ex, path.basename(pin.binary));
    if (!bin) throw new Error(`${pin.binary} not found inside ${pin.asset}.`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(bin, `${dest}.tmp`);
    if (process.platform !== 'win32') fs.chmodSync(`${dest}.tmp`, 0o755);
    await execFileP(`${dest}.tmp`, ['-hide_banner', '-version'], { windowsHide: true, timeout: 20_000 });
    fs.renameSync(`${dest}.tmp`, dest);
    fs.writeFileSync(path.join(path.dirname(dest), 'SOURCE.txt'), `${pin.url}\nsha256 ${pin.sha256}\nlicense ${pin.license}\nDownloaded from its publisher on this computer; SwarmCast does not redistribute ffmpeg.\n`);
    fs.writeFileSync(path.join(path.dirname(dest), 'PIN'), `${pinStamp(pin)}\n`);
    onProgress({ phase: 'done', receivedBytes: received, totalBytes: total });
    log.info({ version: FFMPEG_SPEC.version, license: pin.license }, 'ffmpeg installed');
    return dest;
  } catch (err) {
    onProgress({ phase: 'error', receivedBytes: 0, message: (err as Error).message });
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
