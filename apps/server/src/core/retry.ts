const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` until it succeeds, waiting `delaysMs[i]` before retry i+1 (so delaysMs.length + 1
 * tries in total). Rethrows the last error.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  delaysMs: readonly number[],
  o: { onRetry?: (err: Error, nextAttempt: number, delayMs: number) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const delay = delaysMs[attempt - 1];
      if (delay === undefined) throw err;
      o.onRetry?.(err as Error, attempt + 1, delay);
      await (o.sleep ?? sleep)(delay);
    }
  }
}
