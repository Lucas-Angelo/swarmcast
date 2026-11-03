// The message box: one line, a grapheme counter with the same limits as the server, Enter to
// send, and disabled states that say why (chat off, muted, slow mode, only emotes…). Typed text
// is never lost: on a reject the text comes back into an empty box, with the reply it was.
//
// Replies and mentions (docs/CHAT.md, "Replies and mentions"): "Replying to Ana" sits above the box
// with the quote the server will show and ✕ (Escape cancels too); typing "@" lists the people who
// already wrote in the chat (never everyone watching), and the people a message mentions are worked
// out from its text when it is sent (mentionKeys), so a picked name deleted again is not sent.
//
// Slash commands (docs/CHAT.md, "Slash commands"): a viewer has only /help (/ajuda, /?), answered on
// this page with a short list of what they can do; it is never sent. A streamer command typed here
// ("/poll …") is not sent either (it would show the line to everyone): the box keeps it and says
// only the streamer can use it. "//text" sends "/text".
import { getLang, t, tc } from '@swarmcast/shared/i18n';
import {
  applyMention,
  checkChatInvariants,
  CHAT_MAX_EMOJI_DEFAULT,
  CHAT_MAX_GRAPHEMES_DEFAULT,
  CHAT_NICKNAME_MAX,
  CHAT_REPLY_QUOTE_MAX_BYTES,
  CHAT_REPLY_QUOTE_MAX_GRAPHEMES,
  CHAT_TEXT_MAX_UNITS,
  measureChatText,
  mentionQuery,
  parseCommand,
  suggestMentions,
  type ChatAuthor,
  type ChatPublicSettings,
  type ChatYou,
} from './core/index.js';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';
import { counterText } from './render.js';
import type { ReplyEntry } from './session.js';

export interface InputDeps {
  settings(): ChatPublicSettings | null;
  you(): ChatYou | null;
  connected(): boolean;
  /** Send `text` (a reply to `reply`, when set); returns its nonce, or null when it could not go out. */
  send(text: string, reply: ReplyEntry | null): number | null;
  /** People the @ list may offer, most recent writer first (only people who already wrote; never this viewer). */
  mentionable?(): readonly ChatAuthor[];
  now?: () => number;
}

/** A person in the @ list: the name to insert (the translated "Streamer" for a streamer without one). */
interface Suggestion {
  a: string;
  n: string;
  tag?: string;
}

let inputIds = 0;

export type InputBlock = { key: MessageKey; params?: MessageParams; typing: boolean } | null;

/** A send the server never answers (its reject coalesced away, the socket gone) holds Send at most this long. */
export const ANSWER_WAIT_MS = 10_000;

const seconds = (ms: number): string => t('time.secondsShort', { count: Math.max(1, Math.ceil(ms / 1000)) });

/** Why the viewer cannot send right now (null: they can). `typing`: the box stays usable. */
export function inputBlock(s: ChatPublicSettings | null, you: ChatYou | null, connected: boolean, now: number, cooldownUntil: number): InputBlock {
  if (!s || !s.enabled) return { key: 'chat.viewer.off', typing: false };
  if (you?.mutedUntil === 'live') return { key: 'chat.viewer.mutedLive', typing: false };
  if (typeof you?.mutedUntil === 'number' && you.mutedUntil > now) {
    const time = new Intl.DateTimeFormat(getLang(), { hour: '2-digit', minute: '2-digit' }).format(new Date(you.mutedUntil));
    return { key: 'chat.viewer.mutedUntil', params: { time }, typing: false };
  }
  if (!s.content.includes('text') && !s.content.includes('emotes')) return { key: 'chat.viewer.gifsOnly', typing: false };
  if (!connected) return { key: 'chat.viewer.offline', typing: true };
  if (typeof you?.waitUntil === 'number' && you.waitUntil > now) return { key: 'chat.viewer.newViewer', params: { seconds: seconds(you.waitUntil - now) }, typing: true };
  if (cooldownUntil > now) return { key: 'chat.viewer.wait', params: { seconds: seconds(cooldownUntil - now) }, typing: true };
  return null;
}

export interface LengthState {
  graphemes: number;
  emoji: number;
  max: number;
  maxEmoji: number;
  over: boolean;
}

export function lengthState(text: string, s: ChatPublicSettings | null): LengthState {
  const max = s?.maxGraphemes ?? CHAT_MAX_GRAPHEMES_DEFAULT;
  const maxEmoji = s?.maxEmoji ?? CHAT_MAX_EMOJI_DEFAULT;
  const { graphemes, emoji } = measureChatText(text);
  return { graphemes, emoji, max, maxEmoji, over: graphemes > max || emoji > maxEmoji || text.length > CHAT_TEXT_MAX_UNITS };
}

/** One line: newlines and tabs (paste) become spaces, as the server would do. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ');
}

export class ChatInput {
  readonly form: HTMLFormElement;
  readonly textarea: HTMLTextAreaElement;
  readonly sendButton: HTMLButtonElement;
  readonly counter: HTMLSpanElement;
  readonly status: HTMLParagraphElement;
  /** Where chat.ts puts the emoji/emote picker button. */
  readonly tools: HTMLDivElement;
  /** When the server last took a message from this page (its ack, on this page's clock); null: never. */
  private takenAt: number | null = null;
  /** Until when the last refusal said to wait (its retryMs). */
  private retryUntil = 0;
  private errorText: string | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  /** Sends still waiting for their answer: the text and reply to give back on a reject ('' for a GIF), and when they went. */
  private readonly sent = new Map<number, { text: string; at: number; reply: ReplyEntry | null }>();
  private readonly now: () => number;
  /** "Replying to …" above the box, and the @ list. */
  readonly replyBar: HTMLDivElement;
  /** What a viewer can do (/help), above the box until closed. */
  readonly help: HTMLDivElement;
  readonly suggestions: HTMLUListElement;
  private reply: ReplyEntry | null = null;
  private offered: Suggestion[] = [];
  private active = 0;
  private query: { start: number; prefix: string } | null = null;

  constructor(private readonly deps: InputDeps) {
    this.now = deps.now ?? Date.now;
    this.form = document.createElement('form');
    this.form.className = 'chat-input';
    this.form.noValidate = true;
    this.textarea = document.createElement('textarea');
    this.textarea.rows = 1;
    this.textarea.maxLength = CHAT_TEXT_MAX_UNITS;
    this.textarea.setAttribute('enterkeyhint', 'send');
    this.textarea.setAttribute('autocomplete', 'off');
    this.textarea.setAttribute('aria-label', t('chat.viewer.input.label'));
    this.textarea.dataset.testid = 'chat-input';
    this.counter = document.createElement('span');
    this.counter.className = 'counter';
    this.counter.dataset.testid = 'chat-counter';
    this.tools = document.createElement('div');
    this.tools.className = 'tools';
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'submit';
    this.sendButton.textContent = t('chat.viewer.send');
    this.sendButton.dataset.testid = 'chat-send';
    this.status = document.createElement('p');
    this.status.className = 'chat-status small';
    this.status.setAttribute('role', 'status');
    this.status.dataset.testid = 'chat-status';
    const row = document.createElement('div');
    row.className = 'row';
    row.append(this.textarea, this.tools, this.sendButton);
    this.replyBar = document.createElement('div');
    this.replyBar.className = 'chat-replying';
    this.replyBar.hidden = true;
    this.replyBar.dataset.testid = 'chat-replying';
    const id = ++inputIds;
    this.suggestions = document.createElement('ul');
    this.suggestions.className = 'chat-mentions';
    this.suggestions.id = `chat-mentions-${id}`;
    this.suggestions.hidden = true;
    this.suggestions.setAttribute('role', 'listbox');
    this.suggestions.setAttribute('aria-label', t('chat.viewer.mention.list'));
    this.suggestions.dataset.testid = 'chat-mentions';
    this.textarea.setAttribute('aria-autocomplete', 'list');
    this.textarea.setAttribute('aria-controls', this.suggestions.id);
    this.help = this.buildHelp();
    this.form.append(this.help, this.suggestions, this.replyBar, row, this.counter, this.status);

    this.textarea.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (this.offered.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.setActive(this.active + (e.key === 'ArrowDown' ? 1 : -1));
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          this.pick(this.active);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeSuggestions();
          return;
        }
      }
      if (e.key === 'Escape' && this.reply) {
        e.preventDefault();
        this.setReply(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.textarea.addEventListener('input', () => {
      const v = oneLine(this.textarea.value);
      if (v !== this.textarea.value) this.textarea.value = v;
      this.errorText = null;
      this.update();
      this.suggest();
    });
    // The caret moved without typing (a click, the arrow keys): the @ list follows it.
    this.textarea.addEventListener('click', () => this.suggest());
    this.textarea.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') this.suggest();
    });
    this.textarea.addEventListener('blur', () => this.closeSuggestions());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.update();
  }

  /** Put `text` at the caret (emoji picker). */
  insert(text: string): void {
    const ta = this.textarea;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const caret = start + text.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    this.update();
  }

  /** The /help box: title, a few lines on what viewers can do, and Close. */
  private buildHelp(): HTMLDivElement {
    const box = document.createElement('div');
    box.className = 'chat-help';
    box.hidden = true;
    box.dataset.testid = 'chat-help';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('chat.viewer.help.title'));
    const head = document.createElement('div');
    head.className = 'chat-help-head';
    const title = document.createElement('strong');
    title.textContent = t('chat.viewer.help.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chat-tool chat-help-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', t('chat.viewer.help.close'));
    close.title = t('chat.viewer.help.close');
    close.dataset.testid = 'chat-help-close';
    close.addEventListener('click', () => {
      box.hidden = true;
      this.textarea.focus();
    });
    head.append(title, close);
    const list = document.createElement('ul');
    for (const key of ['chat.viewer.help.reply', 'chat.viewer.help.mention', 'chat.viewer.help.poll', 'chat.viewer.help.settings'] as const) {
      const li = document.createElement('li');
      li.textContent = t(key);
      list.append(li);
    }
    box.append(head, list);
    return box;
  }

  submit(): void {
    const typed = this.textarea.value.trim();
    if (!typed) return;
    // Commands are read here and never sent (the server never reads text as a command).
    const cmd = parseCommand(typed, 'viewer');
    if (cmd && !cmd.ok) {
      this.errorText = t(cmd.code, cmd.params);
      this.update();
      return;
    }
    if (cmd?.ok && cmd.cmd.id === 'help') {
      this.help.hidden = false;
      this.textarea.value = '';
      this.errorText = null;
      this.update();
      return;
    }
    const text = cmd?.ok && cmd.cmd.id === 'say' ? cmd.cmd.text : typed;
    if (this.sendButton.disabled) return;
    const reply = this.reply;
    const n = this.deps.send(text, reply);
    if (n === null) {
      this.errorText = t('chat.viewer.err.offline');
      this.update();
      return;
    }
    this.track(n, text, reply);
    this.textarea.value = '';
    this.errorText = null;
    this.closeSuggestions();
    this.setReply(null, false);
    this.update();
  }

  /** The message being answered (null: none). Shown above the box until sent or cancelled. */
  get replyingTo(): ReplyEntry | null {
    return this.reply;
  }

  /**
   * Answer a message: "Replying to Ana" with the quote the server will show (cut the same way) and
   * ✕ above the box, and the focus in the box. null cancels (focus back in the box when `focus`).
   */
  setReply(r: ReplyEntry | null, focus = true): void {
    this.reply = r;
    const bar = this.replyBar;
    bar.replaceChildren();
    bar.hidden = r === null;
    if (r) {
      const label = document.createElement('span');
      label.className = 'replying-label';
      const icon = document.createElement('span');
      icon.className = 'sc-ico-reply';
      icon.setAttribute('aria-hidden', 'true');
      const name = r.author.n || (r.author.r === 'streamer' ? t('chat.streamer') : '…');
      const nameOk = checkChatInvariants(name, { maxGraphemes: CHAT_NICKNAME_MAX, maxEmoji: CHAT_NICKNAME_MAX });
      // "Replying to {nickname}": the name goes in a <bdi> of its own, between the two halves.
      const [before, after = ''] = t('chat.viewer.replyingTo', { nickname: '\u0000' }).split('\u0000');
      const nick = document.createElement('bdi');
      nick.className = 'q-nick';
      nick.textContent = nameOk ? name : '…';
      label.append(icon, document.createTextNode(before ?? ''), nick, document.createTextNode(after));
      const quote = document.createElement('bdi');
      quote.className = 'q-text';
      quote.setAttribute('dir', 'auto');
      if (r.gif) quote.textContent = t('chat.viewer.gif');
      else if (r.quote !== undefined && checkChatInvariants(r.quote, { maxGraphemes: CHAT_REPLY_QUOTE_MAX_GRAPHEMES, maxBytes: CHAT_REPLY_QUOTE_MAX_BYTES })) quote.textContent = `${r.quote}${r.cut ? '…' : ''}`;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chat-tool replying-cancel';
      cancel.textContent = '✕';
      cancel.setAttribute('aria-label', t('chat.viewer.reply.cancel'));
      cancel.title = t('chat.viewer.reply.cancel');
      cancel.dataset.testid = 'chat-reply-cancel';
      cancel.addEventListener('click', () => this.setReply(null));
      bar.append(label, quote, cancel);
    }
    if (focus && !this.textarea.disabled) this.textarea.focus();
  }

  /** The message being answered left the chat (deleted, cleared): the reply is cancelled. */
  dropReply(gone: (s: number) => boolean): void {
    if (this.reply && gone(this.reply.s)) this.setReply(null, false);
  }

  /** Show the @ list for the name being typed at the caret, or hide it. */
  private suggest(): void {
    const ta = this.textarea;
    const q = ta.selectionStart === ta.selectionEnd ? mentionQuery(ta.value, ta.selectionStart ?? ta.value.length) : null;
    const people = q ? (this.deps.mentionable?.() ?? []) : [];
    const offered = q ? suggestMentions(q.prefix, people.map((p): Suggestion => ({ a: p.a, n: p.n || (p.r === 'streamer' ? t('chat.streamer') : ''), ...(p.tag && p.r !== 'streamer' ? { tag: p.tag } : {}) }))) : [];
    this.query = q;
    this.offered = offered.filter((o) => checkChatInvariants(o.n, { maxGraphemes: CHAT_NICKNAME_MAX, maxEmoji: CHAT_NICKNAME_MAX }));
    const list = this.suggestions;
    list.replaceChildren();
    list.hidden = this.offered.length === 0;
    if (list.hidden) {
      ta.removeAttribute('aria-activedescendant');
      return;
    }
    this.offered.forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.dataset.testid = 'chat-mention-option';
      const name = document.createElement('bdi');
      name.textContent = o.n;
      li.append(name);
      if (o.tag) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = ` #${o.tag}`;
        li.append(tag);
      }
      // pointerdown, not click: the box keeps the focus (and the caret, and a phone's keyboard)
      // while a name is picked, and the pick happens before any blur could close the list.
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.pick(i);
      });
      list.append(li);
    });
    this.setActive(Math.min(this.active, this.offered.length - 1));
  }

  private setActive(i: number): void {
    const n = this.offered.length;
    if (n === 0) return;
    this.active = ((i % n) + n) % n;
    this.suggestions.querySelectorAll('li').forEach((li, k) => li.setAttribute('aria-selected', String(k === this.active)));
    this.textarea.setAttribute('aria-activedescendant', `${this.suggestions.id}-${this.active}`);
  }

  /** Put "@Name " in place of the name being typed. */
  private pick(i: number): void {
    const o = this.offered[i];
    const q = this.query;
    if (!o || !q) return;
    const ta = this.textarea;
    const next = applyMention(ta.value, q.start, ta.selectionStart ?? ta.value.length, o.n);
    ta.value = next.text;
    ta.setSelectionRange(next.caret, next.caret);
    this.closeSuggestions();
    this.update();
  }

  private closeSuggestions(): void {
    this.offered = [];
    this.active = 0;
    this.query = null;
    this.suggestions.hidden = true;
    this.suggestions.replaceChildren();
    this.textarea.removeAttribute('aria-activedescendant');
  }

  /** The oldest send still waiting for its ack (a reject without `n` belongs to it). */
  oldestPending(): number | undefined {
    return this.sent.keys().next().value;
  }

  /** A send that did not come from the box (a GIF): tracked for acks and rejects, and in slow mode it holds Send like one. */
  noteSent(n: number): void {
    this.track(n, '', null);
    this.update();
  }

  private track(n: number, text: string, reply: ReplyEntry | null): void {
    this.sent.set(n, { text, at: this.now(), reply });
    if (this.sent.size > 20) this.sent.delete(this.sent.keys().next().value as number);
  }

  acked(n: number): void {
    this.sent.delete(n);
    // The server's slow-mode wait starts when it takes a message (a GIF too), a moment after this
    // page sent it, so the page counts it from the ack: the next send never reaches the server
    // before that wait is over (one sent as the page's own countdown ended was refused).
    this.takenAt = this.now();
    this.update();
  }

  rejected(n: number | undefined, code: MessageKey, params: MessageParams | undefined, retryMs: number | undefined): void {
    this.errorText = tc({ code, params: params ?? null }, t('chat.viewer.err.generic'));
    const sent = n === undefined ? undefined : this.sent.get(n);
    if (n !== undefined) this.sent.delete(n);
    if (sent && sent.text !== '' && this.textarea.value.trim() === '') {
      this.textarea.value = sent.text;
      if (sent.reply && !this.reply) this.setReply(sent.reply, false);
    }
    // retryMs counts from now, a moment after the server measured it, so a retry never comes early.
    // A refused message starts no slow-mode wait, and leaves the one of a message the server took.
    this.retryUntil = typeof retryMs === 'number' && retryMs > 0 ? this.now() + Math.min(retryMs, 3_600_000) : 0;
    this.update();
  }

  /**
   * When the next send can go, counted as the server will: slow mode from the last ack with the slowS
   * in force now (raised, lowered or turned off since), and the last refusal's retryMs. In slow mode
   * a send still waiting for its answer holds Send too: if the server took it, its wait starts at the
   * ack, so until then the line shows the whole wait (a countdown that is already running goes on).
   */
  private waitUntil(slowS: number, now: number): number {
    const until = Math.max(slowS > 0 && this.takenAt !== null ? this.takenAt + slowS * 1000 : 0, this.retryUntil);
    return slowS > 0 && until <= now && this.awaitingAnswer(now) ? now + slowS * 1000 : until;
  }

  private awaitingAnswer(now: number): boolean {
    for (const { at } of this.sent.values()) if (now - at < ANSWER_WAIT_MS) return true;
    return false;
  }

  /** Re-read settings / you / connection and redraw. */
  update(): void {
    const s = this.deps.settings();
    const now = this.now();
    const block = inputBlock(s, this.deps.you(), this.deps.connected(), now, this.waitUntil(s?.slowS ?? 0, now));
    const len = lengthState(this.textarea.value, s);
    const emotesOnly = !!s && !s.content.includes('text') && s.content.includes('emotes');
    this.textarea.placeholder = t(emotesOnly ? 'chat.viewer.placeholder.emotes' : 'chat.viewer.placeholder');
    this.textarea.disabled = block !== null && !block.typing;
    // GIFs-only mode keeps the tools (the GIF button) while the text box is off.
    this.tools.hidden = this.textarea.disabled && block?.key !== 'chat.viewer.gifsOnly';
    this.sendButton.disabled = block !== null || len.over || this.textarea.value.trim() === '';
    this.counter.textContent = counterText(len.graphemes, len.max);
    this.counter.title = t('chat.viewer.counter', { count: len.graphemes, max: len.max });
    this.counter.classList.toggle('over', len.over);
    this.counter.classList.toggle('near', !len.over && len.graphemes > len.max * 0.9);
    let line: string | null = null;
    let isError = false;
    if (len.graphemes > len.max) {
      line = t('chat.viewer.tooLong', { count: len.graphemes, max: len.max });
      isError = true;
    } else if (len.emoji > len.maxEmoji) {
      line = t('chat.viewer.tooManyEmoji', { count: len.emoji, max: len.maxEmoji });
      isError = true;
    } else if (this.errorText && !(block && !block.typing)) {
      line = this.errorText;
      isError = true;
    } else if (block) {
      line = t(block.key, block.params);
    }
    this.status.textContent = line ?? '';
    this.status.classList.toggle('error', isError);
    this.form.dataset.state = block ? 'blocked' : 'ready';
    // Countdowns (slow mode, new-viewer wait, a mute that ends) refresh once a second.
    const ticking = block !== null && (block.key === 'chat.viewer.wait' || block.key === 'chat.viewer.newViewer' || block.key === 'chat.viewer.mutedUntil');
    if (ticking && !this.tick) this.tick = setInterval(() => this.update(), 1000);
    else if (!ticking && this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }
}
