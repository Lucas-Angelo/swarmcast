import { describe, expect, it } from 'vitest';
import { QUICK_TUNNEL_CONCURRENCY_LIMIT, encodeTrackerFrame } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import { PEAK_WINDOW_MS, notePeak, recentPeak, type HttpStats } from '../../src/public/server.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { NoTunnel, type TunnelProvider } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';
import { controlSocket, directOff, joinViewer, roundTrip, trackerSocket, upgradeServer } from './helpers-b.js';
import { makeController } from './live-helpers.js';

// A Cloudflare quick tunnel allows 200 requests in flight and counts every open WebSocket as one:
// the /control sockets and any plain /tracker socket (tracker channels inside /control do not
// count), plus the HTTP requests in progress (the peak of the last window). The panel warns near
// the limit, from that measured load or from an estimate, whichever is higher: a viewer keeps one
// socket open plus about 0.5 video requests in flight with P2P, 1.5 without (so about 107 viewers
// with P2P reach the warning). Only the quick tunnel in Secure mode has this limit. The viewers'
// P2P switch is set on their sessions directly (their pages report it in stats).

/** The real quick tunnel, never started (no cloudflared needed: the live is not started either). */
const quickTunnel = (): QuickTunnel => new QuickTunnel('/nonexistent/cloudflared', '/nonexistent', null, silentLog);

/** A live on `tunnel` with `viewers` sessions watching, with P2P on unless `p2p` is false. */
function liveWith(viewers: number, opts: { p2p?: boolean; tunnel?: TunnelProvider } = {}): LiveController {
  const { live } = makeController(directOff(), { tunnel: opts.tunnel ?? quickTunnel() });
  for (let i = 0; i < viewers; i++) joinViewer(live.access, `v${i}`).p2pEnabled = opts.p2p ?? true;
  return live;
}

const tunnelWarning = (live: LiveController) => live.snapshot().warningCodes.find((w) => w.code === 'warn.tunnelLimit');

describe('quick tunnel limit (200 in flight, WebSockets included)', () => {
  it('counts open control sockets, plain tracker sockets and the recent HTTP peak, not the channels inside /control', async () => {
    // Arrange
    const { live } = makeController(directOff(), { tunnel: quickTunnel() });
    live.access.begin();
    const url = await upgradeServer(live.access, { control: live.control, tracker: live.tracker });
    const a = joinViewer(live.access, 'a');
    const b = joinViewer(live.access, 'b');
    const c = joinViewer(live.access, 'c');
    await Promise.all([controlSocket(url, a), controlSocket(url, b)]);
    const withChannel = await controlSocket(url, c);
    withChannel.ws.send(encodeTrackerFrame({ op: 'open', id: 1 }));
    await roundTrip(withChannel.ws);
    await Promise.all([trackerSocket(url, a), trackerSocket(url, b)]);
    live.httpStats.inFlight = 30;
    notePeak(live.httpStats);
    live.httpStats.inFlight = 5;
    // Act
    const inFlight = live.tunnelInFlight();
    // Assert
    expect(live.tracker.socketCount).toBe(3);
    expect(inFlight).toBe(3 + 2 + 30);
    expect(live.snapshot().stats.tunnelInFlight).toBe(35);
  });

  it('keeps the HTTP peak for one window', () => {
    // Arrange
    const s: HttpStats = { inFlight: 40, served: 0, peak: 0, peakAt: 0 };
    notePeak(s, 1000);
    s.inFlight = 60;
    notePeak(s, 2000);
    s.inFlight = 3;
    // Act
    const peak = recentPeak(s, 3000);
    // Assert
    expect(peak).toBe(60);
  });

  it('falls back to the current count once the peak is two windows old', () => {
    // Arrange
    const s: HttpStats = { inFlight: 60, served: 0, peak: 0, peakAt: 0 };
    notePeak(s, 1000);
    s.inFlight = 3;
    // Act
    const peak = recentPeak(s, 1000 + 2 * PEAK_WINDOW_MS + 1);
    // Assert
    expect(peak).toBe(3);
  });

  it('starts a new window from the current count', () => {
    // Arrange
    const s: HttpStats = { inFlight: 60, served: 0, peak: 0, peakAt: 0 };
    notePeak(s, 1000);
    s.inFlight = 3;
    // Act
    notePeak(s, 1000 + PEAK_WINDOW_MS + 1);
    // Assert
    expect(s.peak).toBe(3);
  });

  it('no warning for a small audience', () => {
    // Arrange
    const live = liveWith(40);
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning).toBeUndefined();
  });

  it('no warning yet for 100 viewers with P2P (the limit is near about 107)', () => {
    // Arrange
    const live = liveWith(100);
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning).toBeUndefined();
  });

  it('warns for 110 viewers with P2P: 1 socket + ~0.5 requests each', () => {
    // Arrange
    const live = liveWith(110);
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning?.params).toMatchObject({ used: 165, limit: QUICK_TUNNEL_CONCURRENCY_LIMIT });
  });

  it('warns sooner when viewers have P2P off (more video requests each)', () => {
    // Arrange
    const live = liveWith(64, { p2p: false });
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning).toBeDefined();
  });

  it('warns on measured load even when the estimate is low', () => {
    // Arrange
    const live = liveWith(10);
    live.httpStats.inFlight = 180;
    notePeak(live.httpStats);
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning?.params).toMatchObject({ used: 180 });
  });

  it('only for the quick tunnel', () => {
    // Arrange
    const live = liveWith(150, { tunnel: new NoTunnel() });
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning).toBeUndefined();
  });

  it('only in Secure mode', () => {
    // Arrange
    const live = liveWith(150);
    live.mode = 'direct';
    // Act
    const warning = tunnelWarning(live);
    // Assert
    expect(warning).toBeUndefined();
  });
});
