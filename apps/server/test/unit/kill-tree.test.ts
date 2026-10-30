import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedChild, isAlive, killTree } from '../../src/process/children.js';
import { killIfRunning, silentLog, tempDir } from './helpers.js';

// B8: killTree resolves once the kill really happened (Windows: taskkill has exited) and the
// processes are gone, so callers (ManagedChild.stop, the reaper) wait for facts, not a guess.

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');
const posix = process.platform !== 'win32';
/** Far longer than any test may take: a killTree that waited for it would fail by timing out. */
const NEVER_MS = 60_000;
/** ManagedChild.stop's grace before the forced kill: the child here ignores SIGTERM, so it always runs out. */
const GRACE_MS = 50;

/** The grandchild's pid as the parent printed it; anything else fails here, not as a vacuous "not alive". */
function pidOf(line: string): number {
  const pid = Number(line.trim());
  expect(Number.isInteger(pid) && pid > 0, `pid line: ${JSON.stringify(line)}`).toBe(true);
  return pid;
}

/**
 * A node script that starts a grandchild (plain node, spawned normally: in the parent's process
 * group) and prints its pid. Not console.log: with FORCE_COLOR (set in CI) it wraps a number in
 * ANSI colour codes. `ignoreTerm`: the parent survives SIGTERM (its grandchild does not).
 */
function treeScript(ignoreTerm: boolean): string {
  return [
    ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(c.pid + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

/**
 * A parent with a grandchild, spawned like ManagedChild does it (its own process group on POSIX),
 * both alive. Both are killed when the test finishes, if still running.
 */
async function tree(opts: { ignoreTerm?: boolean } = {}): Promise<{ parent: ChildProcess; grandchild: number }> {
  const parent = spawn(process.execPath, ['-e', treeScript(!!opts.ignoreTerm)], { detached: posix, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  onTestFinished(() => killIfRunning(parent.pid!));
  const [line] = (await once(readline.createInterface({ input: parent.stdout! }), 'line')) as [string];
  const grandchild = pidOf(line);
  onTestFinished(() => killIfRunning(grandchild));
  expect(isAlive(parent.pid!)).toBe(true);
  expect(isAlive(grandchild)).toBe(true);
  return { parent, grandchild };
}

describe('killTree', () => {
  it('parent and grandchild are both gone as soon as the await returns', async () => {
    // Arrange
    const { parent, grandchild } = await tree();
    // Act
    const gone = await killTree(parent.pid!, 'SIGKILL');
    // Assert
    expect(gone).toBe(true);
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('a pid that is already gone resolves true without waiting for its waitMs', async () => {
    // Arrange
    const { parent, grandchild } = await tree();
    await killTree(parent.pid!, 'SIGKILL');
    // Act
    const parentAgain = await killTree(parent.pid!, 'SIGKILL', { waitMs: NEVER_MS });
    const grandchildAgain = await killTree(grandchild, 'SIGKILL', { waitMs: NEVER_MS });
    // Assert
    expect(parentAgain).toBe(true);
    expect(grandchildAgain).toBe(true);
  });

  // POSIX: SIGTERM goes to the whole process group; the grandchild dies of it, the parent ignores
  // it, so the group is never empty. The wait is the subject: fake timers, advanced by hand.
  it.skipIf(!posix)('reports false, after exactly waitMs, for a tree that ignores the signal (POSIX)', async () => {
    // Arrange
    const { parent, grandchild } = await tree({ ignoreTerm: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    onTestFinished(() => void vi.useRealTimers());
    let settled = false;
    // Act
    const result = killTree(parent.pid!, 'SIGTERM', { waitMs: 300 });
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(299);
    // Assert
    expect(settled).toBe(false);
    // Act
    await vi.advanceTimersByTimeAsync(1);
    // Assert
    expect(await result).toBe(false);
    expect(isAlive(parent.pid!)).toBe(true);
    // Act
    vi.useRealTimers();
    const killed = await killTree(parent.pid!, 'SIGKILL');
    // Assert
    expect(killed).toBe(true);
    expect(isAlive(grandchild)).toBe(false);
  });
});

describe('ManagedChild.stop', () => {
  it('escalates to a kill and returns only when the whole tree is gone', async () => {
    // Arrange
    const child = new ManagedChild('test-tree', process.execPath, ['-e', treeScript(true)], {}, null, silentLog);
    onTestFinished(() => killIfRunning(child.pid!));
    const [line] = (await once(child, 'line')) as [string];
    const grandchild = pidOf(line);
    onTestFinished(() => killIfRunning(grandchild));
    // Act
    await child.stop(GRACE_MS);
    // Assert
    expect(child.running).toBe(false);
    expect(isAlive(child.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });
});

describe('reaper', () => {
  // Register the tree, then SwarmCast "dies": stdin closes. The pipe keeps the order, so the
  // reaper reads the registration before the close, however long it takes to load (tsx and
  // main.ts: the 30 s timeout). The checks are the facts at the moment the reaper exits, without
  // any extra wait. --reaper never opens the data folder; it gets a temp one anyway, so no run of
  // main.ts can reach the real one.
  it('kills the registered trees when SwarmCast goes away, and exits only after they are gone', async () => {
    // Arrange
    const { parent, grandchild } = await tree();
    const reaper = spawn(process.execPath, ['--import', 'tsx', MAIN, '--reaper', String(process.pid)], {
      stdio: ['pipe', 'ignore', 'inherit'],
      windowsHide: true,
      env: { ...process.env, SWARMCAST_DATA_DIR: tempDir('sc-reaper-'), SWARMCAST_NO_OPEN: '1' },
    });
    onTestFinished(() => killIfRunning(reaper.pid!));
    const exited = once(reaper, 'exit');
    // Act
    reaper.stdin!.end(`+${parent.pid}\n`);
    await exited;
    // Assert
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  }, 30_000);
});
