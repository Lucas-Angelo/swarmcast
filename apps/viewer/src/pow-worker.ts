// Web Worker (same-origin file built by Vite): solves the join proof-of-work off the main thread.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';

const ctx = self as unknown as { onmessage: ((ev: MessageEvent<Challenge>) => void) | null; postMessage(msg: unknown): void };

ctx.onmessage = (ev) => {
  solveChallenge({ challenge: ev.data, deriveKey, timeout: 60_000 }).then(
    (solution) => ctx.postMessage({ solution }),
    (err: unknown) => ctx.postMessage({ error: String(err) }),
  );
};
