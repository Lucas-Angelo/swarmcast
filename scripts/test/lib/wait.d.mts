import type { EventEmitter } from 'node:events';

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started (spawn error). */
  error?: string;
}

/** What `until` needs from a process it depends on (a tracked process, see proc.mjs). */
export interface Owner {
  readonly name: string;
  readonly exited: Promise<ExitInfo>;
  tail(n?: number): string;
}

export class WaitError extends Error {}

export function formatExit(x: ExitInfo | null): string;

export interface UntilOptions {
  timeoutMs: number;
  /** What is awaited, for the error message: "timed out waiting for <what>". */
  what: string;
  /** The state at the moment of failure, for the error message. */
  detail?: () => string;
  /** Fail at once when one of these processes exits. */
  abortOn?: readonly Owner[];
  /** Check again on each of these events. */
  on?: ReadonlyArray<readonly [EventEmitter, string]>;
  /** Safety-net poll interval (default 250 ms). */
  pollMs?: number;
}

export function until(pred: () => boolean | Promise<boolean>, o: UntilOptions): Promise<void>;

export interface LineSource extends Owner, EventEmitter {
  readonly lines: readonly string[];
}

export function waitForLine(
  proc: LineSource,
  re: RegExp,
  o: { timeoutMs: number; what: string; from?: number; detail?: () => string; abortOn?: readonly Owner[] },
): Promise<RegExpExecArray>;
