// Web Worker (same-origin file built by Vite): solves the join proof-of-work off the main thread.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';

const ctx = self as unknown as {
  location: { origin: string };
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(msg: unknown): void;
};

/** Attempts between two progress messages. */
const PROGRESS_EVERY = 500;

/** The one message this worker takes: an ALTCHA v2 challenge ({ parameters: {...}, signature? }). */
function isChallenge(data: unknown): data is Challenge {
  const p = (data as { parameters?: unknown } | null)?.parameters;
  return typeof p === 'object' && p !== null && typeof (p as { salt?: unknown }).salt === 'string';
}

ctx.onmessage = (ev) => {
  // A dedicated worker hears only the page that started it, and those messages carry no origin
  // (or this page's own). Anything else, or anything that is not a challenge, is ignored.
  if (ev.origin !== '' && ev.origin !== ctx.location.origin) return;
  if (!isChallenge(ev.data)) return;
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
