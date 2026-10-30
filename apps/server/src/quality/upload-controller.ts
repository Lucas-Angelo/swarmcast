import type { CodedText, MessageKey, MessageParams, UploadControllerPhase, UploadSignals } from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';

/**
 * Adaptive upload cap (AIMD, like TCP congestion control but on top of it):
 *
 * - Additive increase: while the uplink looks healthy AND viewers actually want more than the
 *   current cap, raise it by a small step every tick. Never raise it while the cap is not the
 *   bottleneck ("app-limited"), so an untested cap never creeps up to the ceiling.
 * - Multiplicative decrease: on any congestion signal (OBS reports congestion or dropped
 *   frames on her main OBS output, or queueing delay on the uplink grows) cut the cap by 30 %
 *   and hold it for a while. Near the last cap that caused trouble, increase more slowly.
 * - Hard ceiling: never above measured upload − other stream (with margin) − headroom.
 *
 * The class is pure (no timers, no I/O): `tick()` gets the signals and the time.
 */
export interface UploadControllerOptions {
  /** Lowest cap in auto mode, Mbps. Viewers still get something; P2P does the rest. */
  floorMbps?: number;
  /** Cap before any information arrives, Mbps (used when no speed test exists). */
  initialMbps?: number;
  /** Multiplicative decrease factor. */
  decrease?: number;
  /** Additive step as a fraction of the ceiling (min 0.25 Mbps). */
  stepFraction?: number;
  /** No increase for this long after a backoff, ms. */
  holdMs?: number;
  /** Queueing delay that counts as congestion: max(minQueueDelayMs, baseRtt × queueDelayFactor). */
  minQueueDelayMs?: number;
  queueDelayFactor?: number;
  /** obs-websocket outputCongestion above this is congestion. */
  obsCongestionThreshold?: number;
  /** Dropped frames (percent of the interval) above this is congestion. */
  obsDroppedPercentThreshold?: number;
}

export interface TickInput {
  now: number;
  /** Hard ceiling (Mbps) or undefined when the upload was never measured. */
  ceilingMbps?: number;
  /** Absolute maximum when the ceiling is unknown (her manual limit). */
  fallbackMaxMbps: number;
  signals: UploadSignals;
}

export interface TickResult {
  capMbps: number;
  phase: UploadControllerPhase;
  /** Set when this tick backed off. */
  backoff?: { reason: string; code: MessageKey; params?: MessageParams; fromMbps: number; toMbps: number };
}

function why(code: MessageKey, params?: MessageParams): CodedText {
  return { code, ...(params ? { params } : {}), text: translate('en', code, params) };
}

export class UploadController {
  capMbps: number;
  phase: UploadControllerPhase = 'starting';
  private holdUntil = 0;
  /** Cap at the last congestion event: increases slow down near it. */
  private lastBadMbps?: number;
  private readonly o: Required<UploadControllerOptions>;

  constructor(opts: UploadControllerOptions = {}) {
    this.o = {
      floorMbps: 1,
      initialMbps: 8,
      decrease: 0.7,
      stepFraction: 0.04,
      holdMs: 10_000,
      minQueueDelayMs: 50,
      queueDelayFactor: 1,
      obsCongestionThreshold: 0.15,
      obsDroppedPercentThreshold: 0.5,
      ...opts,
    };
    this.capMbps = this.o.initialMbps;
  }

  /** Start value for a new live: 60 % of the ceiling (or the initial value), proven upward from there. */
  reset(ceilingMbps: number | undefined, fallbackMaxMbps: number): void {
    const max = ceilingMbps ?? fallbackMaxMbps;
    this.capMbps = clamp(ceilingMbps !== undefined ? ceilingMbps * 0.6 : this.o.initialMbps, Math.min(this.o.floorMbps, max), max);
    this.phase = 'starting';
    this.holdUntil = 0;
    this.lastBadMbps = undefined;
  }

  /** Why the uplink looks congested right now, or null if it looks healthy. */
  congestion(s: UploadSignals): CodedText | null {
    if (s.obsReconnecting) return why('quality.backoff.obsReconnecting');
    if (s.obsCongestion !== undefined && s.obsCongestion > this.o.obsCongestionThreshold) {
      return why('quality.backoff.obsCongestion', { percent: Math.round(s.obsCongestion * 100) });
    }
    if (s.obsDroppedPercent !== undefined && s.obsDroppedPercent > this.o.obsDroppedPercentThreshold) {
      return why('quality.backoff.obsDropped', { percent: Math.round(s.obsDroppedPercent * 10) / 10 });
    }
    if (s.queueDelayMs !== undefined && s.baseRttMs !== undefined) {
      const limit = Math.max(this.o.minQueueDelayMs, s.baseRttMs * this.o.queueDelayFactor);
      if (s.queueDelayMs > limit) return why('quality.backoff.queueing', { ms: Math.round(s.queueDelayMs) });
    }
    return null;
  }

  tick(i: TickInput): TickResult {
    const max = i.ceilingMbps ?? i.fallbackMaxMbps;
    const floor = Math.min(this.o.floorMbps, max);
    let reason = this.congestion(i.signals);
    // Latency growth only means *our* traffic is filling the uplink when we actually send a
    // meaningful share of the cap; with little or no usage it is someone else's traffic or
    // a noisy sample, and cutting the cap would only cause a false "upload too low".
    if (reason?.code === 'quality.backoff.queueing' && i.signals.usedMbps < Math.max(2, this.capMbps * 0.5)) reason = null;
    if (reason) {
      const from = this.capMbps;
      // Back off from what is actually being sent when that is below the cap: cutting an
      // unused cap would not relieve anything.
      const basis = Math.min(this.capMbps, Math.max(i.signals.usedMbps, floor));
      const to = clamp(round1(basis * this.o.decrease), floor, max);
      const already = i.now < this.holdUntil && this.phase === 'backing-off';
      this.capMbps = already ? Math.min(this.capMbps, to) : to;
      this.lastBadMbps = from;
      this.holdUntil = i.now + this.o.holdMs;
      this.phase = 'backing-off';
      return { capMbps: this.capMbps, phase: this.phase, backoff: already ? undefined : { reason: reason.text, code: reason.code, ...(reason.params ? { params: reason.params } : {}), fromMbps: from, toMbps: this.capMbps } };
    }
    if (i.now < this.holdUntil) {
      this.capMbps = clamp(this.capMbps, floor, max);
      return { capMbps: this.capMbps, phase: this.phase };
    }
    if (i.signals.demandLimited && this.capMbps < max) {
      // Proportional to the current cap (not the ceiling: with no speed test the ceiling is
      // her manual maximum, often far above the real link), bounded by a share of the ceiling.
      let step = Math.min(Math.max(0.25, this.capMbps * 0.05), Math.max(0.25, max * this.o.stepFraction));
      // Cautious near the cap that last caused congestion (CUBIC-like plateau).
      if (this.lastBadMbps !== undefined && this.capMbps >= this.lastBadMbps * 0.85) step /= 4;
      this.capMbps = clamp(round1(this.capMbps + step), floor, max);
      this.phase = 'increasing';
    } else {
      this.capMbps = clamp(this.capMbps, floor, max);
      this.phase = 'holding';
    }
    return { capMbps: this.capMbps, phase: this.phase };
  }
}

/**
 * Upload the video limiter leaves to the chat (docs/CHAT.md, plan §6.6), Mbps:
 * min(B_chat, 1.2 × the chat's measured upload), so video + chat stay within the ceiling and video
 * only gives up what chat really uses (at most the chat budget, 768 kbps).
 */
export function chatReserveMbps(budgetBitsPerS: number, egressBitsPerS: number): number {
  const b = Number.isFinite(budgetBitsPerS) ? Math.max(0, budgetBitsPerS) : 0;
  const e = Number.isFinite(egressBitsPerS) ? Math.max(0, egressBitsPerS) : 0;
  return Math.min(b, 1.2 * e) / 1_000_000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Baseline/queueing-delay tracker for RTT samples (LEDBAT-style): base = minimum over a long
 * window, current = minimum of the last few samples (filters one-off spikes).
 */
export class RttTracker {
  private samples: Array<{ at: number; ms: number }> = [];
  constructor(
    private readonly baseWindowMs = 5 * 60_000,
    private readonly currentSamples = 2,
  ) {}

  add(at: number, ms: number): void {
    this.samples.push({ at, ms });
    while (this.samples.length > 0 && at - this.samples[0]!.at > this.baseWindowMs) this.samples.shift();
  }

  get baseMs(): number | undefined {
    if (this.samples.length < this.currentSamples) return undefined;
    return Math.min(...this.samples.map((s) => s.ms));
  }

  get currentMs(): number | undefined {
    if (this.samples.length === 0) return undefined;
    return Math.min(...this.samples.slice(-this.currentSamples).map((s) => s.ms));
  }

  get queueDelayMs(): number | undefined {
    const b = this.baseMs;
    const c = this.currentMs;
    return b === undefined || c === undefined ? undefined : c - b;
  }

  clear(): void {
    this.samples = [];
  }
}
