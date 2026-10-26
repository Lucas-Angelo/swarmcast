import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesktopAutostartState } from '@swarmcast/shared';

/**
 * "Start with the computer" for the desktop app (docs/DESKTOP.md), off by default: SwarmCast
 * never turns it on by itself. The entry in the OS is the source of truth and is read back on
 * every request; an entry that starts another copy of the app (moved or reinstalled) counts
 * as enabled but stale and is rewritten on enable. The entry runs `"<exe>" --background`
 * (tray only, no window).
 *
 * | OS      | Entry                                                                         |
 * |---------|-------------------------------------------------------------------------------|
 * | Windows | HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value "SwarmCast" (reg.exe) |
 * | macOS   | ~/Library/LaunchAgents/io.github.lucas-angelo.swarmcast.plist                 |
 * | Linux   | $XDG_CONFIG_HOME/autostart/swarmcast.desktop (default ~/.config)              |
 */

export const APP_ID = 'io.github.lucas-angelo.swarmcast';
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_VALUE_NAME = 'SwarmCast';
export const BACKGROUND_ARG = '--background';

// ---- entries (pure, unit-tested) ----

function isAbsolute(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** Only absolute paths; control characters cannot be written safely in any of the formats. */
export function checkExePath(exe: string): void {
  // eslint-disable-next-line no-control-regex
  if (!exe || !isAbsolute(exe) || /[\u0000-\u001f\u007f]/.test(exe)) throw new Error(`Invalid app path for autostart: ${JSON.stringify(exe)}`);
}

/** Data of the Windows Run value. Windows paths cannot contain double quotes. */
export function windowsRunCommand(exe: string): string {
  checkExePath(exe);
  if (exe.includes('"')) throw new Error(`Invalid app path for autostart: ${JSON.stringify(exe)}`);
  return `"${exe}" ${BACKGROUND_ARG}`;
}

/** Program of a Run value's command line (`"C:\x y\a.exe" --flag` or `C:\a.exe --flag`). */
export function windowsCommandExe(command: string): string {
  const c = command.trim();
  if (c.startsWith('"')) {
    const end = c.indexOf('"', 1);
    return end > 0 ? c.slice(1, end) : c.slice(1);
  }
  const sp = c.indexOf(' ');
  return sp >= 0 ? c.slice(0, sp) : c;
}

/**
 * The Run value from `reg export` (UTF-16 .reg file text), or null when there is none.
 * `"SwarmCast"="\"C:\\Program Files\\x.exe\" --background"`; a non-string value (hex) is
 * reported as an empty command (exists, but not ours).
 */
export function parseRegExport(text: string, name = WINDOWS_VALUE_NAME): string | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const prefix = `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"=`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const raw = line.slice(prefix.length);
    if (!raw.startsWith('"')) return '';
    let out = '';
    for (let j = 1; j < raw.length; j++) {
      const ch = raw[j]!;
      if (ch === '\\' && j + 1 < raw.length) out += raw[++j];
      else if (ch === '"') return out;
      else out += ch;
    }
    return out;
  }
  return null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** LaunchAgent that opens the app (tray only) when the user logs in. */
export function macLaunchAgentPlist(exe: string): string {
  checkExePath(exe);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exe)}</string>
    <string>${BACKGROUND_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

/** First ProgramArguments entry of a LaunchAgent plist (XML), or null. */
export function macPlistExe(text: string): string | null {
  const args = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const first = args ? /<string>([\s\S]*?)<\/string>/.exec(args[1]!) : null;
  if (first) return xmlUnescape(first[1]!);
  const program = /<key>\s*Program\s*<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  return program ? xmlUnescape(program[1]!) : null;
}

/**
 * Quote one Exec argument (Desktop Entry Specification): inside double quotes, `"`, `` ` ``,
 * `$` and `\` take a backslash; `%` is doubled (field codes); then the value's own string
 * escaping doubles every backslash once more.
 */
export function desktopExecValue(exe: string): string {
  const quoted = `"${exe.replace(/[\\"`$]/g, '\\$&')}"`.replace(/%/g, '%%');
  return `${quoted} ${BACKGROUND_ARG}`.replace(/\\/g, '\\\\');
}

/**
 * TryExec value: the program alone, with the string escaping of every Desktop Entry value
 * (a backslash doubled, as in Exec). No Exec-style quotes: TryExec is a path, not a command line,
 * and a quoted one would never be found.
 */
export function desktopTryExecValue(exe: string): string {
  return exe.replace(/\\/g, '\\\\');
}

/**
 * XDG autostart entry. `TryExec`: removing the `.deb` leaves this file in the home folder
 * (package scripts do not edit home folders), and sessions skip an entry whose TryExec
 * program is gone.
 */
export function linuxDesktopEntry(exe: string): string {
  checkExePath(exe);
  return `[Desktop Entry]
Type=Application
Name=SwarmCast
Comment=Opens SwarmCast in the tray when you sign in
TryExec=${desktopTryExecValue(exe)}
Exec=${desktopExecValue(exe)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function unescapeDesktopString(v: string): string {
  return v.replace(/\\([\\snrt])/g, (_m, c: string) => ({ '\\': '\\', s: ' ', n: '\n', r: '\r', t: '\t' })[c]!);
}

/** Program of an XDG entry, or null when it has no Exec line or is switched off (Hidden / X-GNOME-Autostart-enabled=false). */
export function linuxEntryExe(text: string): string | null {
  let exec: string | null = null;
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Hidden' && value === 'true') return null;
    if (key === 'X-GNOME-Autostart-enabled' && value === 'false') return null;
    if (key === 'Exec') exec = unescapeDesktopString(value);
  }
  if (exec === null) return null;
  if (!exec.startsWith('"')) {
    const sp = exec.indexOf(' ');
    return (sp >= 0 ? exec.slice(0, sp) : exec).replace(/%%/g, '%');
  }
  let out = '';
  for (let i = 1; i < exec.length; i++) {
    const ch = exec[i]!;
    if (ch === '\\' && i + 1 < exec.length) out += exec[++i];
    else if (ch === '"') break;
    else out += ch;
  }
  return out.replace(/%%/g, '%');
}

// ---- OS access ----

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

const defaultRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err?.message ?? '') });
    });
  });

export interface AutostartOptions {
  /** Absolute path that starts the desktop app (SWARMCAST_DESKTOP_EXE); unsupported without it. */
  exe?: string;
  platform?: NodeJS.Platform;
  /** Home folder (tests use a temporary one). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs reg.exe (Windows); replaced in tests. */
  run?: Runner;
  /** Folder for reg.exe's export file. */
  tmpDir?: string;
}

/** Normalize for comparison: Windows paths are case-insensitive. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class Autostart {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: Runner;

  constructor(private readonly o: AutostartOptions) {
    this.platform = o.platform ?? process.platform;
    this.env = o.env ?? process.env;
    this.home = o.home ?? os.homedir();
    this.run = o.run ?? defaultRunner;
  }

  get supported(): boolean {
    return !!this.o.exe && isAbsolute(this.o.exe) && ['win32', 'darwin', 'linux'].includes(this.platform);
  }

  /** Where the entry file lives (macOS / Linux). */
  entryFile(): string {
    if (this.platform === 'darwin') return path.join(this.home, 'Library', 'LaunchAgents', `${APP_ID}.plist`);
    const xdg = this.env.XDG_CONFIG_HOME;
    const config = xdg && path.isAbsolute(xdg) ? xdg : path.join(this.home, '.config');
    return path.join(config, 'autostart', 'swarmcast.desktop');
  }

  /** Program the OS entry starts; null when there is no entry. */
  private async readEntry(): Promise<string | null> {
    if (this.platform === 'win32') return this.readWindows();
    let text: string;
    try {
      text = fs.readFileSync(this.entryFile(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return this.platform === 'darwin' ? (macPlistExe(text) ?? '') : linuxEntryExe(text);
  }

  private async readWindows(): Promise<string | null> {
    // `reg export` writes UTF-16, so paths with accents (C:\Users\João) read back exactly;
    // `reg query` prints them in the console code page.
    const dir = fs.mkdtempSync(path.join(this.o.tmpDir ?? os.tmpdir(), 'sc-reg-'));
    const file = path.join(dir, 'run.reg');
    try {
      const r = await this.run('reg.exe', ['export', WINDOWS_RUN_KEY, file, '/y']);
      if (r.code !== 0 || !fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
      const command = parseRegExport(text);
      return command === null ? null : windowsCommandExe(command);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async status(): Promise<DesktopAutostartState> {
    if (!this.supported) return { supported: false, enabled: false };
    try {
      const current = await this.readEntry();
      if (current === null) return { supported: true, enabled: false };
      return { supported: true, enabled: true, ...(samePath(current, this.o.exe!, this.platform) ? {} : { stale: true }) };
    } catch (err) {
      return { supported: true, enabled: false, error: (err as Error).message };
    }
  }

  async set(enabled: boolean): Promise<DesktopAutostartState> {
    if (!this.supported) throw new Error('Starting with the computer is only available in the SwarmCast desktop app.');
    if (enabled) await this.write(this.o.exe!);
    else await this.remove();
    const s = await this.status();
    if (s.error) throw new Error(s.error);
    if (s.enabled !== enabled || s.stale) throw new Error(`The ${enabled ? 'new' : 'removed'} autostart entry did not read back as expected.`);
    return s;
  }

  private async write(exe: string): Promise<void> {
    if (this.platform === 'win32') {
      const r = await this.run('reg.exe', ['add', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE_NAME, '/t', 'REG_SZ', '/d', windowsRunCommand(exe), '/f']);
      if (r.code !== 0) throw new Error(`reg add failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      return;
    }
    const file = this.entryFile();
    const content = this.platform === 'darwin' ? macLaunchAgentPlist(exe) : linuxDesktopEntry(exe);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }

  private async remove(): Promise<void> {
    if (this.platform === 'win32') {
      if ((await this.readWindows()) === null) return;
      const r = await this.run('reg.exe', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE_NAME, '/f']);
      if (r.code !== 0) throw new Error(`reg delete failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      return;
    }
    // macOS: removing the plist is enough (launchd reads it at the next login). No
    // `launchctl bootout`: when the app itself was started by this agent, that would kill it.
    fs.rmSync(this.entryFile(), { force: true });
  }
}
