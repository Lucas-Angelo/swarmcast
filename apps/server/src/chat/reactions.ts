import { CHAT_REACT_BROADCAST_MAX_PER_KIND, CHAT_REACTIONS, type ChatReactionsItem } from '@swarmcast/shared';
import { RateWindow } from './buckets.js';

/** The counts of one aggregation window: capped for viewers (`c`), as taken for the panel (`raw`). */
export interface ReactionWindow {
  c: number[];
  raw: number[];
}

/**
 * Reactions over the video, added up (docs/CHAT.md, "Reactions"). Every accepted tap only bumps a
 * counter of its kind, so a storm of taps costs one small array, never one object per tap; once
 * per window the hub takes the counts and sends them to everyone as one ephemeral `rx` item, each
 * count capped at CHAT_REACT_BROADCAST_MAX_PER_KIND (a page draws a handful of floaters per window
 * anyway). Pure: the clock is passed in, nothing is sent from here.
 */
export class ReactionTally {
  private acc: number[] = CHAT_REACTIONS.map(() => 0);
  private pending = false;
  /** Taps per kind over the last minute, for the panel's tally. */
  private readonly minute = CHAT_REACTIONS.map(() => new RateWindow(60_000));

  /** Add accepted taps (`counts[i]` of CHAT_REACTIONS[i]; missing kinds count 0). */
  add(counts: readonly number[], now: number): void {
    for (let i = 0; i < this.acc.length; i++) {
      const n = counts[i] ?? 0;
      if (!(n > 0)) continue;
      this.acc[i]! += n;
      this.minute[i]!.add(now, n);
      this.pending = true;
    }
  }

  /** Some taps wait for the next window. */
  get hasPending(): boolean {
    return this.pending;
  }

  /** The counts since the last call, or null when there were none; the counter starts again at 0. */
  take(): ReactionWindow | null {
    if (!this.pending) return null;
    const raw = this.acc;
    this.acc = CHAT_REACTIONS.map(() => 0);
    this.pending = false;
    return { raw, c: raw.map((n) => Math.min(n, CHAT_REACT_BROADCAST_MAX_PER_KIND)) };
  }

  /** Taps per kind over the last minute. */
  lastMinute(now: number): number[] {
    return this.minute.map((w) => w.total(now));
  }

  /** Forget everything (Stop). */
  reset(): void {
    this.acc = CHAT_REACTIONS.map(() => 0);
    this.pending = false;
    for (const w of this.minute) w.reset();
  }
}

/**
 * Folds a newer `rx` into one still waiting for the batch (ChatBatcher.pushLatest): the counts add
 * up, each still capped at CHAT_REACT_BROADCAST_MAX_PER_KIND, so a batch held back by the upload
 * budget never carries more than one window's worth per kind.
 */
export function mergeReactions(pending: ChatReactionsItem, next: ChatReactionsItem): ChatReactionsItem {
  const len = Math.max(pending.c.length, next.c.length);
  const c: number[] = [];
  for (let i = 0; i < len; i++) c.push(Math.min(CHAT_REACT_BROADCAST_MAX_PER_KIND, (pending.c[i] ?? 0) + (next.c[i] ?? 0)));
  return { k: 'rx', c };
}

/**
 * How many taps of each kind a frame may have taken (`want`), given `allowed` taps in all (the
 * smaller of the device's and the address's buckets): kinds in order until the allowance runs out.
 */
export function allowTaps(want: readonly number[], allowed: number): { take: number[]; n: number } {
  const take = CHAT_REACTIONS.map(() => 0);
  let n = 0;
  for (let i = 0; i < take.length && n < allowed; i++) {
    const k = Math.min(Math.max(0, Math.floor(want[i] ?? 0)), allowed - n);
    take[i] = k;
    n += k;
  }
  return { take, n };
}
