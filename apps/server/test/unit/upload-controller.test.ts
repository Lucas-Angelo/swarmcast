import { describe, expect, it } from 'vitest';
import { RttTracker, UploadController } from '../../src/quality/upload-controller.js';

/**
 * A tiny uplink model: capacity C, her stream to another platform T, SwarmCast sends min(cap, demand).
 * When the sum exceeds what the link drains, the router queue (and so the RTT) grows by
 * the excess; otherwise it drains. OBS reports congestion when the queue is deep.
 */
function simulate(o: { capacityMbps: number; twitchMbps: number; demandMbps: (t: number) => number; ticks: number; ceilingMbps?: number; obs?: boolean; useRtt?: boolean }) {
  const c = new UploadController();
  const rtt = new RttTracker();
  const baseRtt = 30;
  let queueMs = 0;
  const caps: number[] = [];
  let congestedTicks = 0;
  let maxQueue = 0;
  c.reset(o.ceilingMbps, 100);
  for (let i = 0; i < o.ticks; i++) {
    const now = i * 2000;
    const demand = o.demandMbps(i);
    const sent = Math.min(c.capMbps, demand);
    const excess = sent + o.twitchMbps - o.capacityMbps * 0.97;
    // Excess Mbps for 2 s, drained at capacity: queue grows by excess/capacity × 2000 ms.
    queueMs = Math.max(0, Math.min(2000, queueMs + (excess / o.capacityMbps) * 2000));
    if (excess < 0) queueMs = Math.max(0, queueMs - 200);
    maxQueue = Math.max(maxQueue, queueMs);
    if (queueMs > 100) congestedTicks += 1;
    rtt.add(now, baseRtt + queueMs);
    const r = c.tick({
      now,
      ceilingMbps: o.ceilingMbps,
      fallbackMaxMbps: 100,
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

describe('UploadController (AIMD on a simulated congested uplink)', () => {
  it('without a speed test, finds the free capacity from RTT growth and keeps the other stream safe most of the time', () => {
    // 20 Mbps uplink, 6 Mbps to another platform: about 13.4 Mbps are really free. Viewers want 40.
    const r = simulate({ capacityMbps: 20, twitchMbps: 6, demandMbps: () => 40, ticks: 600 });
    const tail = r.caps.slice(-300);
    expect(avg(tail)).toBeGreaterThan(13.4 * 0.6);
    expect(Math.max(...tail)).toBeLessThan(13.4 * 1.15);
    expect(r.congestedFraction).toBeLessThan(0.1);
  });

  it('never exceeds the ceiling (measured upload − other stream − headroom), even on a much faster link', () => {
    const r = simulate({ capacityMbps: 200, twitchMbps: 6, demandMbps: () => 500, ticks: 400, ceilingMbps: 30 });
    expect(Math.max(...r.caps)).toBeLessThanOrEqual(30);
    expect(r.caps.at(-1)).toBe(30);
  });

  it('backs off on OBS congestion alone (no RTT signal)', () => {
    const r = simulate({ capacityMbps: 20, twitchMbps: 6, demandMbps: () => 40, ticks: 400, obs: true, useRtt: false, ceilingMbps: 40 });
    const tail = r.caps.slice(-200);
    expect(avg(tail)).toBeLessThan(14);
    expect(avg(tail)).toBeGreaterThan(5);
  });

  it('does not raise an unused cap (app-limited)', () => {
    const r = simulate({ capacityMbps: 100, twitchMbps: 6, demandMbps: () => 3, ticks: 200, ceilingMbps: 80 });
    expect(Math.max(...r.caps)).toBeCloseTo(48, 0); // stays at the start value (60 % of the ceiling)
  });

  it('cuts by 30 % from what is actually sent, holds, and reports why', () => {
    const c = new UploadController();
    c.reset(50, 100);
    expect(c.capMbps).toBe(30);
    const r = c.tick({ now: 0, ceilingMbps: 50, fallbackMaxMbps: 100, signals: { usedMbps: 20, demandLimited: true, obsCongestion: 0.4 } });
    expect(r.backoff?.reason).toMatch(/congestion/);
    expect(r.capMbps).toBe(14);
    // Held for 10 s even though healthy and demand-limited.
    expect(c.tick({ now: 4000, ceilingMbps: 50, fallbackMaxMbps: 100, signals: { usedMbps: 14, demandLimited: true } }).capMbps).toBe(14);
    expect(c.tick({ now: 12_000, ceilingMbps: 50, fallbackMaxMbps: 100, signals: { usedMbps: 14, demandLimited: true } }).capMbps).toBeGreaterThan(14);
  });

  it('treats dropped frames and reconnects as congestion', () => {
    const c = new UploadController();
    expect(c.congestion({ usedMbps: 1, demandLimited: false, obsDroppedPercent: 2 })?.text).toMatch(/dropped/);
    expect(c.congestion({ usedMbps: 1, demandLimited: false, obsReconnecting: true })?.text).toMatch(/reconnecting/);
    expect(c.congestion({ usedMbps: 1, demandLimited: false, queueDelayMs: 20, baseRttMs: 30 })).toBeNull();
    expect(c.congestion({ usedMbps: 1, demandLimited: false, queueDelayMs: 120, baseRttMs: 30 })?.text).toMatch(/queueing/);
  });
});

describe('RttTracker', () => {
  it('uses the long-window minimum as baseline and filters single spikes', () => {
    const t = new RttTracker(60_000, 3);
    for (let i = 0; i < 10; i++) t.add(i * 1000, 30 + (i % 2));
    t.add(10_000, 400); // one spike
    expect(t.baseMs).toBe(30);
    expect(t.queueDelayMs).toBeLessThan(5);
    t.add(11_000, 300);
    t.add(12_000, 320);
    expect(t.queueDelayMs).toBe(270);
  });
});

describe('queueing back-off needs our own traffic', () => {
  it('ignores RTT growth while idle but backs off when we fill the uplink', async () => {
    const { UploadController } = await import('../../src/quality/upload-controller.js');
    const c = new UploadController();
    c.reset(50, 100);
    const idle = c.tick({ now: 0, ceilingMbps: 50, fallbackMaxMbps: 100, signals: { usedMbps: 0, demandLimited: false, queueDelayMs: 400, baseRttMs: 20 } });
    expect(idle.backoff).toBeUndefined();
    const busy = c.tick({ now: 2000, ceilingMbps: 50, fallbackMaxMbps: 100, signals: { usedMbps: idle.capMbps, demandLimited: true, queueDelayMs: 400, baseRttMs: 20 } });
    expect(busy.backoff?.code).toBe('quality.backoff.queueing');
    expect(busy.capMbps).toBeLessThan(idle.capMbps);
  });
});

