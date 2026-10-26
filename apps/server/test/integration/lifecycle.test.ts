import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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

const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
});

describe.skipIf(!posix)('process lifecycle', () => {
  it('killing SwarmCast with SIGKILL takes MediaMTX down with it (reaper)', async () => {
    const dir = tmpDir();
    const ports = { rtmp: 29450, public: 28180, admin: 28181, mediamtxHls: 28988 };
    writeConfig(dir, ports);
    const main = startMain(dir);
    procs.push(main);
    await waitFor(() => isListening(ports.public), 30_000, 'public server');
    await waitFor(() => isListening(ports.rtmp), 30_000, 'MediaMTX');
    const mediamtx = childPids(main.pid!).find((p) => processName(p).includes('mediamtx'));
    expect(mediamtx).toBeDefined();

    main.kill('SIGKILL');
    await waitFor(() => !isAlive(mediamtx!), 10_000, 'MediaMTX to die');
    await waitFor(async () => !(await isListening(ports.rtmp)), 5_000, 'RTMP port to close');
    expect(await isListening(ports.mediamtxHls)).toBe(false);
  });

  it('Ctrl+C (SIGINT) stops everything and exits cleanly', async () => {
    const dir = tmpDir();
    const ports = { rtmp: 29550, public: 28280, admin: 28281, mediamtxHls: 29088 };
    writeConfig(dir, ports);
    const main = startMain(dir);
    procs.push(main);
    let out = '';
    main.stdout!.on('data', (d) => (out += d));
    await waitFor(() => isListening(ports.rtmp), 30_000, 'MediaMTX');
    const mediamtx = childPids(main.pid!).find((p) => processName(p).includes('mediamtx'));
    main.kill('SIGINT');
    const code = await new Promise<number | null>((r) => main.on('exit', r));
    expect(code).toBe(0);
    expect(out).toContain('Off: nothing on your computer is reachable');
    if (mediamtx) expect(isAlive(mediamtx)).toBe(false);
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
  });

  it('turns everything off automatically when OBS sends no video', async () => {
    const app = await createApp({
      dataDir: tmpDir(),
      noTunnel: true,
      noReaper: true,
      logToStdout: false,
      configOverrides: {
        ports: { rtmp: 29650, public: 28380, admin: 28381, mediamtxHls: 29188 },
        speedTest: { enabled: false, intervalMinutes: 15 },
        autoStopMinutes: 0.08,
      },
    });
    try {
      await app.live.start();
      expect(app.live.phase).toBe('waiting-obs');
      expect(app.live.snapshot().autoStopAt).toBeGreaterThan(Date.now());
      await waitFor(() => app.live.phase === 'off', 40_000, 'automatic stop');
      expect(await isListening(29650)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
