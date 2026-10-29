/**
 * Rate limiters of the chat (plan §6.1). All in memory, all O(1) per check, all bounded.
 */

/** Token bucket: `capacity` tokens, refilled at `ratePerS`. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    public capacity: number,
    public ratePerS: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.at = now;
  }

  private refill(now: number): void {
    if (now > this.at) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.ratePerS);
      this.at = now;
    }
  }

  /** Take `n` tokens if there are enough. */
  take(now: number, n = 1): boolean {
    this.refill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Take `n` tokens even when it goes negative (priority traffic still counts). */
  force(now: number, n: number): void {
    this.refill(now);
    this.tokens -= n;
  }

  /** Give back tokens taken provisionally (a message that then failed validation). */
  refund(n = 1): void {
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  /** Milliseconds until `n` tokens are available. */
  waitMs(now: number, n = 1): number {
    this.refill(now);
    if (this.tokens >= n || this.ratePerS <= 0) return 0;
    return Math.ceil(((n - this.tokens) / this.ratePerS) * 1000);
  }
}

/**
 * Buckets keyed by a string (device, IP), with the oldest entries evicted beyond `max` (Map keeps
 * insertion order; a hit moves the key to the end).
 */
export class KeyedBuckets<T> {
  private readonly map = new Map<string, T>();

  constructor(
    private readonly max: number,
    private readonly create: () => T,
  ) {}

  get(key: string): T {
    let v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    v = this.create();
    this.map.set(key, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return v;
  }

  peek(key: string): T | undefined {
    return this.map.get(key);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Per-viewer pacing: slow mode (minimum interval) plus the hard burst bucket. */
export interface ViewerPace {
  /** Last accepted message (ms). */
  lastAt: number;
  burst: TokenBucket;
  /** Last accepted GIF (ms). */
  lastGifAt: number;
}

/**
 * Time-windowed counter (accepted, offered, rejected…): events per second over the last
 * `windowMs`, in 1-second buckets (bounded memory).
 */
export class RateWindow {
  private readonly buckets: number[];
  private readonly seconds: number;
  private head = 0;
  private headSec = 0;

  constructor(windowMs: number) {
    this.seconds = Math.max(1, Math.round(windowMs / 1000));
    this.buckets = new Array<number>(this.seconds).fill(0);
  }

  private advance(now: number): void {
    const sec = Math.floor(now / 1000);
    if (this.headSec === 0) this.headSec = sec;
    const steps = Math.min(this.seconds, sec - this.headSec);
    for (let i = 0; i < steps; i++) {
      this.head = (this.head + 1) % this.seconds;
      this.buckets[this.head] = 0;
    }
    if (sec > this.headSec) this.headSec = sec;
  }

  add(now: number, n = 1): void {
    this.advance(now);
    this.buckets[this.head]! += n;
  }

  total(now: number): number {
    this.advance(now);
    let t = 0;
    for (const b of this.buckets) t += b;
    return t;
  }

  perSecond(now: number): number {
    return this.total(now) / this.seconds;
  }

  reset(): void {
    this.buckets.fill(0);
    this.headSec = 0;
  }
}
