import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { isListening } from '../../src/core/ports.js';
import { decodeDesktopMessage, encodeShellMessage, type DesktopOutMessage, type DesktopStateMessage, type ShellMessage } from '../../src/desktop/protocol.js';
import { isAlive } from '../../src/process/children.js';
import { tmpDir, waitFor } from './helpers.js';

// The real server from source, started like the desktop shell does (`--desktop`), driven over
// stdio by this test acting as the shell. Temporary data folder, HOME and ports (never the
// user's own SwarmCast data, LaunchAgents or a SwarmCast already running on this computer).

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/server/src/main.ts');
const posix = process.platform !== 'win32';

interface Ports {
  rtmp: number;
  public: number;
  admin: number;
  mediamtxHls: number;
}

function writeConfig(dir: string, ports: Ports, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' }, ...extra }));
}

/** A folder like the desktop app's resources: web/admin and web/viewer (SWARMCAST_WEB_DIR). */
function webDir(): string {
  const dir = tmpDir('sc-web-');
  fs.mkdirSync(path.join(dir, 'admin'));
  fs.mkdirSync(path.join(dir, 'viewer'));
  fs.writeFileSync(path.join(dir, 'admin', 'index.html'), '<!doctype html><title>desktop test panel</title>');
  fs.writeFileSync(path.join(dir, 'viewer', 'index.html'), '<!doctype html><title>viewer</title>');
  return dir;
}

class FakeShell {
  readonly proc: ChildProcess;
  readonly messages: DesktopOutMessage[] = [];
  readonly logLines: string[] = [];
  stderr = '';
  readonly exited: Promise<number | null>;

  constructor(
    readonly dataDir: string,
    readonly home: string,
    args: string[] = [],
    env: Record<string, string> = {},
    o: { tunnel?: boolean } = {},
  ) {
    this.proc = spawn(process.execPath, ['--import', 'tsx', MAIN, '--desktop', ...(o.tunnel ? [] : ['--no-tunnel']), '--data-dir', dataDir, ...args], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: '',
        SWARMCAST_NO_OPEN: '1',
        SWARMCAST_NO_FFMPEG_INSTALL: '1',
        SWARMCAST_LOG_LEVEL: 'warn',
        SWARMCAST_DESKTOP_VERSION: '9.9.9-test',
        ...env,
      },
    });
    readline.createInterface({ input: this.proc.stdout! }).on('line', (line) => {
      const msg = decodeDesktopMessage(line);
      if (msg) this.messages.push(msg);
      else {
        // Protocol lines are always whole lines: never glued to a log line.
        expect(line).not.toContain('@@swarmcast');
        this.logLines.push(line);
      }
    });
    this.proc.stderr!.on('data', (d) => (this.stderr += d));
    this.exited = new Promise((r) => this.proc.on('exit', (code) => r(code)));
  }

  send(msg: ShellMessage | string): void {
    this.proc.stdin!.write(typeof msg === 'string' ? msg : encodeShellMessage(msg));
  }

  async next<T extends DesktopOutMessage>(pred: (m: DesktopOutMessage) => m is T, timeoutMs = 30_000, from = 0): Promise<T> {
    let found: T | undefined;
    await waitFor(
      () => {
        found = this.messages.slice(from).find(pred);
        return !!found || this.proc.exitCode !== null;
      },
      timeoutMs,
      'a desktop message',
    );
    if (!found) throw new Error(`server exited (${this.proc.exitCode}) without the expected message. stderr: ${this.stderr}`);
    return found;
  }

  phaseIs(phase: DesktopStateMessage['phase'], from = 0): Promise<DesktopStateMessage> {
    return this.next((m): m is DesktopStateMessage => m.type === 'state' && m.phase === phase, 40_000, from);
  }
}

const isReady = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'ready' }> => m.type === 'ready';
const isFatal = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'fatal' }> => m.type === 'fatal';

/** Log in like the webview: open /auth/<token> (200, cookie, meta refresh to /), keep the cookie, open /. */
async function login(adminUrl: string): Promise<{ base: string; cookie: string; status: number }> {
  const r1 = await fetch(adminUrl, { redirect: 'manual' });
  expect(r1.status).toBe(200);
  const page = await r1.text();
  expect(page).toContain('<meta http-equiv="refresh" content="0;url=/">');
  expect(page).not.toContain(new URL(adminUrl).pathname.slice('/auth/'.length));
  const cookie = r1.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${ADMIN_COOKIE}=`))!;
  const base = new URL(adminUrl).origin;
  const r2 = await fetch(`${base}/`, { headers: { cookie } });
  return { base, cookie, status: r2.status };
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const shells: FakeShell[] = [];
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) if (s.proc.exitCode === null) s.proc.kill('SIGKILL');
  for (const s of servers.splice(0)) {
    if (s instanceof http.Server) s.closeAllConnections();
    s.close();
  }
});

describe.skipIf(!posix)('desktop mode (--desktop) driven by a fake shell', () => {
  it('ready, panel login, state on every change, clicks, update status, autostart, first-run check, quit', async () => {
    const dir = tmpDir();
    const home = tmpDir('sc-home-');
    const ports = { rtmp: 29750, public: 28480, admin: 28481, mediamtxHls: 29188 + 100 };
    writeConfig(dir, ports);
    const exe = process.platform === 'darwin' ? '/Applications/Swarm Cast Test.app/Contents/MacOS/SwarmCast' : '/opt/Swarm Cast Test/swarmcast-desktop';
    const shell = new FakeShell(dir, home, [], { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_DESKTOP_EXE: exe });
    shells.push(shell);

    const ready = await shell.next(isReady);
    expect(ready.adminUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${ports.admin}/auth/[A-Za-z0-9_-]+$`));
    expect(ready.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(shell.messages.filter(isReady)).toHaveLength(1);
    const { base, cookie, status } = await login(ready.adminUrl);
    expect(status).toBe(200);
    // The panel token stays out of the shell's log.
    expect(shell.logLines.join('\n')).not.toContain('/auth/');

    // The live turns on by itself (as in script mode) and waits for OBS.
    await shell.phaseIs('waiting-obs');
    expect(await isListening(ports.rtmp)).toBe(true);

    let from = shell.messages.length;
    shell.send({ type: 'click', id: 'stop' });
    await shell.phaseIs('stopping', from);
    const off = await shell.phaseIs('off', from);
    expect(off).toMatchObject({ state: 'off', canStart: true, canStop: false, viewers: 0, tooltip: 'SwarmCast: off' });

    from = shell.messages.length;
    shell.send({ type: 'click', id: 'start' });
    await shell.phaseIs('starting', from);
    expect(await shell.phaseIs('waiting-obs', from)).toMatchObject({ state: 'waiting', canStop: true });
    // Unknown or broken lines are ignored.
    shell.send('garbage\n{"type":"click","id":"rm"}\n');

    const api = (p: string, init: RequestInit = {}) =>
      fetch(base + p, { ...init, headers: { cookie, origin: base, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });

    // Update status from the shell → the panel API; "Check for updates" → the shell.
    let d = await (await api('/api/desktop')).json();
    expect(d).toMatchObject({ desktop: true, version: '9.9.9-test', autostart: { supported: true, enabled: false }, update: null });
    shell.send({ type: 'update', update: { status: 'available', current: '9.9.9-test', version: '10.0.0', notes: 'Better things' } });
    await waitFor(async () => (await (await api('/api/desktop')).json()).update?.version === '10.0.0', 5000, 'update status');
    from = shell.messages.length;
    expect((await api('/api/desktop/update/check', { method: 'POST', body: '{}' })).status).toBe(200);
    await shell.next((m): m is { type: 'update-check' } => m.type === 'update-check', 5000, from);
    await api('/api/desktop/update/install', { method: 'POST', body: '{}' });
    await shell.next((m): m is { type: 'update-install' } => m.type === 'update-install', 5000, from);

    // "Start with the computer" against the temporary HOME.
    const entry =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'LaunchAgents', 'io.github.lucas-angelo.swarmcast.plist')
        : path.join(home, '.config', 'autostart', 'swarmcast.desktop');
    d = await (await api('/api/desktop/autostart', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).json();
    expect(d.autostart).toEqual({ supported: true, enabled: true });
    expect(fs.readFileSync(entry, 'utf8')).toContain(process.platform === 'darwin' ? exe : 'Swarm Cast Test');
    expect((await (await api('/api/desktop')).json()).autostart.enabled).toBe(true);
    d = await (await api('/api/desktop/autostart', { method: 'PUT', body: JSON.stringify({ enabled: false }) })).json();
    expect(d.autostart.enabled).toBe(false);
    expect(fs.existsSync(entry)).toBe(false);

    // First desktop start: the system check is written in the scripts' format.
    const checkFile = path.join(dir, 'system-check.json');
    await waitFor(() => fs.existsSync(checkFile), 40_000, 'system-check.json');
    const check = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    expect(check).toMatchObject({ version: 1, source: 'desktop', appVersion: ready.version });
    expect(check.results.map((r: { id: string }) => r.id)).toEqual(['os', 'ram', 'cpu', 'upload', 'download', 'disk', 'ports', 'obs', 'github', 'release']);
    // Its own ports are not "in use by another program"; speed tests are off in this config.
    expect(check.results.find((r: { id: string }) => r.id === 'ports')).toMatchObject({ status: 'ok', value: 'free' });
    expect(check.results.find((r: { id: string }) => r.id === 'upload')).toMatchObject({ status: 'skipped' });
    await waitFor(async () => (await (await api('/api/desktop')).json()).systemCheck === 'done', 5000, 'systemCheck done');
    expect((await api('/api/system-check')).status).toBe(200);

    // Quit from the tray: everything stops, exit 0, no child process left.
    const children = childPids(shell.proc.pid!);
    expect(children.length).toBeGreaterThan(0);
    from = shell.messages.length;
    shell.send({ type: 'click', id: 'quit' });
    expect(await shell.exited).toBe(0);
    expect(shell.messages.slice(from).some((m) => m.type === 'state' && m.phase === 'off')).toBe(true);
    await waitFor(() => children.every((p) => !isAlive(p)), 10_000, 'child processes to exit');
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
  });

  it('stdin closing (the shell is gone) stops everything and exits 0', async () => {
    const dir = tmpDir();
    const ports = { rtmp: 29760, public: 28490, admin: 28491, mediamtxHls: 29298 };
    writeConfig(dir, ports);
    const shell = new FakeShell(dir, tmpDir('sc-home-'), [], { SWARMCAST_WEB_DIR: webDir() });
    shells.push(shell);
    await shell.next(isReady);
    await shell.phaseIs('waiting-obs');
    const children = childPids(shell.proc.pid!);
    shell.proc.stdin!.end();
    expect(await shell.exited).toBe(0);
    await waitFor(() => children.every((p) => !isAlive(p)), 10_000, 'child processes to exit');
    expect(await isListening(ports.rtmp)).toBe(false);
  });

  it('quit right away while the live is starting and the first-run speed test hangs: exit in under 5 s, nothing left', async () => {
    // One local server that accepts every request and never answers: the speed test
    // (SWARMCAST_SPEEDTEST_URL) and the tunnel's reachability check (an "external" tunnel
    // pointing at it) both hang, like a slow network on the first start.
    const seen: string[] = [];
    const hang = http.createServer((req) => seen.push(req.url ?? ''));
    servers.push(hang);
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const hangUrl = `http://127.0.0.1:${(hang.address() as net.AddressInfo).port}`;
    const dir = tmpDir();
    const ports = { rtmp: 29765, public: 28495, admin: 28496, mediamtxHls: 29303 };
    writeConfig(dir, ports, { speedTest: { enabled: true, intervalMinutes: 15 }, tunnel: { provider: 'external', externalUrl: hangUrl } });
    const shell = new FakeShell(dir, tmpDir('sc-home-'), [], { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_SPEEDTEST_URL: hangUrl }, { tunnel: true });
    shells.push(shell);
    await shell.next(isReady);
    await shell.phaseIs('starting');
    await waitFor(() => seen.some((u) => u.startsWith('/__down')) && seen.includes('/healthz'), 20_000, 'the speed test and the tunnel check to hang');
    const children = childPids(shell.proc.pid!);
    expect(children.length).toBeGreaterThan(0);

    const t0 = Date.now();
    shell.send({ type: 'quit' });
    expect(await shell.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(shell.messages.at(-1)).toMatchObject({ type: 'state', phase: 'off' });
    await waitFor(() => children.every((p) => !isAlive(p)), 5000, 'child processes to exit');
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
    // The aborted first-run check wrote nothing (the next start checks again).
    expect(fs.existsSync(path.join(dir, 'system-check.json'))).toBe(false);
    hang.closeAllConnections();
  });

  it('{"type":"quit"} exits 0; autostart is unsupported without SWARMCAST_DESKTOP_EXE', async () => {
    const dir = tmpDir();
    writeConfig(dir, { rtmp: 29770, public: 28500, admin: 28501, mediamtxHls: 29308 });
    const shell = new FakeShell(dir, tmpDir('sc-home-'), ['--no-autostart'], { SWARMCAST_WEB_DIR: webDir() });
    shells.push(shell);
    const ready = await shell.next(isReady);
    expect(await shell.phaseIs('off')).toMatchObject({ canStart: true });
    const { base, cookie } = await login(ready.adminUrl);
    const d = await (await fetch(`${base}/api/desktop`, { headers: { cookie } })).json();
    expect(d.autostart).toEqual({ supported: false, enabled: false });
    shell.send({ type: 'quit' });
    expect(await shell.exited).toBe(0);
  });

  it('fatal "ports-busy" when the OBS port is used by another program', async () => {
    const dir = tmpDir();
    const ports = { rtmp: 29780, public: 28510, admin: 28511, mediamtxHls: 29318 };
    writeConfig(dir, ports);
    const other = net.createServer();
    servers.push(other);
    await new Promise<void>((r) => other.listen(ports.rtmp, '127.0.0.1', () => r()));
    const shell = new FakeShell(dir, tmpDir('sc-home-'));
    shells.push(shell);
    const fatal = await shell.next(isFatal);
    expect(fatal.code).toBe('ports-busy');
    expect(fatal.message).toContain(String(ports.rtmp));
    expect(await shell.exited).not.toBe(0);
    expect(shell.messages.some(isReady)).toBe(false);
  });

  it('fatal "already-running" when another SwarmCast answers on the panel port', async () => {
    const ports = { rtmp: 29790, public: 28520, admin: 28521, mediamtxHls: 29328 };
    const firstDir = tmpDir();
    writeConfig(firstDir, ports);
    const first = new FakeShell(firstDir, tmpDir('sc-home-'), ['--no-autostart'], { SWARMCAST_WEB_DIR: webDir() });
    shells.push(first);
    await first.next(isReady);

    const secondDir = tmpDir();
    writeConfig(secondDir, ports);
    const second = new FakeShell(secondDir, tmpDir('sc-home-'), ['--no-autostart']);
    shells.push(second);
    const fatal = await second.next(isFatal);
    expect(fatal.code).toBe('already-running');
    expect(await second.exited).toBe(1);

    first.send({ type: 'quit' });
    expect(await first.exited).toBe(0);
  });
});
