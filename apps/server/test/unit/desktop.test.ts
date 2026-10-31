import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { effectiveUpdateChannel, isPrereleaseVersion, type DesktopUpdate, type UpdateChannel } from '@swarmcast/shared';
import { configSchema, defaultConfig } from '../../src/core/config.js';
import { resolvePaths } from '../../src/core/paths.js';
import { abortable, QuitAbortError, sleep, withRetries } from '../../src/core/retry.js';
import { Autostart } from '../../src/desktop/autostart.js';
import { createProtocolWriter, DesktopBridge } from '../../src/desktop/bridge.js';
import {
  decodeDesktopMessage,
  decodeShellMessage,
  desktopStateFor,
  encodeDesktopMessage,
  encodeShellMessage,
  fatalCodeOf,
  MAX_SHELL_LINE,
  PROTOCOL_PREFIX,
  sameDesktopState,
  StartupError,
  type DesktopOutMessage,
} from '../../src/desktop/protocol.js';
import { HlsOrigin } from '../../src/hls/origin.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { QualityManager } from '../../src/quality/manager.js';
import { TrackerService } from '../../src/tracker/tracker.js';
import { AccessControl } from '../../src/access/access.js';
import { silentLog, tempDir } from './helpers.js';
import { makeController, panelServer } from './live-helpers.js';

// The desktop app (Tauri shell + this server as its sidecar): the line protocol between them,
// the bridge behind the panel's desktop routes, the update channel, and ffmpeg's install retries.

/** A bridge for an app of `version`, with autostart for `exe` in a fresh HOME; what it sends to the shell. */
function bridge(o: { version?: string; serverVersion?: string; exe?: string } = {}) {
  const sent: DesktopOutMessage[] = [];
  const home = tempDir('sc-home-');
  const autostart = new Autostart({ exe: o.exe, platform: 'linux', home, env: {} });
  const b = new DesktopBridge({ version: o.version ?? '1.2.3', serverVersion: o.serverVersion ?? o.version ?? '1.2.3', autostart, send: (m) => sent.push(m) });
  return { bridge: b, sent, home };
}

/** The panel with `desktop` (none: script mode), for app.inject(). */
async function desktopPanel(desktop?: DesktopBridge) {
  const { live } = makeController();
  return panelServer({ live, desktop });
}

describe('desktop protocol: server → shell', () => {
  it('state messages extend the tray state with phase and viewers', () => {
    // Act
    const off = desktopStateFor('off', 0);
    const live = desktopStateFor('live', 3);
    const waiting = desktopStateFor('waiting-obs', 7);
    const stopping = desktopStateFor('stopping', 0);
    // Assert
    expect(off).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false, phase: 'off', viewers: 0 });
    expect(live).toEqual({ type: 'state', state: 'live', tooltip: 'SwarmCast: live · 3 viewers', canStart: false, canStop: true, phase: 'live', viewers: 3 });
    expect(waiting).toMatchObject({ state: 'waiting', phase: 'waiting-obs', viewers: 0 });
    expect(stopping).toMatchObject({ state: 'waiting', phase: 'stopping', canStop: true });
  });

  it('a state is sent again only when it changed, also when only the phase did (the shell follows the phase)', () => {
    // Act
    const first = sameDesktopState(null, desktopStateFor('off', 0));
    const same = sameDesktopState(desktopStateFor('live', 2), desktopStateFor('live', 2));
    const otherPhase = sameDesktopState(desktopStateFor('starting', 0), desktopStateFor('waiting-obs', 0));
    // Assert
    expect(first).toBe(false);
    expect(same).toBe(true);
    expect(otherPhase).toBe(false);
  });

  it.each<DesktopOutMessage>([
    { type: 'ready', adminUrl: 'http://127.0.0.1:8081/auth/abc', version: '0.2.0' },
    desktopStateFor('live', 1),
    { type: 'fatal', code: 'already-running', message: 'line one\nline "two"' },
    { type: 'update-check' },
    { type: 'update-install' },
  ])('encodes $type as one whole prefixed line and decodes it back', (m) => {
    // Act
    const line = encodeDesktopMessage(m);
    // Assert
    expect(line.startsWith(PROTOCOL_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(decodeDesktopMessage(line.slice(0, -1))).toEqual(m);
  });

  it.each([
    ['a log line', '{"level":"info"}'],
    ['the prefix without JSON', `${PROTOCOL_PREFIX}not json`],
  ])('ignores %s', (_what, line) => {
    // Act
    const m = decodeDesktopMessage(line);
    // Assert
    expect(m).toBeNull();
  });

  it('fatal codes', () => {
    // Act
    const coded = fatalCodeOf(new StartupError('ports-busy', 'x'));
    const other = fatalCodeOf(new Error('Invalid config file'));
    // Assert
    expect(coded).toBe('ports-busy');
    expect(other).toBe('startup-failed');
  });
});

describe('desktop protocol: shell → server', () => {
  it.each([
    ['{"type":"click","id":"start"}', { type: 'click', id: 'start' }],
    ['{"type":"click","id":"stop"}', { type: 'click', id: 'stop' }],
    ['{"type":"click","id":"quit"}', { type: 'click', id: 'quit' }],
    ['{"type":"quit"}', { type: 'quit' }],
  ])('accepts %s', (line, msg) => {
    // Act
    const m = decodeShellMessage(line);
    // Assert
    expect(m).toEqual(msg);
  });

  it.each([
    ['an unknown click', '{"type":"click","id":"open"}'],
    ['a click without an id', '{"type":"click"}'],
    ['an unknown type', '{"type":"rm -rf"}'],
    ['an array', '[1]'],
    ['null', 'null'],
    ['not JSON', 'nope'],
    ['a line over MAX_SHELL_LINE', JSON.stringify({ type: 'quit', pad: 'x'.repeat(MAX_SHELL_LINE) })],
  ])('ignores %s', (_what, line) => {
    // Act
    const m = decodeShellMessage(line);
    // Assert
    expect(m).toBeNull();
  });

  it('validates update status: known fields only, progress clamped, notes cut at 20,000 characters', () => {
    // Act
    const available = decodeShellMessage('{"type":"update","status":"available","current":"0.1.0","version":"0.2.0","notes":"Fixes","extra":1}');
    const downloading = decodeShellMessage('{"type":"update","status":"downloading","progress":1.2}');
    const long = decodeShellMessage(JSON.stringify({ type: 'update', status: 'available', version: '9', notes: 'n'.repeat(30_000) }));
    // Assert
    expect(available).toEqual({ type: 'update', update: { status: 'available', current: '0.1.0', version: '0.2.0', notes: 'Fixes' } });
    expect(downloading).toEqual({ type: 'update', update: { status: 'downloading', progress: 1 } });
    expect(long?.type === 'update' && long.update.notes?.length).toBe(20_000);
  });

  it.each([
    ['an unknown status', '{"type":"update","status":"great"}'],
    ['a non-string error', '{"type":"update","status":"error","error":5}'],
  ])('refuses an update message with %s', (_what, line) => {
    // Act
    const m = decodeShellMessage(line);
    // Assert
    expect(m).toBeNull();
  });

  it('round-trips through the encoder the tests use as the fake shell', () => {
    // Arrange
    const update: DesktopUpdate = { status: 'error', version: '0.2.0', error: 'signature mismatch' };
    // Act
    const m = decodeShellMessage(encodeShellMessage({ type: 'update', update }).trim());
    // Assert
    expect(m).toEqual({ type: 'update', update });
  });
});

describe('protocol writer', () => {
  it('writes one line per message', async () => {
    // Arrange
    const s = new PassThrough();
    let text = '';
    s.on('data', (d) => (text += d));
    const w = createProtocolWriter(s);
    // Act
    w.send({ type: 'update-check' });
    await w.flush();
    // Assert
    expect(text).toBe(`${PROTOCOL_PREFIX}{"type":"update-check"}\n`);
  });

  it('survives a closed reader (EPIPE)', async () => {
    // Arrange
    const s = new PassThrough();
    const w = createProtocolWriter(s);
    s.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    // Act
    const send = () => w.send({ type: 'update-install' });
    // Assert
    expect(send).not.toThrow();
    await expect(w.flush()).resolves.toBeUndefined();
  });
});

describe('DesktopBridge', () => {
  it('check for updates: sends update-check, shows checking until the shell answers', () => {
    // Arrange
    const { bridge: b, sent } = bridge();
    const changed = vi.fn();
    b.on('changed', changed);
    // Act
    b.requestUpdateCheck();
    // Assert
    expect(sent).toEqual([{ type: 'update-check' }]);
    expect(b.snapshot().updateChecking).toBe(true);
    // Act
    b.setUpdate({ status: 'none', current: '1.2.3' });
    b.requestUpdateInstall();
    // Assert
    expect(b.snapshot()).toMatchObject({ updateChecking: false, update: { status: 'none' } });
    expect(sent.at(-1)).toEqual({ type: 'update-install' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('the check gives up after a while without an answer', () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { bridge: b } = bridge();
    // Act
    b.requestUpdateCheck();
    vi.advanceTimersByTime(61_000);
    // Assert
    expect(b.snapshot().updateChecking).toBe(false);
  });
});

describe('desktop admin API', () => {
  it('script mode: { desktop: false } and the actions fail', async () => {
    // Arrange
    const { app, headers } = await desktopPanel();
    // Act
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    const autostart = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: headers.json, payload: { enabled: true } });
    const check = await app.inject({ method: 'POST', url: '/api/desktop/update/check', headers: headers.json, payload: {} });
    // Assert
    expect(info.json()).toEqual({ desktop: false });
    expect(autostart.statusCode).toBe(400);
    expect(autostart.json()).toMatchObject({ code: 'err.desktop.only' });
    expect(check.statusCode).toBe(400);
  });

  it('desktop mode: the info', async () => {
    // Arrange
    const { bridge: b } = bridge({ version: '2.0.0', serverVersion: '1.9.0', exe: '/opt/SwarmCast/swarmcast-desktop' });
    const { app, headers } = await desktopPanel(b);
    // Act
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    // Assert
    expect(info.json()).toEqual({ desktop: true, version: '2.0.0', serverVersion: '1.9.0', autostart: { supported: true, enabled: false }, update: null, updateChecking: false, updateChannel: { choice: null, effective: 'stable' }, systemCheck: 'idle' });
  });

  it('desktop mode: autostart toggles; the OS entry is the source of truth, read back', async () => {
    // Arrange
    const { bridge: b, home } = bridge({ exe: '/opt/SwarmCast/swarmcast-desktop' });
    const { app, headers } = await desktopPanel(b);
    const entry = path.join(home, '.config', 'autostart', 'swarmcast.desktop');
    // Act
    const on = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: headers.json, payload: { enabled: true } });
    // Assert
    expect(on.statusCode).toBe(200);
    expect(on.json().autostart).toEqual({ supported: true, enabled: true });
    expect(fs.existsSync(entry)).toBe(true);
    // Act
    fs.rmSync(entry);
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    // Assert
    expect(info.json().autostart.enabled).toBe(false);
  });

  it('desktop mode: validation and auth', async () => {
    // Arrange
    const { bridge: b } = bridge({ exe: '/opt/SwarmCast/swarmcast-desktop' });
    const { app, headers } = await desktopPanel(b);
    // Act
    const notABoolean = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: headers.json, payload: { enabled: 'yes' } });
    const noCookieWrite = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: { ...headers.json, cookie: '' }, payload: { enabled: true } });
    const noCookieRead = await app.inject({ method: 'GET', url: '/api/desktop', headers: { host: headers.host } });
    // Assert
    expect(notABoolean.statusCode).toBe(400);
    expect(noCookieWrite.statusCode).toBe(401);
    expect(noCookieRead.statusCode).toBe(401);
  });

  it('desktop mode: update check and install go to the shell; its answer shows', async () => {
    // Arrange
    const { bridge: b, sent } = bridge({ version: '2.0.0', exe: '/opt/SwarmCast/swarmcast-desktop' });
    const { app, headers } = await desktopPanel(b);
    // Act
    const check = await app.inject({ method: 'POST', url: '/api/desktop/update/check', headers: headers.json, payload: {} });
    // Assert
    expect(check.json().updateChecking).toBe(true);
    expect(sent).toEqual([{ type: 'update-check' }]);
    // Act
    b.setUpdate({ status: 'available', version: '2.1.0', current: '2.0.0', notes: 'New' });
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    await app.inject({ method: 'POST', url: '/api/desktop/update/install', headers: headers.json, payload: {} });
    // Assert
    expect(info.json()).toMatchObject({ updateChecking: false, update: { status: 'available', version: '2.1.0' } });
    expect(sent.at(-1)).toEqual({ type: 'update-install' });
  });
});

describe('desktop update channel ("Get beta versions")', () => {
  /** The panel of a desktop app of `version` whose saved channel is `saved`; the saves it makes. */
  async function channelPanel(version: string, saved?: UpdateChannel) {
    const { bridge: b, sent } = bridge({ version, exe: '/opt/x' });
    let stored = saved;
    const saves: UpdateChannel[] = [];
    b.useUpdateChannel({ get: () => stored, save: (c) => void (saves.push(c), (stored = c)) });
    const { app, headers } = await desktopPanel(b);
    const put = (payload: unknown, h: Record<string, string> = headers.json) => app.inject({ method: 'PUT', url: '/api/desktop/update/channel', headers: h, payload: payload as Record<string, unknown> });
    return { app, headers, bridge: b, sent, saves, put };
  }

  it.each<[UpdateChannel | null | undefined, string, UpdateChannel]>([
    [null, '0.2.2', 'stable'],
    [undefined, '0.3.0-beta.1', 'beta'],
    [null, '0.3.0-rc.1+b7', 'beta'],
    [null, '0.3.0+b7', 'stable'],
    ['stable', '0.3.0-beta.1', 'stable'],
    ['beta', '0.2.2', 'beta'],
  ])('the effective channel: the choice (%s), else beta for a pre-release (%s), else stable → %s', (choice, version, effective) => {
    // Act
    const e = effectiveUpdateChannel(choice, version);
    // Assert
    expect(e).toBe(effective);
  });

  it.each([
    ['0.0.0-test.1', true],
    ['1.2.3', false],
  ])('%s is a pre-release: %s', (version, pre) => {
    // Act
    const p = isPrereleaseVersion(version);
    // Assert
    expect(p).toBe(pre);
  });

  it('off by default on a stable app; the shell is told the saved choice', async () => {
    // Arrange
    const { app, headers, bridge: b, sent } = await channelPanel('0.2.2');
    // Act
    b.sendUpdateChannel();
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    // Assert
    expect(sent).toEqual([{ type: 'update-channel', channel: null }]);
    expect(info.json()).toMatchObject({ updateChannel: { choice: null, effective: 'stable' }, updateChecking: false });
  });

  it('turning it on saves it, tells the shell and shows "checking" until the shell answers; back to stable likewise', async () => {
    // Arrange
    const { bridge: b, sent, saves, put } = await channelPanel('0.2.2');
    // Act
    const beta = await put({ channel: 'beta' });
    // Assert
    expect(beta.statusCode).toBe(200);
    expect(beta.json()).toMatchObject({ updateChannel: { choice: 'beta', effective: 'beta' }, updateChecking: true });
    expect(saves).toEqual(['beta']);
    expect(sent.at(-1)).toEqual({ type: 'update-channel', channel: 'beta' });
    // Act
    b.setUpdate({ status: 'available', version: '0.3.0-beta.1', current: '0.2.2' });
    // Assert
    expect(b.snapshot().updateChecking).toBe(false);
    // Act
    const stable = await put({ channel: 'stable' });
    // Assert
    expect(stable.json()).toMatchObject({ updateChannel: { choice: 'stable', effective: 'stable' }, updateChecking: true });
    expect(sent.at(-1)).toEqual({ type: 'update-channel', channel: 'stable' });
  });

  it('a beta app is on beta until the streamer says otherwise; same channel again: no check', async () => {
    // Arrange
    const { app, headers, sent, put } = await channelPanel('0.3.0-beta.1');
    // Act
    const info = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers.get });
    const same = await put({ channel: 'beta' });
    // Assert
    expect(info.json().updateChannel).toEqual({ choice: null, effective: 'beta' });
    expect(same.json()).toMatchObject({ updateChannel: { choice: 'beta', effective: 'beta' }, updateChecking: false });
    expect(sent).toEqual([{ type: 'update-channel', channel: 'beta' }]);
  });

  it.each([[{ channel: 'nightly' }], [{ channel: null }], [{}]])('refuses %j and saves nothing', async (payload) => {
    // Arrange
    const { saves, put } = await channelPanel('0.2.2', 'stable');
    // Act
    const r = await put(payload);
    // Assert
    expect(r.statusCode).toBe(400);
    expect(saves).toEqual([]);
  });

  it('refuses a change without the panel cookie', async () => {
    // Arrange
    const { headers, saves, put } = await channelPanel('0.2.2', 'stable');
    // Act
    const r = await put({ channel: 'beta' }, { ...headers.json, cookie: '' });
    // Assert
    expect(r.statusCode).toBe(401);
    expect(saves).toEqual([]);
  });

  it('config.json: absent is automatic, the choice is kept, an unknown channel is invalid', () => {
    // Act
    const absent = defaultConfig().updates;
    const beta = configSchema.parse({ updates: { channel: 'beta' } }).updates.channel;
    const nightly = configSchema.safeParse({ updates: { channel: 'nightly' } }).success;
    // Assert
    expect(absent).toEqual({});
    expect(beta).toBe('beta');
    expect(nightly).toBe(false);
  });
});

describe('ffmpeg install with retries', () => {
  it('withRetries: first try + one per delay, then gives up with the last error', async () => {
    // Arrange
    const waits: number[] = [];
    let n = 0;
    const failing = async () => {
      n++;
      throw new Error(`fail ${n}`);
    };
    // Act
    const result = withRetries(failing, [2000, 5000, 10_000], { sleep: async (ms) => void waits.push(ms) });
    // Assert
    await expect(result).rejects.toThrow('fail 4');
    expect(waits).toEqual([2000, 5000, 10_000]);
  });

  it('withRetries: the value of the first try that succeeds', async () => {
    // Act
    const value = await withRetries(async (a) => (a < 2 ? Promise.reject(new Error('x')) : a), [1], { sleep: async () => {} });
    // Assert
    expect(value).toBe(2);
  });

  // The wait between tries is the subject: fake timers, so "stops at once" needs no clock of its own.
  it('quitting (signal) during the wait between tries stops the retries and the wait', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const ac = new AbortController();
    let n = 0;
    const result = withRetries(
      async () => {
        n++;
        throw new Error('offline');
      },
      [60_000, 60_000],
      { signal: ac.signal },
    );
    await vi.advanceTimersByTimeAsync(50);
    const waitingBeforeAbort = vi.getTimerCount();
    // Act
    ac.abort();
    // Assert
    await expect(result).rejects.toThrow('quitting');
    expect(waitingBeforeAbort).toBe(1);
    expect(n).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('already quitting: no retry at all, the error of the only try', async () => {
    // Arrange
    const ac = new AbortController();
    ac.abort();
    // Act
    const result = withRetries(async () => Promise.reject(new Error('once')), [1], { signal: ac.signal });
    // Assert
    await expect(result).rejects.toThrow('once');
  });

  it('sleep rejects at once when already quitting', async () => {
    // Arrange
    const ac = new AbortController();
    ac.abort();
    // Act
    const slept = sleep(60_000, ac.signal);
    // Assert
    await expect(slept).rejects.toBeInstanceOf(QuitAbortError);
  });

  it('abortable: rejects on abort, passes the value through otherwise', async () => {
    // Arrange
    const late = new AbortController();
    const pending = abortable(new Promise(() => {}), late.signal);
    // Act
    late.abort();
    // Assert
    await expect(pending).rejects.toBeInstanceOf(QuitAbortError);
    expect(await abortable(Promise.resolve(7), new AbortController().signal)).toBe(7);
  });

  /** A QualityManager whose ffmpeg install fails until try `okFrom`; counts the tries. */
  function qualityManager(okFrom: { value: number }) {
    const dataDir = tempDir('sc-ff-');
    const tracker = new TrackerService(new AccessControl(), silentLog);
    onTestFinished(() => tracker.close());
    const tries = { n: 0 };
    const q = new QualityManager({
      config: defaultConfig(),
      saveConfig: () => {},
      origin: new HlsOrigin('http://127.0.0.1:9/', silentLog),
      limiter: new BandwidthLimiter(1_000_000),
      tracker,
      log: silentLog,
      reaper: null,
      binDir: '/nonexistent',
      dataDir,
      runDir: dataDir,
      rtmpReadUrl: 'rtmp://127.0.0.1:9/live/k',
      mediamtxHlsUrl: 'http://127.0.0.1:9/live/k/',
      streamKey: 'sc_testtesttest',
      speedTest: () => undefined,
      warn: () => {},
      probe: async () => [],
      cpuTest: async () => [],
      installFfmpeg: async (_dir, _log, onProgress) => {
        tries.n++;
        onProgress?.({ phase: 'downloading', receivedBytes: 10 });
        if (tries.n < okFrom.value) throw new Error('network down');
        return path.join(dataDir, 'ffmpeg');
      },
    });
    const phases: string[] = [];
    q.on('changed', () => q.install && phases.push(`${q.install.phase}:${q.install.attempt ?? '-'}`));
    return { q, tries, phases };
  }

  it('QualityManager shows "retrying" between tries, and a click on Install while waiting starts no second download', async () => {
    // Arrange
    const { q, tries, phases } = qualityManager({ value: 3 });
    const sleeps: number[] = [];
    const clicks: Array<Promise<string>> = [];
    // Act
    await q.installFfmpegWithRetries([2000, 5000, 10_000], async (ms) => {
      sleeps.push(ms);
      clicks.push(q.installFfmpeg().then(() => 'installed', (err: Error) => err.message));
    });
    // Assert
    expect(await Promise.all(clicks)).toEqual([expect.stringMatching(/already being installed/), expect.stringMatching(/already being installed/)]);
    expect(tries.n).toBe(3);
    expect(sleeps).toEqual([2000, 5000]);
    expect(phases).toContain('retrying:2');
    expect(phases).toContain('retrying:3');
    expect(q.install).toMatchObject({ phase: 'downloading', attempt: 3, attempts: 4 });
    expect(q.ffmpegAvailable).toBe(true);
  });

  it('QualityManager shows "error" (Try again) after the last try', async () => {
    // Arrange
    const { q } = qualityManager({ value: Number.POSITIVE_INFINITY });
    // Act
    const result = q.installFfmpegWithRetries([1], async () => {});
    // Assert
    await expect(result).rejects.toThrow('network down');
    expect(q.install).toMatchObject({ phase: 'error', message: 'network down', attempt: 2, attempts: 2 });
  });
});

describe('resolvePaths', () => {
  it('SWARMCAST_WEB_DIR moves the viewer and admin folders; SWARMCAST_BIN_DIR the binaries', () => {
    // Arrange
    const web = path.join(os.tmpdir(), 'sc-web');
    // Act
    const p = resolvePaths('/data', { SWARMCAST_WEB_DIR: web, SWARMCAST_BIN_DIR: '/bins' });
    // Assert
    expect(p.viewerDir).toBe(path.join(web, 'viewer'));
    expect(p.adminDir).toBe(path.join(web, 'admin'));
    expect(p.binDir).toBe(path.resolve('/bins'));
    expect(p.configFile).toBe(path.join('/data', 'config.json'));
  });

  it('without them: the build folders of the repository', () => {
    // Act
    const dev = resolvePaths('/data', {});
    // Assert
    expect(dev.adminDir).toMatch(/apps[\\/]admin[\\/]dist$/);
    expect(dev.viewerDir).toMatch(/apps[\\/]viewer[\\/]dist$/);
  });
});
