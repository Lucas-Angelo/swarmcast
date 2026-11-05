// The panel's loads asked again when the network lost the request (apps/admin/src/ask-again.ts):
// a fetch() that rejected (no HTTP answer at all, e.g. net::ERR_NO_BUFFER_SPACE on a Windows
// runner) runs again after a pause until the server answers; an HTTP error is an answer and is
// passed on at once; aborting stops it. The clock is Vitest's fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api.js';
import { ASK_AGAIN_MS, askUntilAnswered, isNoAnswer } from '../../src/ask-again.js';

/** What fetch() rejects with when the connection fails before any answer (Chrome's text). */
const lost = (): TypeError => new TypeError('Failed to fetch');

/** A request that is lost `n` times, then answered with `answer`. */
function lostTimes<T>(n: number, answer: T) {
  let calls = 0;
  const request = vi.fn(async () => {
    calls++;
    if (calls <= n) throw lost();
    return answer;
  });
  return request;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('askUntilAnswered', () => {
  it('a lost request is sent again after each pause until the server answers', async () => {
    // Arrange
    const request = lostTimes(ASK_AGAIN_MS.length + 2, { done: false });
    // Act
    const answer = askUntilAnswered(request);
    await vi.runAllTimersAsync();
    // Assert
    await expect(answer).resolves.toEqual({ done: false });
    expect(request).toHaveBeenCalledTimes(ASK_AGAIN_MS.length + 3);
  });

  it('waits the pauses of ASK_AGAIN_MS between tries, the last one again and again', async () => {
    // Arrange
    const request = lostTimes(ASK_AGAIN_MS.length + 1, 'ok');
    const expected = [...ASK_AGAIN_MS, ASK_AGAIN_MS.at(-1)!];
    const seen: number[] = [];
    // Act
    void askUntilAnswered(request);
    await vi.advanceTimersByTimeAsync(0);
    for (const ms of expected) {
      const before = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(ms - 1);
      const early = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      seen.push(early === before && request.mock.calls.length === before + 1 ? ms : -1);
    }
    // Assert
    expect(seen).toEqual(expected);
  });

  it('an HTTP error is an answer: passed on at once, never asked again', async () => {
    // Arrange
    const notFound = new ApiError('Request failed (404)', 'err.requestFailed', { status: 404 });
    const request = vi.fn(async () => Promise.reject(notFound));
    // Act
    const answer = askUntilAnswered(request);
    const settled = expect(answer).rejects.toBe(notFound);
    await vi.runAllTimersAsync();
    // Assert
    await settled;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops asking once its signal aborts (the card went away)', async () => {
    // Arrange
    const request = lostTimes(Number.POSITIVE_INFINITY, 'never');
    const stop = new AbortController();
    // Act
    const answer = askUntilAnswered(request, stop.signal);
    const settled = expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_MS[0]);
    stop.abort();
    await vi.runAllTimersAsync();
    // Assert
    await settled;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('only a fetch() that got no answer counts as lost', () => {
    // Act
    const kinds = [isNoAnswer(lost()), isNoAnswer(new ApiError('Request failed (500)')), isNoAnswer(new DOMException('aborted', 'AbortError')), isNoAnswer(null)];
    // Assert
    expect(kinds).toEqual([true, false, false, false]);
  });
});
