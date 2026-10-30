import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { ExitInfo, Owner } from './wait.mjs';

export function isAlive(pid: number): boolean;

/** POSIX: every descendant of `root` (also those in a process group of their own). Windows: []. */
export function descendants(root: number): number[];

export interface KillTreeOptions {
  /** POSIX only; Windows always forces (taskkill /T /F). Default SIGKILL. */
  signal?: NodeJS.Signals;
  /** How long to wait for every process of the tree to be gone (default 5000 ms). */
  waitMs?: number;
  /** `pid` already exited: signal its group only (POSIX), do nothing on Windows (pid reuse). */
  exited?: boolean;
  /** false: POSIX, the group of `pid` only, not descendants in groups of their own (default true). */
  tree?: boolean;
}

/** Kills `pid` and its children; resolves true once all of them are gone, false after `waitMs`. */
export function killTree(pid: number, o?: KillTreeOptions): Promise<boolean>;

export interface SpawnTrackedOptions {
  /** Shown in messages and in the log file (default: the command's file name). */
  name?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default ['ignore', 'pipe', 'pipe']. */
  stdio?: StdioOptions;
  /** Append the command, every output line and the exit to this file. */
  logFile?: string;
  /** Applied to everything written to the log file and returned by tail() (hide secrets). */
  mask?: (text: string) => string;
  /** What the start line of the log says instead of the full command line. */
  describe?: string;
}

export interface Tracked extends EventEmitter<{ line: [line: string, stream: 'stdout' | 'stderr'] }> {
  readonly name: string;
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  /** Output lines so far (stdout and stderr, when piped). */
  readonly lines: readonly string[];
  /** Resolves once the process exited and its output drained. */
  readonly exited: Promise<ExitInfo>;
  readonly exitInfo: ExitInfo | null;
  readonly running: boolean;
  /** The last `n` output lines (default 20), masked. */
  tail(n?: number): string;
  /**
   * Kill the whole tree (after `graceMs` of SIGTERM, if given) and confirm that it is gone:
   * rejects when the process or one of its children survives. Calling it again returns the
   * same promise.
   */
  stop(o?: { graceMs?: number; timeoutMs?: number }): Promise<void>;
}

export function spawnTracked(command: string, args: readonly string[], o?: SpawnTrackedOptions): Tracked;

/** Stops every tracked child not stopped yet; rejects listing every one that survived. */
export function stopTracked(): Promise<void>;

/** An Owner (wait.mjs) for a child that is not tracked: its exit, and the last lines of `output()`. */
export function ownerOf(child: ChildProcess, name: string, output: () => string): Owner;
