import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { isListening } from '../../src/core/ports.js';
import { isAlive } from '../../src/process/children.js';
import { tmpDir, waitFor } from './helpers.js';

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/server/src/main.ts');
const posix = process.platform !== 'win32';

function writeConfig(dir: string, ports: Record<string, number>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' }, ...extra }),
  );
}

function startMain(dir: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', MAIN, '--no-tunnel', '--no-open', '--no-tray', '--data-dir', dir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SWARMCAST_LOG_LEVEL: 'warn' },
  });
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function processName(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)]).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Ports no other test file (or a copy of the suite in another checkout) has hard-coded: the
 * fixed ports used to be shared with ladder.test.ts, so a SwarmCast still running elsewhere
 * made "something listens on the RTMP port" true before this test's own MediaMTX existed.
 */
async function freePorts(): Promise<{ rtmp: number; public: number; admin: number; mediamtxHls: number }> {
  const servers = await Promise.all(
    [0, 1, 2, 3].map(
      () =>
        new Promise<net.Server>((resolve, reject) => {
          const s = net.createServer();
          s.once('error', reject);
          s.listen(0, '127.0.0.1', () => resolve(s));
        }),
    ),
  );
  const [rtmp, pub, admin, hls] = servers.map((s) => (s.address() as net.AddressInfo).port) as [number, number, number, number];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return { rtmp, public: pub, admin, mediamtxHls: hls };
}

/** MediaMTX started by this SwarmCast (its own child, by pid) and listening: not just "the port answers". */
async function ownMediaMtx(main: ChildProcess, rtmpPort: number, out: () => string): Promise<number> {
  let pid: number | undefined;
  await waitFor(
    async () => {
      if (main.exitCode !== null) throw new Error(`SwarmCast exited early (code ${main.exitCode}): ${out()}`);
      pid = childPids(main.pid!).find((p) => processName(p).includes('mediamtx'));
      return pid !== undefined && (await isListening(rtmpPort));
    },
    30_000,
    'MediaMTX started by this SwarmCast',
    out,
  );
  return pid!;
}

const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
});

describe.skipIf(!posix)('process lifecycle', () => {
  it('killing SwarmCast with SIGKILL takes MediaMTX down with it (reaper)', async () => {
    const dir = tmpDir();
    const ports = await freePorts();
    writeConfig(dir, ports);
    const main = startMain(dir);
    procs.push(main);
    let out = '';
    main.stdout!.on('data', (d) => (out += d));
    main.stderr!.on('data', (d) => (out += d));
    const mediamtx = await ownMediaMtx(main, ports.rtmp, () => out.slice(-2000));

    main.kill('SIGKILL');
    await waitFor(() => !isAlive(mediamtx), 10_000, 'MediaMTX to die');
    await waitFor(async () => !(await isListening(ports.rtmp)), 5_000, 'RTMP port to close');
    expect(await isListening(ports.mediamtxHls)).toBe(false);
  });

  it('Ctrl+C (SIGINT) stops everything and exits cleanly', async () => {
    const dir = tmpDir();
    const ports = await freePorts();
    writeConfig(dir, ports);
    const main = startMain(dir);
    procs.push(main);
    let out = '';
    main.stdout!.on('data', (d) => (out += d));
    const mediamtx = await ownMediaMtx(main, ports.rtmp, () => out.slice(-2000));
    main.kill('SIGINT');
    const code = await new Promise<number | null>((r) => main.on('exit', r));
    expect(code).toBe(0);
    expect(out).toContain('Off: nothing on your computer is reachable');
    expect(isAlive(mediamtx)).toBe(false);
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
  });

  it('turns everything off automatically when OBS sends no video', async () => {
    const ports = await freePorts();
    const app = await createApp({
      dataDir: tmpDir(),
      noTunnel: true,
      noReaper: true,
      logToStdout: false,
      configOverrides: {
        // The panel and the public server listen on a port the OS picks (no probe needed).
        ports: { ...ports, public: 0, admin: 0 },
        speedTest: { enabled: false, intervalMinutes: 15 },
        autoStopMinutes: 0.08,
      },
    });
    try {
      await app.live.start();
      expect(app.live.phase).toBe('waiting-obs');
      expect(app.live.snapshot().autoStopAt).toBeGreaterThan(Date.now());
      await waitFor(() => app.live.phase === 'off', 40_000, 'automatic stop');
      expect(await isListening(ports.rtmp)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
