import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
    killTree(this.proc.pid, 'SIGTERM');
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref());
    if ((await Promise.race([this.exitPromise.then(() => 'exited' as const), timeout])) === 'timeout') {
      this.log.warn({ child: this.name }, 'child did not exit in time, killing');
      killTree(this.proc.pid, 'SIGKILL');
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 2000).unref())]);
    }
  }

  waitForExit(): Promise<void> {
    return this.exitPromise;
  }
}

export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      // /T kills the whole tree, /F forces it.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
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

/** Entry point of the reaper process (`swarmcast --reaper <parentPid>`). */
export function runReaper(parentPid: number): void {
  const pids = new Set<number>();
  const reap = (): never => {
    for (const pid of pids) killTree(pid, 'SIGKILL');
    // taskkill is asynchronous on Windows; give it a moment.
    setTimeout(() => process.exit(0), process.platform === 'win32' ? 1500 : 50);
    return undefined as never;
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
