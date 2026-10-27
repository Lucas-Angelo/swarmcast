import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from '../core/logger.js';

/**
 * A child process (MediaMTX, cloudflared) that must never outlive SwarmCast.
 *
 * - POSIX: spawned in its own process group (detached) so the whole group can be signalled.
 * - All platforms: its pid is registered with the reaper process, which kills it if this
 *   process dies without cleaning up (crash, SIGKILL, Task Manager "End task").
 */
export class ManagedChild extends EventEmitter<{ line: [line: string, stream: 'stdout' | 'stderr']; exit: [code: number | null, signal: string | null] }> {
  readonly proc: ChildProcess;
  private exited = false;
  private exitPromise: Promise<void>;

  constructor(
    readonly name: string,
    command: string,
    args: string[],
    opts: SpawnOptions,
    private readonly reaper: Reaper | null,
    private readonly log: Logger,
  ) {
    super();
    this.proc = spawn(command, args, {
      ...opts,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc.once('exit', (code, signal) => {
        this.exited = true;
        if (this.proc.pid) this.reaper?.unregister(this.proc.pid);
        this.emit('exit', code, signal);
        resolve();
      });
      this.proc.once('error', (err) => {
        this.log.error({ err: err.message, child: name }, 'child process failed to start');
        this.exited = true;
        this.emit('exit', -1, null);
        resolve();
      });
    });
    if (this.proc.pid) this.reaper?.register(this.proc.pid);
    for (const [stream, s] of [
      ['stdout', this.proc.stdout],
      ['stderr', this.proc.stderr],
    ] as const) {
      if (!s) continue;
      readline.createInterface({ input: s }).on('line', (line) => this.emit('line', line, stream));
    }
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get running(): boolean {
    return !this.exited;
  }

  /** Graceful stop, escalating to a hard kill after `graceMs`. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.exited || !this.proc.pid) return;
    const pid = this.proc.pid;
    // Graceful first: delivered now, the grace period below is the wait.
    await killTree(pid, 'SIGTERM', { waitMs: 0 });
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref());
    if ((await Promise.race([this.exitPromise.then(() => 'exited' as const), timeout])) === 'timeout') {
      this.log.warn({ child: this.name }, 'child did not exit in time, killing');
      if (!(await killTree(pid, 'SIGKILL'))) this.log.warn({ child: this.name, pid }, 'child still running after a forced kill');
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 2000).unref())]);
    }
  }

  waitForExit(): Promise<void> {
    return this.exitPromise;
  }
}

export interface KillTreeOptions {
  /** How long to wait, after the kill was delivered, for the processes to be gone. Default 2000 ms; 0: do not wait. */
  waitMs?: number;
}

/** taskkill by absolute path: a `taskkill` earlier on PATH (Git, MSYS, a shim) is never run. */
function taskkillExe(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/** True while the process group `pgid` has a member (POSIX). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves when taskkill exited (it only returns once the processes were terminated), at most after `capMs`. */
function runTaskkill(pid: number, capMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let tk: ChildProcess;
    try {
      // /T: the whole tree (children found through their parent pid), /F: forced.
      tk = spawn(taskkillExe(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve();
      return;
    }
    const cap = setTimeout(() => {
      tk.kill();
      resolve();
    }, capMs);
    cap.unref();
    const done = (): void => {
      clearTimeout(cap);
      resolve();
    };
    tk.once('exit', done);
    tk.once('error', done);
  });
}

/**
 * Kill a process and its children, and wait for the facts: resolves once the kill was
 * delivered (Windows: taskkill has exited) and the processes are gone, or `waitMs` passed.
 * Resolves true when they are gone.
 *
 * - Windows: `taskkill /T /F` (always forced; `signal` does not apply). Only `pid` itself can be
 *   checked afterwards; a grandchild whose parent had already exited is not part of the tree
 *   any more (the end state is a Job Object for script mode too, as in the desktop app).
 * - POSIX: `signal` to the process group (our children are spawned detached, as group leaders),
 *   then waits until no member of the group is left; falls back to the process alone.
 */
export async function killTree(pid: number, signal: NodeJS.Signals, opts: KillTreeOptions = {}): Promise<boolean> {
  const waitMs = opts.waitMs ?? 2000;
  let alive: () => boolean = () => isAlive(pid);
  if (process.platform === 'win32') {
    await runTaskkill(pid);
  } else {
    try {
      process.kill(-pid, signal);
      alive = () => groupAlive(pid) || isAlive(pid);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (!alive()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Watchdog process. It reads "+pid" / "-pid" lines on stdin. When stdin closes (because
 * SwarmCast exited for any reason, including a crash or SIGKILL) it kills every registered pid.
 */
export class Reaper {
  private proc: ChildProcess | null = null;
  private pids = new Set<number>();
  private stopping = false;
  private restarts = 0;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly log: Logger,
  ) {}

  start(): void {
    this.stopping = false;
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      // Not detached: it shares our console/session, but ignores SIGINT/SIGHUP itself.
    });
    this.proc.stdin?.on('error', () => {});
    this.proc.on('error', (err) => this.log.warn({ err: err.message }, 'reaper failed to start'));
    this.proc.on('exit', () => {
      this.proc = null;
      if (!this.stopping && this.restarts < 5) {
        this.restarts += 1;
        this.log.warn('reaper exited unexpectedly, restarting');
        this.start();
      }
    });
    for (const pid of this.pids) this.write(`+${pid}`);
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  register(pid: number): void {
    this.pids.add(pid);
    this.write(`+${pid}`);
  }

  unregister(pid: number): void {
    this.pids.delete(pid);
    this.write(`-${pid}`);
  }

  private write(line: string): void {
    this.proc?.stdin?.write(`${line}\n`);
  }

  /** Stop the reaper (only after all children are gone). */
  stop(): void {
    this.stopping = true;
    this.proc?.stdin?.end();
  }
}

/** Longest the reaper waits for its kills (taskkill up to 5 s, then up to 2 s until gone). */
const REAP_CAP_MS = 8000;

/** Entry point of the reaper process (`swarmcast --reaper <parentPid>`). */
export function runReaper(parentPid: number): void {
  const pids = new Set<number>();
  let reaping = false;
  const reap = (): void => {
    if (reaping) return;
    reaping = true;
    // Exit once every tree is really gone (taskkill finished, then each pid checked), not after
    // a guess; a hung kill cannot keep the reaper alive past REAP_CAP_MS.
    setTimeout(() => process.exit(0), REAP_CAP_MS).unref();
    void Promise.all([...pids].map((pid) => killTree(pid, 'SIGKILL', { waitMs: 2000 }))).finally(() => process.exit(0));
  };
  // Ctrl+C / closing the terminal: SwarmCast itself shuts children down gracefully;
  // the reaper only acts once its parent is gone.
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) process.on(sig, () => {});
  readline
    .createInterface({ input: process.stdin })
    .on('line', (line) => {
      const pid = Number(line.slice(1));
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (line.startsWith('+')) pids.add(pid);
      else if (line.startsWith('-')) pids.delete(pid);
    })
    .on('close', reap);
  setInterval(() => {
    if (!isAlive(parentPid)) reap();
  }, 1000);
}
