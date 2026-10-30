// Attempt counting for the browser check's progress bar, shared by the worker (pow-worker.ts) and
// the main-thread fallback (pow.ts). No DOM, no worker globals: both bundles import it.
import type { deriveKey } from 'altcha-lib/algorithms/web/sha';

type DeriveKey = typeof deriveKey;

/** Attempts between two progress reports. */
export const PROGRESS_EVERY = 500;

/** `derive`, counting its calls: `report(attempts)` after every PROGRESS_EVERY of them. */
export function countAttempts(derive: DeriveKey, report: (attempts: number) => void): DeriveKey {
  let attempts = 0;
  return (...args) => {
    attempts += 1;
    if (attempts % PROGRESS_EVERY === 0) report(attempts);
    return derive(...args);
  };
}
