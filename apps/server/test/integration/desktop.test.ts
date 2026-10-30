import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { isListening } from '../../src/core/ports.js';
import type { DesktopOutMessage, DesktopStateMessage } from '../../src/desktop/protocol.js';
import { allocAppPorts, hangingServer, isAlive, POSIX, ServerProcess, signIn, stopTracked, tmpDir, until, writeConfig, type Panel, type Ports } from './helpers.js';

// The real server started like the desktop shell does (`--desktop`), driven over stdio by this
// test acting as the shell. Its own data folder, HOME and ports (never the user's SwarmCast data,
// LaunchAgents or a SwarmCast already running on this computer). The process-tree checks need
// `ps`, and the autostart entries are the macOS and Linux ones: POSIX only.
// Logging in like the webview: /auth/<token> answers 200 with the cookie and a page that opens /
// itself (no redirect: the cookie is SameSite=Strict), and the token never shows in that page.
// Unknown or broken stdin lines are ignored: the first test sends some mid-way and carries on.
// The first-run system check asks whether GitHub is reachable: here it asks a local stand-in
// (SWARMCAST_GITHUB_URL), so the result is known and no test depends on the internet.

/** A quit while the network hangs (speed test, tunnel check) ends within this. */
const QUIT_WHILE_HUNG_MS = 5000;

afterEach(stopTracked);

type Ready = Extract<DesktopOutMessage, { type: 'ready' }>;
const isReady = (m: DesktopOutMessage): m is Ready => m.type === 'ready';
const isFatal = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'fatal' }> => m.type === 'fatal';
const isChannel = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'update-channel' }> => m.type === 'update-channel';
const isType =
  <T extends DesktopOutMessage['type']>(type: T) =>
  (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: T }> =>
    m.type === type;

/** A folder like the desktop app's resources: web/admin and web/viewer (SWARMCAST_WEB_DIR). */
function webDir(): string {
  const dir = tmpDir('sc-web-');
  fs.mkdirSync(path.join(dir, 'admin'));
  fs.mkdirSync(path.join(dir, 'viewer'));
  fs.writeFileSync(path.join(dir, 'admin', 'index.html'), '<!doctype html><title>desktop test panel</title>');
  fs.writeFileSync(path.join(dir, 'viewer', 'index.html'), '<!doctype html><title>viewer</title>');
  return dir;
}

/** SwarmCast in desktop mode, as the shell starts it, with its own data folder (config on `ports`). */
function desktop(o: { ports: Ports; args?: string[]; env?: Record<string, string>; config?: Record<string, unknown>; tunnel?: boolean; dataDir?: string; home?: string }): ServerProcess {
  const dataDir = o.dataDir ?? tmpDir();
  if (!o.dataDir) writeConfig(dataDir, o.ports, o.config);
  return new ServerProcess({
    name: 'SwarmCast --desktop',
    args: ['--desktop', ...(o.tunnel ? [] : ['--no-tunnel']), ...(o.args ?? [])],
    dataDir,
    home: o.home,
    stdin: true,
    env: { SWARMCAST_DESKTOP_VERSION: '9.9.9-test', ...o.env },
  });
}

/** A local stand-in for github.com that answers every request at once (the check only needs an answer). */
async function githubStandIn(): Promise<string> {
  const server = http.createServer((_req, res) => res.end());
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** The first state message for `phase` from index `from` on. */
function phase(server: ServerProcess, p: DesktopStateMessage['phase'], from = 0): Promise<DesktopStateMessage> {
  return server.next((m): m is DesktopStateMessage => m.type === 'state' && m.phase === p, `phase ${p}`, { from });
}

/** Signs in with the panel address of `ready` and opens / with the cookie, like the webview. */
async function webviewLogin(ready: Ready): Promise<{ panel: Panel; page: string; root: number }> {
  const panel = await signIn(ready.adminUrl);
  const root = (await fetch(`${panel.base}/`, { headers: { cookie: panel.cookie } })).status;
  return { panel, page: panel.login.page, root };
}

/** The JSON answer of a panel API GET. */
function getJson(panel: Panel, p: string) {
  return panel.api(p).then((r) => r.json());
}

/** Resolves once every pid in `pids` is gone. */
function gone(pids: number[], timeoutMs = 10_000): Promise<void> {
  return until(() => pids.every((p) => !isAlive(p)), { timeoutMs, what: 'the child processes to exit', detail: () => `alive ${JSON.stringify(pids.filter(isAlive))}` });
}

describe.skipIf(!POSIX)('desktop mode (--desktop) driven by a fake shell', () => {
  it('ready, panel login, state on every change, clicks, update status, autostart, first-run check, quit', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const home = tmpDir('sc-home-');
    const exe = process.platform === 'darwin' ? '/Applications/Swarm Cast Test.app/Contents/MacOS/SwarmCast' : '/opt/Swarm Cast Test/swarmcast-desktop';
    const entry = process.platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'io.github.lucas-angelo.swarmcast.plist') : path.join(home, '.config', 'autostart', 'swarmcast.desktop');
    const server = desktop({ ports, home, env: { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_DESKTOP_EXE: exe, SWARMCAST_GITHUB_URL: await githubStandIn() } });
    // Act
    const ready = await server.next(isReady, 'ready');
    const { panel, page, root } = await webviewLogin(ready);
    await phase(server, 'waiting-obs');
    // Assert
    expect(ready.adminUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${ports.admin}/auth/[A-Za-z0-9_-]+$`));
    expect(ready.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(server.messages.filter(isReady)).toHaveLength(1);
    expect(panel.login.status).toBe(200);
    expect(page).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(page).not.toContain(new URL(ready.adminUrl).pathname.slice('/auth/'.length));
    expect(panel.cookie.split('; ').some((c) => c.startsWith(`${ADMIN_COOKIE}=`))).toBe(true);
    expect(root).toBe(200);
    expect(server.logLines.join('\n')).not.toContain('/auth/');
    expect(await isListening(ports.rtmp)).toBe(true);
    // Act
    let from = server.messages.length;
    server.send({ type: 'click', id: 'stop' });
    await phase(server, 'stopping', from);
    const off = await phase(server, 'off', from);
    // Assert
    expect(off).toMatchObject({ state: 'off', canStart: true, canStop: false, viewers: 0, tooltip: 'SwarmCast: off' });
    // Act
    from = server.messages.length;
    server.send({ type: 'click', id: 'start' });
    await phase(server, 'starting', from);
    const waiting = await phase(server, 'waiting-obs', from);
    server.send('garbage\n{"type":"click","id":"rm"}\n');
    // Assert
    expect(waiting).toMatchObject({ state: 'waiting', canStop: true });
    // Act
    const before = await getJson(panel, '/api/desktop');
    server.send({ type: 'update', update: { status: 'available', current: '9.9.9-test', version: '10.0.0', notes: 'Better things' } });
    await until(async () => (await getJson(panel, '/api/desktop')).update?.version === '10.0.0', { timeoutMs: 5000, what: 'the update status in the panel', abortOn: [server.proc] });
    from = server.messages.length;
    const check = await panel.api('/api/desktop/update/check', { method: 'POST', body: '{}' });
    await server.next(isType('update-check'), 'update-check', { from });
    await panel.api('/api/desktop/update/install', { method: 'POST', body: '{}' });
    await server.next(isType('update-install'), 'update-install', { from });
    // Assert
    expect(before).toMatchObject({ desktop: true, version: '9.9.9-test', autostart: { supported: true, enabled: false }, update: null });
    expect(check.status).toBe(200);
    // Act
    const on = await (await panel.api('/api/desktop/autostart', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).json();
    const entryWhenOn = fs.readFileSync(entry, 'utf8');
    const reportedOn = (await getJson(panel, '/api/desktop')).autostart;
    const offAgain = await (await panel.api('/api/desktop/autostart', { method: 'PUT', body: JSON.stringify({ enabled: false }) })).json();
    // Assert
    expect(on.autostart).toEqual({ supported: true, enabled: true });
    expect(entryWhenOn).toContain(process.platform === 'darwin' ? exe : 'Swarm Cast Test');
    expect(reportedOn).toMatchObject({ enabled: true });
    expect(offAgain.autostart.enabled).toBe(false);
    expect(fs.existsSync(entry)).toBe(false);
    // Act
    const checkFile = path.join(server.dataDir, 'system-check.json');
    await until(() => fs.existsSync(checkFile), { timeoutMs: 40_000, what: 'system-check.json', abortOn: [server.proc] });
    await until(async () => (await getJson(panel, '/api/desktop')).systemCheck === 'done', { timeoutMs: 5000, what: 'the system check to be done', abortOn: [server.proc] });
    const systemCheck = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    const served = await panel.api('/api/system-check');
    // Assert
    expect(systemCheck).toMatchObject({ version: 1, source: 'desktop', appVersion: ready.version });
    expect(systemCheck.results.map((r: { id: string }) => r.id)).toEqual(['os', 'ram', 'cpu', 'upload', 'download', 'disk', 'ports', 'obs', 'github', 'release']);
    expect(systemCheck.results.find((r: { id: string }) => r.id === 'ports')).toMatchObject({ status: 'ok', value: 'free' });
    expect(systemCheck.results.find((r: { id: string }) => r.id === 'upload')).toMatchObject({ status: 'skipped' });
    expect(systemCheck.results.find((r: { id: string }) => r.id === 'github')).toMatchObject({ status: 'ok', value: 'reachable' });
    expect(served.status).toBe(200);
    // Act
    const children = server.children();
    from = server.messages.length;
    server.send({ type: 'click', id: 'quit' });
    const code = await server.exited;
    await gone(children);
    // Assert
    expect(children.length).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(server.messages.slice(from).some((m) => m.type === 'state' && m.phase === 'off')).toBe(true);
    for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
    expect(server.brokenLines).toEqual([]);
  });

  it('stdin closing (the shell is gone) stops everything and exits 0', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const server = desktop({ ports, env: { SWARMCAST_WEB_DIR: webDir() } });
    await server.next(isReady, 'ready');
    await phase(server, 'waiting-obs');
    const children = server.children();
    // Act
    server.proc.child.stdin!.end();
    const code = await server.exited;
    await gone(children);
    // Assert
    expect(code).toBe(0);
    expect(await isListening(ports.rtmp)).toBe(false);
  });

  it('quit right away while the live is starting and the first-run speed test hangs: exit in under 5 s, nothing left', async () => {
    // Arrange
    const hang = await hangingServer();
    onTestFinished(() => hang.close());
    const ports = await allocAppPorts();
    const server = desktop({
      ports,
      tunnel: true,
      config: { speedTest: { enabled: true, intervalMinutes: 15 }, tunnel: { provider: 'external', externalUrl: hang.url } },
      env: { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_SPEEDTEST_URL: hang.url, SWARMCAST_GITHUB_URL: hang.url },
    });
    await server.next(isReady, 'ready');
    await phase(server, 'starting');
    await until(() => hang.requests.some((u) => u.startsWith('/__down')) && hang.requests.includes('/healthz'), {
      timeoutMs: 20_000,
      what: 'the speed test and the tunnel check to hang',
      abortOn: [server.proc],
      detail: () => `requests ${JSON.stringify(hang.requests)}`,
      on: [[hang.server, 'request']],
    });
    const children = server.children();
    // Act
    const quitAt = Date.now();
    server.send({ type: 'quit' });
    const code = await server.exited;
    const quitMs = Date.now() - quitAt;
    await gone(children, 5000);
    // Assert
    expect(children.length).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(quitMs).toBeLessThan(QUIT_WHILE_HUNG_MS);
    expect(server.messages.at(-1)).toMatchObject({ type: 'state', phase: 'off' });
    for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
    expect(fs.existsSync(path.join(server.dataDir, 'system-check.json'))).toBe(false);
  });

  it('{"type":"quit"} exits 0; autostart is unsupported without SWARMCAST_DESKTOP_EXE', async () => {
    // Arrange
    const server = desktop({ ports: await allocAppPorts(), args: ['--no-autostart'], env: { SWARMCAST_WEB_DIR: webDir() } });
    const ready = await server.next(isReady, 'ready');
    const off = await phase(server, 'off');
    const { panel } = await webviewLogin(ready);
    // Act
    const d = await getJson(panel, '/api/desktop');
    server.send({ type: 'quit' });
    const code = await server.exited;
    // Assert
    expect(off).toMatchObject({ canStart: true });
    expect(d.autostart).toEqual({ supported: false, enabled: false });
    expect(code).toBe(0);
  });

  it('fatal "ports-busy" when the OBS port is used by another program', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const other = net.createServer();
    onTestFinished(() => new Promise<void>((resolve) => other.close(() => resolve())));
    await new Promise<void>((resolve) => other.listen(ports.rtmp, '127.0.0.1', () => resolve()));
    // Act
    const server = desktop({ ports });
    const fatal = await server.next(isFatal, 'fatal');
    const code = await server.exited;
    // Assert
    expect(fatal.code).toBe('ports-busy');
    expect(fatal.message).toContain(String(ports.rtmp));
    expect(code).not.toBe(0);
    expect(server.messages.some(isReady)).toBe(false);
  });

  it('fatal "already-running" when another SwarmCast answers on the panel port', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const first = desktop({ ports, args: ['--no-autostart'], env: { SWARMCAST_WEB_DIR: webDir() } });
    await first.next(isReady, 'ready');
    // Act
    const second = desktop({ ports, args: ['--no-autostart'] });
    const fatal = await second.next(isFatal, 'fatal');
    const secondCode = await second.exited;
    first.send({ type: 'quit' });
    const firstCode = await first.exited;
    // Assert
    expect(fatal.code).toBe('already-running');
    expect(secondCode).toBe(1);
    expect(firstCode).toBe(0);
  });
});

describe.skipIf(!POSIX)('desktop mode: update channel ("Get beta versions")', () => {
  it('sent right after ready, changed from the panel, saved in config.json and sent again at the next start', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const env = { SWARMCAST_WEB_DIR: webDir(), SWARMCAST_DESKTOP_VERSION: '0.2.2' };
    const first = desktop({ ports, args: ['--no-autostart'], env });
    const ready = await first.next(isReady, 'ready');
    const { panel } = await webviewLogin(ready);
    // Act
    const initial = await first.next(isChannel, 'the update channel', { timeoutMs: 10_000 });
    const initialView = (await getJson(panel, '/api/desktop')).updateChannel;
    // Assert
    expect(initial.channel).toBeNull();
    expect(first.messages.findIndex(isChannel)).toBe(first.messages.findIndex(isReady) + 1);
    expect(initialView).toEqual({ choice: null, effective: 'stable' });
    // Act
    const from = first.messages.length;
    const put = await panel.api('/api/desktop/update/channel', { method: 'PUT', body: JSON.stringify({ channel: 'beta' }) });
    const putBody = await put.json();
    const changed = await first.next(isChannel, 'the new update channel', { from, timeoutMs: 5000 });
    first.send({ type: 'update', update: { status: 'available', current: '0.2.2', version: '0.3.0-beta.1' } });
    await until(async () => (await getJson(panel, '/api/desktop')).updateChecking === false, { timeoutMs: 5000, what: 'the check to end', abortOn: [first.proc] });
    // Assert
    expect(put.status).toBe(200);
    expect(putBody).toMatchObject({ updateChannel: { choice: 'beta', effective: 'beta' }, updateChecking: true });
    expect(changed.channel).toBe('beta');
    expect(JSON.parse(fs.readFileSync(path.join(first.dataDir, 'config.json'), 'utf8')).updates).toEqual({ channel: 'beta' });
    // Act
    first.send({ type: 'quit' });
    const firstCode = await first.exited;
    const second = desktop({ ports, args: ['--no-autostart'], env, dataDir: first.dataDir, home: first.home });
    await second.next(isReady, 'ready');
    const remembered = await second.next(isChannel, 'the update channel', { timeoutMs: 10_000 });
    second.send({ type: 'quit' });
    const secondCode = await second.exited;
    // Assert
    expect(firstCode).toBe(0);
    expect(remembered.channel).toBe('beta');
    expect(secondCode).toBe(0);
  });
});
