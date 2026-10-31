import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseQuickTunnelUrl } from '../../src/tunnel/parse.js';
import { type CloudflareAnswer, type ReachabilityIo, waitForReachable } from '../../src/tunnel/provider.js';

// cloudflared prints the quick tunnel's address in a banner line; the API host it talks to and
// unrelated lines must never be taken for it. waitForReachable then polls the address with a
// growing back-off (500 ms, ×1.5 each time, at most 4 s) until the live's marker header answers,
// then waits for this machine's resolver to know the name. Its network side (Cloudflare's
// resolver, this machine's resolver, the GET) is a recording double; the clock is fake (Date and
// timers): the back-off passes at once and the attempts are counted against it.

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

/** A ReachabilityIo double that logs every call in `calls`, with Cloudflare's answers and the /healthz markers in turn (the last one repeats). */
function recordingIo(cloudflare: CloudflareAnswer[], markers: Array<string | null>, system: boolean[] = [true]): { io: ReachabilityIo; calls: string[] } {
  const calls: string[] = [];
  const next = <T>(list: T[]): T => (list.length > 1 ? list.shift()! : list[0]!);
  const io: ReachabilityIo = {
    cloudflare: async (host) => {
      const answer = next(cloudflare);
      calls.push(`cloudflare ${host}: ${typeof answer === 'string' ? answer : answer.ip}`);
      return answer;
    },
    system: async (host) => {
      const known = next(system);
      calls.push(`system ${host}: ${known ? 'known' : 'unknown'}`);
      return known;
    },
    health: async (url, ip) => {
      const marker = next(markers);
      calls.push(`GET ${url.href} via ${ip ?? 'system'}: ${marker}`);
      return marker;
    },
  };
  return { io, calls };
}

describe('waitForReachable', () => {
  const URL_ = 'https://brand-new-name.trycloudflare.com';
  const HOST = 'brand-new-name.trycloudflare.com';
  const IP = { ip: '104.16.230.132' };

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
    const { io } = recordingIo([IP], [null, null, 'other', 'live-1']);
    const health = io.health;
    io.health = async (...args) => {
      at.push(Date.now() - t0);
      return health(...args);
    };
    // Act
    const result = waitForReachable(URL_, 'live-1', { io, timeoutMs: 20_000 });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(at).toEqual([0, 500, 1250, 2375]);
  });

  it('gives up after the timeout', async () => {
    // Arrange
    const { io, calls } = recordingIo([IP], [null]);
    // Act
    const result = waitForReachable('https://x.trycloudflare.com', 'm', { io, timeoutMs: 600 });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(false);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
  });

  it("never asks this machine's resolver about the name before Cloudflare has its address, so it never remembers the new link as unknown", async () => {
    // Arrange
    const { io, calls } = recordingIo(['unknown', 'unknown', 'unknown', IP], ['live-1']);
    // Act
    const result = waitForReachable(URL_, 'live-1', { io });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(calls).toEqual([
      `cloudflare ${HOST}: unknown`,
      `cloudflare ${HOST}: unknown`,
      `cloudflare ${HOST}: unknown`,
      `cloudflare ${HOST}: 104.16.230.132`,
      `GET ${URL_}/healthz via 104.16.230.132: live-1`,
      `system ${HOST}: known`,
    ]);
  });

  it("shows the link once this machine's resolver knows the name too", async () => {
    // Arrange
    const { io, calls } = recordingIo([IP], ['live-1'], [false, false, true]);
    // Act
    const result = waitForReachable(URL_, 'live-1', { io });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(calls.filter((c) => c.startsWith('system'))).toEqual([`system ${HOST}: unknown`, `system ${HOST}: unknown`, `system ${HOST}: known`]);
  });

  it("goes through this machine's resolver only when Cloudflare's resolvers cannot be reached", async () => {
    // Arrange
    const { io, calls } = recordingIo(['unreachable'], ['live-1']);
    // Act
    const result = waitForReachable(URL_, 'live-1', { io });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(calls).toEqual([`cloudflare ${HOST}: unreachable`, `GET ${URL_}/healthz via system: live-1`, `system ${HOST}: known`]);
  });

  it('asks no resolver for a local address', async () => {
    // Arrange
    const { io, calls } = recordingIo([IP], ['live-1']);
    // Act
    const result = waitForReachable('http://127.0.0.1:8080', 'live-1', { io });
    await vi.runAllTimersAsync();
    // Assert
    expect(await result).toBe(true);
    expect(calls).toEqual(['GET http://127.0.0.1:8080/healthz via system: live-1']);
  });
});
