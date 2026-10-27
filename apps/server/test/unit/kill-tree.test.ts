import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedChild, isAlive, killTree } from '../../src/process/children.js';
import { silentLog } from './helpers.js';

// B8: killTree resolves once the kill really happened (Windows: taskkill has exited) and the
// processes are gone, so callers (ManagedChild.stop, the reaper) wait for facts, not a guess.

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');
const posix = process.platform !== 'win32';
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/**
 * A parent that starts a grandchild (both plain node processes) and prints the grandchild's pid.
 * Spawned like ManagedChild does it: its own process group on POSIX.
 */
async function tree(opts: { ignoreTerm?: boolean } = {}): Promise<{ parent: ChildProcess; grandchild: number }> {
  const script = [
    opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(c.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', script], { detached: posix, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  leftovers.push(parent.pid!);
  const grandchild = await new Promise<number>((resolve) => readline.createInterface({ input: parent.stdout! }).once('line', (l) => resolve(Number(l))));
  leftovers.push(grandchild);
  expect(isAlive(parent.pid!)).toBe(true);
  expect(isAlive(grandchild)).toBe(true);
  return { parent, grandchild };
}

describe('killTree', () => {
  it('parent and grandchild are both gone as soon as the await returns', async () => {
    const { parent, grandchild } = await tree();
    expect(await killTree(parent.pid!, 'SIGKILL')).toBe(true);
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('a pid that is already gone resolves true at once', async () => {
    const { parent, grandchild } = await tree();
    await killTree(parent.pid!, 'SIGKILL');
    const t0 = Date.now();
    expect(await killTree(parent.pid!, 'SIGKILL')).toBe(true);
    expect(await killTree(grandchild, 'SIGKILL')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(posix ? 200 : 3000);
  });

  it.skipIf(!posix)('reports false, after waitMs, for a tree that ignores the signal (POSIX)', async () => {
    const { parent, grandchild } = await tree({ ignoreTerm: true });
    const t0 = Date.now();
    // The grandchild dies of SIGTERM; the parent ignores it, so the group is not empty.
    expect(await killTree(parent.pid!, 'SIGTERM', { waitMs: 300 })).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(isAlive(parent.pid!)).toBe(true);
    expect(await killTree(parent.pid!, 'SIGKILL')).toBe(true);
    expect(isAlive(grandchild)).toBe(false);
  });
});

describe('ManagedChild.stop', () => {
  it('escalates to a kill and returns only when the whole tree is gone', async () => {
    const script = [
      "process.on('SIGTERM', () => {});",
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'console.log(c.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = new ManagedChild('test-tree', process.execPath, ['-e', script], {}, null, silentLog);
    leftovers.push(child.pid!);
    const grandchild = await new Promise<number>((resolve) => child.once('line', (l) => resolve(Number(l))));
    leftovers.push(grandchild);
    await child.stop(200);
    expect(child.running).toBe(false);
    expect(isAlive(child.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  });
});

describe('reaper', () => {
  it('kills the registered trees when SwarmCast goes away, and exits only after they are gone', async () => {
    const { parent, grandchild } = await tree();
    const reaper = spawn(process.execPath, ['--import', 'tsx', MAIN, '--reaper', String(process.pid)], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
    leftovers.push(reaper.pid!);
    const exited = new Promise<void>((r) => reaper.once('exit', () => r()));
    // Register the tree, then SwarmCast "dies": stdin closes. The pipe keeps the order, so the
    // reaper reads the registration before the close, however long it takes to load.
    reaper.stdin!.end(`+${parent.pid}\n`);
    await exited;
    // Facts at the moment the reaper exits, without any extra wait.
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
  }, 30_000);
});
