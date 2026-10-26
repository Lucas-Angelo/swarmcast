import type { Challenge, Payload, Solution } from 'altcha-lib';

/**
 * Solve a join proof-of-work challenge (ALTCHA format) in a Web Worker and return the payload
 * for POST /api/join. Falls back to the main thread when workers are unavailable.
 */
export async function solvePow(challenge: Challenge): Promise<Payload> {
  const solution = await solveInWorker(challenge).catch(() => solveHere(challenge));
  if (!solution) throw new Error('no solution');
  return { challenge: { parameters: challenge.parameters, ...(challenge.signature ? { signature: challenge.signature } : {}) }, solution };
}

function solveInWorker(challenge: Challenge): Promise<Solution | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ solution?: Solution | null; error?: string }>) => {
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
