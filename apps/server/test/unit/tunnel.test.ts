import { describe, expect, it } from 'vitest';
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

describe('waitForReachable', () => {
  it('retries until the marker header matches', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error('dns');
      return new Response('{}', { status: 200, headers: { 'x-swarmcast': calls >= 4 ? 'live-1' : 'other' } });
    }) as typeof fetch;
    expect(await waitForReachable('https://x.trycloudflare.com', 'live-1', { fetchImpl, timeoutMs: 20_000 })).toBe(true);
    expect(calls).toBe(4);
  });
  it('gives up after the timeout', async () => {
    const fetchImpl = (async () => {
      throw new Error('nope');
    }) as typeof fetch;
    expect(await waitForReachable('https://x', 'm', { fetchImpl, timeoutMs: 600 })).toBe(false);
  });
});
