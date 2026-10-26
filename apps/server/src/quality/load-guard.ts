import os from 'node:os';

/**
 * Keeps the quality ladder from stealing CPU from OBS (docs/QUALITY.md §2b, "CPU safety").
 * Pure logic fed with samples, so it is unit-tested without ffmpeg.
 */

/**
 * Transcoding speed over the last `windowMs` (× real time), from ffmpeg's `out_time_us`
 * progress lines. The input is live, so a converter that keeps up sits at 1.0; ffmpeg's own
 * `speed=` is an average since the start and reacts far too slowly.
 */
export class SpeedWindow {
  private samples: Array<{ at: number; outUs: number }> = [];
  constructor(private readonly windowMs = 10_000) {}

  add(at: number, outTimeUs: number): void {
    const last = this.samples.at(-1);
    // A restart (new run) starts its clock at 0 again.
    if (last && outTimeUs < last.outUs) this.samples = [];
    this.samples.push({ at, outUs: outTimeUs });
    while (this.samples.length > 2 && at - this.samples[1]!.at >= this.windowMs) this.samples.shift();
  }

  /** Span of the samples (ms); the speed is only meaningful once this nears the window. */
  get spanMs(): number {
    const a = this.samples[0];
    const b = this.samples.at(-1);
    return a && b ? b.at - a.at : 0;
  }

  get speed(): number | undefined {
    const a = this.samples[0];
    const b = this.samples.at(-1);
    if (!a || !b || b.at - a.at < 2000) return undefined;
    return (b.outUs - a.outUs) / 1000 / (b.at - a.at);
  }

  clear(): void {
    this.samples = [];
  }
}

/** Whole-machine CPU use (all cores, all processes) between two calls, percent. Works on every OS. */
export class CpuSampler {
  private last: { idle: number; total: number } | null = null;
  constructor(private readonly cpus: () => os.CpuInfo[] = os.cpus) {}

  private read(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of this.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    return { idle, total };
  }

  /** Busy percent since the previous call (undefined on the first call). */
  sample(): number | undefined {
    const now = this.read();
    const prev = this.last;
    this.last = now;
    if (!prev || now.total <= prev.total) return undefined;
    return Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 1000) / 10;
  }
}

export interface LoadGuardOptions {
  /** Below this speed (× real time) the converter is falling behind. 0.97: noise margin under 1.0×. */
  behindSpeed: number;
  /** …for this long. */
  behindForMs: number;
  /** The speed window must cover at least this much before it counts. */
  minWindowMs: number;
  /** Whole-machine CPU at or above this percent is saturation. */
  cpuSaturatedPercent: number;
  /** …for this long. */
  cpuForMs: number;
  /** After dropping a rendition, wait this long to see the effect before dropping another. */
  cooldownMs: number;
}

export const LOAD_GUARD_DEFAULTS: LoadGuardOptions = {
  behindSpeed: 0.97,
  behindForMs: 10_000,
  minWindowMs: 8_000,
  cpuSaturatedPercent: 90,
  cpuForMs: 10_000,
  cooldownMs: 30_000,
};

export type ShedReason = 'behind' | 'cpu';

/**
 * Decides when to drop a rendition: the converter fell behind real time, or the whole machine
 * is saturated (OBS would start dropping frames). One drop at a time, with a cool-down.
 */
export class LoadGuard {
  private readonly o: LoadGuardOptions;
  private behindSince: number | null = null;
  private saturatedSince: number | null = null;
  private lastShedAt: number | null = null;

  constructor(o: Partial<LoadGuardOptions> = {}) {
    this.o = { ...LOAD_GUARD_DEFAULTS, ...o };
  }

  /**
   * Feed one observation (every tick while the converter runs) and get a reason to drop a
   * rendition now, or null.
   */
  check(now: number, s: { speed?: number; speedSpanMs?: number; cpuBusyPercent?: number }): ShedReason | null {
    const behind = s.speed !== undefined && (s.speedSpanMs ?? 0) >= this.o.minWindowMs && s.speed < this.o.behindSpeed;
    this.behindSince = behind ? (this.behindSince ?? now) : null;
    const saturated = s.cpuBusyPercent !== undefined && s.cpuBusyPercent >= this.o.cpuSaturatedPercent;
    this.saturatedSince = saturated ? (this.saturatedSince ?? now) : null;
    if (this.lastShedAt !== null && now - this.lastShedAt < this.o.cooldownMs) return null;
    if (this.behindSince !== null && now - this.behindSince >= this.o.behindForMs) return 'behind';
    if (this.saturatedSince !== null && now - this.saturatedSince >= this.o.cpuForMs) return 'cpu';
    return null;
  }

  /** A rendition was dropped: start the cool-down and the observation windows again. */
  shed(now: number): void {
    this.lastShedAt = now;
    this.behindSince = null;
    this.saturatedSince = null;
  }

  reset(): void {
    this.behindSince = null;
    this.saturatedSince = null;
    this.lastShedAt = null;
  }
}
