import type { Challenge, Payload, Solution } from 'altcha-lib';
import { countAttempts } from './pow-attempts.js';

/** Progress of a solve, 0..1 (estimated from the attempts so far and the most the challenge can need). */
export type PowProgress = (fraction: number) => void;

/** What the solve needs of its dedicated worker (one running pow-worker.ts). */
export type PowWorker = Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;

/** The clock of the worker's watchdog. */
export interface PowTimers {
  setTimeout(fire: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface SolvePowOptions {
  /** Starts the solver worker (tests pass a fake). */
  worker?: () => PowWorker;
  /**
   * The watchdog's clock (tests pass a manual one: faked global timers would also hold the
   * main-thread solver, which yields to the event loop with setTimeout).
   */
  timers?: PowTimers;
}

/**
 * Solve a join proof-of-work challenge (ALTCHA format) in a Web Worker and return the payload
 * for POST /api/join. Falls back to the main thread when the worker fails or stays silent.
 */
export async function solvePow(challenge: Challenge, onProgress?: PowProgress, o: SolvePowOptions = {}): Promise<Payload> {
  const max = Number(challenge.parameters.data?.max) || 0;
  const report = (attempts: number): void => {
    if (onProgress && max > 0) onProgress(Math.min(0.99, attempts / max));
  };
  const solution = await solveInWorker(challenge, report, o.worker ?? startWorker, o.timers ?? realTimers).catch(() => solveHere(challenge, report));
  if (!solution) throw new Error('no solution');
  onProgress?.(1);
  return { challenge: { parameters: challenge.parameters, ...(challenge.signature ? { signature: challenge.signature } : {}) }, solution };
}

/**
 * A worker that has said nothing for this long is stuck (it never started, or its script never
 * arrived without an error event); the solve moves to the main thread. A working one reports
 * every few hundred attempts, far more often.
 */
export const WORKER_SILENT_MS = 15_000;

const startWorker = (): PowWorker => new Worker(new URL('./pow-worker.ts', import.meta.url), { type: 'module' });

const realTimers: PowTimers = {
  setTimeout: (fire, ms) => setTimeout(fire, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout> | undefined),
};

function solveInWorker(
  challenge: Challenge,
  report: (attempts: number) => void,
  start: () => PowWorker,
  timers: PowTimers,
): Promise<Solution | null> {
  return new Promise((resolve, reject) => {
    const worker = start();
    let watchdog: unknown;
    const fail = (why: string): void => {
      timers.clearTimeout(watchdog);
      worker.terminate();
      reject(new Error(why));
    };
    const arm = (): void => {
      timers.clearTimeout(watchdog);
      watchdog = timers.setTimeout(() => fail('the worker stopped answering'), WORKER_SILENT_MS);
    };
    worker.onmessage = (ev: MessageEvent<{ solution?: Solution | null; error?: string; attempts?: number }>) => {
      if (ev.data.attempts !== undefined) {
        arm();
        report(ev.data.attempts);
        return;
      }
      timers.clearTimeout(watchdog);
      worker.terminate();
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data.solution ?? null);
    };
    worker.onerror = (ev) => fail(ev.message || 'worker failed');
    arm();
    worker.postMessage(challenge);
  });
}

/** The same solve on the main thread, still reporting progress (the bar moves while it runs). */
async function solveHere(challenge: Challenge, report: (attempts: number) => void): Promise<Solution | null> {
  const [{ solveChallenge }, { deriveKey }] = await Promise.all([import('altcha-lib'), import('altcha-lib/algorithms/web/sha')]);
  return solveChallenge({ challenge, deriveKey: countAttempts(deriveKey, report), timeout: 60_000 });
}
