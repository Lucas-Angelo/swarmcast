import { describe, expect, it } from 'vitest';
import { ADAPTIVE_DELAY, ADAPTIVE_DELAY_HEADROOM_S, MAX_PLAYER_DELAY_S, PLAYER_LIVE_DELAYS, PLAYER_STALL_INCREASE_S, PLAYLIST_WINDOW_S } from '@swarmcast/shared';
import { latencyFor } from '../../src/player-config.js';
import { DelayController, TUNING, coefficientOfVariation, quantile, scaledTuning, slope, type DelayProfileId } from '../../src/latency-controller.js';

/** What the network does at second t of the simulation. */
interface Net {
  /** Segment download time / segment duration. */
  loadRatio: number;
  /** hls.js bandwidth estimate, bits/s. */
  bw: number;
  /** Share of segments coming from peers (0–1). */
  p2p?: number;
  /** Load ratio of P2P segments (peers are often slower, that is fine). */
  p2pRatio?: number;
}

interface SimResult {
  ctl: DelayController;
  latency: number;
  maxRate: number;
  minRate: number;
  targets: number[];
  latencies: number[];
  holds: number[];
  states: string[];
}

const BITRATE = 3_000_000;
const SEG = 2;

/**
 * A tiny player model: every second the controller ticks; latency changes by (1 − playbackRate);
 * a segment arrives every 2 s; the buffer ahead is latency minus a ~2 s gap to the live edge.
 * Scripted stalls freeze playback for max(stall, hold) seconds.
 */
function simulate(o: {
  profile?: DelayProfileId;
  seconds: number;
  net: (t: number) => Net;
  stalls?: Array<{ at: number; durationS: number }>;
  ctl?: DelayController;
  start?: number;
  latency?: number;
  speed?: number;
  lag?: number;
}): SimResult {
  const profile = o.profile ?? 'stable';
  const ctl = o.ctl ?? new DelayController({ profile, now: o.start ?? 0, speed: o.speed });
  let latency = o.latency ?? ADAPTIVE_DELAY[profile].initial;
  const lag = o.lag ?? 2;
  const res: SimResult = { ctl, latency, maxRate: 1, minRate: 1, targets: [], latencies: [], holds: [], states: [] };
  const stalls = [...(o.stalls ?? [])];
  let p2pCounter = 0;
  const end = (o.start ?? 0) + o.seconds;
  for (let t = o.start ?? 0; t < end; t += 1) {
    const net = o.net(t);
    if (t % SEG === 0) {
      p2pCounter += net.p2p ?? 0;
      const fromPeer = p2pCounter >= 1;
      if (fromPeer) p2pCounter -= 1;
      ctl.onFragment({ at: t, durationS: SEG, loadS: SEG * (fromPeer ? (net.p2pRatio ?? net.loadRatio) : net.loadRatio), source: fromPeer ? 'p2p' : 'http', bytes: (BITRATE / 8) * SEG });
    }
    const s = stalls[0];
    if (s && t >= s.at) {
      stalls.shift();
      const d = ctl.onStallStart(t, latency);
      res.holds.push(d.holdS);
      const freeze = Math.max(d.holdS, s.durationS);
      latency += freeze;
      ctl.onStallEnd(t + freeze, latency, freeze);
    }
    const dec = ctl.tick({ now: t, latency, forwardBuffer: Math.max(0, latency - lag), bandwidthEstimate: net.bw, levelBitrate: BITRATE, playing: true, p2pEnabled: true });
    latency += 1 - dec.playbackRate;
    res.maxRate = Math.max(res.maxRate, dec.playbackRate);
    res.minRate = Math.min(res.minRate, dec.playbackRate);
    res.targets.push(dec.target);
    res.latencies.push(latency);
    res.states.push(dec.state);
  }
  res.latency = latency;
  return res;
}

const fast: Net = { loadRatio: 0.15, bw: 20_000_000 };
const middling: Net = { loadRatio: 0.45, bw: 7_000_000 };

describe('helpers', () => {
  it('quantile, coefficient of variation and slope', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(coefficientOfVariation([2, 2, 2])).toBe(0);
    expect(coefficientOfVariation([1])).toBeNull();
    expect(coefficientOfVariation([1, 3])).toBeCloseTo(0.5);
    expect(slope([{ t: 0, v: 0 }, { t: 5, v: 1 }, { t: 10, v: 2 }], 5)).toBeCloseTo(0.2);
    expect(slope([{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }], 5)).toBeNull();
  });

  it('the fast test clock scales dwell times and rates, not the statistics windows', () => {
    const t = scaledTuning(TUNING.stable, 10);
    expect(t.firm.enterS).toBe(2);
    expect(t.stallQuietS).toBe(12);
    expect(t.decayPerS).toBeCloseTo(0.4);
    expect(t.windowS).toBe(TUNING.stable.windowS);
    expect(t.maxRate).toBe(TUNING.stable.maxRate);
    expect(scaledTuning(TUNING.stable, 1)).toBe(TUNING.stable);
  });
});

describe('bounds', () => {
  it('come from the shared max player delay, inside the playlist window', () => {
    expect(ADAPTIVE_DELAY.stable.max).toBeLessThanOrEqual(MAX_PLAYER_DELAY_S - ADAPTIVE_DELAY_HEADROOM_S);
    expect(ADAPTIVE_DELAY.stable).toMatchObject({ initial: 20, min: 10, p2pMin: 12, max: 30 });
    expect(ADAPTIVE_DELAY['low-delay']).toMatchObject({ initial: 8, min: 6, max: 10 });
    for (const p of Object.values(ADAPTIVE_DELAY)) {
      expect(p.min).toBeLessThanOrEqual(p.p2pMin);
      expect(p.p2pMin).toBeLessThanOrEqual(p.initial);
      expect(p.initial).toBeLessThanOrEqual(p.max);
    }
  });

  it('never leave [min, max] and never push playback past max, whatever the inputs (fuzz)', () => {
    let seed = 42;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const profile of ['stable', 'low-delay'] as const) {
      const b = ADAPTIVE_DELAY[profile];
      const stalls = Array.from({ length: 12 }, (_, i) => ({ at: 30 + i * 50 + Math.floor(rnd() * 20), durationS: rnd() * 8 }));
      const r = simulate({ profile, seconds: 900, stalls, net: () => ({ loadRatio: rnd() * 2, bw: rnd() * 20_000_000, p2p: rnd() }) });
      for (const t of r.targets) {
        expect(t).toBeGreaterThanOrEqual(b.min);
        expect(t).toBeLessThanOrEqual(b.max);
      }
      for (const h of r.holds) expect(h).toBeLessThanOrEqual(TUNING[profile].maxHoldS);
      expect(r.maxRate).toBeLessThanOrEqual(TUNING[profile].maxRate);
      expect(r.minRate).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('stay inside the playlist window the server sizes from MAX_PLAYER_DELAY_S, with room for stalls', () => {
    for (const id of ['stable', 'low-delay'] as const) {
      expect(ADAPTIVE_DELAY[id].max + PLAYER_STALL_INCREASE_S).toBeLessThanOrEqual(MAX_PLAYER_DELAY_S);
      // hls.js' catch-up jump (liveMaxLatencyDuration) stays above the highest target plus a long stall.
      expect(PLAYER_LIVE_DELAYS[id].liveMaxLatencyDuration).toBeGreaterThanOrEqual(ADAPTIVE_DELAY[id].max + 2 * PLAYER_STALL_INCREASE_S);
    }
    expect(PLAYER_LIVE_DELAYS.stable.liveMaxLatencyDuration).toBeGreaterThanOrEqual(36);
    expect(PLAYLIST_WINDOW_S).toBeGreaterThan(MAX_PLAYER_DELAY_S);
  });

  it('a short audio playlist (older server) lowers the ceiling like latencyFor does', () => {
    const fit = latencyFor('stable', { windowS: 20, targetDurationS: 2 });
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.setCeiling(fit.liveMaxLatencyDuration - 4);
    expect(ctl.target).toBe(fit.liveSyncDuration);
    expect(ctl.currentBounds.max).toBe(12);
    expect(ctl.onStallStart(1, 12).target).toBe(12);
    // Firm network: still lowers to the floor, below the ceiling.
    const r = simulate({ ctl, start: 200, latency: 12, seconds: 600, net: () => fast });
    expect(r.ctl.target).toBe(10);
    expect(Math.max(...r.targets)).toBeLessThanOrEqual(12);
    // A ceiling below the floor wins over the floor.
    ctl.setCeiling(8);
    expect(ctl.target).toBe(8);
    expect(ctl.currentBounds.min).toBe(8);
    ctl.setCeiling(null);
    expect(ctl.currentBounds.max).toBe(30);
  });

  it('a short window at stream start caps the delay only until the playlists grow', () => {
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.setCeiling(6);
    expect(ctl.target).toBe(6);
    ctl.tick({ now: 1, latency: 6, forwardBuffer: 4, bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true });
    ctl.setCeiling(null);
    expect(ctl.target).toBe(20);
  });

  it('a delay above the ceiling (the window shrank) is caught up, not slowed down further', () => {
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.setCeiling(12);
    let rate = 0;
    for (let t = 0; t < 30; t++) rate = ctl.tick({ now: t, latency: 18, forwardBuffer: 16, bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true }).playbackRate;
    expect(rate).toBeGreaterThan(1);
  });

  it('the P2P floor applies only while P2P is on', () => {
    const net = (): Net => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 0.5, p2pRatio: 0.5 });
    const on = simulate({ seconds: 600, net });
    expect(on.ctl.target).toBe(12);
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    let latency = 20;
    for (let t = 0; t < 600; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.3, source: t % 4 === 0 ? 'p2p' : 'http' });
      const d = ctl.tick({ now: t, latency, forwardBuffer: latency - 2, bandwidthEstimate: 20_000_000, levelBitrate: BITRATE, playing: true, p2pEnabled: false });
      latency += 1 - d.playbackRate;
    }
    expect(ctl.target).toBe(10);
  });

  it('a hold never takes the delay past the upper bound', () => {
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    const d = ctl.onStallStart(0, 29);
    expect(d.target).toBe(30);
    expect(d.holdS).toBe(1);
    const d2 = ctl.onStallStart(5, 30.2);
    expect(d2.holdS).toBe(0);
  });
});

describe('steady fast network', () => {
  it('drifts down to ~10 s with a gentle catch-up, below 15 s within a few minutes', () => {
    const r = simulate({ seconds: 600, net: () => fast });
    const at3min = r.latencies[180]!;
    expect(at3min).toBeLessThan(16);
    expect(r.latencies.findIndex((l) => l < 15)).toBeLessThan(240);
    expect(r.ctl.target).toBe(ADAPTIVE_DELAY.stable.min);
    expect(r.latency).toBeLessThan(11);
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    expect(r.minRate).toBe(1);
    expect(r.ctl.networkState).toBe('firm');
    // Smooth: the target never moves more than the decay rate per second.
    for (let i = 1; i < r.targets.length; i++) expect(Math.abs(r.targets[i]! - r.targets[i - 1]!)).toBeLessThanOrEqual(TUNING.stable.decayPerS + 1e-9);
  });

  it('waits ~20 s of firm signals before lowering (hysteresis dwell)', () => {
    const r = simulate({ seconds: 25, net: () => fast });
    expect(r.targets.every((t) => t === 20)).toBe(true);
    const r2 = simulate({ seconds: 60, net: () => fast });
    expect(r2.ctl.target).toBeLessThan(20);
  });

  it('a middling network (loads at 45 % of real time) holds the delay where it is', () => {
    const r = simulate({ seconds: 600, net: () => middling });
    expect(r.ctl.target).toBe(20);
    expect(r.latency).toBeCloseTo(20);
    expect(r.states.every((s) => s === 'steady')).toBe(true);
  });

  it('once firm, a borderline network stays firm; from steady it does not become firm', () => {
    const border: Net = { loadRatio: 0.42, bw: 20_000_000 };
    const r = simulate({ seconds: 120, net: () => fast });
    expect(r.ctl.networkState).toBe('firm');
    const r2 = simulate({ ctl: r.ctl, start: 120, latency: r.latency, seconds: 120, net: () => border });
    expect(r2.states.every((s) => s === 'firm')).toBe(true);
    const r3 = simulate({ seconds: 300, net: () => border });
    expect(r3.states.includes('firm')).toBe(false);
  });

  it('does not lower when bandwidth is only just above the rendition', () => {
    const r = simulate({ seconds: 300, net: () => ({ loadRatio: 0.2, bw: BITRATE * 1.7 }) });
    expect(r.ctl.target).toBe(20);
  });

  it('the low-delay profile drifts to 6 s at up to 1.1×', () => {
    const r = simulate({ profile: 'low-delay', seconds: 600, net: () => fast, lag: 1 });
    expect(r.ctl.target).toBe(6);
    expect(r.latency).toBeLessThan(7);
    expect(r.maxRate).toBeLessThanOrEqual(1.1);
  });
});

describe('oscillating 4G', () => {
  // 10 s good, 10 s bad: loads between 40 % and 160 % of real time, estimate 2.5–12 Mbps.
  const osc = (t: number): Net => (Math.floor(t / 10) % 2 === 0 ? { loadRatio: 0.4, bw: 12_000_000 } : { loadRatio: 1.6, bw: 2_500_000 });

  it('raises the target towards 30 s and slows playback slightly to build the delay, never speeds up', () => {
    const r = simulate({ seconds: 300, net: osc });
    expect(r.ctl.networkState).toBe('unstable');
    expect(r.ctl.target).toBe(30);
    expect(r.latency).toBeGreaterThan(26);
    expect(r.maxRate).toBe(1);
    expect(r.minRate).toBe(0.95);
  });

  it('after the network settles, it waits before lowering again (hysteresis), then drifts down', () => {
    const r = simulate({ seconds: 300, net: osc });
    const r2 = simulate({ ctl: r.ctl, start: 300, latency: r.latency, seconds: 40, net: () => fast });
    expect(r2.targets.every((t) => t === 30)).toBe(true);
    const r3 = simulate({ ctl: r.ctl, start: 340, latency: r2.latency, seconds: 400, net: () => fast });
    expect(r3.ctl.target).toBeLessThan(25);
  });
});

describe('stalls', () => {
  it('a single stall raises the target at once and holds the frozen picture to reach it', () => {
    const r = simulate({ seconds: 100, net: () => middling, stalls: [{ at: 50, durationS: 1 }] });
    expect(r.holds).toEqual([3]);
    expect(r.targets[49]).toBe(20);
    expect(r.targets[50]).toBe(23);
    expect(r.latency).toBeCloseTo(23, 0);
  });

  it('a long stall: no hold, the delay it added sticks (no catch-up afterwards)', () => {
    const r = simulate({ seconds: 100, net: () => middling, stalls: [{ at: 50, durationS: 7 }] });
    expect(r.holds).toEqual([3]);
    expect(r.ctl.target).toBeCloseTo(27);
    expect(r.latency).toBeCloseTo(27, 0);
    expect(r.maxRate).toBe(1);
  });

  it('no lowering for 2 minutes after a stall even on a firm network', () => {
    const r = simulate({ seconds: 200, net: () => fast });
    const before = r.ctl.target;
    const r2 = simulate({ ctl: r.ctl, start: 200, latency: r.latency, seconds: 150, net: () => fast, stalls: [{ at: 200, durationS: 1 }] });
    const raised = r2.targets[0]!;
    expect(raised).toBeCloseTo(Math.max(before, r.latency) + 3, 0);
    expect(r2.targets.slice(0, 120).every((t) => t >= raised - 1e-9)).toBe(true);
    const r3 = simulate({ ctl: r.ctl, start: 350, latency: r2.latency, seconds: 200, net: () => fast });
    expect(r3.ctl.target).toBeLessThan(raised);
  });

  it('repeated stalls raise faster, up to the bound', () => {
    const stalls = [{ at: 30, durationS: 2 }, { at: 70, durationS: 2 }, { at: 110, durationS: 2 }];
    const r = simulate({ seconds: 150, net: () => middling, stalls });
    expect(r.targets[30]).toBe(23);
    expect(r.targets[70]! - r.targets[69]!).toBeGreaterThan(3);
    expect(r.ctl.target).toBe(30);
    expect(Math.max(...r.targets)).toBe(30);
    expect(r.latency).toBeLessThanOrEqual(30.5);
  });

  it('a stall far above the bound: the target stays at the bound and playback catches up to it', () => {
    const r = simulate({ seconds: 120, latency: 28, net: () => middling, stalls: [{ at: 5, durationS: 6 }] });
    expect(Math.max(...r.targets)).toBe(30);
    expect(r.latencies[6]).toBeGreaterThan(33);
    expect(r.latency).toBeLessThanOrEqual(31);
  });
});

describe('P2P-heavy network', () => {
  it('slow peer downloads do not count as an unstable link; the floor stays at 12 s', () => {
    const r = simulate({ seconds: 900, net: () => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 0.8, p2pRatio: 1.4 }) });
    expect(r.states.includes('unstable')).toBe(false);
    expect(r.ctl.target).toBe(ADAPTIVE_DELAY.stable.p2pMin);
    expect(r.latency).toBeGreaterThan(11.5);
  });

  it('all segments from peers: still lowers on steady bandwidth and buffer', () => {
    const r = simulate({ seconds: 600, net: () => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 1, p2pRatio: 0.9 }) });
    expect(r.ctl.target).toBe(12);
  });
});

describe('buffer trend and user actions', () => {
  it('a buffer falling behind the live edge makes the network unstable', () => {
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    let state = '';
    for (let t = 0; t < 60; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.6, source: 'http' });
      // The buffer shrinks by 0.3 s every second while the delay stays: downloads fall behind.
      state = ctl.tick({ now: t, latency: 20, forwardBuffer: Math.max(0, 18 - t * 0.3), bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true }).state;
    }
    expect(state).toBe('unstable');
    expect(ctl.signals!.lagSlope).toBeGreaterThan(0.15);
  });

  it('far behind after a pause: the target waits while playback catches up gently', () => {
    const r = simulate({ seconds: 900, net: () => fast, latency: 35 });
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    // The target does not run away from the delay, so the catch-up never stalls halfway.
    r.targets.forEach((t, i) => expect(r.latencies[i]! - t).toBeLessThan(15.5));
    expect(r.targets[60]).toBe(20);
    expect(r.latency).toBeLessThan(11);
  });

  it('a jump in the measured delay while lowering (live edge estimate) does not stop the catch-up', () => {
    const r = simulate({ seconds: 100, net: () => fast, speed: 10 });
    const r2 = simulate({ ctl: r.ctl, start: 100, latency: r.latency + 2, seconds: 300, net: () => fast, speed: 10 });
    expect(r2.latency).toBeLessThan(11);
  });

  it('does not catch up on a thin buffer', () => {
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    for (let t = 0; t < 200; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.2, source: 'http' });
      const d = ctl.tick({ now: t, latency: 20, forwardBuffer: 3, bandwidthEstimate: 20_000_000, levelBitrate: BITRATE, playing: true });
      expect(d.playbackRate).toBe(1);
    }
  });

  it('a profile switch starts over at the profile delay', () => {
    const r = simulate({ seconds: 600, net: () => fast });
    expect(r.ctl.target).toBe(10);
    r.ctl.reset('low-delay', 600);
    expect(r.ctl.target).toBe(8);
    r.ctl.reset('stable', 601);
    expect(r.ctl.target).toBe(20);
  });

  it('the test-only fast clock gets below 15 s in about two minutes; the target never runs away from the delay', () => {
    const r = simulate({ seconds: 400, net: () => fast, speed: 10 });
    expect(r.latencies.findIndex((l) => l < 15)).toBeLessThan(130);
    expect(r.latency).toBeLessThan(11);
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    r.targets.forEach((t, i) => expect(r.latencies[i]! - t).toBeLessThan(TUNING.stable.catchUp.lead + 0.5));
  });
});
