import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isListening } from '../../src/core/ports.js';
import { isAlive } from '../../src/process/children.js';
import { allocAppPorts, bootApp, spawnTracked, stopTracked, tmpDir, until, type Tracked } from './helpers.js';

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/server/src/main.ts');
const posix = process.platform !== 'win32';

function writeConfig(dir: string, ports: Record<string, number>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' }, ...extra }),
  );
}

function startMain(dir: string): Tracked {
  return spawnTracked(process.execPath, ['--import', 'tsx', MAIN, '--no-tunnel', '--no-open', '--no-tray', '--data-dir', dir], {
    name: 'SwarmCast',
    cwd: ROOT,
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

/** MediaMTX started by this SwarmCast (its own child, by pid) and listening: not just "the port answers". */
async function ownMediaMtx(main: Tracked, rtmpPort: number): Promise<number> {
  let pid: number | undefined;
  await until(
    async () => {
      pid = childPids(main.pid!).find((p) => processName(p).includes('mediamtx'));
      return pid !== undefined && (await isListening(rtmpPort));
    },
    { timeoutMs: 30_000, what: 'MediaMTX started by this SwarmCast', abortOn: [main], detail: () => `children ${JSON.stringify(childPids(main.pid!))}; last output: ${main.tail(10)}` },
  );
  return pid!;
}

afterEach(stopTracked);

describe.skipIf(!posix)('process lifecycle', () => {
  it('killing SwarmCast with SIGKILL takes MediaMTX down with it (reaper)', async () => {
    const dir = tmpDir();
    // Ports of this worker's block, free right now: not ports another SwarmCast may hold (one
    // made "something listens on the RTMP port" true before this test's own MediaMTX existed).
    const ports = await allocAppPorts();
    writeConfig(dir, ports);
    const main = startMain(dir);
    const mediamtx = await ownMediaMtx(main, ports.rtmp);

    // A crash: SwarmCast alone dies at once; its reaper must take MediaMTX down.
    main.child.kill('SIGKILL');
    await until(() => !isAlive(mediamtx), { timeoutMs: 10_000, what: 'MediaMTX to die' });
    await until(async () => !(await isListening(ports.rtmp)), { timeoutMs: 5_000, what: 'RTMP port to close' });
    expect(await isListening(ports.mediamtxHls)).toBe(false);
  });

  it('Ctrl+C (SIGINT) stops everything and exits cleanly', async () => {
    const dir = tmpDir();
    const ports = await allocAppPorts();
    writeConfig(dir, ports);
    const main = startMain(dir);
    const mediamtx = await ownMediaMtx(main, ports.rtmp);
    main.child.kill('SIGINT');
    const { code } = await main.exited;
    expect(code).toBe(0);
    expect(main.lines.join('\n')).toContain('Off: nothing on your computer is reachable');
    expect(isAlive(mediamtx)).toBe(false);
    for (const p of Object.values(ports)) expect(await isListening(p)).toBe(false);
  });

  it('turns everything off automatically when OBS sends no video', async () => {
    const { app, ports } = await bootApp({ configOverrides: { autoStopMinutes: 0.08 } });
    try {
      expect(app.live.phase).toBe('waiting-obs');
      expect(app.live.snapshot().autoStopAt).toBeGreaterThan(Date.now());
      await until(() => app.live.phase === 'off', { timeoutMs: 40_000, what: 'automatic stop', detail: () => `phase ${app.live.phase}`, on: [[app.live, 'state']] });
      expect(await isListening(ports.rtmp)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
