import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { isListening } from '../../src/core/ports.js';
import { allocAppPorts, bootApp, isAlive, POSIX, SCRIPT_MODE, ServerProcess, stopTracked, tmpDir, until, writeConfig, type Ports } from './helpers.js';

// How SwarmCast ends: a crash (SIGKILL: its reaper takes MediaMTX down), Ctrl+C (SIGINT: a clean
// stop, exit 0), and the automatic stop when OBS sends no video. The signal tests need POSIX
// signals and `ps`; the automatic stop runs everywhere.
// Each SwarmCast gets ports of this worker's block that are free right now: never the ports of
// another SwarmCast (one made "something listens on the RTMP port" true before this test's own
// MediaMTX existed).

afterEach(stopTracked);

/** The command name of `pid` ("" once it is gone). */
function processName(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)]).toString().trim();
  } catch {
    return '';
  }
}

/** SwarmCast in script mode on `ports`, with its own data folder. */
function startServer(ports: Ports): ServerProcess {
  const dataDir = tmpDir();
  writeConfig(dataDir, ports);
  return new ServerProcess({ args: SCRIPT_MODE, dataDir });
}

/** The pid of the MediaMTX this SwarmCast started (its own child, by name), once it listens: not just "the port answers". */
async function ownMediaMtx(server: ServerProcess, rtmpPort: number): Promise<number> {
  let pid: number | undefined;
  await until(
    async () => {
      pid = server.children().find((p) => processName(p).includes('mediamtx'));
      return pid !== undefined && (await isListening(rtmpPort));
    },
    { timeoutMs: 30_000, what: 'MediaMTX started by this SwarmCast', abortOn: [server.proc], detail: () => `children ${JSON.stringify(server.children())}; last output: ${server.proc.tail(10)}` },
  );
  return pid!;
}

describe.skipIf(!POSIX)('process lifecycle: signals', () => {
  it('killing SwarmCast with SIGKILL takes MediaMTX down with it (reaper)', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const server = startServer(ports);
    const mediamtx = await ownMediaMtx(server, ports.rtmp);
    // Act
    server.proc.child.kill('SIGKILL');
    await until(() => !isAlive(mediamtx), { timeoutMs: 10_000, what: 'MediaMTX to die' });
    await until(async () => !(await isListening(ports.rtmp)), { timeoutMs: 5_000, what: 'the RTMP port to close' });
    // Assert
    expect(await isListening(ports.mediamtxHls)).toBe(false);
  });

  it('Ctrl+C (SIGINT) stops everything and exits cleanly', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const server = startServer(ports);
    const mediamtx = await ownMediaMtx(server, ports.rtmp);
    // Act
    server.proc.child.kill('SIGINT');
    const code = await server.exited;
    // Assert
    expect(code).toBe(0);
    expect(server.logLines.join('\n')).toContain('Off: nothing on your computer is reachable');
    expect(isAlive(mediamtx)).toBe(false);
    for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
  });
});

describe('process lifecycle: automatic stop', () => {
  it('turns everything off automatically when OBS sends no video', async () => {
    // Arrange
    const { app, ports } = await bootApp({ configOverrides: { autoStopMinutes: 0.08 } });
    onTestFinished(() => app.close());
    const started = { phase: app.live.phase, autoStopAt: app.live.snapshot().autoStopAt, now: Date.now() };
    // Act
    await until(() => app.live.phase === 'off', { timeoutMs: 40_000, what: 'the automatic stop', detail: () => `phase ${app.live.phase}`, on: [[app.live, 'state']] });
    // Assert
    expect(started.phase).toBe('waiting-obs');
    expect(started.autoStopAt).toBeGreaterThan(started.now);
    expect(await isListening(ports.rtmp)).toBe(false);
  });
});
