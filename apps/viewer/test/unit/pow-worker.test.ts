// The join proof-of-work worker (pow-worker.ts) in a stand-in for a dedicated worker's global scope:
// each test loads the module fresh into a scope of its own, so no test sees another's messages.
// handleMessage settles once its answer, if any, is posted, so "ignored" is checked right after it.
import { createChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const ORIGIN = 'https://stream.example';

function challenge(counter = 3): Promise<Challenge> {
  return createChallenge({ algorithm: 'SHA-256', cost: 1, counter, deriveKey, hmacSignatureSecret: 'test' });
}

/**
 * The worker, loaded fresh into a scope of its own: `posted` is what it sent to the page,
 * `firstPost` settles with the first message it posts, `scope.onmessage` is what the browser calls.
 */
async function worker() {
  const posted: unknown[] = [];
  let onPost: (m: unknown) => void = () => {};
  const firstPost = new Promise<unknown>((resolve) => (onPost = resolve));
  const scope = {
    location: { origin: ORIGIN },
    onmessage: null as ((ev: { origin: string; data: unknown }) => void) | null,
    postMessage: (m: unknown) => {
      posted.push(m);
      onPost(m);
    },
  };
  vi.resetModules();
  vi.stubGlobal('self', scope);
  onTestFinished(() => void vi.unstubAllGlobals());
  const { handleMessage } = await import('../../src/pow-worker.js');
  return { posted, firstPost, scope, handleMessage };
}

const solved = (counter: number) => ({ solution: expect.objectContaining({ counter }) });

describe('pow worker', () => {
  it('solves a challenge from the page that started it (messages without an origin)', async () => {
    // Arrange
    const { posted, handleMessage } = await worker();

    // Act
    await handleMessage({ origin: '', data: await challenge() });

    // Assert
    expect(posted).toEqual([solved(3)]);
  });

  it("also takes a message that carries this page's origin", async () => {
    // Arrange
    const { posted, handleMessage } = await worker();

    // Act
    await handleMessage({ origin: ORIGIN, data: await challenge() });

    // Assert
    expect(posted).toEqual([solved(3)]);
  });

  it.each([
    ['a challenge from another origin', 'https://evil.example', () => challenge()],
    ['nothing', '', async () => null],
    ['a string', '', async () => 'solve me'],
    ['parameters without a salt', '', async () => ({ parameters: {} })],
  ])('ignores %s', async (_case, origin, data) => {
    // Arrange
    const { posted, handleMessage } = await worker();
    const message = await data();

    // Act
    await handleMessage({ origin, data: message });

    // Assert
    expect(posted).toEqual([]);
  });

  it('answers what the page sends through onmessage', async () => {
    // Arrange
    const { firstPost, scope } = await worker();

    // Act
    scope.onmessage!({ origin: '', data: await challenge() });

    // Assert
    expect(await firstPost).toEqual(solved(3));
  });
});
