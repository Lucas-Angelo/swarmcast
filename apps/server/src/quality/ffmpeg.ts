import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';
import versions from '../../../../scripts/build/versions.json' with { type: 'json' };
import { runCommand, system32, type CommandOptions } from '../core/exec.js';
import { removeDir } from '../core/fs-cleanup.js';
import type { Logger } from '../core/logger.js';
import { CodedError, codeOf } from '../core/messages.js';
import { exe, isPackaged, platformTag } from '../core/paths.js';

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

/** The whole download may take this long (30-80 MB on a slow link). */
export const FFMPEG_DOWNLOAD_MAX_MS = 30 * 60_000;
/**
 * A try that receives nothing for this long (no answer, or no new bytes) fails with a message
 * that says so, instead of showing "Downloading… 0 MB" until FFMPEG_DOWNLOAD_MAX_MS: a link that
 * stalled that long is gone (github.com answered 504s and stalled downloads for almost two hours on
 * 2026-11-08). A slow link is not affected: even at a few kB/s bytes arrive every second.
 */
export const FFMPEG_STALL_MS = 60_000;

export function ffmpegPin(target = platformTag()): FfmpegPin | undefined {
  return FFMPEG_SPEC.assets[target];
}

/**
 * Where the desktop app's first start and the panel's "Install the video converter" button put
 * ffmpeg: `<data>/tools/ffmpeg/`, in the data folder, so app updates never download it again.
 */
export function toolsFfmpegDir(dataDir: string): string {
  return path.join(dataDir, 'tools', 'ffmpeg');
}

export function installedFfmpegPath(dataDir: string): string {
  return path.join(toolsFfmpegDir(dataDir), exe('ffmpeg'));
}

/** Pin stamp written next to the binary: "<version> <sha256>". */
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
 * (the app's first start or the panel), the older panel location `<data>/bin/ffmpeg-<version>/`.
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

const LOOPBACK_FILE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\w.\-/]*$/;

/**
 * Where the pinned archive is downloaded from: its publisher (`pin.url`), or, for the system
 * tests only, a local stand-in that serves the same file (SWARMCAST_TEST_FFMPEG_URL, never set in
 * a real run; docs/TESTING.md, "No third-party service in the gate"). Only http://127.0.0.1 is
 * accepted, so it can never send the download anywhere but this machine, and the SHA-256 check is
 * the same, so it cannot install anything but the pinned build. Throws on any other address.
 */
export function ffmpegDownloadUrl(pin: FfmpegPin, env: NodeJS.ProcessEnv = process.env): string {
  const standIn = env.SWARMCAST_TEST_FFMPEG_URL;
  if (!standIn) return pin.url;
  if (!LOOPBACK_FILE_URL.test(standIn)) throw new Error('SWARMCAST_TEST_FFMPEG_URL must be an http://127.0.0.1:<port>/<file> address');
  return standIn;
}

export interface InstallProgress {
  /** 'retrying': the last try failed (`message`), the next one starts shortly. */
  phase: 'downloading' | 'verifying' | 'extracting' | 'retrying' | 'done' | 'error';
  receivedBytes: number;
  totalBytes?: number;
  message?: string;
  /** `message` as a message key, when it has one, so the panel can translate it. */
  code?: MessageKey;
  params?: MessageParams;
  /** Automatic retries (desktop first run): this try's number and how many there can be. */
  attempt?: number;
  attempts?: number;
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

/** Run a step of the install; a failure throws execFile's own error, whose message the panel shows. */
async function mustRun(command: string, args: string[], o: CommandOptions): Promise<void> {
  const r = await runCommand(command, args, o);
  if (r.error) throw r.error;
}

/**
 * Download the pinned ffmpeg build for this platform straight from its publisher, verify the
 * SHA-256, extract only the ffmpeg binary and check that it runs. Started by the streamer
 * from the panel or by the desktop app's first start (its
 * installer step): SwarmCast itself does not redistribute ffmpeg (docs/QUALITY.md).
 */
export async function installFfmpeg(
  dataDir: string,
  log: Logger,
  onProgress: (p: InstallProgress) => void = () => {},
  opts: {
    pin?: FfmpegPin;
    fetchImpl?: typeof fetch;
    /** Aborts the download (the app is quitting). */
    signal?: AbortSignal;
    /** FFMPEG_STALL_MS (tests). */
    stallMs?: number;
    /** Read for SWARMCAST_TEST_FFMPEG_URL (ffmpegDownloadUrl). */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  const pin = opts.pin ?? ffmpegPin();
  if (!pin) throw new Error(`No ffmpeg build is pinned for ${platformTag()}.`);
  const dest = installedFfmpegPath(dataDir);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ffmpeg-'));
  const stallMs = opts.stallMs ?? FFMPEG_STALL_MS;
  const stalled = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  // Armed before the request and again after the answer and after each chunk is written: the
  // time counted is the network's alone, never the disk's.
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stalled.abort(new CodedError('quality.install.stalled', { s: Math.round(stallMs / 1000) })), stallMs);
  };
  try {
    const archive = path.join(work, pin.asset);
    const url = ffmpegDownloadUrl(pin, opts.env);
    const signal = AbortSignal.any([stalled.signal, AbortSignal.timeout(FFMPEG_DOWNLOAD_MAX_MS), ...(opts.signal ? [opts.signal] : [])]);
    let received = 0;
    let total: number | undefined;
    const hash = crypto.createHash('sha256');
    try {
      armStall();
      // The stand-in is on this machine and never redirects; a redirect would leave it.
      const res = await (opts.fetchImpl ?? fetch)(url, { redirect: url === pin.url ? 'follow' : 'error', signal });
      armStall();
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
      total = Number(res.headers.get('content-length')) || undefined;
      const out = fs.createWriteStream(archive);
      // A write error (disk full, folder removed) must fail this install, not escape as an
      // uncaught 'error' event that would stop SwarmCast.
      const writeFailed = new Promise<never>((_, reject) => out.once('error', reject));
      writeFailed.catch(() => {});
      let lastReport = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), writeFailed]);
        armStall();
        if (received - lastReport > 1_000_000) {
          lastReport = received;
          onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total });
        }
      }
      clearTimeout(stallTimer);
      await Promise.race([new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve()))), writeFailed]);
    } catch (err) {
      // fetch rejects with its own AbortError or with the reason; say why it stopped.
      if (stalled.signal.aborted && !opts.signal?.aborted) throw stalled.signal.reason as Error;
      throw err;
    } finally {
      clearTimeout(stallTimer);
    }
    onProgress({ phase: 'verifying', receivedBytes: received, totalBytes: total });
    const actual = hash.digest('hex');
    if (actual !== pin.sha256) throw new Error(`Checksum mismatch for ${pin.asset}: expected ${pin.sha256}, got ${actual}.`);
    onProgress({ phase: 'extracting', receivedBytes: received, totalBytes: total });
    const ex = path.join(work, 'x');
    fs.mkdirSync(ex);
    // bsdtar (macOS, Windows 10+) reads zip and tar.xz; GNU tar (Linux) reads tar.xz.
    // On Windows, Git's GNU tar may come first in PATH and cannot read zip; use the OS's bsdtar.
    const tar = process.platform === 'win32' ? system32('tar.exe') : 'tar';
    await mustRun(tar, ['-xf', archive, '-C', ex], { timeoutMs: 5 * 60_000, signal: opts.signal });
    const bin = findFile(ex, path.basename(pin.binary));
    if (!bin) throw new Error(`${pin.binary} not found inside ${pin.asset}.`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(bin, `${dest}.tmp`);
    if (process.platform !== 'win32') fs.chmodSync(`${dest}.tmp`, 0o755);
    await mustRun(`${dest}.tmp`, ['-hide_banner', '-version'], { timeoutMs: 20_000 });
    fs.renameSync(`${dest}.tmp`, dest);
    fs.writeFileSync(path.join(path.dirname(dest), 'SOURCE.txt'), `${pin.url}\nsha256 ${pin.sha256}\nlicense ${pin.license}\nDownloaded from its publisher on this computer; SwarmCast does not redistribute ffmpeg.\n`);
    fs.writeFileSync(path.join(path.dirname(dest), 'PIN'), `${pinStamp(pin)}\n`);
    onProgress({ phase: 'done', receivedBytes: received, totalBytes: total });
    log.info({ version: FFMPEG_SPEC.version, license: pin.license }, 'ffmpeg installed');
    return dest;
  } catch (err) {
    onProgress({ phase: 'error', receivedBytes: 0, message: (err as Error).message, ...codeOf(err) });
    throw err;
  } finally {
    // Never let a locked temporary file turn a finished install (or its real error) into EPERM.
    await removeDir(work, log, 'ffmpeg download');
  }
}
