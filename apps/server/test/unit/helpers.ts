import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { onTestFinished, vi } from 'vitest';

export const silentLog = pino({ level: 'silent' });

/**
 * A fresh, empty folder under the OS temp dir, deleted when the current test finishes, passed or
 * failed (call it from a test or a beforeEach). Cleanups run in reverse order, so whatever the test
 * opens in the folder afterwards (a log file, a child process) is closed before the folder goes:
 * Windows cannot delete a folder while a file in it is open.
 */
export function tempDir(prefix = 'sc-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A logger that keeps every line it writes (at `level` and above), parsed. */
export function captureLog(level: pino.Level = 'debug'): { log: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const out: string[] = [];
  const log = pino({ level }, { write: (line: string) => void out.push(line) });
  return { log, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** A clock the test moves by hand: `now` goes to the code under test, `advance(ms)` is the test's. */
export interface ManualClock {
  now: () => number;
  /** Moves the clock forward and returns the new time. */
  advance: (ms: number) => number;
}

export function manualClock(start = 1_000_000): ManualClock {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * Kills a process the test started that may already be gone: a cleanup, so "no such process"
 * (ESRCH) is the expected case, while any other error (EPERM: not ours) still fails the test.
 */
export function killIfRunning(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * A viewer's WebSocket as ControlChannel.attach takes it: frames arrive through the 'message'
 * event (as `ws` emits them), and whatever the channel sends, closes or terminates is recorded.
 */
export class FakeControlSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminate = vi.fn();
  close = vi.fn();
  ping(): void {}
  send(d: string): void {
    this.sent.push(d);
  }
  /** A frame from the viewer. */
  receive(data: string | Buffer, isBinary = false): void {
    this.emit('message', typeof data === 'string' ? Buffer.from(data) : data, isBinary);
  }
}
