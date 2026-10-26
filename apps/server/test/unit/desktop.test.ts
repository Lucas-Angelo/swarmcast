import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, type DesktopUpdate } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfig } from '../../src/core/config.js';
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
import type { DirectMode } from '../../src/direct/direct.js';
import { HlsOrigin } from '../../src/hls/origin.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { QualityManager } from '../../src/quality/manager.js';
import { TrackerService } from '../../src/tracker/tracker.js';
import { AccessControl } from '../../src/access/access.js';
import { makeController } from './live-helpers.js';
import { silentLog } from './helpers.js';

describe('desktop protocol: server → shell', () => {
  it('state messages extend the tray state with phase and viewers', () => {
    expect(desktopStateFor('off', 0)).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false, phase: 'off', viewers: 0 });
    expect(desktopStateFor('live', 3)).toEqual({ type: 'state', state: 'live', tooltip: 'SwarmCast: live · 3 viewers', canStart: false, canStop: true, phase: 'live', viewers: 3 });
    expect(desktopStateFor('waiting-obs', 7)).toMatchObject({ state: 'waiting', phase: 'waiting-obs', viewers: 0 });
    expect(desktopStateFor('stopping', 0)).toMatchObject({ state: 'waiting', phase: 'stopping', canStop: true });
    expect(sameDesktopState(null, desktopStateFor('off', 0))).toBe(false);
    expect(sameDesktopState(desktopStateFor('live', 2), desktopStateFor('live', 2))).toBe(true);
    // Same icon and tooltip, different phase: still sent (the shell follows the phase).
    expect(sameDesktopState(desktopStateFor('starting', 0), desktopStateFor('waiting-obs', 0))).toBe(false);
  });

  it('encodes whole prefixed lines and decodes them back', () => {
    const msgs: DesktopOutMessage[] = [
      { type: 'ready', adminUrl: 'http://127.0.0.1:8081/auth/abc', version: '0.2.0' },
      desktopStateFor('live', 1),
      { type: 'fatal', code: 'already-running', message: 'line one\nline "two"' },
      { type: 'update-check' },
      { type: 'update-install' },
    ];
    for (const m of msgs) {
      const line = encodeDesktopMessage(m);
      expect(line.startsWith(PROTOCOL_PREFIX)).toBe(true);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
      expect(decodeDesktopMessage(line.slice(0, -1))).toEqual(m);
    }
    expect(decodeDesktopMessage('{"level":"info"}')).toBeNull();
    expect(decodeDesktopMessage(`${PROTOCOL_PREFIX}not json`)).toBeNull();
  });

  it('fatal codes', () => {
    expect(fatalCodeOf(new StartupError('ports-busy', 'x'))).toBe('ports-busy');
    expect(fatalCodeOf(new Error('Invalid config file'))).toBe('startup-failed');
  });
});

describe('desktop protocol: shell → server', () => {
  it('accepts clicks, quit and update status; ignores anything else', () => {
    expect(decodeShellMessage('{"type":"click","id":"start"}')).toEqual({ type: 'click', id: 'start' });
    expect(decodeShellMessage('{"type":"click","id":"stop"}')).toEqual({ type: 'click', id: 'stop' });
    expect(decodeShellMessage('{"type":"click","id":"quit"}')).toEqual({ type: 'click', id: 'quit' });
    expect(decodeShellMessage('{"type":"quit"}')).toEqual({ type: 'quit' });
    expect(decodeShellMessage('{"type":"click","id":"open"}')).toBeNull();
    expect(decodeShellMessage('{"type":"click"}')).toBeNull();
    expect(decodeShellMessage('{"type":"rm -rf"}')).toBeNull();
    expect(decodeShellMessage('[1]')).toBeNull();
    expect(decodeShellMessage('null')).toBeNull();
    expect(decodeShellMessage('nope')).toBeNull();
    expect(decodeShellMessage(JSON.stringify({ type: 'quit', pad: 'x'.repeat(MAX_SHELL_LINE) }))).toBeNull();
  });

  it('validates update status (lenient on sizes, strict on the status)', () => {
    const u = decodeShellMessage('{"type":"update","status":"available","current":"0.1.0","version":"0.2.0","notes":"Fixes","extra":1}');
    expect(u).toEqual({ type: 'update', update: { status: 'available', current: '0.1.0', version: '0.2.0', notes: 'Fixes' } });
    expect(decodeShellMessage('{"type":"update","status":"downloading","progress":1.2}')).toEqual({ type: 'update', update: { status: 'downloading', progress: 1 } });
    const long = decodeShellMessage(JSON.stringify({ type: 'update', status: 'available', version: '9', notes: 'n'.repeat(30_000) }));
    expect(long?.type === 'update' && long.update.notes?.length).toBe(20_000);
    expect(decodeShellMessage('{"type":"update","status":"great"}')).toBeNull();
    expect(decodeShellMessage('{"type":"update","status":"error","error":5}')).toBeNull();
    // Round trip with the encoder the tests use as the fake shell.
    const update: DesktopUpdate = { status: 'error', version: '0.2.0', error: 'signature mismatch' };
    expect(decodeShellMessage(encodeShellMessage({ type: 'update', update }).trim())).toEqual({ type: 'update', update });
  });
});

describe('protocol writer', () => {
  it('writes one line per message and survives a closed reader', async () => {
    const s = new PassThrough();
    let text = '';
    s.on('data', (d) => (text += d));
    const w = createProtocolWriter(s);
    w.send({ type: 'update-check' });
    await w.flush();
    expect(text).toBe(`${PROTOCOL_PREFIX}{"type":"update-check"}\n`);
    s.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    expect(() => w.send({ type: 'update-install' })).not.toThrow();
    await w.flush();
  });
});

describe('DesktopBridge', () => {
  const make = (exe?: string) => {
    const sent: DesktopOutMessage[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-home-'));
    const bridge = new DesktopBridge({ version: '1.2.3', serverVersion: '1.2.3', autostart: new Autostart({ exe, platform: 'linux', home, env: {} }), send: (m) => sent.push(m) });
    return { bridge, sent, home };
  };

  it('check for updates: sends update-check, shows checking until the shell answers', () => {
    const { bridge, sent } = make();
    const changed = vi.fn();
    bridge.on('changed', changed);
    bridge.requestUpdateCheck();
    expect(sent).toEqual([{ type: 'update-check' }]);
    expect(bridge.snapshot().updateChecking).toBe(true);
    bridge.setUpdate({ status: 'none', current: '1.2.3' });
    expect(bridge.snapshot()).toMatchObject({ updateChecking: false, update: { status: 'none' } });
    bridge.requestUpdateInstall();
    expect(sent.at(-1)).toEqual({ type: 'update-install' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('the check gives up after a while without an answer', () => {
    vi.useFakeTimers();
    try {
      const { bridge } = make();
      bridge.requestUpdateCheck();
      vi.advanceTimersByTime(61_000);
      expect(bridge.snapshot().updateChecking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('desktop admin API', () => {
  const headers = (port: number) => ({ host: `127.0.0.1:${port}`, cookie: `${ADMIN_COOKIE}=tok` });
  const post = (port: number) => ({ ...headers(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
  const server = async (port: number, desktop?: DesktopBridge) => {
    const { live } = makeController({} as DirectMode);
    return createAdminServer({ port, adminDir: '/nonexistent', live, log: silentLog, token: 'tok', onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn(), desktop });
  };

  it('script mode: { desktop: false } and the actions fail', async () => {
    const app = await server(39401);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/desktop', headers: headers(39401) })).json()).toEqual({ desktop: false });
      const r = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: post(39401), payload: { enabled: true } });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'err.desktop.only' });
      expect((await app.inject({ method: 'POST', url: '/api/desktop/update/check', headers: post(39401), payload: {} })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('desktop mode: info, autostart toggle (read back), update check/install, auth and validation', async () => {
    const exe = '/opt/SwarmCast/swarmcast-desktop';
    const sent: DesktopOutMessage[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-home-'));
    const autostart = new Autostart({ exe, platform: 'linux', home, env: {} });
    const bridge = new DesktopBridge({ version: '2.0.0', serverVersion: '1.9.0', autostart, send: (m) => sent.push(m) });
    const app = await server(39402, bridge);
    try {
      const info = (await app.inject({ method: 'GET', url: '/api/desktop', headers: headers(39402) })).json();
      expect(info).toEqual({ desktop: true, version: '2.0.0', serverVersion: '1.9.0', autostart: { supported: true, enabled: false }, update: null, updateChecking: false, systemCheck: 'idle' });

      let r = await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: post(39402), payload: { enabled: true } });
      expect(r.statusCode).toBe(200);
      expect(r.json().autostart).toEqual({ supported: true, enabled: true });
      expect(fs.existsSync(path.join(home, '.config', 'autostart', 'swarmcast.desktop'))).toBe(true);
      // The OS entry is the source of truth: removed outside SwarmCast, GET says off.
      fs.rmSync(path.join(home, '.config', 'autostart', 'swarmcast.desktop'));
      expect((await app.inject({ method: 'GET', url: '/api/desktop', headers: headers(39402) })).json().autostart.enabled).toBe(false);

      expect((await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: post(39402), payload: { enabled: 'yes' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/api/desktop/autostart', headers: { ...post(39402), cookie: '' }, payload: { enabled: true } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/desktop', headers: { host: '127.0.0.1:39402' } })).statusCode).toBe(401);

      r = await app.inject({ method: 'POST', url: '/api/desktop/update/check', headers: post(39402), payload: {} });
      expect(r.json().updateChecking).toBe(true);
      expect(sent).toEqual([{ type: 'update-check' }]);
      bridge.setUpdate({ status: 'available', version: '2.1.0', current: '2.0.0', notes: 'New' });
      r = await app.inject({ method: 'GET', url: '/api/desktop', headers: headers(39402) });
      expect(r.json()).toMatchObject({ updateChecking: false, update: { status: 'available', version: '2.1.0' } });
      await app.inject({ method: 'POST', url: '/api/desktop/update/install', headers: post(39402), payload: {} });
      expect(sent.at(-1)).toEqual({ type: 'update-install' });
    } finally {
      await app.close();
    }
  });
});

describe('ffmpeg install with retries', () => {
  it('withRetries: first try + one per delay, then gives up with the last error', async () => {
    const waits: number[] = [];
    let n = 0;
    await expect(
      withRetries(
        async () => {
          n++;
          throw new Error(`fail ${n}`);
        },
        [2000, 5000, 10_000],
        { sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow('fail 4');
    expect(waits).toEqual([2000, 5000, 10_000]);
    expect(await withRetries(async (a) => (a < 2 ? Promise.reject(new Error('x')) : a), [1], { sleep: async () => {} })).toBe(2);
  });

  it('quitting (signal) stops the retries, the wait between them and anything abortable', async () => {
    const ac = new AbortController();
    let n = 0;
    const t0 = Date.now();
    const p = withRetries(
      async () => {
        n++;
        throw new Error('offline');
      },
      [60_000, 60_000],
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow('quitting');
    expect(n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Already aborted: no retry at all, the error of the only try.
    await expect(withRetries(async () => Promise.reject(new Error('once')), [1], { signal: ac.signal })).rejects.toThrow('once');
    await expect(sleep(60_000, ac.signal)).rejects.toBeInstanceOf(QuitAbortError);
    const late = new AbortController();
    const pending = abortable(new Promise(() => {}), late.signal);
    late.abort();
    await expect(pending).rejects.toBeInstanceOf(QuitAbortError);
    expect(await abortable(Promise.resolve(7), new AbortController().signal)).toBe(7);
  });

  it('QualityManager shows "retrying" between tries and "error" (Try again) after the last one', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ff-'));
    let tries = 0;
    const phases: string[] = [];
    const q = new QualityManager({
      config: defaultConfig(),
      saveConfig: () => {},
      origin: new HlsOrigin('http://127.0.0.1:9/', silentLog),
      limiter: new BandwidthLimiter(1_000_000),
      tracker: new TrackerService(new AccessControl(), silentLog),
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
        tries++;
        onProgress?.({ phase: 'downloading', receivedBytes: 10 });
        if (tries < 3) throw new Error('network down');
        return path.join(dataDir, 'ffmpeg');
      },
    });
    q.on('changed', () => q.install && phases.push(`${q.install.phase}:${q.install.attempt ?? '-'}`));
    const sleeps: number[] = [];
    await q.installFfmpegWithRetries([2000, 5000, 10_000], async (ms) => {
      sleeps.push(ms);
      // A click on "Install" while waiting does not start a second download.
      await expect(q.installFfmpeg()).rejects.toThrow(/already being installed/);
    });
    expect(tries).toBe(3);
    expect(sleeps).toEqual([2000, 5000]);
    expect(phases).toContain('retrying:2');
    expect(phases).toContain('retrying:3');
    expect(q.install).toMatchObject({ phase: 'downloading', attempt: 3, attempts: 4 });
    expect(q.ffmpegAvailable).toBe(true);

    tries = -10;
    await expect(q.installFfmpegWithRetries([1], async () => {})).rejects.toThrow('network down');
    expect(q.install).toMatchObject({ phase: 'error', message: 'network down', attempt: 2, attempts: 2 });
  });
});

describe('resolvePaths', () => {
  it('SWARMCAST_WEB_DIR moves the viewer and admin folders; SWARMCAST_BIN_DIR the binaries', () => {
    const web = path.join(os.tmpdir(), 'sc-web');
    const p = resolvePaths('/data', { SWARMCAST_WEB_DIR: web, SWARMCAST_BIN_DIR: '/bins' });
    expect(p.viewerDir).toBe(path.join(web, 'viewer'));
    expect(p.adminDir).toBe(path.join(web, 'admin'));
    expect(p.binDir).toBe(path.resolve('/bins'));
    expect(p.configFile).toBe(path.join('/data', 'config.json'));
    const dev = resolvePaths('/data', {});
    expect(dev.adminDir).toMatch(/apps[\\/]admin[\\/]dist$/);
    expect(dev.viewerDir).toMatch(/apps[\\/]viewer[\\/]dist$/);
  });
});
