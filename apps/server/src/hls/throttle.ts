import { Readable } from 'node:stream';

/**
 * Global token-bucket limiter for everything the origin uploads.
 * One instance is shared by all viewers so the configured cap is a hard global ceiling.
 */
export class BandwidthLimiter {
  private tokens: number;
  private last: number;
  private queue: Array<{ bytes: number; resolve: () => void; reject: (e: Error) => void }> = [];
  private timer: NodeJS.Timeout | null = null;
  private windowBytes = 0;
  private windowStart: number;
  private lastRateBps = 0;
  /** Last time a request had to wait for tokens (the cap was the bottleneck). */
  private lastThrottledAt = Number.NEGATIVE_INFINITY;
  /** Upload kept for the chat (bytes/s), taken off the cap: video + chat stay within it. */
  private reserveBps = 0;

  constructor(
    private bytesPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = this.burst;
    this.last = this.now();
    this.windowStart = this.last;
  }

  static fromMbps(mbps: number): BandwidthLimiter {
    return new BandwidthLimiter((mbps * 1_000_000) / 8);
  }

  /** Rate video may use: the cap minus the chat's reserve, never below half the cap. */
  private get rate(): number {
    return Math.max(this.bytesPerSecond / 2, this.bytesPerSecond - this.reserveBps);
  }

  /** Burst allowance: 250 ms worth of traffic. */
  private get burst(): number {
    return Math.max(16 * 1024, this.rate / 4);
  }

  /**
   * Upload the chat is using right now (docs/CHAT.md, "chat cannot degrade video"): the video
   * gets the cap minus this. `mbps` keeps reporting the cap itself.
   */
  setReserveMbps(mbps: number): void {
    const bps = Math.max(0, (mbps * 1_000_000) / 8);
    if (Math.abs(bps - this.reserveBps) < 1) return;
    this.refill();
    this.reserveBps = bps;
    this.tokens = Math.min(this.tokens, this.burst);
    this.pump();
  }

  /** The chat's reserve, Mbps. */
  get reserveMbps(): number {
    return (this.reserveBps * 8) / 1_000_000;
  }

  /** What video may use now, Mbps: the cap minus the chat's reserve, never below half the cap. */
  get videoMbps(): number {
    return (this.rate * 8) / 1_000_000;
  }

  setMbps(mbps: number): void {
    this.refill();
    this.bytesPerSecond = (mbps * 1_000_000) / 8;
    this.tokens = Math.min(this.tokens, this.burst);
    this.pump();
  }

  get mbps(): number {
    return (this.bytesPerSecond * 8) / 1_000_000;
  }

  /** Measured outgoing rate (Mbps) over the last ~2 s window. */
  currentMbps(): number {
    const t = this.now();
    const elapsed = t - this.windowStart;
    if (elapsed >= 2000) {
      this.lastRateBps = (this.windowBytes * 1000) / elapsed;
      this.windowBytes = 0;
      this.windowStart = t;
    }
    return (this.lastRateBps * 8) / 1_000_000;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  /** Wait until `bytes` may be sent. Requests are served in FIFO order. */
  take(bytes: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) return;
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      // Large chunks may exceed the burst; let them through once the bucket is full.
      const need = Math.min(head.bytes, this.burst);
      if (this.tokens < need) break;
      this.tokens -= head.bytes;
      this.windowBytes += head.bytes;
      this.queue.shift();
      head.resolve();
    }
    if (this.queue.length > 0) {
      this.lastThrottledAt = this.now();
      const head = this.queue[0]!;
      const need = Math.min(head.bytes, this.burst) - this.tokens;
      const waitMs = Math.max(1, (need / this.rate) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, waitMs);
    }
  }

  /** True when viewers wanted more than the cap at some point in the last `ms` milliseconds. */
  throttledWithin(ms: number): boolean {
    return this.queue.length > 0 || this.now() - this.lastThrottledAt <= ms;
  }

  /** Reject pending waiters (used on shutdown). */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.queue.splice(0)) w.reject(new Error('limiter closed'));
  }

  /** Stream a buffer through the limiter in small chunks. */
  stream(data: Buffer, chunkSize = 16 * 1024): Readable {
    let offset = 0;
    let reading = false;
    const readable = new Readable({
      read: () => {
        if (reading) return;
        reading = true;
        const next = (): void => {
          if (offset >= data.length) {
            readable.push(null);
            return;
          }
          const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
          this.take(chunk.length).then(
            () => {
              offset += chunk.length;
              reading = false;
              if (readable.push(chunk)) {
                reading = true;
                next();
              }
            },
            (err: Error) => readable.destroy(err),
          );
        };
        next();
      },
    });
    return readable;
  }
}
