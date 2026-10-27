import { describe, expect, it, vi } from 'vitest';
import { QUICK_TUNNEL_CONCURRENCY_LIMIT } from '@swarmcast/shared';
import type { DirectMode } from '../../src/direct/direct.js';
import { PEAK_WINDOW_MS, notePeak, recentPeak, type HttpStats } from '../../src/public/server.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { makeController } from './live-helpers.js';

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;

/** A tunnel that reports itself as the Cloudflare quick tunnel. */
function quickTunnel(): NoTunnel {
  const t = new NoTunnel();
  Object.defineProperty(t, 'name', { value: 'cloudflare-quick' });
  return t;
}

function liveWith(viewers: number, opts: { p2p?: boolean; tunnel?: NoTunnel } = {}) {
  const { live } = makeController(direct, { tunnel: opts.tunnel ?? quickTunnel() });
  for (let i = 0; i < viewers; i++) {
    const s = live.access.createSession({ nickname: `v${i}`, deviceId: `d${i}`, device: 'desktop', ip: 'ip' });
    s.connections = 1;
    s.p2pEnabled = opts.p2p ?? true;
  }
  return live;
}

const tunnelWarning = (live: ReturnType<typeof liveWith>) => live.snapshot().warningCodes.find((w) => w.code === 'warn.tunnelLimit');

describe('quick tunnel limit (200 in flight, WebSockets included)', () => {
  it('counts open WebSockets and the recent HTTP peak', () => {
    const live = liveWith(0);
    expect(live.tunnelInFlight()).toBe(0);
    live.httpStats.inFlight = 30;
    notePeak(live.httpStats);
    live.httpStats.inFlight = 5;
    // Control sockets and plain /tracker sockets count, channels inside /control do not.
    vi.spyOn(live.control, 'connectionCount', 'get').mockReturnValue(100);
    vi.spyOn(live.tracker, 'plainSocketCount', 'get').mockReturnValue(2);
    expect(live.tunnelInFlight()).toBe(132);
    expect(live.snapshot().stats.tunnelInFlight).toBe(132);
  });

  it('keeps the HTTP peak for one window, then falls back to the current count', () => {
    const s: HttpStats = { inFlight: 0, served: 0, peak: 0, peakAt: 0 };
    s.inFlight = 40;
    notePeak(s, 1000);
    s.inFlight = 60;
    notePeak(s, 2000);
    s.inFlight = 3;
    expect(recentPeak(s, 3000)).toBe(60);
    expect(recentPeak(s, 1000 + 2 * PEAK_WINDOW_MS + 1)).toBe(3);
    // A new window starts from the current count.
    notePeak(s, 1000 + PEAK_WINDOW_MS + 1);
    expect(s.peak).toBe(3);
  });

  it('no warning for a small audience', () => {
    expect(tunnelWarning(liveWith(40))).toBeUndefined();
  });

  it('warns near the limit: ~107 viewers with P2P (1 socket + ~0.5 requests each)', () => {
    expect(tunnelWarning(liveWith(100))).toBeUndefined();
    const w = tunnelWarning(liveWith(110));
    expect(w?.params).toMatchObject({ used: 165, limit: QUICK_TUNNEL_CONCURRENCY_LIMIT });
  });

  it('warns sooner when viewers have P2P off (more video requests each)', () => {
    expect(tunnelWarning(liveWith(64, { p2p: false }))).toBeDefined();
  });

  it('warns on measured load even when the estimate is low', () => {
    const live = liveWith(10);
    vi.spyOn(live.control, 'connectionCount', 'get').mockReturnValue(10);
    live.httpStats.inFlight = 170;
    notePeak(live.httpStats);
    expect(tunnelWarning(live)?.params).toMatchObject({ used: 180 });
  });

  it('only for the quick tunnel in Secure mode', () => {
    expect(tunnelWarning(liveWith(150, { tunnel: new NoTunnel() }))).toBeUndefined();
    const live = liveWith(150);
    live.mode = 'direct';
    expect(tunnelWarning(live)).toBeUndefined();
  });
});
