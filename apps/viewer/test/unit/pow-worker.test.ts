import { createChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The worker's global scope, as the browser gives it to a dedicated worker.
const posted: unknown[] = [];
const scope = {
  location: { origin: 'https://stream.example' },
  onmessage: null as ((ev: { origin: string; data: unknown }) => void) | null,
  postMessage: (m: unknown) => posted.push(m),
};

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('../../src/pow-worker.js');
});

function challenge(): Promise<Challenge> {
  return createChallenge({ algorithm: 'SHA-256', cost: 1, counter: 3, deriveKey, hmacSignatureSecret: 'test' });
}

describe('pow worker', () => {
  it('solves a challenge from the page that started it', async () => {
    posted.length = 0;
    scope.onmessage!({ origin: '', data: await challenge() });
    await vi.waitFor(() => expect(posted).toContainEqual({ solution: expect.objectContaining({ counter: 3 }) }));
  });

  it("also takes a message that carries this page's origin", async () => {
    posted.length = 0;
    scope.onmessage!({ origin: 'https://stream.example', data: await challenge() });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
  });

  it('ignores messages from another origin and anything that is not a challenge', async () => {
    posted.length = 0;
    scope.onmessage!({ origin: 'https://evil.example', data: await challenge() });
    scope.onmessage!({ origin: '', data: null });
    scope.onmessage!({ origin: '', data: 'solve me' });
    scope.onmessage!({ origin: '', data: { parameters: {} } });
    await new Promise((r) => setTimeout(r, 50));
    expect(posted).toEqual([]);
  });
});
