import {
  adjustNameColor,
  BUILTIN_EMOTE_CODES,
  CHAT_BG_DARK,
  CHAT_BG_LIGHT,
  CHAT_BLOCKED_WORD_MAX_GRAPHEMES,
  CHAT_BLOCKED_WORDS_MAX,
  checkChatInvariants,
  countGraphemes,
  tokenizeChat,
  type ChatCounters,
  type ChatPublicSettings,
  type ChatSettings,
  type ChatToken,
  type MessageKey,
  type MessageParams,
} from '@swarmcast/shared';

/** Pure helpers of the chat card (unit tested in apps/admin/test/unit/chat-logic.test.ts). */

export type ContentPreset = 'all' | 'text' | 'emotes' | 'gifs' | 'textEmotes';

export const CONTENT_PRESETS: ReadonlyArray<{ id: ContentPreset; key: MessageKey; content: ChatSettings['content'] }> = [
  { id: 'all', key: 'admin.chat.preset.all', content: { text: true, emotes: true, gifs: true } },
  { id: 'textEmotes', key: 'admin.chat.preset.textEmotes', content: { text: true, emotes: true, gifs: false } },
  { id: 'text', key: 'admin.chat.preset.text', content: { text: true, emotes: false, gifs: false } },
  { id: 'emotes', key: 'admin.chat.preset.emotes', content: { text: false, emotes: true, gifs: false } },
  { id: 'gifs', key: 'admin.chat.preset.gifs', content: { text: false, emotes: false, gifs: true } },
];

/** The preset a content mix matches, or null for another mix. */
export function presetOf(c: ChatSettings['content']): ContentPreset | null {
  return CONTENT_PRESETS.find((p) => p.content.text === c.text && p.content.emotes === c.emotes && p.content.gifs === c.gifs)?.id ?? null;
}

/** A preset that needs GIFs is offered only when a key is set. */
export function presetNeedsGifs(id: ContentPreset): boolean {
  return CONTENT_PRESETS.find((p) => p.id === id)!.content.gifs;
}

export type Tone = 'ok' | 'wait' | 'bad' | 'off';

/** The header pill: what the chat does right now. */
export function chatStatus(enabled: boolean, eff: ChatPublicSettings | null, counters: ChatCounters | null): { key: MessageKey; params?: MessageParams; tone: Tone } {
  if (!enabled) return { key: 'admin.chat.status.off', tone: 'off' };
  if (counters?.broken) return { key: 'admin.chat.status.broken', tone: 'bad' };
  const protect = counters?.protect ?? eff?.protect ?? 'off';
  if (protect === 'lockdown') return { key: 'admin.chat.status.lockdown', tone: 'wait' };
  const slow = eff?.slowS ?? 0;
  if (eff?.autoSlow || protect === 'slow') return { key: 'admin.chat.status.autoSlow', params: { count: slow }, tone: 'wait' };
  if (slow > 0) return { key: 'admin.chat.status.slow', params: { count: slow }, tone: 'ok' };
  return { key: 'admin.chat.status.on', tone: 'ok' };
}

/** A mute still in force at `now` (a timed mute in the past is over). */
export function isMuted(mutedUntil: number | 'live' | null | undefined, now = Date.now()): boolean {
  return mutedUntil === 'live' || (typeof mutedUntil === 'number' && mutedUntil > now);
}

/** The muted badge text: "muted until 21:40" or "muted until the stream ends"; null when not muted. */
export function mutedText(mutedUntil: number | 'live' | null | undefined, clock: (at: number) => string, now = Date.now()): { key: MessageKey; params?: MessageParams } | null {
  if (mutedUntil === 'live') return { key: 'admin.chat.mutedLive' };
  if (typeof mutedUntil === 'number' && mutedUntil > now) return { key: 'admin.chat.mutedUntil', params: { clock: clock(mutedUntil) } };
  return null;
}

/** Mute choices of the menu: minutes, or null for "until the stream ends". */
export const MUTE_CHOICES: ReadonlyArray<{ minutes: number | null; key: MessageKey; params?: MessageParams }> = [
  { minutes: 1, key: 'admin.chat.mute.minutes', params: { count: 1 } },
  { minutes: 10, key: 'admin.chat.mute.minutes', params: { count: 10 } },
  { minutes: 60, key: 'admin.chat.mute.hour' },
  { minutes: null, key: 'admin.chat.mute.live' },
];

/**
 * Blocked words from the textarea (one per line): trimmed, empty lines dropped, duplicates
 * (ignoring case) dropped, at most CHAT_BLOCKED_WORDS_MAX. `tooLong` lists the lines over the
 * server's 40-grapheme limit, so the panel can say so before saving.
 */
export function parseBlockedWords(text: string): { words: string[]; tooLong: string[] } {
  const seen = new Set<string>();
  const words: string[] = [];
  const tooLong: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const w = raw.trim();
    if (!w) continue;
    const key = w.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (countGraphemes(w) > CHAT_BLOCKED_WORD_MAX_GRAPHEMES) tooLong.push(w);
    words.push(w);
  }
  return { words: words.slice(0, CHAT_BLOCKED_WORDS_MAX), tooLong };
}

/** Same settings (the Save button is enabled only when something changed). */
export function sameSettings(a: ChatSettings, b: ChatSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The chat background of the panel's theme (the feed sits on --sc-surface). */
export function feedBackground(dark: boolean): string {
  return dark ? CHAT_BG_DARK : CHAT_BG_LIGHT;
}

/** A name colour made readable on the feed (contrast ≥ 4.5:1, same hue). */
export function readableName(color: string, dark: boolean): string {
  return adjustNameColor(color, feedBackground(dark));
}

const EMOTES = new Set(BUILTIN_EMOTE_CODES);

/**
 * Tokens to render a message with, or null when the text fails the shared safety invariants
 * (the server never sends such text; a defence in depth before any DOM is built, plan §2.4).
 */
export function messageTokens(text: string): ChatToken[] | null {
  if (!checkChatInvariants(text, { maxGraphemes: 500, maxEmoji: 100 })) return null;
  return tokenizeChat(text, EMOTES);
}

/** Grapheme count of the streamer's draft and whether it fits. */
export function draftLength(text: string, max: number): { count: number; over: boolean } {
  const count = countGraphemes(text);
  return { count, over: count > max };
}
