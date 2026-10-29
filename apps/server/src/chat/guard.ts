import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export type GuardState = 'ok' | 'degrade' | 'pause';

/** One sample: event-loop delay p99 (ms) and utilization (0..1) over the last second. */
export interface LoopSample {
  p99Ms: number;
  elu: number;
}

export interface GuardOptions {
  /** Sample source (tests inject one); default: perf_hooks. */
  sample?: () => LoopSample;
  intervalMs?: number;
  onChange?: (state: GuardState, prev: GuardState) => void;
}

/** Thresholds (plan §6.6): relative to a baseline learned while calm. */
export const GUARD = {
  degradeDelayMs: 30,
  degradeElu: 0.7,
  /** Seconds above the degrade thresholds before degrading. */
  degradeAfter: 5,
  pauseDelayMs: 120,
  pauseElu: 0.9,
  /** Consecutive seconds above the pause thresholds before pausing. */
  pauseAfter: 2,
  /** Seconds below the thresholds before stepping back to normal. */
  recoverAfter: 10,
  /** EWMA weight of a calm sample in the baseline. */
  baselineAlpha: 0.05,
} as const;

/**
 * EventLoopGuard (plan §6.6, point 3): chat yields first when the process is busy, whatever the
 * cause (the ffmpeg ladder, a request flood, chat itself).
 *
 * - degrade: batches every second, the global message rate halved, GIFs paused;
 * - pause: only the streamer's and moderation items go out; viewers' messages get "busy".
 */
export class EventLoopGuard {
  state: GuardState = 'ok';
  private baseline = -1;
  private high = 0;
  private veryHigh = 0;
  private calm = 0;
  private timer: NodeJS.Timeout | null = null;
  private hist: IntervalHistogram | null = null;
  private lastElu: EventLoopUtilization | null = null;
  last: LoopSample = { p99Ms: 0, elu: 0 };

  constructor(private readonly opts: GuardOptions = {}) {}

  start(): void {
    if (this.timer) return;
    if (!this.opts.sample) {
      this.hist = monitorEventLoopDelay({ resolution: 10 });
      this.hist.enable();
      this.lastElu = performance.eventLoopUtilization();
    }
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hist?.disable();
    this.hist = null;
    this.reset();
  }

  reset(): void {
    this.set('ok');
    this.high = this.veryHigh = this.calm = 0;
  }

  private read(): LoopSample {
    if (this.opts.sample) return this.opts.sample();
    const p99Ms = this.hist ? this.hist.percentile(99) / 1e6 : 0;
    this.hist?.reset();
    const now = performance.eventLoopUtilization();
    const elu = this.lastElu ? performance.eventLoopUtilization(now, this.lastElu).utilization : 0;
    this.lastElu = now;
    return { p99Ms: Number.isFinite(p99Ms) ? p99Ms : 0, elu };
  }

  /** One sample (also called directly by tests). */
  tick(sample: LoopSample = this.read()): GuardState {
    this.last = sample;
    const base = this.baseline < 0 ? sample.p99Ms : this.baseline;
    const isVeryHigh = sample.p99Ms > base + GUARD.pauseDelayMs || sample.elu > GUARD.pauseElu;
    const isHigh = isVeryHigh || sample.p99Ms > base + GUARD.degradeDelayMs || sample.elu > GUARD.degradeElu;
    this.veryHigh = isVeryHigh ? this.veryHigh + 1 : 0;
    this.high = isHigh ? this.high + 1 : 0;
    this.calm = isHigh ? 0 : this.calm + 1;
    // The baseline learns only while calm, so a long overload never becomes "normal".
    if (!isHigh && this.state === 'ok') this.baseline = this.baseline < 0 ? sample.p99Ms : this.baseline + GUARD.baselineAlpha * (sample.p99Ms - this.baseline);
    if (this.veryHigh >= GUARD.pauseAfter) this.set('pause');
    else if (this.high >= GUARD.degradeAfter && this.state === 'ok') this.set('degrade');
    else if (this.calm >= GUARD.recoverAfter && this.state !== 'ok') this.set('ok');
    return this.state;
  }

  private set(s: GuardState): void {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    this.opts.onChange?.(s, prev);
  }
}
