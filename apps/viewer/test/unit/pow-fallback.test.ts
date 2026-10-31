// The browser check's solver (apps/viewer/src/pow.ts) around its worker: a worker double stands
// in for pow-worker.ts, and the main-thread fallback runs the real altcha solver on easy
// challenges. A silent worker used to leave the join page at "Checking your browser… 0 %" for
// good (stability soak: Firefox on Windows); the watchdog moves the solve to the main thread, and
// the bar keeps moving there too.
// The watchdog runs on a manual clock, never on faked global timers: the real solver yields to the
// event loop with setTimeout once a solve passes 200 ms, and a faked one would hold it for good
// (a loaded runner reached that; the test then timed out).
import { createChallenge, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { solvePow, WORKER_SILENT_MS, type PowTimers, type PowWorker } from '../../src/pow.js';
import { PROGRESS_EVERY } from '../../src/pow-attempts.js';

/** A challenge whose answer is `counter` attempts away; `max` is what the progress bar counts against. */
function challenge(counter: number, max = 15_000): Promise<Challenge> {
  return createChallenge({ algorithm: 'SHA-256', cost: 1, counter, deriveKey, hmacSignatureSecret: 'test', data: { max } });
}

/** A worker double: says what the test tells it to, or nothing at all. */
class FakeWorker implements PowWorker {
  onmessage: PowWorker['onmessage'] = null;
  onerror: PowWorker['onerror'] = null;
  readonly received: unknown[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    this.received.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(data: { attempts?: number; solution?: Solution; error?: string }): void {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent);
  }
  crash(message: string): void {
    this.onerror?.call(this as unknown as Worker, { message } as ErrorEvent);
  }
}

/** The watchdog's clock: time moves only when the test says so (then pending callbacks run). */
class ManualClock implements PowTimers {
  private now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fire: () => void }>();
  setTimeout(fire: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fire });
    return id;
  }
  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number);
  }
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at > this.now) continue;
      this.timers.delete(id);
      t.fire();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('solvePow with a worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the worker's solution and shows its progress against the most attempts the challenge can need", async () => {
    // Arrange
    const c = await challenge(3, 2_000);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    const progress: number[] = [];
    const solved = solvePow(c, (f) => progress.push(f), { worker: () => worker, timers: clock });
    const solution: Solution = { counter: 3, derivedKey: 'k', time: 1 };

    // Act
    worker.say({ attempts: 500 });
    worker.say({ attempts: 1_000 });
    worker.say({ solution });

    // Assert
    expect(await solved).toEqual({ challenge: { parameters: c.parameters, signature: c.signature }, solution });
    expect(worker.received).toEqual([c]);
    expect(progress).toEqual([0.25, 0.5, 1]);
    expect(worker.terminated).toBe(true);
  });

  it('keeps waiting for a worker that reports progress, however long the whole solve takes', async () => {
    // Arrange
    const c = await challenge(3);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    const solved = solvePow(c, undefined, { worker: () => worker, timers: clock });
    const solution: Solution = { counter: 3, derivedKey: 'k', time: 1 };

    // Act
    for (let i = 1; i <= 3; i++) {
      await clock.advance(WORKER_SILENT_MS - 1);
      worker.say({ attempts: i * PROGRESS_EVERY });
    }
    worker.say({ solution });

    // Assert
    expect((await solved).solution).toEqual(solution);
  });

  it('solves on the main thread when the worker stays silent for WORKER_SILENT_MS', async () => {
    // Arrange
    const c = await challenge(3);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    let settled = false;
    const solved = solvePow(c, undefined, { worker: () => worker, timers: clock }).finally(() => (settled = true));

    // Act
    await clock.advance(WORKER_SILENT_MS - 1);

    // Assert
    expect(settled).toBe(false);
    expect(worker.terminated).toBe(false);

    // Act
    await clock.advance(1);

    // Assert
    expect((await solved).solution.counter).toBe(3);
    expect(worker.terminated).toBe(true);
  });

  it('solves on the main thread at once when the worker fails to start', async () => {
    // Arrange
    const c = await challenge(3);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    const solved = solvePow(c, undefined, { worker: () => worker, timers: clock });

    // Act
    worker.crash('SyntaxError: import declarations may only appear at top level of a module');

    // Assert
    expect((await solved).solution.counter).toBe(3);
    expect(worker.terminated).toBe(true);
  });

  it('keeps the progress bar moving while the main thread solves', async () => {
    // Arrange
    const c = await challenge(2 * PROGRESS_EVERY + 100, 4 * PROGRESS_EVERY);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    const progress: number[] = [];
    const solved = solvePow(c, (f) => progress.push(f), { worker: () => worker, timers: clock });

    // Act
    worker.crash('worker failed');
    await solved;

    // Assert
    expect(progress).toEqual([0.25, 0.5, 1]);
  });

  it('finishes a main-thread solve slow enough to yield to the event loop', async () => {
    // Arrange
    const c = await challenge(2 * PROGRESS_EVERY + 100, 4 * PROGRESS_EVERY);
    const worker = new FakeWorker();
    const clock = new ManualClock();
    const progress: number[] = [];
    const solved = solvePow(c, (f) => progress.push(f), { worker: () => worker, timers: clock });
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 50));
    const yields = vi.spyOn(globalThis, 'setTimeout');

    // Act
    worker.crash('worker failed');
    const { solution } = await solved;

    // Assert
    expect(solution.counter).toBe(2 * PROGRESS_EVERY + 100);
    expect(progress).toEqual([0.25, 0.5, 1]);
    expect(yields).toHaveBeenCalledWith(expect.any(Function), 0);
  });
});
