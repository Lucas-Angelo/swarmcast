// Loads the panel makes once, when a card appears (the tutorial's "done", "Your page", the log
// retention, the desktop app's state), asked again when the network lost the request.
//
// A request that never got an answer (fetch() rejected: the connection failed before any HTTP
// response) is not an answer: the browser never sends it again by itself, and a card that took
// it as one stayed wrong until the page was reloaded. On a Windows runner one such request,
// GET /api/onboarding, failed with net::ERR_NO_BUFFER_SPACE while every other request of the
// panel went through, and the first-run tutorial never opened (pipeline run 42046773993,
// windows app job). An HTTP error is an answer (an older server without the route answers
// 404) and is passed on at once.

/** Pauses before asking again, one per try; the last one repeats until the server answers. */
export const ASK_AGAIN_MS = [500, 1000, 2000, 4000, 5000] as const;

/**
 * True when `err` says the request got no answer at all: fetch() rejects with a TypeError when
 * the connection fails (refused, reset, no buffer space), never for an HTTP error status.
 */
export function isNoAnswer(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `request` until the server answers: when it fails without an answer (isNoAnswer), it
 * runs again after the next pause of ASK_AGAIN_MS. Resolves with the first answer; rejects
 * with an HTTP error (any error but a lost request) at once, or with the signal's reason once
 * `signal` aborts (the card went away).
 */
export async function askUntilAnswered<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await request();
    } catch (err) {
      if (!isNoAnswer(err) || signal?.aborted) throw err;
    }
    await pause(ASK_AGAIN_MS[Math.min(tries, ASK_AGAIN_MS.length - 1)]!, signal);
  }
}
