// The adaptive delay controller (latency-controller.ts, pure: time is an argument) on a tiny player
// model (`simulate`), plus its bounds and the test-only fast clock and rate flags of the watch page.
// Background for some cases:
// - a short audio playlist (servers up to v0.2.0) lowers the ceiling, like latencyFor does;
// - at stream start the playlists are short and grow: the delay is capped (or not built) only
//   until they have; hls.js keeps the playhead inside the window and syncs (start, Go live, watchdog
//   restarts) inside it, not on its oldest segment;
// - "oscillating 4G" is 10 s good, 10 s bad: loads between 40 % and 160 % of real time, an
//   estimate of 2.5-12 Mbps;
// - a buffer that shrinks by 0.3 s a second while the delay stays means downloads fall behind;
// - far behind after a pause, the target does not run away from the delay, so the catch-up never
//   stalls halfway.
import { describe, expect, it } from 'vitest';
import { ADAPTIVE_DELAY, ADAPTIVE_DELAY_HEADROOM_S, MAX_PLAYER_DELAY_S, PLAYER_LIVE_DELAYS, PLAYER_STALL_INCREASE_S, PLAYLIST_WINDOW_S } from '@swarmcast/shared';
import { latencyFor } from '../../src/player-config.js';
import { delayRateFromSearch, delaySpeedFromSearch, delayTestFlags } from '../../src/adaptive-delay.js';
import { DelayController, MAX_SCALED_RATE_STEP, TUNING, coefficientOfVariation, quantile, scaledTuning, slope, type DelayProfileId } from '../../src/latency-controller.js';

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
const PROFILE_IDS = ['stable', 'low-delay'] as const;

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
  rateScale?: number;
  lag?: number;
}): SimResult {
  const profile = o.profile ?? 'stable';
  const ctl = o.ctl ?? new DelayController({ profile, now: o.start ?? 0, speed: o.speed, rateScale: o.rateScale });
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
const border: Net = { loadRatio: 0.42, bw: 20_000_000 };
const osc = (t: number): Net => (Math.floor(t / 10) % 2 === 0 ? { loadRatio: 0.4, bw: 12_000_000 } : { loadRatio: 1.6, bw: 2_500_000 });

/** A stable controller with the ceiling a 20 s audio playlist gives (latencyFor): 12 s. */
function shortAudioCeiling() {
  const fit = latencyFor('stable', { windowS: 20, targetDurationS: 2 });
  const ctl = new DelayController({ profile: 'stable', now: 0 });
  ctl.setCeiling(fit.liveMaxLatencyDuration - 4);
  return { ctl, fit };
}

/** A stable controller limited to a 4 s growth window, ticked for a minute of slow loads at 6 s behind live. */
function shortWindowMinute() {
  const ctl = new DelayController({ profile: 'stable', now: 0 });
  ctl.setGrowthLimit(4);
  const rates: number[] = [];
  for (let t = 0; t < 60; t++) {
    if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 1.8, source: 'http' });
    rates.push(ctl.tick({ now: t, latency: 6, forwardBuffer: 5, bandwidthEstimate: 3_000_000, levelBitrate: BITRATE, playing: true }).playbackRate);
  }
  return { ctl, rates };
}

describe('helpers', () => {
  it('quantile', () => {
    // Act
    const q = [quantile([5, 1, 3, 2, 4], 0.5), quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)];

    // Assert
    expect(q).toEqual([3, 9]);
  });

  it('coefficient of variation (null for a single sample)', () => {
    // Act
    const cv = [coefficientOfVariation([2, 2, 2]), coefficientOfVariation([1]), coefficientOfVariation([1, 3])];

    // Assert
    expect(cv[0]).toBe(0);
    expect(cv[1]).toBeNull();
    expect(cv[2]).toBeCloseTo(0.5);
  });

  it('slope over a window (null when the samples do not span it)', () => {
    // Act
    const spanning = slope([{ t: 0, v: 0 }, { t: 5, v: 1 }, { t: 10, v: 2 }], 5);
    const short = slope([{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }], 5);

    // Assert
    expect(spanning).toBeCloseTo(0.2);
    expect(short).toBeNull();
  });

  it('the fast test clock scales dwell times and rates, not the statistics windows', () => {
    // Act
    const t = scaledTuning(TUNING.stable, 10);

    // Assert
    expect(t.firm.enterS).toBe(2);
    expect(t.stallQuietS).toBe(12);
    expect(t.decayPerS).toBeCloseTo(0.4);
    expect(t.windowS).toBe(TUNING.stable.windowS);
    expect(t.maxRate).toBe(TUNING.stable.maxRate);
    expect(t.slowRate).toBe(TUNING.stable.slowRate);
  });

  it('speed 1 is the profile tuning itself', () => {
    // Act
    const t = scaledTuning(TUNING.stable, 1);

    // Assert
    expect(t).toBe(TUNING.stable);
  });

  it('the test-only rate scale moves playbackRate further from 1', () => {
    // Act
    const t = scaledTuning(TUNING.stable, 10, 10);

    // Assert
    expect(t.maxRate).toBe(1.5);
    expect(t.slowRate).toBe(0.5);
    expect(t.decayPerS).toBeCloseTo(0.4);
  });

  it.each([
    ['stable, speed 1, rate scale 2', TUNING.stable, 1, 2, 1.1],
    ['low-delay, rate scale 10: at most MAX_SCALED_RATE_STEP', TUNING['low-delay'], 10, 10, 1 + MAX_SCALED_RATE_STEP],
    ['stable, rate scale 1', TUNING.stable, 10, 1, TUNING.stable.maxRate],
  ])('maxRate with %s', (_case, tuning, speed, rateScale, maxRate) => {
    // Act
    const t = scaledTuning(tuning, speed, rateScale);

    // Assert
    expect(t.maxRate).toBe(maxRate);
  });

  it.each([
    ['delaySpeed', delaySpeedFromSearch, '?delaySpeed=10&delayRate=10', 10],
    ['delayRate', delayRateFromSearch, '?delaySpeed=10&delayRate=10', 10],
    ['delayRate above its bound', delayRateFromSearch, '?delayRate=99', 10],
    ['delayRate below its bound', delayRateFromSearch, '?delayRate=0.5', 1],
    ['delayRate absent', delayRateFromSearch, '', 1],
  ])('reads the test-only URL flag %s within its bounds', (_case, read, search, value) => {
    // Act
    const got = read(search);

    // Assert
    expect(got).toBe(value);
  });

  it.each([
    ['not allowed by the server', '?delaySpeed=60&delayRate=10', false, { speed: 1, rateScale: 1 }],
    ['allowed', '?delaySpeed=10&delayRate=10', true, { speed: 10, rateScale: 10 }],
    ['allowed but absent', '', true, { speed: 1, rateScale: 1 }],
  ])('test-only URL flags %s', (_case, search, allowed, flags) => {
    // Act
    const got = delayTestFlags(search, allowed);

    // Assert
    expect(got).toEqual(flags);
  });
});

describe('bounds', () => {
  it('come from the shared max player delay, inside the playlist window', () => {
    // Act
    const { stable, 'low-delay': low } = ADAPTIVE_DELAY;

    // Assert
    expect(stable.max).toBeLessThanOrEqual(MAX_PLAYER_DELAY_S - ADAPTIVE_DELAY_HEADROOM_S);
    expect(stable).toMatchObject({ initial: 20, min: 10, p2pMin: 12, max: 30 });
    expect(low).toMatchObject({ initial: 8, min: 6, max: 10 });
  });

  it.each(PROFILE_IDS)('%s: min ≤ P2P min ≤ initial ≤ max', (id) => {
    // Act
    const p = ADAPTIVE_DELAY[id];

    // Assert
    expect(p.min).toBeLessThanOrEqual(p.p2pMin);
    expect(p.p2pMin).toBeLessThanOrEqual(p.initial);
    expect(p.initial).toBeLessThanOrEqual(p.max);
  });

  it.each(PROFILE_IDS)('%s: never leave [min, max] and never push playback past max, whatever the inputs (fuzz)', (profile) => {
    // Arrange
    let seed = 42;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const b = ADAPTIVE_DELAY[profile];
    const stalls = Array.from({ length: 12 }, (_, i) => ({ at: 30 + i * 50 + Math.floor(rnd() * 20), durationS: rnd() * 8 }));

    // Act
    const r = simulate({ profile, seconds: 900, stalls, net: () => ({ loadRatio: rnd() * 2, bw: rnd() * 20_000_000, p2p: rnd() }) });

    // Assert
    expect(Math.min(...r.targets)).toBeGreaterThanOrEqual(b.min);
    expect(Math.max(...r.targets)).toBeLessThanOrEqual(b.max);
    expect(Math.max(...r.holds)).toBeLessThanOrEqual(TUNING[profile].maxHoldS);
    expect(r.maxRate).toBeLessThanOrEqual(TUNING[profile].maxRate);
    expect(r.minRate).toBeGreaterThanOrEqual(0.95);
  });

  it.each(PROFILE_IDS)('%s: stays inside the playlist window the server sizes from MAX_PLAYER_DELAY_S, with room for stalls', (id) => {
    // Act
    const { max } = ADAPTIVE_DELAY[id];

    // Assert
    expect(max + PLAYER_STALL_INCREASE_S).toBeLessThanOrEqual(MAX_PLAYER_DELAY_S);
    expect(PLAYER_LIVE_DELAYS[id].liveMaxLatencyDuration).toBeGreaterThanOrEqual(max + 2 * PLAYER_STALL_INCREASE_S);
  });

  it("hls.js' catch-up jump stays above the highest target plus a long stall, inside the playlist window", () => {
    // Act
    const jump = PLAYER_LIVE_DELAYS.stable.liveMaxLatencyDuration;

    // Assert
    expect(jump).toBeGreaterThanOrEqual(36);
    expect(PLAYLIST_WINDOW_S).toBeGreaterThan(MAX_PLAYER_DELAY_S);
  });

  it('a short audio playlist (older server) lowers the ceiling like latencyFor does', () => {
    // Act
    const { ctl, fit } = shortAudioCeiling();

    // Assert
    expect(ctl.target).toBe(fit.liveSyncDuration);
    expect(ctl.currentBounds.max).toBe(12);
    expect(ctl.onStallStart(1, 12).target).toBe(12);
  });

  it('under that ceiling, a firm network still lowers the delay to the floor', () => {
    // Arrange
    const { ctl } = shortAudioCeiling();
    ctl.onStallStart(1, 12);

    // Act
    const r = simulate({ ctl, start: 200, latency: 12, seconds: 600, net: () => fast });

    // Assert
    expect(r.ctl.target).toBe(10);
    expect(Math.max(...r.targets)).toBeLessThanOrEqual(12);
  });

  it('a ceiling below the floor wins over the floor', () => {
    // Arrange
    const { ctl } = shortAudioCeiling();

    // Act
    ctl.setCeiling(8);

    // Assert
    expect(ctl.target).toBe(8);
    expect(ctl.currentBounds.min).toBe(8);
  });

  it('no ceiling gives the profile bound back', () => {
    // Arrange
    const { ctl } = shortAudioCeiling();

    // Act
    ctl.setCeiling(null);

    // Assert
    expect(ctl.currentBounds.max).toBe(30);
  });

  it('a short window at stream start caps the delay', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    ctl.setCeiling(6);

    // Assert
    expect(ctl.target).toBe(6);
  });

  it('the cap goes once the playlists have grown', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.setCeiling(6);
    ctl.tick({ now: 1, latency: 6, forwardBuffer: 4, bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true });

    // Act
    ctl.setCeiling(null);

    // Assert
    expect(ctl.target).toBe(20);
  });

  it('a short growth window keeps the target hls.js uses at the profile (the playhead stays inside the window)', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    ctl.setGrowthLimit(4);

    // Assert
    expect(ctl.target).toBe(20);
  });

  it('a short growth window does not pull the playhead closer to live, nor build delay past it', () => {
    // Act
    const { ctl, rates } = shortWindowMinute();

    // Assert
    expect(ctl.networkState).toBe('unstable');
    expect(Math.max(...rates)).toBe(1);
    expect(Math.min(...rates)).toBe(1);
  });

  it('a short growth window: no hold past it either, and hls.js syncs inside it', () => {
    // Arrange
    const { ctl } = shortWindowMinute();

    // Act
    const stall = ctl.onStallStart(61, 6);

    // Assert
    expect(stall.holdS).toBe(0);
    expect(ctl.syncTarget).toBe(4);
  });

  it('once the playlists have grown, it builds delay again', () => {
    // Arrange
    const { ctl } = shortWindowMinute();

    // Act
    ctl.setGrowthLimit(32);
    const d = ctl.tick({ now: 62, latency: 6, forwardBuffer: 5, bandwidthEstimate: 3_000_000, levelBitrate: BITRATE, playing: true });

    // Assert
    expect(d.playbackRate).toBe(0.95);
  });

  it('a delay above the ceiling (the window shrank) is caught up, not slowed down further', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.setCeiling(12);

    // Act
    let rate = 0;
    for (let t = 0; t < 30; t++) rate = ctl.tick({ now: t, latency: 18, forwardBuffer: 16, bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true }).playbackRate;

    // Assert
    expect(rate).toBeGreaterThan(1);
  });

  it('the P2P floor (12 s) applies while P2P is on', () => {
    // Act
    const on = simulate({ seconds: 600, net: () => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 0.5, p2pRatio: 0.5 }) });

    // Assert
    expect(on.ctl.target).toBe(12);
  });

  it('the P2P floor does not apply while P2P is off, even with segments from peers', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    let latency = 20;

    // Act
    for (let t = 0; t < 600; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.3, source: t % 4 === 0 ? 'p2p' : 'http' });
      const d = ctl.tick({ now: t, latency, forwardBuffer: latency - 2, bandwidthEstimate: 20_000_000, levelBitrate: BITRATE, playing: true, p2pEnabled: false });
      latency += 1 - d.playbackRate;
    }

    // Assert
    expect(ctl.target).toBe(10);
  });

  it('a hold takes the delay up to the upper bound, not past it', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    const d = ctl.onStallStart(0, 29);

    // Assert
    expect(d.target).toBe(30);
    expect(d.holdS).toBe(1);
  });

  it('no hold for a stall already past the upper bound', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    const d = ctl.onStallStart(0, 30.2);

    // Assert
    expect(d.holdS).toBe(0);
  });
});

describe('steady fast network', () => {
  it('drifts down to ~10 s with a gentle, smooth catch-up, below 15 s within a few minutes', () => {
    // Act
    const r = simulate({ seconds: 600, net: () => fast });

    // Assert
    expect(r.latencies[180]!).toBeLessThan(16);
    expect(r.latencies.findIndex((l) => l < 15)).toBeLessThan(240);
    expect(r.ctl.target).toBe(ADAPTIVE_DELAY.stable.min);
    expect(r.latency).toBeLessThan(11);
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    expect(r.minRate).toBe(1);
    expect(r.ctl.networkState).toBe('firm');
    const steps = r.targets.slice(1).map((t, i) => Math.abs(t - r.targets[i]!));
    expect(Math.max(...steps)).toBeLessThanOrEqual(TUNING.stable.decayPerS + 1e-9);
  });

  it('waits ~20 s of firm signals before lowering (hysteresis dwell)', () => {
    // Act
    const r = simulate({ seconds: 25, net: () => fast });

    // Assert
    expect(r.targets.every((t) => t === 20)).toBe(true);
  });

  it('lowers once the dwell is over', () => {
    // Act
    const r = simulate({ seconds: 60, net: () => fast });

    // Assert
    expect(r.ctl.target).toBeLessThan(20);
  });

  it('a middling network (loads at 45 % of real time) holds the delay where it is', () => {
    // Act
    const r = simulate({ seconds: 600, net: () => middling });

    // Assert
    expect(r.ctl.target).toBe(20);
    expect(r.latency).toBeCloseTo(20);
    expect(r.states.every((s) => s === 'steady')).toBe(true);
  });

  it('once firm, a borderline network stays firm', () => {
    // Arrange
    const r = simulate({ seconds: 120, net: () => fast });

    // Act
    const r2 = simulate({ ctl: r.ctl, start: 120, latency: r.latency, seconds: 120, net: () => border });

    // Assert
    expect(r.ctl.networkState).toBe('firm');
    expect(r2.states.every((s) => s === 'firm')).toBe(true);
  });

  it('from steady, a borderline network does not become firm', () => {
    // Act
    const r = simulate({ seconds: 300, net: () => border });

    // Assert
    expect(r.states.includes('firm')).toBe(false);
  });

  it('does not lower when bandwidth is only just above the rendition', () => {
    // Act
    const r = simulate({ seconds: 300, net: () => ({ loadRatio: 0.2, bw: BITRATE * 1.7 }) });

    // Assert
    expect(r.ctl.target).toBe(20);
  });

  it('the low-delay profile drifts to 6 s at up to 1.1×', () => {
    // Act
    const r = simulate({ profile: 'low-delay', seconds: 600, net: () => fast, lag: 1 });

    // Assert
    expect(r.ctl.target).toBe(6);
    expect(r.latency).toBeLessThan(7);
    expect(r.maxRate).toBeLessThanOrEqual(1.1);
  });
});

describe('oscillating 4G', () => {
  it('raises the target towards 30 s and slows playback slightly to build the delay, never speeds up', () => {
    // Act
    const r = simulate({ seconds: 300, net: osc });

    // Assert
    expect(r.ctl.networkState).toBe('unstable');
    expect(r.ctl.target).toBe(30);
    expect(r.latency).toBeGreaterThan(26);
    expect(r.maxRate).toBe(1);
    expect(r.minRate).toBe(0.95);
  });

  it('with the E2E fast clock and rate scale: the same rise within a minute, never speeds up', () => {
    // Act
    const r = simulate({ seconds: 60, net: osc, speed: 10, rateScale: 10 });

    // Assert
    expect(r.ctl.networkState).toBe('unstable');
    expect(r.ctl.target).toBe(30);
    expect(r.latency).toBeGreaterThan(26);
    expect(r.maxRate).toBe(1);
    expect(r.minRate).toBe(0.5);
  });

  it('after the network settles, it waits before lowering again (hysteresis)', () => {
    // Arrange
    const r = simulate({ seconds: 300, net: osc });

    // Act
    const r2 = simulate({ ctl: r.ctl, start: 300, latency: r.latency, seconds: 40, net: () => fast });

    // Assert
    expect(r2.targets.every((t) => t === 30)).toBe(true);
  });

  it('then drifts down', () => {
    // Arrange
    const r = simulate({ seconds: 300, net: osc });
    const r2 = simulate({ ctl: r.ctl, start: 300, latency: r.latency, seconds: 40, net: () => fast });

    // Act
    const r3 = simulate({ ctl: r.ctl, start: 340, latency: r2.latency, seconds: 400, net: () => fast });

    // Assert
    expect(r3.ctl.target).toBeLessThan(25);
  });
});

describe('stalls', () => {
  it('a single stall raises the target at once and holds the frozen picture to reach it', () => {
    // Act
    const r = simulate({ seconds: 100, net: () => middling, stalls: [{ at: 50, durationS: 1 }] });

    // Assert
    expect(r.holds).toEqual([3]);
    expect(r.targets[49]).toBe(20);
    expect(r.targets[50]).toBe(23);
    expect(r.latency).toBeCloseTo(23, 0);
  });

  it('at most one hold a minute: a freeze that keeps coming back is not extended again', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    const first = ctl.onStallStart(0, 20).holdS;
    ctl.onStallEnd(5, 23, 5);

    // Act
    const again = ctl.onStallStart(10, 23).holdS;

    // Assert
    expect(first).toBe(3);
    expect(again).toBe(0);
  });

  it('a stall more than a minute after the last hold gets a hold again', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });
    ctl.onStallStart(0, 20);
    ctl.onStallEnd(5, 23, 5);
    ctl.onStallStart(10, 23);
    ctl.onStallEnd(12, 23, 2);

    // Act
    const later = ctl.onStallStart(70, 24).holdS;

    // Assert
    expect(later).toBeGreaterThan(0);
  });

  it('a long stall: no hold beyond the stall, the delay it added sticks (no catch-up afterwards)', () => {
    // Act
    const r = simulate({ seconds: 100, net: () => middling, stalls: [{ at: 50, durationS: 7 }] });

    // Assert
    expect(r.holds).toEqual([3]);
    expect(r.ctl.target).toBeCloseTo(27);
    expect(r.latency).toBeCloseTo(27, 0);
    expect(r.maxRate).toBe(1);
  });

  it('a stall raises the target even on a firm network, and nothing lowers it for 2 minutes', () => {
    // Arrange
    const r = simulate({ seconds: 200, net: () => fast });
    const before = r.ctl.target;

    // Act
    const r2 = simulate({ ctl: r.ctl, start: 200, latency: r.latency, seconds: 150, net: () => fast, stalls: [{ at: 200, durationS: 1 }] });

    // Assert
    const raised = r2.targets[0]!;
    expect(raised).toBeCloseTo(Math.max(before, r.latency) + 3, 0);
    expect(Math.min(...r2.targets.slice(0, 120))).toBeGreaterThanOrEqual(raised - 1e-9);
  });

  it('after those 2 minutes, a firm network lowers it again', () => {
    // Arrange
    const r = simulate({ seconds: 200, net: () => fast });
    const r2 = simulate({ ctl: r.ctl, start: 200, latency: r.latency, seconds: 150, net: () => fast, stalls: [{ at: 200, durationS: 1 }] });
    const raised = r2.targets[0]!;

    // Act
    const r3 = simulate({ ctl: r.ctl, start: 350, latency: r2.latency, seconds: 200, net: () => fast });

    // Assert
    expect(r3.ctl.target).toBeLessThan(raised);
  });

  it('repeated stalls raise faster, up to the bound', () => {
    // Arrange
    const stalls = [{ at: 30, durationS: 2 }, { at: 70, durationS: 2 }, { at: 110, durationS: 2 }];

    // Act
    const r = simulate({ seconds: 150, net: () => middling, stalls });

    // Assert
    expect(r.targets[30]).toBe(23);
    expect(r.targets[70]! - r.targets[69]!).toBeGreaterThan(3);
    expect(r.ctl.target).toBe(30);
    expect(Math.max(...r.targets)).toBe(30);
    expect(r.latency).toBeLessThanOrEqual(30.5);
  });

  it('a stall far above the bound: the target stays at the bound and playback catches up to it', () => {
    // Act
    const r = simulate({ seconds: 120, latency: 28, net: () => middling, stalls: [{ at: 5, durationS: 6 }] });

    // Assert
    expect(Math.max(...r.targets)).toBe(30);
    expect(r.latencies[6]).toBeGreaterThan(33);
    expect(r.latency).toBeLessThanOrEqual(31);
  });
});

describe('P2P-heavy network', () => {
  it('slow peer downloads do not count as an unstable link; the floor stays at 12 s', () => {
    // Act
    const r = simulate({ seconds: 900, net: () => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 0.8, p2pRatio: 1.4 }) });

    // Assert
    expect(r.states.includes('unstable')).toBe(false);
    expect(r.ctl.target).toBe(ADAPTIVE_DELAY.stable.p2pMin);
    expect(r.latency).toBeGreaterThan(11.5);
  });

  it('all segments from peers: still lowers on steady bandwidth and buffer', () => {
    // Act
    const r = simulate({ seconds: 600, net: () => ({ loadRatio: 0.15, bw: 20_000_000, p2p: 1, p2pRatio: 0.9 }) });

    // Assert
    expect(r.ctl.target).toBe(12);
  });
});

describe('buffer trend and user actions', () => {
  it('a buffer falling behind the live edge makes the network unstable', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    let state = '';
    for (let t = 0; t < 60; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.6, source: 'http' });
      state = ctl.tick({ now: t, latency: 20, forwardBuffer: Math.max(0, 18 - t * 0.3), bandwidthEstimate: 9_000_000, levelBitrate: BITRATE, playing: true }).state;
    }

    // Assert
    expect(state).toBe('unstable');
    expect(ctl.signals!.lagSlope).toBeGreaterThan(0.15);
  });

  it('far behind after a pause: the target waits while playback catches up gently', () => {
    // Act
    const r = simulate({ seconds: 900, net: () => fast, latency: 35 });

    // Assert
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    expect(Math.max(...r.targets.map((t, i) => r.latencies[i]! - t))).toBeLessThan(15.5);
    expect(r.targets[60]).toBe(20);
    expect(r.latency).toBeLessThan(11);
  });

  it('a jump in the measured delay while lowering (live edge estimate) does not stop the catch-up', () => {
    // Arrange
    const r = simulate({ seconds: 100, net: () => fast, speed: 10 });

    // Act
    const r2 = simulate({ ctl: r.ctl, start: 100, latency: r.latency + 2, seconds: 300, net: () => fast, speed: 10 });

    // Assert
    expect(r2.latency).toBeLessThan(11);
  });

  it('does not catch up on a thin buffer', () => {
    // Arrange
    const ctl = new DelayController({ profile: 'stable', now: 0 });

    // Act
    const rates: number[] = [];
    for (let t = 0; t < 200; t++) {
      if (t % 2 === 0) ctl.onFragment({ at: t, durationS: 2, loadS: 0.2, source: 'http' });
      rates.push(ctl.tick({ now: t, latency: 20, forwardBuffer: 3, bandwidthEstimate: 20_000_000, levelBitrate: BITRATE, playing: true }).playbackRate);
    }

    // Assert
    expect(new Set(rates)).toEqual(new Set([1]));
  });

  it.each([
    ['low-delay', 8],
    ['stable', 20],
  ] as const)('a switch to the %s profile starts over at its delay (%s s)', (profile, target) => {
    // Arrange
    const r = simulate({ seconds: 600, net: () => fast });
    const before = r.ctl.target;

    // Act
    r.ctl.reset(profile, 600);

    // Assert
    expect(before).toBe(10);
    expect(r.ctl.target).toBe(target);
  });

  it('the test-only fast clock gets below 15 s in about two minutes; the target never runs away from the delay', () => {
    // Act
    const r = simulate({ seconds: 400, net: () => fast, speed: 10 });

    // Assert
    expect(r.latencies.findIndex((l) => l < 15)).toBeLessThan(130);
    expect(r.latency).toBeLessThan(11);
    expect(r.maxRate).toBeLessThanOrEqual(1.05);
    expect(Math.max(...r.targets.map((t, i) => r.latencies[i]! - t))).toBeLessThan(TUNING.stable.catchUp.lead + 0.5);
  });

  it('with the rate scale too (the E2E flags), below 15 s in well under a minute, same shape', () => {
    // Act
    const r = simulate({ seconds: 120, net: () => fast, speed: 10, rateScale: 10 });

    // Assert
    expect(r.latencies.findIndex((l) => l < 15)).toBeLessThan(40);
    expect(r.maxRate).toBe(1.5);
    expect(r.latency).toBeLessThan(11);
    expect(Math.max(...r.targets.map((t, i) => r.latencies[i]! - t))).toBeLessThan(TUNING.stable.catchUp.lead + 1);
  });
});
