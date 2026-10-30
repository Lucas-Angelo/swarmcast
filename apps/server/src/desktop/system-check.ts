import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpeedTestResult } from '@swarmcast/shared';
import { readSystemCheck, type SystemCheck, type SystemCheckResult } from '../admin/system-check-routes.js';
import { writePrivateFile } from '../core/paths.js';
import { isPortFree } from '../core/ports.js';
import { throwIfAborted } from '../core/retry.js';

/**
 * The start scripts' system check (scripts/start-*: check_os … report_and_confirm,
 * write_system_check), in TypeScript for the desktop app's first start. Same ids, statuses,
 * thresholds, value texts and `system-check.json` format, so the setup tutorial shows it
 * unchanged. Differences, on purpose: the ports SwarmCast itself is using count as free, the
 * release row names the installed app, and github.com is checked once (it is only needed for
 * updates, like a script run from a local bundle).
 */

// Same thresholds as the scripts (SC_MIN_* / SC_REC_*).
export const MIN_RAM_MB = 3500; // "4 GB" machines report a bit less than 4096 MB
export const REC_RAM_MB = 7500; // "8 GB"
export const MIN_CORES = 2;
export const REC_CORES = 4;
export const MIN_UP_MBPS = 10;
export const REC_UP_MBPS = 50;
export const MIN_DISK_BYTES = 500 * 1024 * 1024;
export const OBS_HINT = 'Install OBS Studio from https://obsproject.com to stream.';

export type Platform = 'win32' | 'darwin' | 'linux';
type Level = 'ok' | 'warn' | 'bad';

export interface OsInfo {
  /** "Ubuntu 24.04.1 LTS", "macOS 15.1", "Windows 11 Pro (build 22631)". */
  desc: string;
  status: Level;
  note: string;
}

export interface SystemFacts {
  platform: Platform;
  os: OsInfo;
  /** Build in use: x64 or arm64 (Windows on ARM runs the x64 build, as in the script). */
  arch: string;
  ramMB: number;
  cores: number;
  diskBytes: number;
  /** Ports SwarmCast needs that another program uses. */
  busyPorts: { port: number; owner?: string }[];
  /** Where OBS was found, or null. */
  obs: string | null;
  githubOk: boolean;
  /** Speed test result; 'skipped' when speed tests are off in the config. */
  speed: { uploadMbps: number; downloadMbps: number } | 'failed' | 'skipped';
  appVersion: string;
}

// ---- operating system (pure) ----

/** KEY=value pairs of /etc/os-release (quotes removed). */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    out[m[1]!] = v;
  }
  return out;
}

/** check_os of start-linux.sh. */
export function linuxOsInfo(rel: Record<string, string> | null, kernel: string): OsInfo {
  const id = rel?.ID ?? '';
  const idLike = ` ${rel?.ID_LIKE ?? ''} `;
  const major = Number.parseInt((rel?.VERSION_ID ?? '').split('.')[0] ?? '', 10) || 0;
  const desc = rel?.PRETTY_NAME || `Linux ${kernel}`;
  const tested = 'tested: Ubuntu 22.04/24.04, Debian 12';
  if (id === 'ubuntu') return major >= 22 ? { desc, status: 'ok', note: '' } : { desc, status: 'warn', note: 'Ubuntu 22.04 or newer is recommended' };
  if (id === 'debian') return major >= 12 ? { desc, status: 'ok', note: '' } : { desc, status: 'warn', note: 'Debian 12 or newer is recommended' };
  if (idLike.includes(' ubuntu ') || idLike.includes(' debian ')) return { desc, status: 'warn', note: `based on Ubuntu/Debian but not tested (${tested})` };
  return { desc, status: 'warn', note: `not a tested distribution (${tested}); it will probably work` };
}

/** check_os of start-macos.command (`sw_vers -productVersion`). */
export function macOsInfo(productVersion: string): OsInfo {
  const ver = productVersion.trim() || 'unknown';
  const desc = `macOS ${ver}`;
  const major = /^\d+/.exec(ver)?.[0];
  if (!major) return { desc, status: 'warn', note: 'could not read the macOS version' };
  return Number(major) >= 12 ? { desc, status: 'ok', note: '' } : { desc, status: 'bad', note: 'macOS 12 or newer is required' };
}

/**
 * Get-OsInfo of start-windows.ps1. `release` is os.release() ("10.0.22631"), `version` is
 * os.version() ("Windows 10 Pro"; Windows 11 still calls itself 10 there, so the build decides).
 */
export function windowsOsInfo(release: string, version: string): OsInfo {
  const [maj, min, build] = release.split('.').map((n) => Number.parseInt(n, 10) || 0) as [number, number, number];
  let caption = version.trim() || `Windows ${maj}.${min}`;
  if (maj === 10 && build >= 22000) caption = caption.replace(/^(Microsoft )?Windows 10\b/, '$1Windows 11');
  const desc = `${caption} (build ${build})`;
  if (maj < 10) return { desc, status: 'bad', note: 'Windows 10 or 11 is required' };
  if (/server/i.test(caption)) return { desc, status: 'warn', note: 'Windows Server is not a tested edition (tested: Windows 10/11); it will probably work' };
  return { desc, status: 'ok', note: '' };
}

// ---- report (pure) ----

function level(value: number, min: number, rec: number): Level {
  return value >= rec ? 'ok' : value >= min ? 'warn' : 'bad';
}

const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const noDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "7.8 GB" (gb_of_mb / '{0:N1} GB'). */
export function formatRam(ramMB: number): string {
  return `${(ramMB / 1024).toFixed(1)} GB`;
}

/** size_of_kb (macOS/Linux) and Format-Size (Windows). */
export function formatDisk(bytes: number, platform: Platform): string {
  if (platform === 'win32') {
    return bytes >= 1024 ** 3 ? `${oneDecimal.format(bytes / 1024 ** 3)} GB` : `${noDecimal.format(bytes / 1024 ** 2)} MB`;
  }
  const kb = Math.floor(bytes / 1024);
  return kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.floor(kb / 1024)} MB`;
}

/** "23.4" (bash printf %.1f gives "23.0"; PowerShell prints a rounded double as "23"). */
export function formatMbps(n: number, platform: Platform): string {
  const r = Math.round(n * 10) / 10;
  return platform === 'win32' ? String(r) : r.toFixed(1);
}

/** Viewers served straight from this computer, as the scripts estimate it (6 Mbps stream, also sent elsewhere). */
export function viewerEstimate(uploadMbps: number): number {
  return Math.floor(Math.max(0, uploadMbps * 0.75 - 6) / (6 * 1.15));
}

/** Build system-check.json from the facts, exactly like report_and_confirm / Show-Report. */
export function buildSystemCheck(f: SystemFacts, at: Date = new Date()): SystemCheck {
  const results: SystemCheckResult[] = [];
  const below: string[] = [];
  const add = (id: string, st: Level | 'skipped', value: string, min = '', recommended = '', detail = ''): void => {
    const status = value.includes('skipped') ? 'skipped' : st === 'bad' ? 'fail' : st;
    results.push({ id, status, value, min, recommended, detail });
  };
  const win = f.platform === 'win32';

  const osMin = f.platform === 'darwin' ? 'macOS 12' : win ? 'Windows 10' : '';
  add('os', f.os.status, win ? f.os.desc : `${f.os.desc} (${f.arch})`, osMin, '', f.os.note);
  if (f.os.status === 'bad') below.push('os');

  let st = level(f.ramMB, MIN_RAM_MB, REC_RAM_MB);
  add('ram', st, formatRam(f.ramMB), '4 GB', '8 GB');
  if (st === 'bad') below.push('ram');

  st = level(f.cores, MIN_CORES, REC_CORES);
  add('cpu', st, String(f.cores), '2', '4');
  if (st === 'bad') below.push('cpu');

  const speed = typeof f.speed === 'object' ? f.speed : null;
  if (speed) {
    st = level(speed.uploadMbps, MIN_UP_MBPS, REC_UP_MBPS);
    add('upload', st, `${formatMbps(speed.uploadMbps, f.platform)} Mbps`, '10 Mbps', '50 Mbps');
    if (st === 'bad') below.push('upload');
    add('download', 'ok', `${formatMbps(speed.downloadMbps, f.platform)} Mbps`, '-', '-');
  } else if (f.speed === 'skipped') {
    add('upload', 'warn', 'not measured (skipped)', '10 Mbps', '50 Mbps');
    add('download', 'skipped', 'not measured (skipped)');
  } else {
    add('upload', 'warn', 'speed test failed', '10 Mbps', '50 Mbps');
    add('download', 'warn', 'speed test failed');
  }

  st = f.diskBytes >= MIN_DISK_BYTES ? 'ok' : 'bad';
  add('disk', st, formatDisk(f.diskBytes, f.platform), '500 MB', '');
  if (st === 'bad') below.push('disk');

  if (f.busyPorts.length === 0) add('ports', 'ok', 'free');
  else {
    add(
      'ports',
      'warn',
      `in use: ${f.busyPorts.map((p) => p.port).join(' ')}`,
      '',
      '',
      f.busyPorts.map((p) => `port ${p.port} is used by ${p.owner || 'another program'}`).join('; '),
    );
  }

  if (f.obs) add('obs', 'ok', 'installed');
  else add('obs', 'warn', 'not found', '', '', OBS_HINT);

  // Like a script run from a local bundle: github.com is only needed for updates.
  add('github', f.githubOk ? 'ok' : 'warn', f.githubOk ? 'reachable' : 'unreachable (not needed)');
  add('release', 'ok', `v${f.appVersion} (desktop app)`);

  return {
    version: 1,
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    os: f.os.desc,
    arch: f.arch,
    results,
    uploadMbps: speed ? speed.uploadMbps : null,
    downloadMbps: speed ? speed.downloadMbps : null,
    viewerEstimate: speed ? viewerEstimate(speed.uploadMbps) : null,
    belowMinimum: below,
    appVersion: f.appVersion,
    source: 'desktop',
  };
}

/** Run the check on the desktop app's first start, and again after the app was updated. */
export function needsSystemCheck(file: string, appVersion: string): boolean {
  const c = readSystemCheck(file);
  return !c || c.appVersion !== appVersion;
}

export function writeSystemCheck(file: string, c: SystemCheck): void {
  writePrivateFile(file, `${JSON.stringify(c, null, 2)}\n`);
}

// ---- gathering the facts (OS access) ----

type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string }>;

const execWith =
  (signal?: AbortSignal): Exec =>
  (command, args, timeoutMs = 10_000) =>
    new Promise((resolve) => {
      try {
        execFile(command, args, { windowsHide: true, timeout: timeoutMs, signal }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
      } catch {
        resolve({ ok: false, stdout: '' });
      }
    });

export interface GatherDeps {
  dataDir: string;
  appVersion: string;
  /** Ports SwarmCast needs (from config.json: RTMP, public server, panel). */
  ports: number[];
  /** Ports SwarmCast itself is listening on right now (they count as free). */
  ownPorts: () => Iterable<number>;
  /** Speed test: a result, undefined when it failed, 'skipped' when tests are off. */
  speed: () => Promise<SpeedTestResult | undefined | 'skipped'>;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exec?: Exec;
  fetchImpl?: typeof fetch;
  githubUrl?: string;
  /** Aborted when the app quits: the check gives up and writes nothing. */
  signal?: AbortSignal;
}

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * check_obs / Find-Obs. `applications`: the macOS system Applications folder (default
 * /Applications; tests pass a folder of their own).
 */
export async function findObs(platform: Platform, o: { env?: NodeJS.ProcessEnv; home?: string; exec?: Exec; applications?: string } = {}): Promise<string | null> {
  const env = o.env ?? process.env;
  const run = o.exec ?? execWith();
  if (platform === 'darwin') {
    for (const p of [path.join(o.applications ?? '/Applications', 'OBS.app'), path.join(o.home ?? os.homedir(), 'Applications', 'OBS.app')]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  if (platform === 'win32') {
    const keys = [
      'HKLM\\SOFTWARE\\OBS Studio',
      'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio',
      'HKCU\\SOFTWARE\\OBS Studio',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio',
    ];
    for (const k of keys) {
      if ((await run('reg.exe', ['query', k])).ok) return k;
    }
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!base) continue;
      const dir = path.win32.join(base, 'obs-studio');
      if (fs.existsSync(path.win32.join(dir, 'bin', '64bit', 'obs64.exe'))) return dir;
    }
    return null;
  }
  const bin = await onPath('obs', env);
  if (bin) return bin;
  if ((await onPath('flatpak', env)) && (await run('flatpak', ['info', 'com.obsproject.Studio'])).ok) return 'flatpak com.obsproject.Studio';
  if ((await onPath('snap', env)) && (await run('snap', ['list', 'obs-studio'])).ok) return 'snap obs-studio';
  return null;
}

async function osInfo(platform: Platform, run: Exec): Promise<OsInfo> {
  if (platform === 'darwin') return macOsInfo((await run('sw_vers', ['-productVersion'])).stdout);
  if (platform === 'win32') return windowsOsInfo(os.release(), os.version());
  let rel: Record<string, string> | null = null;
  try {
    rel = parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8'));
  } catch {
    /* none */
  }
  return linuxOsInfo(rel, os.release());
}

async function archOf(platform: Platform, run: Exec): Promise<string> {
  if (platform === 'win32') return process.arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'darwin' && process.arch === 'x64') {
    // An Intel build running under Rosetta on Apple Silicon: report the Mac's own processor.
    return (await run('sysctl', ['-n', 'sysctl.proc_translated'])).stdout.trim() === '1' ? 'arm64' : 'x64';
  }
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function freeDisk(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

/** Any HTTP answer means github.com is reachable. */
async function reachable(url: string, f: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(20_000);
    await f(url, { method: 'HEAD', redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { 'User-Agent': 'SwarmCast system check' } });
    return true;
  } catch {
    return false;
  }
}

export async function gatherSystemFacts(d: GatherDeps): Promise<SystemFacts> {
  const platform = d.platform ?? (process.platform as Platform);
  const run = d.exec ?? execWith(d.signal);
  const env = d.env ?? process.env;
  const own = new Set(d.ownPorts());
  const busyPorts: SystemFacts['busyPorts'] = [];
  for (const port of [...new Set(d.ports)]) {
    if (!own.has(port) && !(await isPortFree(port))) busyPorts.push({ port });
  }
  const [osI, arch, obs, githubOk, speed] = await Promise.all([
    osInfo(platform, run),
    archOf(platform, run),
    findObs(platform, { env, home: d.home, exec: run }),
    reachable(d.githubUrl ?? 'https://github.com', d.fetchImpl ?? fetch, d.signal),
    d.speed().catch(() => undefined),
  ]);
  throwIfAborted(d.signal);
  return {
    platform,
    os: osI,
    arch,
    ramMB: Math.floor(os.totalmem() / 1048576),
    cores: os.cpus().length,
    diskBytes: freeDisk(d.dataDir),
    busyPorts,
    obs,
    githubOk,
    speed: speed === 'skipped' ? 'skipped' : speed ? { uploadMbps: speed.uploadMbps, downloadMbps: speed.downloadMbps } : 'failed',
    appVersion: d.appVersion,
  };
}

/** Gather, build and write `<data>/system-check.json`. */
export async function runSystemCheck(file: string, d: GatherDeps): Promise<SystemCheck> {
  const c = buildSystemCheck(await gatherSystemFacts(d));
  writeSystemCheck(file, c);
  return c;
}
