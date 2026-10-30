// Child processes for the test suites that never outlive the test that started them.
//
// - POSIX: every tracked child leads its own process group (detached), so a stop reaches its
//   children too (an ffmpeg behind a wrapper script, MediaMTX behind SwarmCast).
// - Windows: `taskkill /T /F` by absolute path (no taskkill earlier on PATH runs), awaited.
// - A stop waits for the facts: the child's exit, then no process of its tree left. It throws
//   when something survives, so a leak fails the test that caused it instead of a later one.
// - If the test process itself dies, every tracked tree still running is killed on the way out.
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { formatExit, orTimeout } from './wait.mjs';

const win = process.platform === 'win32';
const TAIL_LINES = 200;

/** True while `pid` exists (EPERM: it exists but belongs to someone else). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function taskkill(pid) {
  return new Promise((resolve) => {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    let tk;
    try {
      tk = spawn(exe, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      return resolve();
    }
    const cap = setTimeout(() => {
      tk.kill();
      resolve();
    }, 10_000);
    tk.once('exit', () => (clearTimeout(cap), resolve()));
    tk.once('error', () => (clearTimeout(cap), resolve()));
  });
}

/**
 * POSIX: every descendant of `root`, from `ps` (also those in process groups of their own, like
 * the MediaMTX a SwarmCast starts). Windows: [] (taskkill /T walks the tree itself).
 */
export function descendants(root) {
  if (win) return [];
  let out;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const kids = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || pid === process.pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const found = [];
  const queue = [root];
  while (queue.length) {
    for (const c of kids.get(queue.shift()) ?? []) {
      found.push(c);
      queue.push(c);
    }
  }
  return found;
}

function signal(target, sig) {
  try {
    process.kill(target, sig);
  } catch {
    /* gone, or not a group */
  }
}

/**
 * Kills `pid` and its children and resolves true once they are all gone (false after `waitMs`).
 * - POSIX: `signal` to the process group of `pid` (tracked children lead their own group), and
 *   to every descendant and its group (children that started a group of their own).
 * - Windows: `taskkill /T /F` (always forced), awaited.
 * `exited`: `pid` itself already exited, so only its group is signalled (POSIX) and nothing is
 * done on Windows: the number may already belong to an unrelated process.
 * `tree: false`: POSIX, the group of `pid` only (a graceful stop lets `pid` stop its own children).
 */
export async function killTree(pid, o = {}) {
  const { signal: sig = 'SIGKILL', waitMs = 5000, exited = false, tree = true } = o;
  let alive;
  if (win) {
    if (!exited) await taskkill(pid);
    alive = () => !exited && isAlive(pid);
  } else {
    const others = tree && !exited ? descendants(pid) : [];
    signal(-pid, sig);
    if (!exited) signal(pid, sig);
    for (const p of others) {
      signal(-p, sig);
      signal(p, sig);
    }
    alive = () => groupAlive(pid) || (!exited && isAlive(pid)) || others.some(isAlive);
  }
  const deadline = Date.now() + waitMs;
  while (alive()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/** Every tracked child not stopped yet (also after it exited: its children may still run). */
const pending = new Set();

// Last resort when the test process exits with trees still running (a crash, a timeout that
// killed the worker): POSIX can signal synchronously here; Windows cannot wait for taskkill.
process.once('exit', () => {
  for (const t of pending) {
    if (!t.pid) continue;
    try {
      if (!win) process.kill(-t.pid, 'SIGKILL');
      else if (!t.exitInfo) spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(t.pid), '/T', '/F'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } catch {
      /* gone */
    }
  }
});

class Tracked extends EventEmitter {
  constructor(command, args, o) {
    super();
    this.name = o.name ?? path.basename(command);
    this.lines = [];
    this.exitInfo = null;
    this.mask = o.mask ?? ((s) => s);
    this.logFile = o.logFile ? path.resolve(o.logFile) : null;
    this.stopping = null;
    this.child = spawn(command, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: o.stdio ?? ['ignore', 'pipe', 'pipe'],
      detached: !win,
      windowsHide: true,
    });
    this.pid = this.child.pid;
    pending.add(this);
    this.log(`--- ${new Date().toISOString()} ${this.name} pid ${this.pid ?? '?'}: ${o.describe ?? [command, ...args].join(' ')}\n`);
    for (const stream of ['stdout', 'stderr']) {
      const s = this.child[stream];
      if (!s) continue;
      s.setEncoding('utf8');
      // Whole lines only, so masking sees a secret that arrives split across two chunks.
      let partial = '';
      s.on('data', (d) => {
        const text = partial + d;
        const cut = text.lastIndexOf('\n') + 1;
        partial = text.slice(cut);
        if (cut) this.onText(text.slice(0, cut), stream);
      });
      s.on('end', () => {
        if (partial) this.onText(`${partial}\n`, stream);
        partial = '';
      });
    }
    const closed = new Promise((r) => this.child.once('close', r));
    this.exited = new Promise((resolve) => {
      const done = (info) => {
        if (this.exitInfo) return;
        this.exitInfo = info;
        // Let the pipes drain so the last lines are in tail(); a grandchild holding them open
        // must not keep the exit from being reported (orTimeout clears its timer either way).
        void orTimeout(closed, 500, null).then(() => {
          this.log(`--- ${new Date().toISOString()} ${this.name} pid ${this.pid ?? '?'} exited (${formatExit(info)})\n`);
          resolve(info);
        });
      };
      this.child.once('exit', (code, signal) => done({ code, signal }));
      this.child.once('error', (err) => done({ code: null, signal: null, error: err.message }));
    });
  }

  log(text) {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, this.mask(text));
    } catch {
      /* the log is evidence only */
    }
  }

  onText(text, stream) {
    this.log(text);
    for (const line of text.split('\n').slice(0, -1)) {
      const clean = line.replace(/\r$/, '');
      this.lines.push(clean);
      if (this.lines.length > TAIL_LINES * 10) this.lines.splice(0, TAIL_LINES);
      this.emit('line', clean, stream);
    }
  }

  get running() {
    return !this.exitInfo;
  }

  tail(n = 20) {
    return this.mask(this.lines.slice(-n).join('\n'));
  }

  stop(o = {}) {
    this.stopping ??= this.doStop(o).finally(() => pending.delete(this));
    return this.stopping;
  }

  async doStop({ graceMs = 0, timeoutMs = 10_000 } = {}) {
    const pid = this.pid;
    if (!pid) return;
    if (!this.exitInfo && graceMs > 0) {
      // Graceful: the process stops its own children (SwarmCast stops MediaMTX, its reaper exits).
      await killTree(pid, { signal: 'SIGTERM', waitMs: 0, tree: false });
      await orTimeout(this.exited, graceMs, null);
    }
    // Also after an exit of its own: the child may have left its own children behind.
    const gone = await killTree(pid, { waitMs: timeoutMs, exited: !!this.exitInfo });
    // No timer outlives the stop: a leftover one would keep the test process alive for nothing.
    const exited = await orTimeout(this.exited.then(() => true), timeoutMs, false);
    if (!exited) throw new Error(`${this.name} (pid ${pid}) did not exit within ${timeoutMs} ms of a forced kill`);
    if (!gone) throw new Error(`${this.name} (pid ${pid}): a process of its tree is still running ${timeoutMs} ms after a forced kill`);
  }
}

/**
 * Starts a tracked child: output lines in `lines` (and a 'line' event), `exited` (resolves with
 * { code, signal, error? } once it exited and its output drained), `tail(n)` (last lines,
 * masked), `stop()` (kill the whole tree and confirm it is gone; throws if it is not).
 * `logFile`: append the command, every output line and the exit to this file, masked.
 */
export function spawnTracked(command, args, o = {}) {
  return new Tracked(command, args, o);
}

/**
 * What a wait needs of a process it depends on (an Owner of wait.mjs), for a child that is not
 * tracked (a start script whose whole output a test reads): its exit, and the last lines of
 * `output()`.
 */
export function ownerOf(child, name, output) {
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    child.once('exit', (code, sig) => resolve({ code, signal: sig }));
    child.once('error', (err) => resolve({ code: null, signal: null, error: err.message }));
  });
  return { name, exited, tail: (n = 20) => output().split(/\r?\n/).filter(Boolean).slice(-n).join('\n') };
}

/** Stops every tracked child still running; throws one error listing every one that survived. */
export async function stopTracked() {
  const results = await Promise.allSettled([...pending].map((t) => t.stop()));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (errors.length) throw new Error(errors.join('\n'));
}
