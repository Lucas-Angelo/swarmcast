// The poll card (docs/CHAT.md, "Polls and predictions"): the streamer's poll or prediction at the
// top of the chat column, under the pinned bar, never over the list or the input. Question and
// options are the server's canonical text, checked with the shared invariants and drawn from text
// nodes in <bdi> boxes (an ESLint rule bans innerHTML in chat/). Options are buttons; results show
// live while voting (bars through the CSSOM: style.setProperty('--p'), which the CSP allows), the
// vote is final, and after the vote, the end or the answer the buttons stay focusable
// (aria-disabled) so the keyboard and screen readers keep their place. Announcements go through a
// polite live region, only on changes of state (opened, ended, answered, your vote, a refusal) and at
// most one per ANNOUNCE_MIN_MS; counts are never announced as they change.
//
// On a phone the chat under the player has room for a few lines only, so a new poll starts folded
// to its header (the label, the question on one line, the time left): a tap on the question or on ▸
// opens it, and the list keeps its room until the viewer does.
import { t, tc, type MessageKey, type MessageParams } from '@swarmcast/shared/i18n';
import { checkChatInvariants, CHAT_POLL_OPTION_MAX_GRAPHEMES, CHAT_POLL_QUESTION_MAX_GRAPHEMES, type ChatYou } from './core/index.js';
import type { PollEntry } from './session.js';

/** Announcements in the live region are at least this far apart (a burst of changes is said once, the last one). */
export const ANNOUNCE_MIN_MS = 2000;
/** A vote the server never answers (its refusal coalesced away, the socket gone) frees the buttons after this long. */
export const VOTE_WAIT_MS = 10_000;

export interface PollCardDeps {
  /** Send a vote; returns its nonce, or null when it could not go out (offline). */
  vote(id: string, o: number): number | null;
  you(): ChatYou | null;
  now?: () => number;
  /** Run `cb` in `ms`; returns its cancel (setTimeout). */
  later?: (cb: () => void, ms: number) => () => void;
  /** Run `cb` every `ms`; returns its cancel (setInterval). */
  every?: (cb: () => void, ms: number) => () => void;
  /** A small screen (a phone): a new poll starts folded. */
  compact?: () => boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** "1:42" from milliseconds (rounded up, so 0:00 shows only when the time is really up). */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole percentages of `c` (0 with no votes). */
export function percents(c: readonly number[]): number[] {
  const total = c.reduce((a, b) => a + b, 0);
  return c.map((n) => (total > 0 ? Math.round((n / total) * 100) : 0));
}

let cardIds = 0;

interface OptionRow {
  button: HTMLButtonElement;
  bar: HTMLSpanElement;
  pct: HTMLSpanElement;
  mark: HTMLSpanElement;
}

export class PollCard {
  readonly root: HTMLElement;
  /** Called when a poll starts, changes state or goes away (the "Show chat" badge). */
  onChange: (p: PollEntry | null, fresh: boolean) => void = () => {};
  private readonly label: HTMLSpanElement;
  /** The question on one line while folded (a button: a tap opens the card). */
  private readonly peek: HTMLButtonElement;
  private readonly time: HTMLSpanElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private readonly question: HTMLParagraphElement;
  private readonly list: HTMLUListElement;
  private readonly foot: HTMLParagraphElement;
  private readonly live: HTMLDivElement;
  private rows: OptionRow[] = [];
  private poll: PollEntry | null = null;
  /** When voting ends, on this page's clock. */
  private deadline = 0;
  private allowed = true;
  /** Polls this viewer folded (in memory). */
  private readonly folded = new Set<string>();
  private pending: { n: number; o: number; cancel: () => void } | null = null;
  private error: string | null = null;
  private stopTick: (() => void) | null = null;
  private lastAnnounce = -Infinity;
  private announceCancel: (() => void) | null = null;
  private readonly now: () => number;
  private readonly later: (cb: () => void, ms: number) => () => void;
  private readonly every: (cb: () => void, ms: number) => () => void;
  private readonly qid: string;

  constructor(private readonly deps: PollCardDeps) {
    this.now = deps.now ?? Date.now;
    this.later =
      deps.later ??
      ((cb, ms) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      });
    this.every =
      deps.every ??
      ((cb, ms) => {
        const id = setInterval(cb, ms);
        return () => clearInterval(id);
      });
    this.qid = `chat-poll-q-${++cardIds}`;
    this.root = el('section', 'chat-poll');
    this.root.hidden = true;
    this.root.dataset.testid = 'chat-poll';
    this.root.setAttribute('aria-labelledby', this.qid);
    const head = el('div', 'poll-head');
    this.label = el('span', 'poll-label');
    this.time = el('span', 'poll-time');
    this.time.dataset.testid = 'chat-poll-time';
    this.toggle = el('button', 'chat-tool poll-toggle');
    this.toggle.type = 'button';
    this.toggle.dataset.testid = 'chat-poll-toggle';
    this.toggle.addEventListener('click', () => {
      const p = this.poll;
      if (!p) return;
      if (this.folded.has(p.id)) this.folded.delete(p.id);
      else this.folded.add(p.id);
      this.render();
    });
    this.peek = el('button', 'poll-peek');
    this.peek.type = 'button';
    this.peek.dataset.testid = 'chat-poll-peek';
    this.peek.addEventListener('click', () => {
      const p = this.poll;
      if (!p) return;
      this.folded.delete(p.id);
      this.render();
      this.rows[0]?.button.focus();
    });
    head.append(this.label, this.peek, this.time, this.toggle);
    this.body = el('div', 'poll-body');
    this.body.id = `${this.qid}-body`;
    this.toggle.setAttribute('aria-controls', this.body.id);
    this.peek.setAttribute('aria-controls', this.body.id);
    this.question = el('p', 'poll-q');
    this.question.id = this.qid;
    this.list = el('ul', 'poll-options');
    this.foot = el('p', 'poll-foot');
    this.foot.dataset.testid = 'chat-poll-status';
    this.body.append(this.question, this.list, this.foot);
    this.live = el('div', 'sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('role', 'status');
    this.live.dataset.testid = 'chat-poll-live';
    this.root.append(head, this.body, this.live);
  }

  /** The poll changed or went away (null). A new id builds the card anew; the same id updates it in place (focus stays). */
  set(next: PollEntry | null): void {
    const prev = this.poll;
    // A vote this card learnt from a refusal ("you already voted", from another tab) stays for the same poll.
    const p = next && prev?.id === next.id && next.mine === undefined && prev.mine !== undefined ? { ...next, mine: prev.mine } : next;
    const fresh = p !== null && prev?.id !== p.id;
    this.poll = p;
    // The server's time left, when an update carries it (a new poll, a snapshot); updates without it
    // (this device's vote) keep the countdown where it is.
    if (p?.st === 'open' && typeof p.endsIn === 'number') this.deadline = this.now() + p.endsIn;
    if (fresh || p === null) {
      this.clearPending();
      this.error = null;
      if (p && this.deps.compact?.()) this.folded.add(p.id);
      this.build();
    }
    if (p && (fresh || prev?.st !== p.st)) this.announceState(p, fresh);
    if (p && prev?.id === p.id && prev.mine === undefined && p.mine !== undefined) this.clearPending();
    this.render();
    if (fresh || p === null || prev?.st !== p.st) this.onChange(p, fresh);
  }

  /** New counts for the poll on screen. */
  tally(id: string, c: number[]): void {
    if (this.poll?.id !== id) return;
    this.poll = { ...this.poll, c };
    this.renderCounts();
  }

  /** This device's vote was counted (from this tab or another one). */
  voted(n: number | undefined, id: string, o: number): void {
    const p = this.poll;
    if (!p || p.id !== id) return;
    if (this.pending && (n === undefined || n === this.pending.n || o === this.pending.o)) this.clearPending();
    this.error = null;
    this.say(t(p.kind === 'prediction' ? 'chat.prediction.youGuessed' : 'chat.poll.youVoted', { option: this.optionText(o) }));
    this.render();
  }

  /** A refusal for a vote this card sent: shown in the card; true when `n` was one of its votes. */
  rejected(n: number | undefined, code: MessageKey, params: MessageParams | undefined): boolean {
    if (!this.pending || n !== this.pending.n) return false;
    this.clearPending();
    const p = this.poll;
    // Voted already (another tab, a reload before the answer): the server says which option.
    const o = typeof params?.o === 'number' ? params.o : undefined;
    if (code === 'chat.err.voted' && p && o !== undefined && Number.isInteger(o) && o >= 0 && o < p.o.length) {
      this.poll = { ...p, mine: o };
      this.error = null;
    } else this.error = tc({ code, params: params ?? null }, t('chat.viewer.err.generic'));
    if (this.error) this.say(this.error);
    this.render();
    return true;
  }

  /** The chat is on (the card shows) or off (hidden with the rest of the chat). */
  setAllowed(on: boolean): void {
    if (on === this.allowed) return;
    this.allowed = on;
    this.render();
  }

  /** "You" changed (a mute): the buttons follow. */
  update(): void {
    this.render();
  }

  get current(): PollEntry | null {
    return this.poll;
  }

  private clearPending(): void {
    this.pending?.cancel();
    this.pending = null;
  }

  private optionText(i: number): string {
    return this.poll?.o[i] ?? '';
  }

  /** Whether the question and every option pass the shared invariants (a server bug never reaches the DOM unchecked). */
  private textsOk(p: PollEntry): boolean {
    return checkChatInvariants(p.q, { maxGraphemes: CHAT_POLL_QUESTION_MAX_GRAPHEMES, maxEmoji: CHAT_POLL_QUESTION_MAX_GRAPHEMES }) && p.o.every((o) => checkChatInvariants(o, { maxGraphemes: CHAT_POLL_OPTION_MAX_GRAPHEMES, maxEmoji: CHAT_POLL_OPTION_MAX_GRAPHEMES }));
  }

  private muted(): boolean {
    const m = this.deps.you()?.mutedUntil;
    return m === 'live' || (typeof m === 'number' && m > this.now());
  }

  /** The question and option rows of a new poll (or nothing). */
  private build(): void {
    this.question.replaceChildren();
    this.list.replaceChildren();
    this.rows = [];
    const p = this.poll;
    if (!p) return;
    if (!this.textsOk(p)) {
      this.question.textContent = t('chat.poll.hidden');
      this.question.classList.add('poll-hidden');
      return;
    }
    this.question.classList.remove('poll-hidden');
    const q = el('bdi');
    q.setAttribute('dir', 'auto');
    q.textContent = p.q;
    this.question.append(q);
    p.o.forEach((text, i) => {
      const li = el('li');
      const button = el('button', 'poll-option');
      button.type = 'button';
      button.dataset.testid = 'chat-poll-option';
      button.dataset.option = String(i);
      const bar = el('span', 'poll-bar');
      bar.setAttribute('aria-hidden', 'true');
      const name = el('bdi', 'poll-text');
      name.setAttribute('dir', 'auto');
      name.textContent = text;
      const mark = el('span', 'sr-only');
      const pct = el('span', 'poll-pct');
      button.append(bar, name, mark, pct);
      button.addEventListener('click', () => this.choose(i));
      li.append(button);
      this.list.append(li);
      this.rows.push({ button, bar, pct, mark });
    });
  }

  private canVote(p: PollEntry): boolean {
    return p.st === 'open' && p.mine === undefined && this.pending === null && !this.muted() && this.rows.length > 0;
  }

  private choose(i: number): void {
    const p = this.poll;
    if (!p || !this.canVote(p)) return;
    const n = this.deps.vote(p.id, i);
    if (n === null) {
      this.error = t('chat.viewer.err.offline');
      this.render();
      return;
    }
    const cancel = this.later(() => {
      if (this.pending?.n !== n) return;
      this.pending = null;
      this.render();
    }, VOTE_WAIT_MS);
    this.pending = { n, o: i, cancel };
    this.error = null;
    this.render();
  }

  private render(): void {
    const p = this.poll;
    this.root.hidden = !p || !this.allowed;
    if (!p) {
      this.stopCountdown();
      return;
    }
    this.root.dataset.state = p.st;
    this.root.dataset.kind = p.kind;
    this.label.textContent = t(p.kind === 'prediction' ? 'chat.prediction.title' : 'chat.poll.title');
    const folded = this.folded.has(p.id);
    this.body.hidden = folded;
    this.root.classList.toggle('folded', folded);
    this.peek.hidden = !folded;
    this.peek.replaceChildren();
    if (folded) {
      const q = el('bdi');
      q.setAttribute('dir', 'auto');
      q.textContent = this.textsOk(p) ? p.q : t('chat.poll.hidden');
      this.peek.append(q);
      this.peek.setAttribute('aria-label', `${t('chat.poll.expand')}: ${q.textContent}`);
    }
    this.toggle.textContent = folded ? '▸' : '▾';
    this.toggle.setAttribute('aria-expanded', String(!folded));
    const tip = t(folded ? 'chat.poll.expand' : 'chat.poll.collapse');
    this.toggle.setAttribute('aria-label', tip);
    this.toggle.title = tip;
    const voting = this.canVote(p);
    for (const [i, r] of this.rows.entries()) {
      r.button.setAttribute('aria-disabled', String(!voting));
      r.button.classList.toggle('mine', p.mine === i || this.pending?.o === i);
      r.button.classList.toggle('win', p.st === 'resolved' && p.win === i);
      if (p.mine === i) r.button.setAttribute('aria-pressed', 'true');
      else r.button.removeAttribute('aria-pressed');
      const marks: string[] = [];
      if (p.mine === i) marks.push(t('chat.poll.mine'));
      if (p.st === 'resolved' && p.win === i) marks.push(t('chat.poll.winner'));
      r.mark.textContent = marks.length ? ` (${marks.join(', ')})` : '';
    }
    this.renderCounts();
    this.renderTime();
    if (p.st === 'open' && !folded) this.startCountdown();
    else if (p.st !== 'open') this.stopCountdown();
  }

  /** Bars, percentages and the line under the options. */
  private renderCounts(): void {
    const p = this.poll;
    if (!p) return;
    const pct = percents(p.c);
    const total = p.c.reduce((a, b) => a + b, 0);
    for (const [i, r] of this.rows.entries()) {
      r.bar.style.setProperty('--p', String(total > 0 ? (p.c[i] ?? 0) / total : 0));
      r.pct.textContent = `${pct[i] ?? 0}%`;
    }
    const prediction = p.kind === 'prediction';
    const count = t(prediction ? 'chat.prediction.guesses' : 'chat.poll.votes', { count: total });
    const parts: string[] = [];
    if (p.st === 'open') {
      if (this.pending) parts.push(t('chat.poll.sending'));
      else if (p.mine !== undefined) parts.push(t(prediction ? 'chat.prediction.youGuessed' : 'chat.poll.youVoted', { option: this.optionText(p.mine) }));
      else if (this.muted()) parts.push(t('chat.poll.muted'));
      else if (this.error === null) parts.push(t(prediction ? 'chat.prediction.make' : 'chat.poll.pick'));
      if (this.error !== null) parts.push(this.error);
      parts.push(count);
    } else if (p.st === 'closed') {
      parts.push(t('chat.poll.ended'), count);
      if (p.mine !== undefined) parts.push(t('chat.poll.youVoted', { option: this.optionText(p.mine) }));
    } else if (p.st === 'locked') {
      parts.push(t('chat.prediction.locked'), count);
      if (p.mine !== undefined) parts.push(t('chat.prediction.youGuessed', { option: this.optionText(p.mine) }));
    } else {
      const win = p.win ?? -1;
      parts.push(t('chat.prediction.answer', { option: this.optionText(win) }), t('chat.prediction.gotIt', { count: p.c[win] ?? 0 }));
      if (p.mine !== undefined) parts.push(t(p.mine === win ? 'chat.prediction.right' : 'chat.prediction.wrong'));
    }
    this.foot.textContent = parts.join(' · ');
    this.foot.classList.toggle('error', this.error !== null && p.st === 'open');
  }

  private renderTime(): void {
    const p = this.poll;
    this.time.textContent = p?.st === 'open' ? t('chat.poll.timeLeft', { time: clockText(this.deadline - this.now()) }) : '';
    this.time.hidden = this.time.textContent === '';
  }

  private startCountdown(): void {
    if (this.stopTick) return;
    this.stopTick = this.every(() => this.renderTime(), 1000);
  }

  private stopCountdown(): void {
    this.stopTick?.();
    this.stopTick = null;
  }

  private announceState(p: PollEntry, fresh: boolean): void {
    const prediction = p.kind === 'prediction';
    if (fresh && p.st === 'open') this.say(t(prediction ? 'chat.prediction.announce.open' : 'chat.poll.announce.open', { question: this.textsOk(p) ? p.q : '' }));
    else if (p.st === 'closed') this.say(t('chat.poll.announce.closed'));
    else if (p.st === 'locked') this.say(t('chat.prediction.announce.locked'));
    else if (p.st === 'resolved') this.say(t('chat.prediction.answer', { option: this.textsOk(p) ? this.optionText(p.win ?? -1) : '' }));
  }

  /** Polite announcement, at most one per ANNOUNCE_MIN_MS: a later one replaces one still waiting. */
  private say(text: string): void {
    this.announceCancel?.();
    this.announceCancel = null;
    const wait = this.lastAnnounce + ANNOUNCE_MIN_MS - this.now();
    const speak = (): void => {
      this.announceCancel = null;
      this.lastAnnounce = this.now();
      this.live.textContent = text;
    };
    if (wait <= 0) speak();
    else this.announceCancel = this.later(speak, wait);
  }
}

/** The language-aware label of the "Show chat" badge while a poll is open. */
export function pollBadge(p: PollEntry | null): string | null {
  if (!p || p.st !== 'open') return null;
  return t(p.kind === 'prediction' ? 'chat.prediction.title' : 'chat.poll.title');
}
