import type { ChatProtect } from '@swarmcast/shared';
import type { MessageKey } from '@swarmcast/shared/i18n';
import { RateWindow } from './buckets.js';

export type ChatThreat = 0 | 1 | 2; // normal, suspicious, attack

/** Seconds a level must hold before the state escalates. */
const ESCALATE_AFTER_S = 3;
/** Calm seconds before stepping down one level. */
const CALM_STEP_DOWN_S = 120;
/** A sender who joined less than this ago counts as new. */
const NEW_SENDER_MS = 2 * 60_000;
/** Distinct keys tracked per 10 s window for the duplicate signal. */
const MAX_KEYS = 2000;

interface Window10 {
  startedAt: number;
  messages: number;
  keys: Map<string, Set<string>>;
  senders: Map<string, boolean>;
}

/**
 * Automatic flood detection for the chat (plan §6.3), on the pattern of the attack detector:
 * rolling 10 s windows, an EWMA baseline that learns only while calm, absolute and per-viewer
 * floors, 3 s to escalate and 2 calm minutes to step down.
 */
export class ChatDetector {
  level: ChatThreat = 0;
  reason?: MessageKey;
  private readonly offered = new RateWindow(10_000);
  private readonly rejects = new RateWindow(10_000);
  private readonly terminations = new RateWindow(10_000);
  private win: Window10 = { startedAt: 0, messages: 0, keys: new Map(), senders: new Map() };
  private last: Window10 | null = null;
  private baseline = 0;
  private pending: ChatThreat = 0;
  private pendingFor = 0;
  private calmFor = 0;

  frame(now: number): void {
    this.offered.add(now);
  }

  /** A refused message (`slow` from honest viewers retrying is not counted). */
  reject(now: number, code: string): void {
    if (code !== 'chat.err.slow') this.rejects.add(now);
  }

  terminated(now: number): void {
    this.terminations.add(now);
  }

  accepted(now: number, sender: string, key: string, joinedAt: number): void {
    this.rotate(now);
    this.win.messages++;
    let set = this.win.keys.get(key);
    if (!set && this.win.keys.size < MAX_KEYS) this.win.keys.set(key, (set = new Set()));
    set?.add(sender);
    this.win.senders.set(sender, now - joinedAt < NEW_SENDER_MS);
  }

  private rotate(now: number): void {
    if (now - this.win.startedAt < 10_000) return;
    this.last = this.win;
    this.win = { startedAt: now, messages: 0, keys: new Map(), senders: new Map() };
  }

  /** Signal levels right now; `viewers`: connected viewers. */
  signals(now: number, viewers: number): { level: ChatThreat; reason?: MessageKey } {
    this.rotate(now);
    // Early in a window, the previous one tells more (whichever saw more messages).
    const w = this.last && now - this.win.startedAt < 5000 && this.last.messages > this.win.messages ? this.last : this.win;
    const offered = this.offered.perSecond(now);
    const rejects = this.rejects.perSecond(now);
    const terms = this.terminations.total(now);
    let dupMessages = 0;
    for (const set of w.keys.values()) if (set.size >= 5) dupMessages += set.size;
    const dupRatio = w.messages > 0 ? dupMessages / w.messages : 0;
    let fresh = 0;
    for (const isNew of w.senders.values()) if (isNew) fresh++;
    const senders = w.senders.size;
    const newRatio = senders > 0 ? fresh / senders : 0;

    let level: ChatThreat = 0;
    const raise = (l: ChatThreat): void => {
      if (l > level) level = l;
    };
    if (offered >= Math.max(20, 0.3 * viewers, 8 * this.baseline)) raise(2);
    else if (offered >= Math.max(5, 0.1 * viewers, 4 * this.baseline)) raise(1);
    if (rejects >= Math.max(10, 0.1 * viewers)) raise(2);
    else if (rejects >= Math.max(2, 0.03 * viewers)) raise(1);
    if (dupRatio > 0.6 && w.messages >= 10) raise(2);
    else if (dupRatio > 0.3 && w.messages >= 10) raise(1);
    if (newRatio > 0.8 && senders >= 20) raise(2);
    else if (newRatio > 0.5 && senders >= 10) raise(1);
    if (terms >= 5) raise(2);
    else if (terms >= 1) raise(1);
    if (level === 0) this.baseline = this.baseline === 0 ? offered : this.baseline + 0.05 * (offered - this.baseline);
    return { level, reason: level > 0 ? 'chat.protect.reason.flood' : undefined };
  }

  /** Once a second: escalate after 3 s, step down after 2 calm minutes. Returns true on a change. */
  tick(now: number, viewers: number): boolean {
    const { level, reason } = this.signals(now, viewers);
    const before = this.level;
    if (level > this.level) {
      if (level === this.pending) this.pendingFor++;
      else {
        this.pending = level;
        this.pendingFor = 1;
      }
      if (this.pendingFor >= ESCALATE_AFTER_S) {
        this.level = level;
        this.reason = reason;
        this.calmFor = 0;
      }
    } else {
      this.pending = level;
      this.pendingFor = 0;
    }
    if (level < this.level) {
      if (++this.calmFor >= CALM_STEP_DOWN_S) {
        this.level = (this.level - 1) as ChatThreat;
        this.calmFor = 0;
        if (this.level === 0) this.reason = undefined;
      }
    } else this.calmFor = 0;
    return this.level !== before;
  }

  reset(): void {
    this.level = 0;
    this.reason = undefined;
    this.pending = 0;
    this.pendingFor = 0;
    this.calmFor = 0;
    this.baseline = 0;
    this.offered.reset();
    this.rejects.reset();
    this.terminations.reset();
    this.win = { startedAt: 0, messages: 0, keys: new Map(), senders: new Map() };
    this.last = null;
  }
}

/**
 * Adaptive slow mode (plan §6.2): every 5 s, raise the automatic interval at once when the chat
 * is busy for the global limit G, and halve it after 60 calm seconds (off below 5 s).
 */
export class AdaptiveSlowMode {
  autoSlowS = 0;
  private readonly accepted = new RateWindow(10_000);
  private readonly offered = new RateWindow(10_000);
  private readonly senders = new Map<string, number>();
  private calmSince = 0;

  offer(now: number): void {
    this.offered.add(now);
  }

  accept(now: number, sender: string): void {
    this.accepted.add(now);
    this.senders.delete(sender);
    this.senders.set(sender, now);
    if (this.senders.size > 5000) this.senders.delete(this.senders.keys().next().value!);
  }

  /** Distinct senders in the last 60 s. */
  activeSenders(now: number): number {
    for (const [k, at] of this.senders) {
      if (now - at <= 60_000) break;
      this.senders.delete(k);
    }
    return this.senders.size;
  }

  /** Evaluate with the current global limit G (msg/s). Returns true when autoSlowS changed. */
  evaluate(now: number, g: number): boolean {
    const before = this.autoSlowS;
    const r = this.accepted.perSecond(now);
    const o = this.offered.perSecond(now);
    if (r >= 0.8 * g || o >= 1.5 * g) {
      const a = this.activeSenders(now);
      this.autoSlowS = Math.max(this.autoSlowS, Math.min(120, Math.max(5, Math.ceil(a / Math.max(g, 0.1)))));
      this.calmSince = 0;
    } else if (r < 0.4 * g) {
      if (this.calmSince === 0) this.calmSince = now;
      if (this.autoSlowS > 0 && now - this.calmSince >= 60_000) {
        this.autoSlowS = Math.floor(this.autoSlowS / 2);
        if (this.autoSlowS < 5) this.autoSlowS = 0;
        this.calmSince = now;
      }
    } else this.calmSince = 0;
    return this.autoSlowS !== before;
  }

  reset(): void {
    this.autoSlowS = 0;
    this.accepted.reset();
    this.offered.reset();
    this.senders.clear();
    this.calmSince = 0;
  }
}

/** Protection state from the detector, the attack shield and the streamer (manual wins). */
export function protectState(detector: ChatThreat, shield: ChatThreat, manual: ChatProtect | null, auto: boolean): ChatProtect {
  if (manual) return manual;
  if (!auto) return 'off';
  const l = Math.max(detector, shield);
  return l === 2 ? 'lockdown' : l === 1 ? 'slow' : 'off';
}
