import { DEFAULT_NEED_S, MAX_NEED_S } from './throttle.js';

/**
 * How soon a viewer needs a segment (docs/QUALITY.md "Upload order"). The watch page sends
 * `X-SC-Need: <seconds>` with every segment request: the segment's start minus the playhead, 0
 * before the first picture. The upload limiter serves the soonest need first, so when many people
 * join at once (or the uplink is full) the ones about to run out of video, and the newcomers
 * waiting for their first picture, go before the ones only filling their buffer far ahead.
 *
 * Nothing a viewer says is trusted beyond its own requests: a page that always claims 0 s gets its
 * urgent order only within a budget (UrgencyBudget), and after that waits like everyone else.
 */
export const NEED_HEADER = 'x-sc-need';

/** A need below this many seconds is urgent: it goes before almost everything else. */
export const URGENT_S = 4;
/** The window of the per-viewer urgency budget, ms. */
export const URGENT_WINDOW_MS = 10_000;
/** Bytes every viewer may get urgently per window, at least: a first picture at 1080p (init + 2 segments). */
export const URGENT_FLOOR_BYTES = 3 * 1024 * 1024;
/** …or this many fair shares of the upload cap over the window, when that is more. */
export const URGENT_FAIR_SHARES = 3;

/** Seconds from an X-SC-Need header, or undefined when absent or not a number (0…MAX_NEED_S). */
export function parseNeed(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3})?$/.test(value)) return undefined;
  return Math.min(MAX_NEED_S, Number(value));
}

export interface UrgencyBudgetOptions {
  /** What video may use now, bytes per second (the upload cap minus the chat's reserve). */
  capBytesPerS: () => number;
  /** Viewers sharing it. */
  viewers: () => number;
  now?: () => number;
}

/**
 * Per-viewer bound on urgent bytes, so that one page claiming "I need it now" for every request
 * cannot keep everyone else waiting: urgent needs count against max(URGENT_FLOOR_BYTES,
 * URGENT_FAIR_SHARES × its fair share of the cap) per URGENT_WINDOW_MS; past that, its requests
 * are scheduled at DEFAULT_NEED_S, the order of a request that says nothing.
 */
export class UrgencyBudget {
  private used = new Map<string, { at: number; bytes: number }>();
  private readonly now: () => number;

  constructor(private readonly o: UrgencyBudgetOptions) {
    this.now = o.now ?? Date.now;
  }

  /** The need to schedule `bytes` for `viewer` with, given what its page `asked` for (seconds). */
  needFor(viewer: string, asked: number | undefined, bytes: number): number {
    if (asked === undefined) return DEFAULT_NEED_S;
    if (asked >= URGENT_S) return asked;
    const now = this.now();
    let u = this.used.get(viewer);
    if (!u || now - u.at >= URGENT_WINDOW_MS) {
      if (this.used.size > 2 * this.o.viewers() + 16) this.prune(now);
      u = { at: now, bytes: 0 };
      this.used.set(viewer, u);
    }
    const fair = (this.o.capBytesPerS() * (URGENT_WINDOW_MS / 1000)) / Math.max(1, this.o.viewers());
    if (u.bytes + bytes > Math.max(URGENT_FLOOR_BYTES, URGENT_FAIR_SHARES * fair)) return DEFAULT_NEED_S;
    u.bytes += bytes;
    return asked;
  }

  private prune(now: number): void {
    for (const [k, u] of this.used) if (now - u.at >= URGENT_WINDOW_MS) this.used.delete(k);
  }
}
