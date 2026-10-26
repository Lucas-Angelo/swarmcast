// Web Worker (same-origin file built by Vite): solves the join proof-of-work off the main thread.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';

const ctx = self as unknown as { onmessage: ((ev: MessageEvent<Challenge>) => void) | null; postMessage(msg: unknown): void };

/** Attempts between two progress messages. */
const PROGRESS_EVERY = 500;

ctx.onmessage = (ev) => {
  // Count attempts for the page's progress bar (the server puts the most attempts needed in data.max).
  let attempts = 0;
  const counting: typeof deriveKey = (...args) => {
    attempts += 1;
    if (attempts % PROGRESS_EVERY === 0) ctx.postMessage({ attempts });
    return deriveKey(...args);
  };
  solveChallenge({ challenge: ev.data, deriveKey: counting, timeout: 60_000 }).then(
    (solution) => ctx.postMessage({ solution }),
    (err: unknown) => ctx.postMessage({ error: String(err) }),
  );
};
