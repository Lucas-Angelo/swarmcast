import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isAlive } from '../../src/process/children.js';
import { killIfRunning } from './helpers.js';

// Inherited output handles: when SwarmCast's output is redirected (start script > log file, a support
// step; the installer test's wrapper), a process SwarmCast starts must not keep that output open
// after SwarmCast exits, or whoever waits for the end of the output (PowerShell's `& $exe`,
// cmd's `>>`) hangs until that process exits too. The suspects: the browser launch
// (`cmd /c start`, openBrowser), the toast's powershell.exe (notify) and the reaper.
//
// The question is whether a child inherits the parent's stdout handle although it is spawned
// with its own stdio ('ignore' or pipes): on Windows every *inheritable* handle is passed to a
// child created with bInheritHandles, which libuv uses. Node marks the stdio handles it inherited
// as non-inheritable at startup (uv_disable_stdio_inheritance), which would rule this hang out. These
// tests check that on each OS, with a positive control proving the method sees a holder.
//
// The method, with no timing involved: the "app" exits at once, and its output's 'close' event
// fires only once every holder let go of it. A grandchild still alive at that moment did not hold
// it. The positive control proves the opposite: its grandchild writes into the app's output after
// the app is gone, and the output only closes once that grandchild is killed.

/**
 * The grandchild: lives GRANDCHILD_LIFETIME_MS (far longer than an output nobody holds takes to
 * close, and shorter than the test timeout, so a holder shows up as a grandchild that died before
 * the close, not as a timeout; never waited for when the output is not held), and once its parent is
 * gone writes "orphan <pid>" to its stdout. POSIX: an orphan gets a new parent; Windows keeps the
 * old parent id, so it also checks whether that process still exists.
 */
const GRANDCHILD_LIFETIME_MS = 10_000;
const GRANDCHILD_SCRIPT = [
  'const parent = process.ppid;',
  "const gone = () => { if (process.ppid !== parent) return true; try { process.kill(parent, 0); return false; } catch { return true; } };",
  "const watch = setInterval(() => { if (gone()) { clearInterval(watch); process.stdout.write('orphan ' + process.pid + '\\n'); } }, 20);",
  `setTimeout(() => process.exit(0), ${GRANDCHILD_LIFETIME_MS});`,
].join('\n');

/** The "app": starts the grandchild with the spawn options in SC_GRANDCHILD_OPTS, prints its pid, exits. */
const APP_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  'const opts = JSON.parse(process.env.SC_GRANDCHILD_OPTS);',
  "const c = spawn(process.execPath, ['-e', process.env.SC_GRANDCHILD_SCRIPT], opts);",
  'c.unref();',
  "process.stdout.write(c.pid + '\\n');",
].join('\n');

/**
 * Runs the app with its stdout and stderr as pipes this test holds (as a redirect to a log file
 * would), its grandchild spawned with `childStdio` and options like the product's. The scripts
 * travel as data (environment variables), never as code built from options. Both processes are
 * killed when the test finishes, if still running.
 */
async function runApp(childStdio: 'ignore' | 'inherit', extra: { detached?: boolean; windowsHide?: boolean }) {
  const app = spawn(process.execPath, ['-e', APP_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, SC_GRANDCHILD_OPTS: JSON.stringify({ stdio: childStdio, ...extra }), SC_GRANDCHILD_SCRIPT: GRANDCHILD_SCRIPT },
  });
  onTestFinished(() => killIfRunning(app.pid!));
  app.stderr!.resume();
  const exit = once(app, 'exit');
  let closed = false;
  const close = once(app, 'close').then(() => void (closed = true));
  const lines = readline.createInterface({ input: app.stdout! })[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => String((await lines.next()).value).trim();
  const grandchild = Number(await nextLine());
  expect(Number.isInteger(grandchild) && grandchild > 0, `grandchild pid ${grandchild}`).toBe(true);
  onTestFinished(() => killIfRunning(grandchild));
  return { grandchild, exit, close, closed: () => closed, nextLine };
}

describe("a process SwarmCast starts does not hold SwarmCast's redirected output", () => {
  // Windows: libuv puts children that are not detached in a job object that is closed (and its
  // processes killed) when the parent exits, so this one cannot outlive the app at all.
  // POSIX: it outlives the app, without holding its output.
  it('toast-like launch (stdio ignore, hidden window): the output closes when the app exits', async () => {
    // Arrange
    const run = await runApp('ignore', { windowsHide: true });
    // Act
    await run.close;
    // Assert
    expect(isAlive(run.grandchild)).toBe(process.platform !== 'win32');
  });

  it('browser-like launch (stdio ignore, detached): the output closes when the app exits, the browser goes on', async () => {
    // Arrange
    const run = await runApp('ignore', { detached: true, windowsHide: true });
    // Act
    await run.close;
    // Assert
    expect(isAlive(run.grandchild)).toBe(true);
  });

  // Detached, so that on Windows the grandchild is not killed with the app (see above).
  it('positive control: a child given the output (stdio inherit) does hold it', async () => {
    // Arrange
    const run = await runApp('inherit', { detached: true, windowsHide: true });
    // Act
    const [line] = await Promise.all([run.nextLine(), run.exit]);
    // Assert
    expect(line).toBe(`orphan ${run.grandchild}`);
    expect(run.closed()).toBe(false);
    // Act
    killIfRunning(run.grandchild);
    await run.close;
    // Assert
    expect(run.closed()).toBe(true);
  });
});
