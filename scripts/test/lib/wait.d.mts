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

export interface PollOptions {
  timeoutMs: number;
  what: string;
  detail?: () => string;
  abortOn?: readonly Owner[];
  /** Interval between two calls of `fn` (default 500 ms). */
  everyMs?: number;
}

/**
 * Polls `fn` until it returns something truthy and resolves with it; a throw means "not yet",
 * except a WaitError, which fails the wait at once.
 */
export function poll<T>(fn: () => T | Promise<T>, o: PollOptions): Promise<NonNullable<T>>;

/** What `promise` resolves to, or `fallback` after `ms` (the timer is cleared either way). */
export function orTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F>;

export interface LineSource extends Owner, EventEmitter {
  readonly lines: readonly string[];
}

export function waitForLine(
  proc: LineSource,
  re: RegExp,
  o: { timeoutMs: number; what: string; from?: number; detail?: () => string; abortOn?: readonly Owner[] },
): Promise<RegExpExecArray>;
