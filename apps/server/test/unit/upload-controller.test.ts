import { describe, expect, it } from 'vitest';
import type { UploadSignals } from '@swarmcast/shared';
import { RttTracker, UploadController } from '../../src/quality/upload-controller.js';

// The adaptive upload cap (AIMD) on a simulated congested uplink, and its RTT tracker. The cap
// starts at 60 % of the ceiling, is cut by 30 % from what is actually sent on any congestion
// signal and then held for 10 s, never exceeds the ceiling (measured upload − other stream −
// headroom), and is never raised while viewers do not use it (app-limited). RTT growth only counts
// as congestion while SwarmCast itself fills the uplink.

/** One controller step every 2 s, as the quality manager runs it. */
const TICK_MS = 2000;
/** Her manual limit: the cap's maximum when the upload was never measured. */
const FALLBACK_MAX_MBPS = 100;

/**
 * A tiny uplink model: capacity C, her stream to another platform T, SwarmCast sends
 * min(cap, demand). When the sum exceeds what the link drains (97 % of C), the router queue (and
 * so the RTT) grows by the excess; otherwise it drains. OBS reports congestion when the queue is
 * deep.
 */
function simulate(o: { capacityMbps: number; twitchMbps: number; demandMbps: (t: number) => number; ticks: number; ceilingMbps?: number; obs?: boolean; useRtt?: boolean }) {
  const c = new UploadController();
  const rtt = new RttTracker();
  const baseRtt = 30;
  let queueMs = 0;
  const caps: number[] = [];
  let congestedTicks = 0;
  let maxQueue = 0;
  c.reset(o.ceilingMbps, FALLBACK_MAX_MBPS);
  for (let i = 0; i < o.ticks; i++) {
    const now = i * TICK_MS;
    const demand = o.demandMbps(i);
    const sent = Math.min(c.capMbps, demand);
    const excess = sent + o.twitchMbps - o.capacityMbps * 0.97;
    // Excess Mbps for one tick, drained at capacity: the queue grows by excess / capacity × tick.
    queueMs = Math.max(0, Math.min(2000, queueMs + (excess / o.capacityMbps) * TICK_MS));
    if (excess < 0) queueMs = Math.max(0, queueMs - 200);
    maxQueue = Math.max(maxQueue, queueMs);
    if (queueMs > 100) congestedTicks += 1;
    rtt.add(now, baseRtt + queueMs);
    const r = c.tick({
      now,
      ceilingMbps: o.ceilingMbps,
      fallbackMaxMbps: FALLBACK_MAX_MBPS,
      signals: {
        usedMbps: sent,
        demandLimited: demand > c.capMbps,
        ...(o.useRtt !== false ? { rttMs: rtt.currentMs, baseRttMs: rtt.baseMs, queueDelayMs: rtt.queueDelayMs } : {}),
        ...(o.obs ? { obsCongestion: Math.min(1, queueMs / 500) } : {}),
      },
    });
    caps.push(r.capMbps);
  }
  return { caps, congestedFraction: congestedTicks / o.ticks, maxQueue, controller: c };
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** What the model's 20 Mbps link really has free next to a 6 Mbps stream elsewhere (it drains 97 %). */
const FREE_MBPS = 20 * 0.97 - 6;

/** One controller step at `now` with a ceiling of 50 Mbps. */
const tickAt = (c: UploadController, now: number, signals: UploadSignals) => c.tick({ now, ceilingMbps: 50, fallbackMaxMbps: FALLBACK_MAX_MBPS, signals });

describe('UploadController (AIMD on a simulated congested uplink)', () => {
  it('without a speed test, finds the free capacity from RTT growth and keeps the other stream safe most of the time', () => {
    // Act
    const r = simulate({ capacityMbps: 20, twitchMbps: 6, demandMbps: () => 40, ticks: 600 });
    // Assert
    const tail = r.caps.slice(-300);
    expect(avg(tail)).toBeGreaterThan(FREE_MBPS * 0.6);
    expect(Math.max(...tail)).toBeLessThan(FREE_MBPS * 1.15);
    expect(r.congestedFraction).toBeLessThan(0.1);
  });

  it('never exceeds the ceiling (measured upload − other stream − headroom), even on a much faster link', () => {
    // Act
    const r = simulate({ capacityMbps: 200, twitchMbps: 6, demandMbps: () => 500, ticks: 400, ceilingMbps: 30 });
    // Assert
    expect(Math.max(...r.caps)).toBeLessThanOrEqual(30);
    expect(r.caps.at(-1)).toBe(30);
  });

  it('backs off on OBS congestion alone (no RTT signal)', () => {
    // Act
    const r = simulate({ capacityMbps: 20, twitchMbps: 6, demandMbps: () => 40, ticks: 400, obs: true, useRtt: false, ceilingMbps: 40 });
    // Assert
    const tail = r.caps.slice(-200);
    expect(avg(tail)).toBeLessThan(14);
    expect(avg(tail)).toBeGreaterThan(5);
  });

  it('does not raise an unused cap (app-limited): it stays at the start value, 60 % of the ceiling', () => {
    // Act
    const r = simulate({ capacityMbps: 100, twitchMbps: 6, demandMbps: () => 3, ticks: 200, ceilingMbps: 80 });
    // Assert
    expect(Math.max(...r.caps)).toBeCloseTo(48, 0);
  });

  it('starts a new live at 60 % of the ceiling', () => {
    // Arrange
    const c = new UploadController();
    // Act
    c.reset(50, FALLBACK_MAX_MBPS);
    // Assert
    expect(c.capMbps).toBe(30);
  });

  it('cuts by 30 % from what is actually sent, and reports why', () => {
    // Arrange
    const c = new UploadController();
    c.reset(50, FALLBACK_MAX_MBPS);
    // Act
    const r = tickAt(c, 0, { usedMbps: 20, demandLimited: true, obsCongestion: 0.4 });
    // Assert
    expect(r.backoff?.reason).toMatch(/congestion/);
    expect(r.capMbps).toBe(14);
  });

  it('holds the cut for 10 s even though the link is healthy and viewers want more', () => {
    // Arrange
    const c = new UploadController();
    c.reset(50, FALLBACK_MAX_MBPS);
    tickAt(c, 0, { usedMbps: 20, demandLimited: true, obsCongestion: 0.4 });
    // Act
    const held = tickAt(c, 4000, { usedMbps: 14, demandLimited: true });
    // Assert
    expect(held.capMbps).toBe(14);
  });

  it('raises the cap again after the hold', () => {
    // Arrange
    const c = new UploadController();
    c.reset(50, FALLBACK_MAX_MBPS);
    tickAt(c, 0, { usedMbps: 20, demandLimited: true, obsCongestion: 0.4 });
    // Act
    const raised = tickAt(c, 12_000, { usedMbps: 14, demandLimited: true });
    // Assert
    expect(raised.capMbps).toBeGreaterThan(14);
  });

  it.each([
    ['dropped frames', { obsDroppedPercent: 2 }, /dropped/],
    ['OBS reconnecting', { obsReconnecting: true }, /reconnecting/],
    ['queueing delay above the base RTT', { queueDelayMs: 120, baseRttMs: 30 }, /queueing/],
  ])('treats %s as congestion', (_what, signals, reason) => {
    // Act
    const r = new UploadController().congestion({ usedMbps: 1, demandLimited: false, ...signals });
    // Assert
    expect(r?.text).toMatch(reason);
  });

  it('does not treat a small queueing delay as congestion', () => {
    // Act
    const r = new UploadController().congestion({ usedMbps: 1, demandLimited: false, queueDelayMs: 20, baseRttMs: 30 });
    // Assert
    expect(r).toBeNull();
  });
});

describe('RttTracker', () => {
  /** Ten samples of 30–31 ms, one a second: the baseline. */
  function steady(): RttTracker {
    const t = new RttTracker(60_000, 3);
    for (let i = 0; i < 10; i++) t.add(i * 1000, 30 + (i % 2));
    return t;
  }

  it('uses the long-window minimum as baseline and filters a single spike', () => {
    // Arrange
    const t = steady();
    // Act
    t.add(10_000, 400);
    // Assert
    expect(t.baseMs).toBe(30);
    expect(t.queueDelayMs).toBeLessThan(5);
  });

  it('reports the queueing delay once high samples last', () => {
    // Arrange
    const t = steady();
    t.add(10_000, 400);
    // Act
    t.add(11_000, 300);
    t.add(12_000, 320);
    // Assert
    expect(t.queueDelayMs).toBe(270);
  });
});

describe('queueing back-off needs our own traffic', () => {
  /** RTT 400 ms above a 20 ms baseline. */
  const QUEUEING = { queueDelayMs: 400, baseRttMs: 20 };

  it('ignores RTT growth while idle', () => {
    // Arrange
    const c = new UploadController();
    c.reset(50, FALLBACK_MAX_MBPS);
    // Act
    const idle = tickAt(c, 0, { usedMbps: 0, demandLimited: false, ...QUEUEING });
    // Assert
    expect(idle.backoff).toBeUndefined();
  });

  it('backs off on the same RTT growth when we fill the uplink', () => {
    // Arrange
    const c = new UploadController();
    c.reset(50, FALLBACK_MAX_MBPS);
    const idle = tickAt(c, 0, { usedMbps: 0, demandLimited: false, ...QUEUEING });
    // Act
    const busy = tickAt(c, TICK_MS, { usedMbps: idle.capMbps, demandLimited: true, ...QUEUEING });
    // Assert
    expect(busy.backoff?.code).toBe('quality.backoff.queueing');
    expect(busy.capMbps).toBeLessThan(idle.capMbps);
  });
});
