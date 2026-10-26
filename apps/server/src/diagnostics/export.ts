import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import type { ActivityEntry } from '@swarmcast/shared';
import type { Anonymizer } from './anonymize.js';

/** Logs from the last 14 days go into an export. */
export const EXPORT_LOG_DAYS = 14;
/** Raw log bytes read into one export at most (newest files first); the logs folder is capped at 100 MB. */
export const EXPORT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_SYSTEM_CHECK_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Log files of the server (`swarmcast-*.log*`, legacy `swarmcast.log*`), the desktop shell (`desktop.log*`) and children. */
export function isLogFile(name: string): boolean {
  return /\.log(\.\d+)?$/i.test(name);
}

/** Keys of config.json whose string values never go into an export (links, URLs, passwords, keys). */
const CONFIG_SECRET_KEY = /secret|token|password|passwd|key$|link|url|urls$|cookie/i;

/**
 * config.json for an export: strings under link/URL/password/key/token fields become
 * `[redacted]` (the tunnel URL, extra blocklist URLs, the obs-websocket password…), everything
 * else goes through the anonymiser. Numbers and booleans are kept (they are the settings).
 */
export function sanitizeConfig(config: unknown, anon: Anonymizer): unknown {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && CONFIG_SECRET_KEY.test(key) ? '[redacted]' : anon.text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(config);
}

export interface LogExportInput {
  logsDir: string;
  /** `<data>/system-check.json` (included when present and valid JSON). */
  systemCheckFile?: string;
  /** The loaded config (sanitised here). */
  config: unknown;
  /** The in-memory activity log. */
  activity: ActivityEntry[];
  /** Lines of about.txt (anonymised here too). */
  about: string[];
  anonymizer: Anonymizer;
  now?: number;
  days?: number;
  maxLogBytes?: number;
}

export interface BuiltExport {
  /** Name → content of every file in the ZIP (already anonymised). */
  files: Record<string, string>;
  zip: Uint8Array;
}

function fmtActivity(e: ActivityEntry): string {
  const level = e.level === 'error' ? 'ERROR' : e.level === 'warn' ? 'WARN ' : 'INFO ';
  return `${new Date(e.at).toISOString()} ${level} [${e.kind}] ${e.text}`;
}

/**
 * Build the ZIP of a log export. Never reads secrets.json, state.json or the signing keys: only
 * the logs folder, system-check.json and what the caller passes. Every text file is anonymised.
 */
export async function buildLogExport(o: LogExportInput): Promise<BuiltExport> {
  const now = o.now ?? Date.now();
  const cutoff = now - (o.days ?? EXPORT_LOG_DAYS) * DAY_MS;
  const anon = o.anonymizer;

  // Newest first, until the byte budget is used up.
  const logs: Array<{ name: string; mtime: number; text: string }> = [];
  let budget = o.maxLogBytes ?? EXPORT_MAX_LOG_BYTES;
  let skipped = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(o.logsDir).filter(isLogFile);
  } catch {
    /* no logs folder yet */
  }
  const candidates = names
    .map((name) => {
      try {
        const st = fs.statSync(path.join(o.logsDir, name));
        return st.isFile() && st.mtimeMs >= cutoff ? { name, mtime: st.mtimeMs, size: st.size } : null;
      } catch {
        return null;
      }
    })
    .filter((f): f is { name: string; mtime: number; size: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of candidates) {
    if (f.size > budget) {
      skipped++;
      continue;
    }
    budget -= f.size;
    try {
      logs.push({ name: f.name, mtime: f.mtime, text: fs.readFileSync(path.join(o.logsDir, f.name), 'utf8') });
    } catch {
      skipped++;
    }
  }

  // First pass: learn every nickname, so free text in any file is masked too.
  for (const l of logs) anon.learn(l.text);
  for (const e of o.activity) {
    const nick = e.params?.nickname;
    if (typeof nick === 'string') anon.addNickname(nick);
  }

  const files: Record<string, string> = {};
  const about = [...o.about];
  if (skipped) about.push(`Log files left out (export size limit): ${skipped}`);
  files['about.txt'] = anon.text(about.join('\n')) + '\n';
  files['config.json'] = JSON.stringify(sanitizeConfig(o.config, anon), null, 2) + '\n';
  if (o.systemCheckFile) {
    try {
      const st = fs.statSync(o.systemCheckFile);
      if (st.isFile() && st.size <= MAX_SYSTEM_CHECK_BYTES) {
        files['system-check.json'] = JSON.stringify(anon.json(JSON.parse(fs.readFileSync(o.systemCheckFile, 'utf8'))), null, 2) + '\n';
      }
    } catch {
      /* missing or invalid: about.txt says so */
    }
  }
  files['activity.txt'] = o.activity.length ? o.activity.map((e) => anon.text(fmtActivity(e))).join('\n') + '\n' : '(empty)\n';
  for (const l of logs) files[`logs/${l.name}`] = await anon.file(l.text);

  const enc = new TextEncoder();
  const mtimeOf = (name: string): Date => new Date(logs.find((l) => `logs/${l.name}` === name)?.mtime ?? now);
  const zippable: Zippable = {};
  for (const [name, text] of Object.entries(files)) zippable[name] = [enc.encode(text), { mtime: mtimeOf(name) }];
  // Plain deflate, no encryption, no zip64 (well under 4 GB): Windows Explorer opens it natively.
  return { files, zip: zipSync(zippable, { level: 6 }) };
}

/** `SwarmCast-logs-0.1.0-20261026-1430.zip` (local time). */
export function exportFileName(version: string, now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  const safeVersion = version.replace(/[^0-9A-Za-z.+-]/g, '_');
  return `SwarmCast-logs-${safeVersion}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

function usableDir(dir: string | undefined | null): string | null {
  if (!dir) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

/** XDG_DOWNLOAD_DIR from the environment or ~/.config/user-dirs.dirs (`"$HOME/Downloads"`). */
export function xdgDownloadDir(env: NodeJS.ProcessEnv, home: string, readFile: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): string | null {
  const expand = (v: string): string => v.replace(/^"|"$/g, '').replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
  if (env.XDG_DOWNLOAD_DIR) return expand(env.XDG_DOWNLOAD_DIR);
  try {
    const text = readFile(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs'));
    const m = /^\s*XDG_DOWNLOAD_DIR\s*=\s*(.+?)\s*$/m.exec(text);
    if (m) {
      const dir = expand(m[1]!);
      // `$HOME/` alone means "no Downloads folder" in user-dirs.dirs.
      if (path.resolve(dir) !== path.resolve(home)) return dir;
    }
  } catch {
    /* no user-dirs.dirs */
  }
  return null;
}

/** Windows: the Downloads Known Folder (users can move it), read from the registry. */
function windowsKnownDownloads(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(String(stdout));
        if (!m) return resolve(null);
        resolve(m[1]!.trim().replace(/%([^%]+)%/g, (all, name: string) => env[name] ?? env[name.toUpperCase()] ?? all));
      },
    );
  });
}

/** The user's Downloads folder, or null when there is none we can write to. */
export async function downloadsDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<string | null> {
  if (platform === 'win32') {
    const known = await windowsKnownDownloads(env);
    return usableDir(known) ?? usableDir(path.join(env.USERPROFILE || home, 'Downloads'));
  }
  if (platform === 'darwin') return usableDir(path.join(home, 'Downloads'));
  return usableDir(xdgDownloadDir(env, home)) ?? usableDir(path.join(home, 'Downloads'));
}

/**
 * Write the ZIP into `dir` (the Downloads folder) or, when it is missing or not writable, into
 * `fallbackDir` (`<data>/exports`). Never overwrites an existing file.
 */
export function writeExportFile(zip: Uint8Array, name: string, dir: string | null, fallbackDir: string): { path: string; fallback: boolean } {
  const tryWrite = (folder: string): string | null => {
    try {
      fs.mkdirSync(folder, { recursive: true });
      const ext = path.extname(name);
      const stem = name.slice(0, -ext.length);
      for (let i = 1; i < 100; i++) {
        const file = path.join(folder, i === 1 ? name : `${stem}-${i}${ext}`);
        try {
          fs.writeFileSync(file, zip, { flag: 'wx', mode: 0o600 });
          return file;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      return null;
    } catch {
      return null;
    }
  };
  if (dir) {
    const file = tryWrite(dir);
    if (file) return { path: file, fallback: false };
  }
  const file = tryWrite(fallbackDir);
  if (!file) throw new Error(`Could not write the log export to ${dir ?? fallbackDir}`);
  return { path: file, fallback: true };
}

/** Open the file manager on the export: Explorer with it selected, Finder revealing it, or its folder. */
export function revealCommand(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${file}`] };
  if (platform === 'darwin') return { command: 'open', args: ['-R', file] };
  return { command: 'xdg-open', args: [path.dirname(file)] };
}
