// The chat over the video (docs/CHAT.md, "Chat over the video"): while the player fills the screen
// and the viewer turned it on (overlay-mode.ts, off by default), the latest messages show over the
// bottom left of the picture, above the player's controls, and each one fades after
// CHAT_OVERLAY_FADE_S. A small button opens the chat's own message box there (the same form, moved
// into the overlay and back), so the viewer can write, react and reply without leaving full screen.
//
// - Lines are built by the chat list's own code (ChatList.overlayLine: text nodes, `<bdi>` boxes,
//   the shared invariants), so there is no second renderer to secure; GIFs are left out.
// - Readable on any picture: each line sits on a strong scrim made from the video tokens
//   (OVERLAY_SCRIM of --video-bg), light text on it, and names are made readable against the
//   lightest that scrim can be (over a white picture).
// - It never takes the controls: the overlay sits under the player's bar (DOM order, the same
//   layer), its lines take no click, only its own button and message box do.
// - Decorative for screen readers (`aria-hidden` on the lines): the chat list stays the
//   accessible chat. Reduce motion: lines appear and go without fading.
import './overlay.css';
import { t } from '@swarmcast/shared/i18n';
import { CHAT_OVERLAY_FADE_S, CHAT_OVERLAY_LINES } from './core/index.js';
import type { ChatEntry } from './session.js';

/** Opacity of the video background behind each line (overlay.css `--ov-scrim` must match). */
export const OVERLAY_SCRIM = 0.72;
/** A line starts to fade this long before it goes (the CSS transition's length). */
export const FADE_OUT_MS = 1200;

export interface OverlayDeps {
  player: HTMLElement;
  /** One line for an entry (null: not shown over the video). */
  line(e: ChatEntry): HTMLElement | null;
  /** Moves the message box into `host`, or back to the chat column (null). */
  moveInput(host: HTMLElement | null): void;
  /** Puts the focus in the message box. */
  focusInput(): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

interface Line {
  s: number;
  el: HTMLElement;
  timers: unknown[];
}

export class ChatOverlay {
  readonly root: HTMLDivElement;
  private readonly lines: HTMLDivElement;
  private readonly write: HTMLButtonElement;
  private readonly writeLabel: HTMLSpanElement;
  private readonly inputHost: HTMLDivElement;
  private shown: Line[] = [];
  private on = false;
  private inputOpen = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly d: OverlayDeps) {
    this.now = d.now ?? (() => Date.now());
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.root = document.createElement('div');
    this.root.className = 'chat-overlay';
    this.root.dataset.testid = 'chat-overlay';
    this.root.hidden = true;
    this.lines = document.createElement('div');
    this.lines.className = 'ov-lines';
    this.lines.dataset.testid = 'chat-overlay-lines';
    this.lines.setAttribute('aria-hidden', 'true');
    this.write = document.createElement('button');
    this.write.type = 'button';
    this.write.className = 'ov-write pc-ico-chat';
    this.write.dataset.testid = 'chat-overlay-write';
    this.write.setAttribute('aria-expanded', 'false');
    this.writeLabel = document.createElement('span');
    this.writeLabel.className = 'ov-write-label';
    this.write.append(this.writeLabel);
    this.inputHost = document.createElement('div');
    // `chat`: the message box keeps the chat's own look (surface, sizes) where it is moved.
    this.inputHost.className = 'ov-input chat';
    this.inputHost.dataset.testid = 'chat-overlay-input';
    this.inputHost.hidden = true;
    this.write.addEventListener('click', () => (this.inputOpen ? this.closeInput(true) : this.openInput()));
    this.root.append(this.lines, this.write, this.inputHost);
    this.label();
    // Over the picture and the reactions, under the player's controls (they come later in the player).
    d.player.insertBefore(this.root, d.player.querySelector('.pc'));
  }

  /** It shows now. */
  get active(): boolean {
    return this.on;
  }

  /** The message box is over the video now. */
  get writing(): boolean {
    return this.inputOpen;
  }

  private label(): void {
    const text = t(this.inputOpen ? 'chat.overlay.close' : 'chat.overlay.write');
    this.writeLabel.textContent = text;
    this.write.title = text;
    this.write.setAttribute('aria-expanded', String(this.inputOpen));
  }

  /** Show it (the player fills the screen and the viewer wants it) or hide it; hidden, the message box goes back to the chat. */
  setActive(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.root.hidden = !on;
    if (on) this.place();
    if (!on && this.inputOpen) this.closeInput(false);
  }

  private barWatch: ResizeObserver | null = null;

  /**
   * Just above the player's control bar, whatever its height (taller in full screen, with the
   * phone's safe area): measured, and again whenever the bar changes size. Without ResizeObserver
   * the CSS estimate stays.
   */
  private place(): void {
    const bar = this.d.player.querySelector<HTMLElement>('.pc-bar');
    if (!bar) return;
    const set = (): void => this.root.style.setProperty('--ov-bottom', `${Math.ceil(bar.getBoundingClientRect().height) + 8}px`);
    set();
    if (!this.barWatch && typeof ResizeObserver === 'function') {
      this.barWatch = new ResizeObserver(() => {
        if (this.on) set();
      });
      this.barWatch.observe(bar);
    }
  }

  /**
   * New entries (also while it is hidden, so it has the latest ones when it shows), each for
   * CHAT_OVERLAY_FADE_S. `history`: entries of a snapshot, which only show for what is left of
   * that time since the server got them (a page clock behind the server's shows them the full time).
   */
  add(entries: readonly ChatEntry[], history = false): void {
    const life = CHAT_OVERLAY_FADE_S * 1000;
    const now = this.now();
    for (const e of entries) {
      if (e.kind === 'skip') continue;
      const left = history ? Math.min(life, life - (now - e.at)) : life;
      if (left <= 0) continue;
      const el = this.d.line(e);
      if (!el) continue;
      const line: Line = { s: e.s, el, timers: [] };
      if (left > FADE_OUT_MS) line.timers.push(this.setTimer(() => el.classList.add('ov-old'), left - FADE_OUT_MS));
      else el.classList.add('ov-old');
      line.timers.push(this.setTimer(() => this.drop(line), left));
      this.shown.push(line);
      this.lines.append(el);
    }
    while (this.shown.length > CHAT_OVERLAY_LINES) this.drop(this.shown[0]!);
  }

  private drop(line: Line): void {
    for (const id of line.timers) this.clearTimer(id);
    line.el.remove();
    this.shown = this.shown.filter((l) => l !== line);
  }

  /** Messages deleted by the streamer. */
  remove(seqs: readonly number[]): void {
    for (const l of [...this.shown]) if (seqs.includes(l.s)) this.drop(l);
  }

  /** The chat was cleared up to `s`. */
  clearUpTo(s: number): void {
    for (const l of [...this.shown]) if (l.s <= s) this.drop(l);
  }

  /** A new snapshot: what was shown goes; its messages of the last CHAT_OVERLAY_FADE_S show. */
  reset(entries: readonly ChatEntry[] = []): void {
    for (const l of [...this.shown]) this.drop(l);
    this.add(entries.slice(-CHAT_OVERLAY_LINES), true);
  }

  /** Lines on screen (tests). */
  get count(): number {
    return this.shown.length;
  }

  /** Opens the message box over the video (the button, or the C key); false when the overlay does not show. */
  openInput(): boolean {
    if (!this.on) return false;
    if (!this.inputOpen) {
      this.inputOpen = true;
      this.inputHost.hidden = false;
      this.d.moveInput(this.inputHost);
      this.label();
    }
    this.d.focusInput();
    return true;
  }

  /** Puts the message box back in the chat column (`focus`: the focus goes back to the button). */
  closeInput(focus: boolean): void {
    if (!this.inputOpen) return;
    this.inputOpen = false;
    this.d.moveInput(null);
    this.inputHost.hidden = true;
    this.label();
    if (focus) this.write.focus();
  }
}
