import type { Challenge, Payload, Solution } from 'altcha-lib';

/** Progress of a solve, 0..1 (estimated from the attempts so far and the most the challenge can need). */
export type PowProgress = (fraction: number) => void;

/**
 * Solve a join proof-of-work challenge (ALTCHA format) in a Web Worker and return the payload
 * for POST /api/join. Falls back to the main thread when workers are unavailable.
 */
export async function solvePow(challenge: Challenge, onProgress?: PowProgress): Promise<Payload> {
  const max = Number(challenge.parameters.data?.max) || 0;
  const report = (attempts: number): void => {
    if (onProgress && max > 0) onProgress(Math.min(0.99, attempts / max));
  };
  const solution = await solveInWorker(challenge, report).catch(() => solveHere(challenge));
  if (!solution) throw new Error('no solution');
  onProgress?.(1);
  return { challenge: { parameters: challenge.parameters, ...(challenge.signature ? { signature: challenge.signature } : {}) }, solution };
}

function solveInWorker(challenge: Challenge, report: (attempts: number) => void): Promise<Solution | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ solution?: Solution | null; error?: string; attempts?: number }>) => {
      if (ev.data.attempts !== undefined) {
        report(ev.data.attempts);
        return;
      }
      worker.terminate();
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data.solution ?? null);
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || 'worker failed'));
    };
    worker.postMessage(challenge);
  });
}

async function solveHere(challenge: Challenge): Promise<Solution | null> {
  const [{ solveChallenge }, { deriveKey }] = await Promise.all([import('altcha-lib'), import('altcha-lib/algorithms/web/sha')]);
  return solveChallenge({ challenge, deriveKey, timeout: 60_000 });
}
