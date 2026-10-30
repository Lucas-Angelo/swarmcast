// The message box: one line, a grapheme counter with the same limits as the server, Enter to
// send, and disabled states that say why (chat off, muted, slow mode, only emotes…). Typed text
// is never lost: on a reject the text comes back into an empty box.
import { getLang, t, tc } from '@swarmcast/shared/i18n';
import { CHAT_MAX_EMOJI_DEFAULT, CHAT_MAX_GRAPHEMES_DEFAULT, CHAT_TEXT_MAX_UNITS, measureChatText, type ChatPublicSettings, type ChatYou } from './core/index.js';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';
import { counterText } from './render.js';

export interface InputDeps {
  settings(): ChatPublicSettings | null;
  you(): ChatYou | null;
  connected(): boolean;
  /** Send `text`; returns its nonce, or null when it could not go out. */
  send(text: string): number | null;
  now?: () => number;
}

export type InputBlock = { key: MessageKey; params?: MessageParams; typing: boolean } | null;

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
  private cooldownUntil = 0;
  /** When the slow-mode wait of the last message the server took ends (counted from its ack). */
  private slowUntil = 0;
  private errorText: string | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly sent = new Map<number, string>();
  private readonly now: () => number;

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
    this.form.append(row, this.counter, this.status);

    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.textarea.addEventListener('input', () => {
      const v = oneLine(this.textarea.value);
      if (v !== this.textarea.value) this.textarea.value = v;
      this.errorText = null;
      this.update();
    });
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

  submit(): void {
    const text = this.textarea.value.trim();
    if (!text || this.sendButton.disabled) return;
    const n = this.deps.send(text);
    if (n === null) {
      this.errorText = t('chat.viewer.err.offline');
      this.update();
      return;
    }
    this.sent.set(n, text);
    if (this.sent.size > 20) this.sent.delete(this.sent.keys().next().value as number);
    this.textarea.value = '';
    this.errorText = null;
    const slowS = this.deps.settings()?.slowS ?? 0;
    if (slowS > 0) this.cooldownUntil = this.now() + slowS * 1000;
    this.update();
  }

  /** The oldest send still waiting for its ack (a reject without `n` belongs to it). */
  oldestPending(): number | undefined {
    return this.sent.keys().next().value;
  }

  /** A send that did not come from the box (a GIF): tracked for acks and rejects. */
  noteSent(n: number): void {
    this.sent.set(n, '');
  }

  acked(n: number): void {
    this.sent.delete(n);
    // The server's slow-mode wait starts when it took the message, a moment after this page sent
    // it: counted again from the ack, the next send never reaches the server before that wait is
    // over (it was refused with chat.err.slow right as this page's countdown ended). A GIF counts
    // too: the server paces every message.
    const slowS = this.deps.settings()?.slowS ?? 0;
    if (slowS > 0) {
      this.slowUntil = Math.max(this.slowUntil, this.now() + slowS * 1000);
      this.cooldownUntil = Math.max(this.cooldownUntil, this.slowUntil);
      this.update();
    }
  }

  rejected(n: number | undefined, code: MessageKey, params: MessageParams | undefined, retryMs: number | undefined): void {
    this.errorText = tc({ code, params: params ?? null }, t('chat.viewer.err.generic'));
    const text = n === undefined ? undefined : this.sent.get(n);
    if (n !== undefined) this.sent.delete(n);
    if (text !== undefined && this.textarea.value.trim() === '') this.textarea.value = text;
    // retryMs counts from now, a moment after the server measured it, so a retry never comes early.
    // A refused message starts no wait (the guard submit() set for it goes), nor does it end the
    // wait of a message the server took: a GIF refused during that wait (lockdown, busy) ended it.
    const retryUntil = typeof retryMs === 'number' && retryMs > 0 ? this.now() + Math.min(retryMs, 3_600_000) : 0;
    this.cooldownUntil = Math.max(this.slowUntil, retryUntil);
    this.update();
  }

  /** Re-read settings / you / connection and redraw. */
  update(): void {
    const s = this.deps.settings();
    const now = this.now();
    const block = inputBlock(s, this.deps.you(), this.deps.connected(), now, this.cooldownUntil);
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
