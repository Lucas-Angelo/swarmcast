// Reactions over the video (docs/CHAT.md, "Reactions"). A viewer taps one of the bee emotes; it
// floats up over the video for a moment for everyone. Three parts, each testable on its own:
//
// - ReactionSender: the page's side of the wire. The first tap goes at once, the taps after it
//   together, at most one `chat.react` frame per CHAT_REACT_FRAME_MS (well inside the socket's own
//   reaction budget, so tapping never costs the socket), at most CHAT_REACT_PER_FRAME_MAX taps per
//   frame, and the same tap bucket as the server, so a tap the page draws is a tap the server takes.
//   It remembers its own taps for a few seconds and takes them off the next counts from the server,
//   so a viewer does not see their own reaction twice.
// - ReactionLayer: what is drawn inside the player (so it shows in full screen too). At most
//   CHAT_FLOATERS_SPAWN_PER_WINDOW floaters per window, sampled by the counts, at most
//   CHAT_FLOATERS_MAX on screen, nothing while the tab is hidden (no backlog), only transform and
//   opacity animated. With "reduce motion" nothing moves: a calm counter per kind in the corner
//   counts up in place instead and goes away after a few quiet seconds. Images from our own origin
//   (the built-in emotes), never text; decorative for screen readers (the list stays the chat).
// - createReactPicker: the React button and its eight named buttons (keyboard: arrows, Home, End,
//   Escape), staying open for more taps.
import './reactions.css';
import { t, type MessageKey } from '@swarmcast/shared/i18n';
import { CHAT_FLOATERS_MAX, CHAT_FLOATERS_SPAWN_PER_WINDOW, CHAT_REACT_BURST, CHAT_REACT_FRAME_MS, CHAT_REACT_PER_FRAME_MAX, CHAT_REACT_REFILL_PER_S, CHAT_REACTIONS, type ChatReactionCode } from './core/index.js';
import { BUILTIN_EMOTES, type Emote } from './emotes.js';
import { createPopover, type Popover } from './popover.js';

/** Each reaction's name, for its button (aria-label and tooltip). */
const NAME_KEYS: Record<ChatReactionCode, MessageKey> = {
  love: 'chat.react.love',
  hype: 'chat.react.hype',
  lol: 'chat.react.lol',
  wow: 'chat.react.wow',
  gg: 'chat.react.gg',
  fire: 'chat.react.fire',
  sad: 'chat.react.sad',
  hi: 'chat.react.hi',
};

/** The translated name of reaction `i`. */
export function reactionName(i: number): string {
  const code = CHAT_REACTIONS[i];
  return code ? t(NAME_KEYS[code]) : '';
}

/** The built-in emote drawn for reaction `i`. */
export function reactionEmote(i: number): Emote | undefined {
  const code = CHAT_REACTIONS[i];
  return BUILTIN_EMOTES.find((e) => e.code === code);
}

/** A page's own taps are taken off the server's counts for this long (the window, the batch and the trip there and back). */
export const OWN_ECHO_MS = 6000;
/** With "reduce motion", the counter of a kind stays this long after its last reaction. */
export const CALM_COUNTER_MS = 4000;

const zeros = (): number[] => CHAT_REACTIONS.map(() => 0);
/** A count as a whole number of taps (anything else is none). */
const tapsOf = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/**
 * The kinds to float for one window's counts: at most `max`, every kind that came at least once
 * while there is room, the rest shared by the counts (largest remainder), in a random order.
 */
export function sampleFloaters(c: readonly number[], max: number, rand: () => number = Math.random): number[] {
  const counts = CHAT_REACTIONS.map((_, i) => tapsOf(c[i]));
  const total = counts.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  if (total <= max) counts.forEach((n, i) => out.push(...Array<number>(n).fill(i)));
  else {
    const kinds = counts.map((n, i) => ({ n, i })).filter((k) => k.n > 0);
    // One of each kind first (the most frequent kinds when there are more kinds than room).
    kinds.sort((a, b) => b.n - a.n);
    const first = kinds.slice(0, max);
    for (const k of first) out.push(k.i);
    const room = max - out.length;
    if (room > 0 && first.some((k) => k.n > 1)) {
      const rest = first.map((k) => ({ i: k.i, n: k.n - 1 }));
      const left = rest.reduce((a, k) => a + k.n, 0);
      const shares = rest.map((k) => ({ i: k.i, exact: (k.n * room) / left }));
      let given = 0;
      for (const s of shares) {
        const whole = Math.floor(s.exact);
        out.push(...Array<number>(whole).fill(s.i));
        given += whole;
      }
      shares.sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)));
      for (let j = 0; j < room - given; j++) out.push(shares[j % shares.length]!.i);
    }
  }
  for (let j = out.length - 1; j > 0; j--) {
    const k = Math.floor(rand() * (j + 1));
    [out[j], out[k]] = [out[k]!, out[j]!];
  }
  return out;
}

export interface SenderDeps {
  /** Sends one frame's counts (`c[i]` taps of CHAT_REACTIONS[i]); false when it could not go (no socket). */
  send(c: number[]): boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The page's side of the wire: one frame per CHAT_REACT_FRAME_MS at most, the server's tap bucket, its own taps remembered. */
export class ReactionSender {
  private pending = zeros();
  private pendingTotal = 0;
  private lastSentAt = -Infinity;
  private timer: unknown = null;
  private tokens = CHAT_REACT_BURST;
  private tokensAt: number;
  private readonly own: Array<{ at: number; c: number[] }> = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly d: SenderDeps) {
    this.now = d.now ?? (() => Date.now());
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.tokensAt = this.now();
  }

  /** A tap on reaction `i`: true when it was taken (the page draws it), false when the bucket or the frame is full. */
  tap(i: number): boolean {
    if (!(i >= 0 && i < CHAT_REACTIONS.length)) return false;
    const now = this.now();
    this.tokens = Math.min(CHAT_REACT_BURST, this.tokens + ((now - this.tokensAt) / 1000) * CHAT_REACT_REFILL_PER_S);
    this.tokensAt = now;
    if (this.tokens < 1 || this.pendingTotal >= CHAT_REACT_PER_FRAME_MAX) return false;
    this.tokens -= 1;
    this.pending[i]!++;
    this.pendingTotal++;
    const wait = this.lastSentAt + CHAT_REACT_FRAME_MS - now;
    if (wait <= 0 && this.timer === null) this.flush();
    else if (this.timer === null)
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, wait);
    return true;
  }

  /** Sends what waits now (also the timer's job). */
  flush(): void {
    if (this.pendingTotal === 0) return;
    const c = this.pending;
    // Trailing zeros are left out: the server reads a missing kind as 0.
    let len = c.length;
    while (len > 1 && c[len - 1] === 0) len--;
    const now = this.now();
    if (this.d.send(c.slice(0, len))) {
      this.lastSentAt = now;
      this.own.push({ at: now, c });
    }
    this.pending = zeros();
    this.pendingTotal = 0;
  }

  /** The server's counts without this page's own taps of the last OWN_ECHO_MS (taken off once). */
  others(c: readonly number[]): number[] {
    const now = this.now();
    while (this.own.length && now - this.own[0]!.at > OWN_ECHO_MS) this.own.shift();
    const out = CHAT_REACTIONS.map((_, i) => Math.max(0, c[i] ?? 0));
    for (const o of this.own) {
      for (let i = 0; i < out.length; i++) {
        const k = Math.min(out[i]!, o.c[i]!);
        out[i]! -= k;
        o.c[i]! -= k;
      }
    }
    return out;
  }

  /** Forget the taps waiting (reactions turned off, the socket closed). */
  reset(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = zeros();
    this.pendingTotal = 0;
  }
}

export interface LayerDeps {
  /** "Reduce motion" is asked for now: a calm counter instead of floaters. */
  reduced(): boolean;
  /** The tab is visible (nothing is drawn while it is not, so nothing piles up). */
  pageVisible(): boolean;
  rand?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** What is drawn over the video: floaters, or with "reduce motion" a counter per kind. */
export class ReactionLayer {
  readonly root: HTMLDivElement;
  private readonly tally: HTMLDivElement;
  private readonly chips = new Map<number, { el: HTMLElement; count: HTMLElement; n: number }>();
  private calmTimer: unknown = null;
  private on = false;
  private live = 0;
  /** Floaters started since the page opened (tests, stats). */
  spawned = 0;
  /** The most floaters on screen at once since the page opened (tests, stats). */
  peak = 0;
  private readonly rand: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(
    private readonly player: HTMLElement,
    private readonly d: LayerDeps,
  ) {
    this.rand = d.rand ?? Math.random;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.root = document.createElement('div');
    this.root.className = 'rx-layer';
    this.root.dataset.testid = 'reactions';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.hidden = true;
    this.tally = document.createElement('div');
    this.tally.className = 'rx-tally';
    this.tally.dataset.testid = 'reactions-tally';
    this.tally.hidden = true;
    this.root.append(this.tally);
    // Right over the picture, under the player's controls (they come later in the player).
    const video = player.querySelector('video');
    player.insertBefore(this.root, video ? video.nextSibling : player.firstChild);
  }

  /** Floaters on screen now. */
  get alive(): number {
    return this.live;
  }

  /** Draw reactions at all (the viewer's choice, the chat on and shown); off clears the layer. */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.root.hidden = !on;
    if (!on) this.clear();
  }

  /** One window's counts (`c[i]` of CHAT_REACTIONS[i]), or the page's own tap. */
  show(c: readonly number[]): void {
    if (!this.on || !this.d.pageVisible()) return;
    if (this.d.reduced()) return this.count(c);
    const kinds = sampleFloaters(c, CHAT_FLOATERS_SPAWN_PER_WINDOW, this.rand);
    if (kinds.length === 0) return;
    // One read of the player's height per window: how far the floaters rise.
    const rise = Math.max(80, Math.round(this.player.clientHeight * 0.55));
    kinds.forEach((i, j) => this.float(i, rise, j));
  }

  private float(i: number, rise: number, order: number): void {
    if (this.live >= CHAT_FLOATERS_MAX) return;
    const emote = reactionEmote(i);
    if (!emote) return;
    const img = document.createElement('img');
    img.className = 'rx-float';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.src = emote.url;
    if (emote.url2x) img.srcset = `${emote.url} 1x, ${emote.url2x} 2x`;
    const dur = 2400 + Math.round(this.rand() * 1000);
    // CSSOM custom properties (the CSP allows them, never a style attribute): where it starts,
    // how long it takes, how far it sways and rises, and a small stagger inside one window.
    img.style.setProperty('--rx-x', `${(4 + this.rand() * 18).toFixed(1)}%`);
    img.style.setProperty('--rx-sway', `${Math.round((this.rand() - 0.5) * 48)}px`);
    img.style.setProperty('--rx-rise', `${rise}px`);
    img.style.setProperty('--rx-dur', `${dur}ms`);
    img.style.setProperty('--rx-delay', `${Math.min(order, 7) * 90}ms`);
    this.live++;
    this.spawned++;
    this.peak = Math.max(this.peak, this.live);
    let done = false;
    const remove = (): void => {
      if (done) return;
      done = true;
      this.live--;
      img.remove();
    };
    img.addEventListener('animationend', remove);
    // The end of the animation, or this (an engine that skips it, a tab put away mid-flight).
    this.setTimer(remove, dur + Math.min(order, 7) * 90 + 500);
    this.root.append(img);
  }

  /** "Reduce motion": each kind's counter counts up in place; all of them go after CALM_COUNTER_MS without reactions. */
  private count(c: readonly number[]): void {
    let any = false;
    CHAT_REACTIONS.forEach((_, i) => {
      const n = tapsOf(c[i]);
      if (n === 0) return;
      any = true;
      let chip = this.chips.get(i);
      if (!chip) {
        const el = document.createElement('span');
        el.className = 'rx-chip';
        el.dataset.reaction = CHAT_REACTIONS[i];
        const emote = reactionEmote(i);
        if (emote) {
          const img = document.createElement('img');
          img.alt = '';
          img.src = emote.url;
          el.append(img);
        }
        const count = document.createElement('span');
        count.className = 'rx-count';
        el.append(count);
        chip = { el, count, n: 0 };
        this.chips.set(i, chip);
        // Always in CHAT_REACTIONS order, so a counter never jumps sideways.
        const after = [...this.chips.keys()].filter((k) => k > i).sort((a, b) => a - b)[0];
        this.tally.insertBefore(el, after === undefined ? null : this.chips.get(after)!.el);
      }
      chip.n += n;
      chip.count.textContent = chip.n > 999 ? '999+' : String(chip.n);
    });
    if (!any) return;
    this.tally.hidden = false;
    if (this.calmTimer !== null) this.clearTimer(this.calmTimer);
    this.calmTimer = this.setTimer(() => {
      this.calmTimer = null;
      this.clearTally();
    }, CALM_COUNTER_MS);
  }

  private clearTally(): void {
    for (const chip of this.chips.values()) chip.el.remove();
    this.chips.clear();
    this.tally.hidden = true;
  }

  private clear(): void {
    if (this.calmTimer !== null) this.clearTimer(this.calmTimer);
    this.calmTimer = null;
    this.clearTally();
    for (const el of [...this.root.querySelectorAll('.rx-float')]) el.remove();
    this.live = 0;
  }
}

export interface ReactPicker {
  popover: Popover;
  panel: HTMLElement;
}

/**
 * The React button (a bee in the chat's tools) and its popover of eight named buttons. A tap calls
 * `onTap(i)`; the popover stays open for more taps and closes on Escape, a click outside or the
 * button again. Arrow keys move between the reactions, Home and End go to the first and last.
 */
export function createReactPicker(button: HTMLButtonElement, deps: { onTap(i: number): void }): ReactPicker {
  button.type = 'button';
  button.className = 'chat-tool react-btn';
  button.dataset.testid = 'chat-react-button';
  button.setAttribute('aria-label', t('chat.react.button'));
  button.title = t('chat.react.button.tip');
  const icon = reactionEmote(0);
  if (icon) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = icon.url;
    button.append(img);
  }
  const panel = document.createElement('div');
  panel.className = 'chat-pop chat-react';
  panel.dataset.testid = 'chat-react';
  panel.setAttribute('aria-label', t('chat.react.title'));
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent = t('chat.react.hint');
  const grid = document.createElement('div');
  grid.className = 'react-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', t('chat.react.title'));
  const buttons = CHAT_REACTIONS.map((code, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'react-opt';
    b.dataset.reaction = code;
    b.dataset.testid = 'chat-react-option';
    const name = reactionName(i);
    b.setAttribute('aria-label', name);
    b.title = name;
    const emote = reactionEmote(i);
    if (emote) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = emote.url;
      if (emote.url2x) img.srcset = `${emote.url} 1x, ${emote.url2x} 2x`;
      b.append(img);
    }
    b.addEventListener('click', () => deps.onTap(i));
    return b;
  });
  grid.append(...buttons);
  grid.addEventListener('keydown', (e) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const cols = 4;
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowDown' ? at + cols : e.key === 'ArrowUp' ? at - cols : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, to))]!.focus();
  });
  panel.append(grid, hint);
  const popover = createPopover(button, panel, { onOpen: () => buttons[0]?.focus() });
  return { popover, panel };
}
