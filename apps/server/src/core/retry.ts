/** The app is quitting: background work (speed test, first-run check, downloads, a pending start) gives up. */
export class QuitAbortError extends Error {
  constructor() {
    super('SwarmCast is quitting.');
    this.name = 'AbortError';
  }
}

/** Throws QuitAbortError when `signal` is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QuitAbortError();
}

/** Waits `ms`, or rejects (QuitAbortError) as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new QuitAbortError());
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new QuitAbortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `p`, or a rejection (QuitAbortError) as soon as `signal` aborts. The work behind `p` goes on:
 * the caller stops it (e.g. by stopping the child process); its late result is ignored.
 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(new QuitAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new QuitAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Run `fn` until it succeeds, waiting `delaysMs[i]` before retry i+1 (so delaysMs.length + 1
 * tries in total). Rethrows the last error. `signal` stops the retries (the app is quitting).
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  delaysMs: readonly number[],
  o: { onRetry?: (err: Error, nextAttempt: number, delayMs: number) => void; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const delay = delaysMs[attempt - 1];
      if (delay === undefined || o.signal?.aborted) throw err;
      o.onRetry?.(err as Error, attempt + 1, delay);
      await (o.sleep ?? ((ms) => sleep(ms, o.signal)))(delay);
      throwIfAborted(o.signal);
    }
  }
}
