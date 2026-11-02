import { Readable } from 'node:stream';

/**
 * Seconds until a response's bytes are needed when nobody says (branding images, a client that
 * sends no X-SC-Need): after what a player needs to keep playing, before what only fills its
 * buffer far ahead. docs/QUALITY.md "Upload order".
 */
export const DEFAULT_NEED_S = 8;
/**
 * Bytes should be there this long before they are needed (one segment's worth): sent exactly at
 * their deadline they arrive a moment late, a short stall each time (surge bench: 26 stalls of
 * 0.1 s in one burst without it).
 */
export const NEED_MARGIN_S = 2;
/** The furthest ahead a need counts: past this, every response is "later" alike. */
export const MAX_NEED_S = 30;
/**
 * The longest a chunk of any response waits while others go first (ms). p2p-media-loader drops a
 * download that receives nothing for 3 s (httpNotReceivingBytesTimeoutMs) and starts it again, so
 * every response keeps getting a chunk at least this often, however low its priority.
 */
export const MAX_CHUNK_WAIT_MS = 1000;

interface Waiter {
  bytes: number;
  /** When the bytes are needed (this.now() ms): the earliest goes first. */
  due: number;
  /** When the chunk joined the queue. */
  since: number;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * Global token-bucket limiter for everything the origin uploads.
 * One instance is shared by all viewers so the configured cap is a hard global ceiling.
 *
 * Order (docs/QUALITY.md "Upload order"): when the cap is the bottleneck, the chunk whose bytes
 * are needed soonest goes first (earliest deadline first), so a viewer about to run out of video,
 * or one waiting for its first picture, is served before one that only fills its buffer far ahead.
 * Equal deadlines share in arrival order (each response has one chunk waiting at a time, so that
 * is round robin), and no chunk waits more than MAX_CHUNK_WAIT_MS while it can be sent.
 */
export class BandwidthLimiter {
  private tokens: number;
  private last: number;
  private queue: Waiter[] = [];
  private seq = 0;

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

  /** Chunks waiting for tokens now. */
  get queued(): number {
    return this.queue.length;
  }

  /** The deadline of bytes needed in `needInS` seconds from now (clamped to 0…MAX_NEED_S), NEED_MARGIN_S earlier. */
  dueIn(needInS: number = DEFAULT_NEED_S): number {
    const s = Number.isFinite(needInS) ? Math.min(MAX_NEED_S, Math.max(0, needInS)) : DEFAULT_NEED_S;
    return this.now() + Math.max(0, s - NEED_MARGIN_S) * 1000;
  }

  /**
   * Wait until `bytes` may be sent. `due` (this clock, ms; see dueIn) orders the waiters: the
   * earliest goes first, equal ones in arrival order.
   */
  take(bytes: number, due: number = this.dueIn()): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, due, since: this.now(), seq: this.seq++, resolve, reject });
      this.pump();
    });
  }

  /** Index of the waiter to serve next: one that waited too long (the longest), else the earliest due. */
  private next(): number {
    const t = this.now();
    let starved = -1;
    let best = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const w = this.queue[i]!;
      if (t - w.since >= MAX_CHUNK_WAIT_MS && (starved < 0 || w.since < this.queue[starved]!.since)) starved = i;
      const b = this.queue[best]!;
      if (w.due < b.due || (w.due === b.due && w.seq < b.seq)) best = i;
    }
    return starved >= 0 ? starved : best;
  }

  private pump(): void {
    if (this.timer) return;
    this.refill();
    while (this.queue.length > 0) {
      const i = this.next();
      const head = this.queue[i]!;
      // Large chunks may exceed the burst; let them through once the bucket is full.
      const need = Math.min(head.bytes, this.burst);
      if (this.tokens < need) break;
      this.tokens -= head.bytes;
      this.windowBytes += head.bytes;
      this.queue.splice(i, 1);
      head.resolve();
    }
    if (this.queue.length > 0) {
      this.lastThrottledAt = this.now();
      const head = this.queue[this.next()]!;
      const need = Math.min(head.bytes, this.burst) - this.tokens;
      // Which chunk goes next is decided when the tokens are there (next()), so a chunk that
      // waited too long meanwhile is not passed over.
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

  /**
   * Stream a buffer through the limiter in small chunks. `needInS`: seconds until the viewer
   * needs these bytes (see take); every chunk keeps the deadline set now.
   */
  stream(data: Buffer, needInS: number = DEFAULT_NEED_S, chunkSize = 16 * 1024): Readable {
    const due = this.dueIn(needInS);
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
          this.take(chunk.length, due).then(
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
