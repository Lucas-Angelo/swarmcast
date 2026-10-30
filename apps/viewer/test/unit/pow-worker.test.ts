// The join proof-of-work worker (pow-worker.ts) in a stand-in for a dedicated worker's global scope:
// each test loads the module fresh into a scope of its own, so no test sees another's messages.
// Solving is asynchronous (WebCrypto), so "ignored" is shown with a sentinel: after the messages
// that must be ignored, a valid challenge goes in, and once its solution is out, nothing else is.
import { createChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const ORIGIN = 'https://stream.example';

function challenge(counter = 3): Promise<Challenge> {
  return createChallenge({ algorithm: 'SHA-256', cost: 1, counter, deriveKey, hmacSignatureSecret: 'test' });
}

/**
 * The worker, loaded fresh into a scope of its own. `send` is a message from the page, `posted`
 * what the worker sent back, and `until(done)` resolves as soon as a message it posts makes
 * `done(posted)` true (no polling: it is told about every message).
 */
async function worker() {
  const posted: unknown[] = [];
  const listeners = new Set<() => void>();
  const scope = {
    location: { origin: ORIGIN },
    onmessage: null as ((ev: { origin: string; data: unknown }) => void) | null,
    postMessage: (m: unknown) => {
      posted.push(m);
      for (const l of [...listeners]) l();
    },
  };
  vi.resetModules();
  vi.stubGlobal('self', scope);
  onTestFinished(() => void vi.unstubAllGlobals());
  await import('../../src/pow-worker.js');
  const send = (origin: string, data: unknown): void => scope.onmessage!({ origin, data });
  const until = (done: (messages: unknown[]) => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!done(posted)) return;
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
      check();
    });
  return { posted, send, until };
}

/** A solution message for a challenge whose secret number is `counter`. */
const isSolution = (m: unknown, counter: number): boolean => (m as { solution?: { counter?: number } }).solution?.counter === counter;

describe('pow worker', () => {
  it('solves a challenge from the page that started it (messages without an origin)', async () => {
    // Arrange
    const { posted, send, until } = await worker();

    // Act
    send('', await challenge());
    await until((m) => m.length > 0);

    // Assert
    expect(posted).toEqual([{ solution: expect.objectContaining({ counter: 3 }) }]);
  });

  it("also takes a message that carries this page's origin", async () => {
    // Arrange
    const { posted, send, until } = await worker();

    // Act
    send(ORIGIN, await challenge());
    await until((m) => m.length > 0);

    // Assert
    expect(posted).toEqual([{ solution: expect.objectContaining({ counter: 3 }) }]);
  });

  it('ignores messages from another origin and anything that is not a challenge', async () => {
    // Arrange
    const { posted, send, until } = await worker();
    const [foreign, sentinel] = await Promise.all([challenge(3), challenge(40)]);

    // Act
    send('https://evil.example', foreign);
    send('', null);
    send('', 'solve me');
    send('', { parameters: {} });
    send('', sentinel);
    await until((m) => m.some((x) => isSolution(x, 40)));

    // Assert
    expect(posted).toEqual([{ solution: expect.objectContaining({ counter: 40 }) }]);
  });
});
