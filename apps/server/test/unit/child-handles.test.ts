import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { isAlive } from '../../src/process/children.js';

// B11 (plan: WIN F1): when SwarmCast's output is redirected (start script > log file, a support
// step; the installer test's wrapper), a process SwarmCast starts must not keep that output open
// after SwarmCast exits, or whoever waits for the end of the output (PowerShell's `& $exe`,
// cmd's `>>`) hangs until that process exits too. The suspects: the browser launch
// (`cmd /c start`, openBrowser), the toast's powershell.exe (notify) and the reaper.
//
// The question is whether a child inherits the parent's stdout handle although it is spawned
// with its own stdio ('ignore' or pipes): on Windows every *inheritable* handle is passed to a
// child created with bInheritHandles, which libuv uses. Node marks the stdio handles it inherited
// as non-inheritable at startup (uv_disable_stdio_inheritance), which would rule B11 out. These
// tests check that on each OS, with a positive control proving the method sees a holder.

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
 * Runs an "app" whose stdout and stderr are pipes held by this test (as a redirect to a log
 * file would be). The app starts a grandchild that lives 20 s with `childStdio` and spawn
 * options like the product's, prints the grandchild's pid and exits. Resolves with how long the
 * app's output stayed open after the app itself exited, and the grandchild's pid.
 */
async function outputHeldAfterExit(
  childStdio: 'ignore' | 'inherit',
  extra: { detached?: boolean; windowsHide?: boolean },
  killGrandchildAfterMs?: number,
): Promise<{ heldMs: number; grandchild: number }> {
  const opts = JSON.stringify({ stdio: childStdio, ...extra });
  const script = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], ${opts});`,
    'c.unref();',
    "process.stdout.write(c.pid + '\\n');",
  ].join('\n');
  const app = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  leftovers.push(app.pid!);
  app.stderr!.resume();
  const grandchild = await new Promise<number>((resolve) => readline.createInterface({ input: app.stdout! }).once('line', (l) => resolve(Number(l.trim()))));
  leftovers.push(grandchild);
  expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
  // 'close' fires once the process exited AND every holder of its stdout/stderr let go.
  let exitedAt = 0;
  app.once('exit', () => (exitedAt = Date.now()));
  const killer = killGrandchildAfterMs === undefined ? null : setTimeout(() => process.kill(grandchild, 'SIGKILL'), killGrandchildAfterMs);
  await new Promise<void>((resolve) => app.once('close', () => resolve()));
  if (killer) clearTimeout(killer);
  return { heldMs: Date.now() - exitedAt, grandchild };
}

describe("a process SwarmCast starts does not hold SwarmCast's redirected output", () => {
  it('toast-like launch (stdio ignore, hidden window): the output closes when the app exits', async () => {
    const { heldMs, grandchild } = await outputHeldAfterExit('ignore', { windowsHide: true });
    expect(isAlive(grandchild)).toBe(true);
    expect(heldMs).toBeLessThan(2000);
  }, 30_000);

  it('browser-like launch (stdio ignore, detached): the output closes when the app exits', async () => {
    const { heldMs, grandchild } = await outputHeldAfterExit('ignore', { detached: true, windowsHide: true });
    expect(isAlive(grandchild)).toBe(true);
    expect(heldMs).toBeLessThan(2000);
  }, 30_000);

  it('positive control: a child given the output (stdio inherit) does hold it', async () => {
    // The grandchild owns the output: the close waits for it (killed after 3 s to stay short).
    const { heldMs } = await outputHeldAfterExit('inherit', { windowsHide: true }, 3000);
    expect(heldMs).toBeGreaterThanOrEqual(2000);
  }, 30_000);
});
