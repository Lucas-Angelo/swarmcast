/**
 * Adaptive playback delay: pure decision code (no DOM, no hls.js), unit tested in
 * apps/viewer/test/unit/latency-controller.test.ts. adaptive-delay.ts feeds it player events
 * and applies its decisions. docs/QUALITY.md ("Adaptive delay") explains every number.
 *
 * Each viewer gets its own target delay behind live, inside the profile's bounds
 * (ADAPTIVE_DELAY in @swarmcast/shared, capped by MAX_PLAYER_DELAY_S):
 * - firm network (segments load much faster than real time, steady bandwidth well above the
 *   rendition, no stalls for 2 min): the target drifts down slowly, and playback catches up
 *   with a gentle playbackRate (at most the profile's maxRate);
 * - unstable network (slow or erratic segment loads, oscillating bandwidth, the buffer falling
 *   behind the live edge): the target rises, and playback slows slightly (0.95×) to build buffer;
 * - a stall raises the target at once; the freeze already in progress is held a little longer
 *   (at most maxHoldS) to reach it, so there is no second freeze later.
 * Classification has hysteresis (separate enter / leave thresholds and dwell times).
 */
import { ADAPTIVE_DELAY, type AdaptiveDelayBounds } from '@swarmcast/shared';

export type DelayProfileId = keyof typeof ADAPTIVE_DELAY;
export type NetworkState = 'firm' | 'steady' | 'unstable';
export type RateMode = 'normal' | 'catch-up' | 'slow-down';

/** One media segment the player loaded. Times in seconds. */
export interface FragmentSample {
  /** When it finished loading (controller clock). */
  at: number;
  /** Media duration of the segment. */
  durationS: number;
  /** Time the download took (request to last byte). */
  loadS: number;
  /** Where the bytes came from (p2p-media-loader). */
  source: 'http' | 'p2p';
  /** Size, used to estimate the rendition bitrate when the playlist does not say. */
  bytes?: number;
}

export interface TickInput {
  /** Controller clock, seconds (monotonic). */
  now: number;
  /** Seconds behind the live edge (hls.latency), null when unknown. */
  latency: number | null;
  /** Seconds of video buffered ahead of the playhead. */
  forwardBuffer: number;
  /** hls.js bandwidth estimate, bits/s. */
  bandwidthEstimate: number;
  /** Bitrate of the rendition playing, bits/s (0 = unknown). */
  levelBitrate: number;
  /** Video is advancing: not paused by the viewer, not stalled, not held by us. */
  playing: boolean;
  /** This viewer has P2P on (peers may supply segments). */
  p2pEnabled?: boolean;
}

export interface Decision {
  /** Target delay behind live, seconds. */
  target: number;
  /** playbackRate to apply. */
  playbackRate: number;
  state: NetworkState;
  rateMode: RateMode;
}

export interface StallDecision {
  target: number;
  /** Keep playback held this long (seconds) from the start of the stall; 0 = no hold. */
  holdS: number;
}

export interface Signals {
  httpSamples: number;
  p2pShare: number;
  medianLoadRatio: number | null;
  p90LoadRatio: number | null;
  headroom: number | null;
  headroomCov: number | null;
  lagSlope: number | null;
  sinceStallS: number;
}

export interface Tuning {
  /** Statistics window for segment loads and bandwidth samples, s. */
  windowS: number;
  /** Window for the buffer trend (slope of the distance between buffer end and live edge), s. */
  trendWindowS: number;
  minHttpSamples: number;
  /** Bandwidth headroom (estimate / rendition bitrate) is capped here before computing its variance. */
  headroomCap: number;
  firm: { medianRatio: number; p90Ratio: number; maxCov: number; minHeadroom: number; maxLagSlope: number; enterS: number };
  /** Leaving "firm" (looser than entering it: hysteresis). */
  firmExit: { medianRatio: number; p90Ratio: number; maxCov: number; minHeadroom: number; lagSlope: number; afterS: number };
  unstable: { medianRatio: number; p90Ratio: number; cov: number; minHeadroom: number; lagSlope: number; enterS: number; exitS: number };
  /** No lowering for this long after a stall, s. */
  stallQuietS: number;
  /** Stalls this recent make the next raise bigger, s. */
  stallMemoryS: number;
  /** P2P segments this recent keep the P2P floor (bounds.p2pMin), s. */
  p2pMemoryS: number;
  /** Target decrease on a firm network, s per s. */
  decayPerS: number;
  /** Target increase on an unstable network, s per s. */
  raisePerS: number;
  /** Target increase at a stall (× 1, 2, 3 with recent stalls), s. */
  stallStepS: number;
  /** Longest hold added to a stall, s. */
  maxHoldS: number;
  /** At most one hold this often, s: a freeze that keeps coming back (stuck loading, the stall
   * watchdog restarting it) is not extended again and again. */
  holdEveryS: number;
  /** Highest catch-up playbackRate. */
  maxRate: number;
  /** playbackRate while building delay on an unstable network. */
  slowRate: number;
  /**
   * lead: when lowering, the target never goes more than this far below the current delay, so
   * it only moves as fast as playback can follow (the delay falls at most at maxRate − 1 s/s).
   */
  catchUp: { startAbove: number; stopBelow: number; minBufferS: number; lead: number };
  slowDown: { startBelow: number; stopBelow: number };
}

const COMMON = {
  windowS: 60,
  trendWindowS: 30,
  minHttpSamples: 4,
  headroomCap: 4,
  firm: { medianRatio: 0.35, p90Ratio: 0.6, maxCov: 0.2, minHeadroom: 2, maxLagSlope: 0.05, enterS: 20 },
  firmExit: { medianRatio: 0.5, p90Ratio: 0.8, maxCov: 0.3, minHeadroom: 1.5, lagSlope: 0.1, afterS: 5 },
  unstable: { medianRatio: 0.6, p90Ratio: 0.9, cov: 0.35, minHeadroom: 1.2, lagSlope: 0.15, enterS: 5, exitS: 30 },
  stallQuietS: 120,
  stallMemoryS: 300,
  holdEveryS: 60,
  p2pMemoryS: 120,
  slowRate: 0.95,
  slowDown: { startBelow: 1, stopBelow: 0.25 },
} satisfies Partial<Tuning>;

export const TUNING: Record<DelayProfileId, Tuning> = {
  stable: {
    ...COMMON,
    decayPerS: 0.04,
    raisePerS: 0.1,
    stallStepS: 3,
    maxHoldS: 4,
    maxRate: 1.05,
    catchUp: { startAbove: 1, stopBelow: 0.25, minBufferS: 4, lead: 3 },
  },
  'low-delay': {
    ...COMMON,
    decayPerS: 0.02,
    raisePerS: 0.05,
    stallStepS: 1.5,
    maxHoldS: 2,
    maxRate: 1.1,
    catchUp: { startAbove: 0.75, stopBelow: 0.2, minBufferS: 2, lead: 2 },
  },
};

/** Time-based constants divided by `speed` (test-only fast clock); statistics windows unchanged. */
export function scaledTuning(t: Tuning, speed: number): Tuning {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (s === 1) return t;
  return {
    ...t,
    firm: { ...t.firm, enterS: t.firm.enterS / s },
    firmExit: { ...t.firmExit, afterS: t.firmExit.afterS / s },
    unstable: { ...t.unstable, enterS: t.unstable.enterS / s, exitS: t.unstable.exitS / s },
    stallQuietS: t.stallQuietS / s,
    stallMemoryS: t.stallMemoryS / s,
    holdEveryS: t.holdEveryS / s,
    p2pMemoryS: t.p2pMemoryS / s,
    decayPerS: t.decayPerS * s,
    raisePerS: t.raisePerS * s,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Nearest-rank quantile of a non-empty list. */
export function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/** Coefficient of variation (std / mean), null for fewer than 2 values or a zero mean. */
export function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** Least-squares slope of y over t, null without enough spread. */
export function slope(points: ReadonlyArray<{ t: number; v: number }>, minSpanS: number): number | null {
  if (points.length < 3) return null;
  const span = points[points.length - 1]!.t - points[0]!.t;
  if (span < minSpanS) return null;
  const mt = points.reduce((a, p) => a + p.t, 0) / points.length;
  const mv = points.reduce((a, p) => a + p.v, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) ** 2;
  }
  return den > 0 ? num / den : null;
}

export interface DelayControllerOptions {
  profile: DelayProfileId;
  /** Test-only: run the controller's clocks this many times faster (URL flag in adaptive-delay.ts). */
  speed?: number;
  /** Override the bounds (tests). */
  bounds?: AdaptiveDelayBounds;
  /** Clock value at creation. */
  now?: number;
}

export class DelayController {
  private profile: DelayProfileId;
  private readonly speed: number;
  private boundsOverride: AdaptiveDelayBounds | undefined;
  private bounds!: AdaptiveDelayBounds;
  private tuning!: Tuning;
  private targetS = 0;
  private ceiling: number | null = null;
  private growthLimit: number | null = null;
  private state: NetworkState = 'steady';
  private rateMode: RateMode = 'normal';
  private frags: FragmentSample[] = [];
  private headrooms: Array<{ t: number; v: number }> = [];
  private lags: Array<{ t: number; v: number }> = [];
  private stalls: Array<{ at: number; durationS: number }> = [];
  private lastStallAt = -Infinity;
  private lastHoldAt = -Infinity;
  private lastP2PAt = -Infinity;
  private lastTick: number | null = null;
  /** Since when the "enter" condition of the next state has held (hysteresis dwell). */
  private firmSince: number | null = null;
  private unstableSince: number | null = null;
  private calmSince: number | null = null;
  private looseSince: number | null = null;
  private lastSignals: Signals | null = null;

  constructor(o: DelayControllerOptions) {
    this.profile = o.profile;
    this.speed = o.speed ?? 1;
    this.boundsOverride = o.bounds;
    this.reset(o.profile, o.now);
  }

  /** Back to the profile's starting target (profile switch, new stream). */
  reset(profile: DelayProfileId = this.profile, now?: number): void {
    this.profile = profile;
    this.bounds = this.boundsOverride ?? ADAPTIVE_DELAY[profile];
    this.tuning = scaledTuning(TUNING[profile], this.speed);
    this.targetS = clamp(this.bounds.initial, this.bounds.min, this.bounds.max);
    this.state = 'steady';
    this.rateMode = 'normal';
    this.frags = [];
    this.headrooms = [];
    this.lags = [];
    this.firmSince = this.unstableSince = this.calmSince = this.looseSince = null;
    this.lastTick = now ?? null;
    // Stall and P2P memory survive a profile switch: the network did not change.
  }

  /** The target to play at: the network's target, capped by the playlist ceiling. */
  get target(): number {
    return clamp(this.targetS, this.minS, this.maxS);
  }

  get networkState(): NetworkState {
    return this.state;
  }

  /**
   * Hard upper limit from the playlists actually served (player-config.ts latencyFor: an older
   * server whose audio playlist is shorter than the video one), null = none. It caps the
   * target (and so hls.js' live sync position); the network's own target is kept underneath.
   */
  setCeiling(seconds: number | null): void {
    this.ceiling = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  /**
   * How far back the shortest live playlist in use reaches right now (stream just started, or a
   * server keeping fewer segments), null = no limit. The controller never builds delay past it
   * (no slow-down, no hold), but does not pull the playhead closer to live because of it either:
   * a short window at stream start grows by itself.
   */
  setGrowthLimit(seconds: number | null): void {
    this.growthLimit = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  private get growthMaxS(): number {
    return this.growthLimit === null ? this.maxS : Math.min(this.maxS, this.growthLimit);
  }

  /** Highest target now: the profile bound, lowered by the playlist ceiling if any. */
  get maxS(): number {
    return this.ceiling === null ? this.bounds.max : Math.min(this.bounds.max, this.ceiling);
  }

  /** Lowest target now (never above maxS). */
  get minS(): number {
    return Math.min(this.bounds.min, this.maxS);
  }

  /** The profile's bounds with the playlist ceiling applied. */
  get currentBounds(): AdaptiveDelayBounds {
    return { ...this.bounds, min: this.minS, max: this.maxS };
  }

  get signals(): Signals | null {
    return this.lastSignals;
  }

  onFragment(s: FragmentSample): void {
    if (!(s.durationS > 0.2) || !(s.loadS >= 0) || !Number.isFinite(s.loadS)) return;
    this.frags.push(s);
    if (s.source === 'p2p') this.lastP2PAt = Math.max(this.lastP2PAt, s.at);
  }

  /**
   * Playback stopped for lack of data. Raises the target now (bigger with recent stalls) and says
   * how long to hold playback so the delay reaches it within this freeze instead of a later one.
   * Never holds past the bounds (the server's playlist window).
   */
  onStallStart(now: number, latency: number | null): StallDecision {
    const tu = this.tuning;
    this.stalls = this.stalls.filter((s) => now - s.at <= tu.stallMemoryS);
    // Recent stalls, long ones weighing more (4 s stalled ≈ one more stall).
    const severity = 1 + this.stalls.reduce((a, s) => a + 1 + s.durationS / 4, 0);
    this.stalls.push({ at: now, durationS: 0 });
    this.lastStallAt = now;
    const step = tu.stallStepS * Math.min(3, severity);
    const base = Math.max(this.targetS, latency ?? this.targetS);
    this.targetS = clamp(base + step, this.bounds.min, this.bounds.max);
    this.enterUnstable(now);
    this.rateMode = 'normal';
    if (latency === null || !Number.isFinite(latency)) return { target: this.target, holdS: 0 };
    if (now - this.lastHoldAt < tu.holdEveryS) return { target: this.target, holdS: 0 };
    const room = this.growthMaxS - latency;
    const holdS = clamp(Math.min(this.target - latency, room), 0, tu.maxHoldS);
    if (holdS < 0.5) return { target: this.target, holdS: 0 };
    this.lastHoldAt = now;
    return { target: this.target, holdS: Math.round(holdS * 10) / 10 };
  }

  /** Playback resumed: the delay the stall added stays (the target never sits below it). */
  onStallEnd(now: number, latency: number | null, durationS: number): void {
    const last = this.stalls[this.stalls.length - 1];
    if (last) last.durationS = Math.max(0, durationS);
    this.lastStallAt = now;
    if (latency !== null && Number.isFinite(latency)) this.targetS = clamp(Math.max(this.targetS, latency), this.bounds.min, this.bounds.max);
  }

  tick(input: TickInput): Decision {
    const tu = this.tuning;
    const now = input.now;
    const dt = this.lastTick === null ? 0 : clamp(now - this.lastTick, 0, 5);
    this.lastTick = now;
    this.record(input);
    const sig = this.computeSignals(now);
    this.lastSignals = sig;
    this.updateState(now, sig, input);

    // Target.
    const floor = input.p2pEnabled !== false && now - this.lastP2PAt <= tu.p2pMemoryS ? Math.max(this.bounds.min, this.bounds.p2pMin) : this.bounds.min;
    if (this.state === 'firm') {
      if (this.targetS > floor) {
        let next = Math.max(floor, this.targetS - tu.decayPerS * dt);
        // Do not run ahead of what playback can follow (and never raise the target here). After
        // a pause, the delay is far above the target: the target waits while playback catches up.
        const l = input.latency;
        if (l !== null && Number.isFinite(l)) next = Math.max(next, Math.min(this.targetS, l - tu.catchUp.lead));
        this.targetS = next;
      } else this.targetS = Math.min(floor, this.targetS + tu.decayPerS * dt);
    } else if (this.state === 'unstable' && this.unstableNow(sig)) {
      this.targetS = Math.min(this.bounds.max, this.targetS + tu.raisePerS * dt);
    }
    this.targetS = clamp(this.targetS, this.bounds.min, this.bounds.max);

    return { target: this.target, playbackRate: this.rate(input), state: this.state, rateMode: this.rateMode };
  }

  private record(input: TickInput): void {
    const tu = this.tuning;
    const now = input.now;
    const bitrate = input.levelBitrate > 0 ? input.levelBitrate : this.fragmentBitrate();
    if (input.bandwidthEstimate > 0 && bitrate > 0) {
      this.headrooms.push({ t: now, v: Math.min(tu.headroomCap, input.bandwidthEstimate / bitrate) });
    }
    if (input.playing && input.latency !== null && Number.isFinite(input.latency)) {
      this.lags.push({ t: now, v: input.latency - input.forwardBuffer });
    }
    this.frags = this.frags.filter((f) => now - f.at <= tu.windowS);
    this.headrooms = this.headrooms.filter((h) => now - h.t <= tu.windowS);
    this.lags = this.lags.filter((l) => now - l.t <= tu.trendWindowS);
  }

  private fragmentBitrate(): number {
    const rates = this.frags.filter((f) => f.bytes && f.bytes > 0).map((f) => (f.bytes! * 8) / f.durationS);
    return rates.length ? quantile(rates, 0.5) : 0;
  }

  private computeSignals(now: number): Signals {
    const http = this.frags.filter((f) => f.source === 'http');
    const ratios = http.map((f) => f.loadS / f.durationS);
    const latestHeadroom = this.headrooms.length ? this.headrooms[this.headrooms.length - 1]!.v : null;
    return {
      httpSamples: http.length,
      p2pShare: this.frags.length ? (this.frags.length - http.length) / this.frags.length : 0,
      medianLoadRatio: ratios.length ? quantile(ratios, 0.5) : null,
      p90LoadRatio: ratios.length ? quantile(ratios, 0.9) : null,
      headroom: latestHeadroom,
      headroomCov: this.headrooms.length >= 5 ? coefficientOfVariation(this.headrooms.map((h) => h.v)) : null,
      lagSlope: slope(this.lags, Math.min(10, this.tuning.trendWindowS / 2)),
      sinceStallS: now - this.lastStallAt,
    };
  }

  private firmNow(s: Signals): boolean {
    const f = this.tuning.firm;
    const loadsOk =
      s.httpSamples >= this.tuning.minHttpSamples
        ? s.medianLoadRatio! <= f.medianRatio && s.p90LoadRatio! <= f.p90Ratio
        : // Mostly from peers: their timing says little about this viewer's link; rely on the rest.
          s.p2pShare >= 0.5 && this.frags.length >= this.tuning.minHttpSamples;
    const bwOk = s.headroom !== null && s.headroomCov !== null && s.headroom >= f.minHeadroom && s.headroomCov <= f.maxCov;
    const trendOk = s.lagSlope === null || s.lagSlope <= f.maxLagSlope;
    return loadsOk && bwOk && trendOk && s.sinceStallS >= this.tuning.stallQuietS;
  }

  /** Clearly no longer firm (looser than firmNow: hysteresis). */
  private looseNow(s: Signals): boolean {
    const x = this.tuning.firmExit;
    return (
      (s.httpSamples >= 3 && (s.medianLoadRatio! > x.medianRatio || s.p90LoadRatio! > x.p90Ratio)) ||
      (s.headroomCov !== null && s.headroomCov > x.maxCov) ||
      (s.headroom !== null && s.headroom < x.minHeadroom) ||
      (s.lagSlope !== null && s.lagSlope > x.lagSlope)
    );
  }

  private unstableNow(s: Signals): boolean {
    const u = this.tuning.unstable;
    return (
      (s.httpSamples >= 3 && (s.p90LoadRatio! >= u.p90Ratio || s.medianLoadRatio! >= u.medianRatio)) ||
      (s.headroomCov !== null && s.headroomCov >= u.cov) ||
      (s.headroom !== null && s.headroom < u.minHeadroom) ||
      (s.lagSlope !== null && s.lagSlope >= u.lagSlope)
    );
  }

  private enterUnstable(now: number): void {
    this.state = 'unstable';
    this.calmSince = null;
    this.firmSince = null;
    this.unstableSince = now;
  }

  private updateState(now: number, s: Signals, input: TickInput): void {
    const tu = this.tuning;
    // Do not judge the network while the viewer paused (no loads to speak of) or before any data.
    if (!input.playing && this.state !== 'unstable') {
      this.firmSince = null;
      return;
    }
    const unstable = this.unstableNow(s);
    const firm = !unstable && this.firmNow(s);
    if (this.state === 'unstable') {
      if (unstable || now - this.lastStallAt < tu.unstable.exitS) {
        this.calmSince = null;
        return;
      }
      this.calmSince ??= now;
      if (now - this.calmSince >= tu.unstable.exitS) {
        this.state = 'steady';
        this.calmSince = null;
      }
      return;
    }
    if (unstable) {
      this.unstableSince ??= now;
      if (now - this.unstableSince >= tu.unstable.enterS) this.enterUnstable(now);
      return;
    }
    this.unstableSince = null;
    if (this.state === 'firm') {
      if (this.looseNow(s) || s.sinceStallS < tu.stallQuietS) {
        this.looseSince ??= now;
        if (now - this.looseSince >= tu.firmExit.afterS || s.sinceStallS < tu.stallQuietS) {
          this.state = 'steady';
          this.looseSince = null;
          this.firmSince = null;
        }
      } else {
        this.looseSince = null;
      }
      return;
    }
    // steady
    if (firm) {
      this.firmSince ??= now;
      if (now - this.firmSince >= tu.firm.enterS) {
        this.state = 'firm';
        this.looseSince = null;
      }
    } else {
      this.firmSince = null;
    }
  }

  private rate(input: TickInput): number {
    const tu = this.tuning;
    if (!input.playing || input.latency === null || !Number.isFinite(input.latency)) {
      this.rateMode = 'normal';
      return 1;
    }
    const d = input.latency - this.target;
    const overMax = input.latency > this.maxS + tu.catchUp.stopBelow;
    // Catch up (lower the delay): never while the network is unstable unless the delay is past
    // the bounds, and never on a thin buffer.
    const canCatchUp = (this.state !== 'unstable' || overMax) && input.forwardBuffer >= tu.catchUp.minBufferS;
    if (this.rateMode === 'catch-up') {
      if (!canCatchUp || d < tu.catchUp.stopBelow) this.rateMode = 'normal';
    } else if (canCatchUp && d > tu.catchUp.startAbove) {
      this.rateMode = 'catch-up';
    }
    // Slow down (raise the delay) only on an unstable network.
    const canSlow = this.state === 'unstable' && !overMax && input.latency < this.growthMaxS - tu.slowDown.startBelow;
    if (this.rateMode === 'slow-down') {
      if (!canSlow || d > -tu.slowDown.stopBelow) this.rateMode = 'normal';
    } else if (this.rateMode === 'normal' && canSlow && d < -tu.slowDown.startBelow) {
      this.rateMode = 'slow-down';
    }
    if (this.rateMode === 'catch-up') {
      // Full boost from 2 s away, half of it closer in: two steps keep audio resampling smooth.
      const boost = tu.maxRate - 1;
      return Math.round((1 + (d >= 2 ? boost : boost / 2)) * 1000) / 1000;
    }
    if (this.rateMode === 'slow-down') return tu.slowRate;
    return 1;
  }
}
