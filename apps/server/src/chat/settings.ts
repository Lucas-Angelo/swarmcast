import type { ChatContentKind, ChatProtect, ChatPublicSettings, ChatSettings } from '@swarmcast/shared';
import type { GuardState } from './guard.js';

/** What protection changes (plan §6.3). */
const SLOW = { slowS: 10, newViewerWaitS: 60, history: 20 } as const;
const LOCKDOWN = { slowS: 30, history: 0, presentMs: 2 * 60_000 } as const;

export interface EffectiveChat {
  /** Sent to viewers. */
  public: ChatPublicSettings;
  /** Chat accepts messages at all (on and not stopped by errors). */
  enabled: boolean;
  slowS: number;
  newViewerWaitS: number;
  historyOnJoin: number;
  gifs: boolean;
  /** Lockdown: only sessions present before the alert began, for at least 2 minutes, may write. */
  lockdown: boolean;
  lockdownPresentMs: number;
}

export interface EffectiveInputs {
  settings: ChatSettings;
  protect: ChatProtect;
  autoSlowS: number;
  guard: GuardState;
  broken: boolean;
}

/** Manual settings + automatic protection + the event-loop guard → what applies right now. */
export function effectiveChat(i: EffectiveInputs): EffectiveChat {
  const s = i.settings;
  const enabled = s.enabled && !i.broken;
  let slowS = Math.max(s.slowModeS, i.autoSlowS);
  let newViewerWaitS = s.newViewerWaitS;
  let historyOnJoin = s.historyOnJoin;
  let gifs = s.content.gifs && s.gif.key !== '';
  if (i.protect === 'slow') {
    slowS = Math.max(slowS, SLOW.slowS);
    newViewerWaitS = Math.max(newViewerWaitS, SLOW.newViewerWaitS);
    historyOnJoin = Math.min(historyOnJoin, SLOW.history);
    gifs = false;
  } else if (i.protect === 'lockdown') {
    slowS = Math.max(slowS, LOCKDOWN.slowS);
    historyOnJoin = LOCKDOWN.history;
    gifs = false;
  }
  if (i.guard !== 'ok') gifs = false;
  const content: ChatContentKind[] = [];
  if (s.content.text) content.push('text');
  if (s.content.emotes) content.push('emotes');
  if (s.content.gifs) content.push('gifs');
  const pub: ChatPublicSettings = {
    enabled,
    content,
    slowS,
    autoSlow: slowS > s.slowModeS,
    maxGraphemes: s.maxGraphemes,
    maxEmoji: s.maxEmoji,
    newViewerWaitS,
    colors: s.viewerColors ? 'choose' : 'fixed',
    linksBlocked: s.links === 'block',
    ...(gifs ? { gif: { provider: s.gif.provider, key: s.gif.key, rating: s.gif.rating, consent: s.gif.consent } } : {}),
    emotes: [],
    builtinEmotes: s.emotes.builtin,
    protect: i.protect,
    streamerName: s.streamerName,
  };
  return { public: pub, enabled, slowS, newViewerWaitS, historyOnJoin, gifs, lockdown: i.protect === 'lockdown', lockdownPresentMs: LOCKDOWN.presentMs };
}

/** Coalesces settings pushes to at most one per `intervalMs` (the last state wins). */
export class Coalescer {
  private timer: NodeJS.Timeout | null = null;
  private lastAt = 0;

  constructor(
    private readonly run: () => void,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  request(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastAt + this.intervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastAt = this.now();
      this.run();
    }, wait);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
