// Web Worker (same-origin file built by Vite): solves the join proof-of-work off the main thread.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { countAttempts } from './pow-attempts.js';

const ctx = self as unknown as {
  location: { origin: string };
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(msg: unknown): void;
};

/** The one message this worker takes: an ALTCHA v2 challenge ({ parameters: {...}, signature? }). */
function isChallenge(data: unknown): data is Challenge {
  const p = (data as { parameters?: unknown } | null)?.parameters;
  return typeof p === 'object' && p !== null && typeof (p as { salt?: unknown }).salt === 'string';
}

/** One message from the page; settles once its answer, if it gets one, is posted. */
export function handleMessage(ev: { origin: string; data: unknown }): Promise<void> {
  // A dedicated worker hears only the page that started it, and those messages carry no origin
  // (or this page's own). Anything else, or anything that is not a challenge, is ignored.
  if (ev.origin !== '' && ev.origin !== ctx.location.origin) return Promise.resolve();
  if (!isChallenge(ev.data)) return Promise.resolve();
  // Count attempts for the page's progress bar (the server puts the most attempts needed in data.max).
  const counting = countAttempts(deriveKey, (attempts) => ctx.postMessage({ attempts }));
  return solveChallenge({ challenge: ev.data, deriveKey: counting, timeout: 60_000 }).then(
    (solution) => ctx.postMessage({ solution }),
    (err: unknown) => ctx.postMessage({ error: String(err) }),
  );
}

ctx.onmessage = (ev) => void handleMessage(ev);
