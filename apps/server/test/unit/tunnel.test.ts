import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseQuickTunnelUrl } from '../../src/tunnel/parse.js';
import { waitForReachable } from '../../src/tunnel/provider.js';

// cloudflared prints the quick tunnel's address in a banner line; the API host it talks to and
// unrelated lines must never be taken for it. waitForReachable then polls the address with a
// growing back-off (500 ms, ×1.5 each time, at most 4 s) until the live's marker header answers.
// The clock is fake (Date and timers): the back-off passes at once and the attempts are counted
// against it.

describe('quick tunnel URL parsing', () => {
  it('reads the URL from the cloudflared banner line', () => {
    // Arrange
    const line = '2026-10-25T18:00:00Z INF |  https://quiet-river-mango-tree.trycloudflare.com                                     |';
    // Act
    const url = parseQuickTunnelUrl(line);
    // Assert
    expect(url).toBe('https://quiet-river-mango-tree.trycloudflare.com');
  });

  it.each([
    ['the API host', 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"'],
    ['a connection line', 'INF Registered tunnel connection connIndex=0'],
    ['another site', 'see https://example.com'],
  ])('ignores %s', (_what, line) => {
    // Act
    const url = parseQuickTunnelUrl(line);
    // Assert
    expect(url).toBeNull();
  });

  it('normalizes case', () => {
    // Act
    const url = parseQuickTunnelUrl('INF | https://ABC-def.TryCloudflare.com |');
    // Assert
    expect(url).toBe('https://abc-def.trycloudflare.com');
  });
});

describe('waitForReachable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries with a growing delay until the marker header matches', async () => {
    // Arrange
    const at: number[] = [];
    const t0 = Date.now();
    const fetchImpl = (async () => {
      at.push(Date.now() - t0);
      if (at.length < 3) throw new Error('dns');
      return new Response('{}', { status: 200, headers: { 'x-swarmcast': at.length >= 4 ? 'live-1' : 'other' } });
    }) as typeof fetch;
    // Act
    const result = waitForReachable('https://x.trycloudflare.com', 'live-1', { fetchImpl, timeoutMs: 20_000 });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(at).toEqual([0, 500, 1250, 2375]);
  });

  it('gives up after the timeout', async () => {
    // Arrange
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('nope');
    }) as typeof fetch;
    // Act
    const result = waitForReachable('https://x', 'm', { fetchImpl, timeoutMs: 600 });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(false);
    expect(calls).toBe(2);
  });
});
