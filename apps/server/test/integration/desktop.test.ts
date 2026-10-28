import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { isListening } from '../../src/core/ports.js';
import { decodeDesktopMessage, encodeShellMessage, type DesktopOutMessage, type DesktopStateMessage, type ShellMessage } from '../../src/desktop/protocol.js';
import { isAlive } from '../../src/process/children.js';
import { allocAppPorts, spawnTracked, stopTracked, tmpDir, until, type Ports, type Tracked } from './helpers.js';

// The real server from source, started like the desktop shell does (`--desktop`), driven over
// stdio by this test acting as the shell. Temporary data folder, HOME and ports (never the
// user's own SwarmCast data, LaunchAgents or a SwarmCast already running on this computer).

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/server/src/main.ts');
const posix = process.platform !== 'win32';

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
  readonly t: Tracked;
  readonly proc: ChildProcess;
  readonly messages: DesktopOutMessage[] = [];
  readonly logLines: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(
    readonly dataDir: string,
    readonly home: string,
    args: string[] = [],
    env: Record<string, string> = {},
    o: { tunnel?: boolean } = {},
  ) {
    this.t = spawnTracked(process.execPath, ['--import', 'tsx', MAIN, '--desktop', ...(o.tunnel ? [] : ['--no-tunnel']), '--data-dir', dataDir, ...args], {
      name: 'SwarmCast --desktop',
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
    this.proc = this.t.child;
    this.t.on('line', (line, stream) => {
      if (stream !== 'stdout') return;
      const msg = decodeDesktopMessage(line);
      if (msg) this.messages.push(msg);
      else {
        // Protocol lines are always whole lines: never glued to a log line.
        expect(line).not.toContain('@@swarmcast');
        this.logLines.push(line);
      }
    });
    this.exited = this.t.exited.then((x) => x.code);
  }

  send(msg: ShellMessage | string): void {
    this.proc.stdin!.write(typeof msg === 'string' ? msg : encodeShellMessage(msg));
  }

  /** The first message from index `from` on that matches; fails at once if the server exits without it. */
  async next<T extends DesktopOutMessage>(pred: (m: DesktopOutMessage) => m is T, timeoutMs = 30_000, from = 0, what = 'a desktop message'): Promise<T> {
    let found: T | undefined;
    await until(
      () => {
        found = this.messages.slice(from).find(pred);
        return !!found;
      },
      { timeoutMs, what, abortOn: [this.t], on: [[this.t, 'line']], detail: () => `messages ${JSON.stringify(this.messages.slice(from).map((m) => m.type))}; last output: ${this.t.tail(10)}` },
    );
    return found!;
  }

  phaseIs(phase: DesktopStateMessage['phase'], from = 0): Promise<DesktopStateMessage> {
    return this.next((m): m is DesktopStateMessage => m.type === 'state' && m.phase === phase, 40_000, from, `phase ${phase}`);
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

const servers: net.Server[] = [];
afterEach(async () => {
  await stopTracked();
  for (const s of servers.splice(0)) {
    if (s instanceof http.Server) s.closeAllConnections();
    s.close();
  }
});

describe.skipIf(!posix)('desktop mode (--desktop) driven by a fake shell', () => {
  it('ready, panel login, state on every change, clicks, update status, autostart, first-run check, quit', async () => {
    const dir = tmpDir();
    const home = tmpDir('sc-home-');
    const ports = await allocAppPorts();
    writeConfig(dir, ports);
    const exe = process.platform === 'darwin' ? '/Applications/Swarm Cast Test.app/Contents/MacOS/SwarmCast' : '/opt/Swarm Cast Test/swarmcast-desktop';
    const shell = new FakeShell(dir, home, [], { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_DESKTOP_EXE: exe });

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
    await until(async () => (await (await api('/api/desktop')).json()).update?.version === '10.0.0', { timeoutMs: 5000, what: 'update status', abortOn: [shell.t] });
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
    await until(() => fs.existsSync(checkFile), { timeoutMs: 40_000, what: 'system-check.json', abortOn: [shell.t] });
    const check = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    expect(check).toMatchObject({ version: 1, source: 'desktop', appVersion: ready.version });
    expect(check.results.map((r: { id: string }) => r.id)).toEqual(['os', 'ram', 'cpu', 'upload', 'download', 'disk', 'ports', 'obs', 'github', 'release']);
    // Its own ports are not "in use by another program"; speed tests are off in this config.
    expect(check.results.find((r: { id: string }) => r.id === 'ports')).toMatchObject({ status: 'ok', value: 'free' });
    expect(check.results.find((r: { id: string }) => r.id === 'upload')).toMatchObject({ status: 'skipped' });
    await until(async () => (await (await api('/api/desktop')).json()).systemCheck === 'done', { timeoutMs: 5000, what: 'systemCheck done', abortOn: [shell.t] });
    expect((await api('/api/system-check')).status).toBe(200);

    // Quit from the tray: everything stops, exit 0, no child process left.
    const children = childPids(shell.proc.pid!);
    expect(children.length).toBeGreaterThan(0);
    from = shell.messages.length;
    shell.send({ type: 'click', id: 'quit' });
    expect(await shell.exited).toBe(0);
    expect(shell.messages.slice(from).some((m) => m.type === 'state' && m.phase === 'off')).toBe(true);
    await until(() => children.every((p) => !isAlive(p)), { timeoutMs: 10_000, what: 'child processes to exit', detail: () => `alive ${JSON.stringify(children.filter(isAlive))}` });
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
  });

  it('stdin closing (the shell is gone) stops everything and exits 0', async () => {
    const dir = tmpDir();
    const ports = await allocAppPorts();
    writeConfig(dir, ports);
    const shell = new FakeShell(dir, tmpDir('sc-home-'), [], { SWARMCAST_WEB_DIR: webDir() });
    await shell.next(isReady);
    await shell.phaseIs('waiting-obs');
    const children = childPids(shell.proc.pid!);
    shell.proc.stdin!.end();
    expect(await shell.exited).toBe(0);
    await until(() => children.every((p) => !isAlive(p)), { timeoutMs: 10_000, what: 'child processes to exit', detail: () => `alive ${JSON.stringify(children.filter(isAlive))}` });
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
    const ports = await allocAppPorts();
    writeConfig(dir, ports, { speedTest: { enabled: true, intervalMinutes: 15 }, tunnel: { provider: 'external', externalUrl: hangUrl } });
    const shell = new FakeShell(dir, tmpDir('sc-home-'), [], { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_SPEEDTEST_URL: hangUrl }, { tunnel: true });
    await shell.next(isReady);
    await shell.phaseIs('starting');
    await until(() => seen.some((u) => u.startsWith('/__down')) && seen.includes('/healthz'), { timeoutMs: 20_000, what: 'the speed test and the tunnel check to hang', abortOn: [shell.t], detail: () => `requests ${JSON.stringify(seen)}`, on: [[hang, 'request']] });
    const children = childPids(shell.proc.pid!);
    expect(children.length).toBeGreaterThan(0);

    const t0 = Date.now();
    shell.send({ type: 'quit' });
    expect(await shell.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(shell.messages.at(-1)).toMatchObject({ type: 'state', phase: 'off' });
    await until(() => children.every((p) => !isAlive(p)), { timeoutMs: 5000, what: 'child processes to exit', detail: () => `alive ${JSON.stringify(children.filter(isAlive))}` });
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
    // The aborted first-run check wrote nothing (the next start checks again).
    expect(fs.existsSync(path.join(dir, 'system-check.json'))).toBe(false);
    hang.closeAllConnections();
  });

  it('{"type":"quit"} exits 0; autostart is unsupported without SWARMCAST_DESKTOP_EXE', async () => {
    const dir = tmpDir();
    writeConfig(dir, await allocAppPorts());
    const shell = new FakeShell(dir, tmpDir('sc-home-'), ['--no-autostart'], { SWARMCAST_WEB_DIR: webDir() });
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
    const ports = await allocAppPorts();
    writeConfig(dir, ports);
    const other = net.createServer();
    servers.push(other);
    await new Promise<void>((r) => other.listen(ports.rtmp, '127.0.0.1', () => r()));
    const shell = new FakeShell(dir, tmpDir('sc-home-'));
    const fatal = await shell.next(isFatal);
    expect(fatal.code).toBe('ports-busy');
    expect(fatal.message).toContain(String(ports.rtmp));
    expect(await shell.exited).not.toBe(0);
    expect(shell.messages.some(isReady)).toBe(false);
  });

  it('fatal "already-running" when another SwarmCast answers on the panel port', async () => {
    const ports = await allocAppPorts();
    const firstDir = tmpDir();
    writeConfig(firstDir, ports);
    const first = new FakeShell(firstDir, tmpDir('sc-home-'), ['--no-autostart'], { SWARMCAST_WEB_DIR: webDir() });
    await first.next(isReady);

    const secondDir = tmpDir();
    writeConfig(secondDir, ports);
    const second = new FakeShell(secondDir, tmpDir('sc-home-'), ['--no-autostart']);
    const fatal = await second.next(isFatal);
    expect(fatal.code).toBe('already-running');
    expect(await second.exited).toBe(1);

    first.send({ type: 'quit' });
    expect(await first.exited).toBe(0);
  });
});
