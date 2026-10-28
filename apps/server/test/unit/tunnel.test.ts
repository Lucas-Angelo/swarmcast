import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseQuickTunnelUrl } from '../../src/tunnel/parse.js';
import { waitForReachable } from '../../src/tunnel/provider.js';

describe('quick tunnel URL parsing', () => {
  it('reads the URL from the cloudflared banner line', () => {
    const line = '2026-10-25T18:00:00Z INF |  https://quiet-river-mango-tree.trycloudflare.com                                     |';
    expect(parseQuickTunnelUrl(line)).toBe('https://quiet-river-mango-tree.trycloudflare.com');
  });
  it('ignores the API host and unrelated lines', () => {
    expect(parseQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"')).toBeNull();
    expect(parseQuickTunnelUrl('INF Registered tunnel connection connIndex=0')).toBeNull();
    expect(parseQuickTunnelUrl('see https://example.com')).toBeNull();
  });
  it('normalizes case', () => {
    expect(parseQuickTunnelUrl('INF | https://ABC-def.TryCloudflare.com |')).toBe('https://abc-def.trycloudflare.com');
  });
});

// A fake clock (Date and timers): the back-off between attempts (500 ms, x1.5, at most 4 s)
// passes at once, and the attempts can be counted against it.
describe('waitForReachable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries with a growing delay until the marker header matches', async () => {
    const at: number[] = [];
    const t0 = Date.now();
    const fetchImpl = (async () => {
      at.push(Date.now() - t0);
      if (at.length < 3) throw new Error('dns');
      return new Response('{}', { status: 200, headers: { 'x-swarmcast': at.length >= 4 ? 'live-1' : 'other' } });
    }) as typeof fetch;
    const result = waitForReachable('https://x.trycloudflare.com', 'live-1', { fetchImpl, timeoutMs: 20_000 });
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(at).toEqual([0, 500, 1250, 2375]);
  });

  it('gives up after the timeout', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('nope');
    }) as typeof fetch;
    const result = waitForReachable('https://x', 'm', { fetchImpl, timeoutMs: 600 });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(calls).toBe(2);
  });
});
