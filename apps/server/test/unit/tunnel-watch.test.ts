import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPublicAddress, type CloudflareAnswer, type HealthAnswer, type ReachabilityIo } from '../../src/tunnel/provider.js';
import { TunnelWatch, WATCH_ERRORS_BEFORE_REPLACE, WATCH_EVERY_MS, WATCH_RECHECK_MS, type PublicCheck } from '../../src/tunnel/watch.js';

// During a live, Cloudflare's edge can answer the quick tunnel's address with its own error page
// (HTTP 530: no connection for that tunnel) while cloudflared runs on without an error line (gate
// run 42164021587, preflight on a Windows runner: the address answered SwarmCast's marker, then the
// first viewer got Cloudflare's 530 page). The live watches the address and replaces such a tunnel.
// TunnelWatch's checks are a scripted double and its timers fake, so each check's time is exact.
// checkPublicAddress tells Cloudflare's answers (no marker) from no answer at all (the streamer's
// own connection), with a recording ReachabilityIo double.

describe('TunnelWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A watch whose checks answer `script` in turn (the last one repeats); records when each check ran and when it gave up. */
  function scripted(script: PublicCheck[]) {
    const t0 = Date.now();
    const checks: number[] = [];
    const lost: number[] = [];
    const watch = new TunnelWatch({
      check: async () => {
        checks.push(Date.now() - t0);
        return script.length > 1 ? script.shift()! : script[0]!;
      },
      onLost: () => lost.push(Date.now() - t0),
    });
    return { watch, checks, lost };
  }

  it('gives the tunnel up after three Cloudflare errors in a row, checking again every 5 s after the first', async () => {
    // Arrange
    const { watch, checks, lost } = scripted(['ok', 'edge-error', 'edge-error', 'edge-error', 'ok']);
    // Act
    watch.start();
    await vi.advanceTimersByTimeAsync(10 * WATCH_EVERY_MS);
    // Assert
    expect(WATCH_ERRORS_BEFORE_REPLACE).toBe(3);
    expect(checks).toEqual([WATCH_EVERY_MS, 2 * WATCH_EVERY_MS, 2 * WATCH_EVERY_MS + WATCH_RECHECK_MS, 2 * WATCH_EVERY_MS + 2 * WATCH_RECHECK_MS]);
    expect(lost).toEqual([2 * WATCH_EVERY_MS + 2 * WATCH_RECHECK_MS]);
    expect(watch.active).toBe(false);
  });

  it('keeps the tunnel when an answer with the marker comes between errors', async () => {
    // Arrange
    const { watch, lost } = scripted(['edge-error', 'edge-error', 'ok', 'edge-error', 'edge-error', 'ok']);
    // Act
    watch.start();
    await vi.advanceTimersByTimeAsync(20 * WATCH_EVERY_MS);
    // Assert
    expect(lost).toEqual([]);
    expect(watch.active).toBe(true);
  });

  it("never gives the tunnel up when nothing answers at all (the streamer's own connection is down)", async () => {
    // Arrange
    const { watch, checks, lost } = scripted(['no-answer']);
    // Act
    watch.start();
    await vi.advanceTimersByTimeAsync(20 * WATCH_EVERY_MS);
    // Assert
    expect(checks).toHaveLength(20);
    expect(lost).toEqual([]);
  });

  it('ignores a check that was still running when the watch stopped', async () => {
    // Arrange
    let answer!: (c: PublicCheck) => void;
    let lost = 0;
    const watch = new TunnelWatch({ check: () => new Promise((r) => (answer = r)), onLost: () => lost++, errorsBeforeReplace: 1 });
    watch.start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    // Act
    watch.stop();
    answer('edge-error');
    await vi.advanceTimersByTimeAsync(10 * WATCH_EVERY_MS);
    // Assert
    expect(lost).toBe(0);
    expect(watch.active).toBe(false);
  });
});

describe('checkPublicAddress', () => {
  const URL_ = 'https://quiet-river-mango-tree.trycloudflare.com';

  /** Cloudflare's resolver answers `dns`; the GET answers `health`; every call is recorded. */
  function io(dns: CloudflareAnswer, health: HealthAnswer | null): { io: ReachabilityIo; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      io: {
        cloudflare: async (host) => (calls.push(`cloudflare ${host}`), dns),
        system: async () => true,
        health: async (url, ip, headers) => (calls.push(`GET ${url.href} via ${ip ?? 'system'} probe ${headers['x-swarmcast-probe']}`), health),
      },
    };
  }

  it.each<[string, CloudflareAnswer, HealthAnswer | null, PublicCheck]>([
    ['our marker', { ip: '104.16.230.132' }, { status: 200, marker: 'live-1' }, 'ok'],
    ["Cloudflare's 530 page (no tunnel connection)", { ip: '104.16.230.132' }, { status: 530, marker: null }, 'edge-error'],
    ['a name Cloudflare no longer knows', 'unknown', { status: 200, marker: 'live-1' }, 'edge-error'],
    ['a marker of another live', { ip: '104.16.230.132' }, { status: 200, marker: 'live-0' }, 'edge-error'],
    ['no answer at all', { ip: '104.16.230.132' }, null, 'no-answer'],
  ])('%s → %s', async (_what, dns, health, expected) => {
    // Arrange
    const net = io(dns, health);
    // Act
    const seen = await checkPublicAddress(URL_, 'live-1', 'probe-token', net.io);
    // Assert
    expect(seen).toBe(expected);
  });

  it("asks through Cloudflare's address, with the live's probe token", async () => {
    // Arrange
    const net = io({ ip: '104.16.230.132' }, { status: 200, marker: 'live-1' });
    // Act
    await checkPublicAddress(URL_, 'live-1', 'probe-token', net.io);
    // Assert
    expect(net.calls).toEqual(['cloudflare quiet-river-mango-tree.trycloudflare.com', `GET ${URL_}/healthz via 104.16.230.132 probe probe-token`]);
  });
});
