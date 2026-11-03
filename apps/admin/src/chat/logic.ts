import {
  adjustNameColor,
  BUILTIN_EMOTE_CODES,
  CHAT_PIN_PRESETS_MIN,
  CHAT_BG_DARK,
  CHAT_BG_LIGHT,
  CHAT_BLOCKED_WORD_MAX_GRAPHEMES,
  CHAT_BLOCKED_WORDS_MAX,
  CHAT_POLL_OPTION_MAX_GRAPHEMES,
  CHAT_POLL_QUESTION_MAX_GRAPHEMES,
  CHAT_REACTIONS,
  checkChatInvariants,
  countGraphemes,
  cutQuote,
  findMentionSpans,
  plainNameKey,
  tokenizeChat,
  type ChatAuthor,
  type ChatCommand,
  type ChatCounters,
  type ChatPollCreate,
  type ChatProtect,
  type ChatSessionInfo,
  type ChatMessageItem,
  type ChatRingItem,
  type ChatPublicSettings,
  type ChatSettings,
  type ChatSystemItem,
  type ChatToken,
  type LivePhase,
  type MentionCandidate,
  type MessageKey,
  type MessageParams,
} from '@swarmcast/shared';
import { t, translate, translateWire } from '@swarmcast/shared/i18n';

/** Pure helpers of the chat card (unit tested in apps/admin/test/unit/chat-logic.test.ts). */

/**
 * The text of a system line. A code this panel does not know (a newer server, or a panel tab left
 * open across an update) shows a neutral line instead of breaking the feed.
 */
export function systemText(item: ChatSystemItem): string {
  return translateWire(item.code, item.params, 'chat.sys.unknown');
}

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

/**
 * Whether the panel shows the live chat column next to (or, on a narrow window, under) the
 * status at the top. Only while live with the chat on: before the live, after it, or with the
 * chat off there is nothing to read, so the panel keeps its calm one-column layout. It follows
 * the /ws state snapshot, which arrives with the first render, so the layout never moves when
 * GET /api/chat answers.
 */
export function chatColumnShown(phase: LivePhase, chatEnabled: boolean): boolean {
  return phase === 'live' && chatEnabled;
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

/**
 * The live chat's reactions line (docs/CHAT.md, "Reactions"): the taps of the last minute per kind,
 * most first; paused (lockdown, a busy computer) while the streamer has them on but viewers cannot
 * send them; null while the streamer has them off.
 */
export function reactionsLine(settingOn: boolean, eff: ChatPublicSettings | null, counts: readonly number[] | undefined): { key: MessageKey; params?: MessageParams } | null {
  if (!settingOn) return null;
  if (eff?.enabled && eff.reactions !== true) return { key: 'admin.chat.reactions.paused' };
  const kinds = CHAT_REACTIONS.map((code, i) => ({ code, n: Math.max(0, Math.floor(counts?.[i] ?? 0)) }))
    .filter((k) => k.n > 0)
    .sort((a, b) => b.n - a.n);
  if (kinds.length === 0) return { key: 'admin.chat.reactions.none' };
  const list = kinds.map((k) => t('admin.chat.reactions.item', { name: t(`chat.react.${k.code}`), count: k.n })).join(' · ');
  return { key: 'admin.chat.reactions.tally', params: { list } };
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

/** Pin choices of the menu: null for "until I unpin it", then CHAT_PIN_PRESETS_MIN (minutes). */
export const PIN_CHOICES: ReadonlyArray<{ minutes: number | null; key: MessageKey; params?: MessageParams }> = [
  { minutes: null, key: 'admin.chat.pin.untilUnpin' },
  ...CHAT_PIN_PRESETS_MIN.map((m) => (m === 60 ? { minutes: m, key: 'admin.chat.pin.hour' as const } : { minutes: m, key: 'admin.chat.pin.minutes' as const, params: { count: m } })),
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

/**
 * The people the streamer's @ list offers (docs/CHAT.md, "Replies and mentions"): authors of the
 * messages in the feed, newest first, never the streamer; like the viewers' list, only people who
 * already wrote in the chat.
 */
export function mentionableAuthors(items: readonly ChatRingItem[], roster: ReadonlyMap<string, ChatAuthor>): ChatAuthor[] {
  const seen = new Set<string>();
  const out: ChatAuthor[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.k !== 'm' || seen.has(it.a)) continue;
    seen.add(it.a);
    const au = roster.get(it.a);
    if (au && au.r !== 'streamer') out.push(au);
  }
  return out;
}

/** The streamer's author key in the feed (their messages have role streamer), if they wrote. */
export function streamerKey(roster: ReadonlyMap<string, ChatAuthor>): string | undefined {
  for (const au of roster.values()) if (au.r === 'streamer') return au.a;
  return undefined;
}

/** What the reply box shows of the message it answers: the quote the server will cut, or a GIF mark. */
export function replyPreview(item: Pick<ChatMessageItem, 'x' | 'g'>): { text: string; gif: boolean } {
  if (item.g || item.x === undefined) return { text: '', gif: !!item.g };
  const { q, cut } = cutQuote(item.x);
  return { text: `${q}${cut ? '…' : ''}`, gif: false };
}

/** The names a mention of these people can have (the streamer without a name: "Streamer" in either language). */
export function mentionCandidates(people: readonly ChatAuthor[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const p of people) {
    if (p.n) out.push({ a: p.a, n: p.n });
    else if (p.r === 'streamer') for (const lang of ['en', 'pt-BR'] as const) out.push({ a: p.a, n: translate(lang, 'chat.streamer') });
  }
  return out;
}

/**
 * A message's text in parts: plain runs and the "@Name" of each person it mentions (`mn`, checked by
 * the server), so the feed can mark them; null when the text fails the shared invariants.
 */
export function messageParts(text: string, mentioned: readonly ChatAuthor[]): Array<{ mention?: string; tokens: ChatToken[] }> | null {
  if (!checkChatInvariants(text, { maxGraphemes: 500, maxEmoji: 100 })) return null;
  const spans = mentioned.length ? findMentionSpans(text, mentionCandidates(mentioned)) : [];
  const out: Array<{ mention?: string; tokens: ChatToken[] }> = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.start > at) out.push({ tokens: tokenizeChat(text.slice(at, sp.start), EMOTES) });
    out.push({ mention: sp.a, tokens: [{ k: 't', v: text.slice(sp.start, sp.end) }] });
    at = sp.end;
  }
  if (at < text.length) out.push({ tokens: tokenizeChat(at === 0 ? text : text.slice(at), EMOTES) });
  return out;
}

/** Grapheme count of the streamer's draft and whether it fits. */
export function draftLength(text: string, max: number): { count: number; over: boolean } {
  const count = countGraphemes(text);
  return { count, over: count > max };
}

// ---------------------------------------------------------------------------
// Slash commands (docs/CHAT.md, "Slash commands"): parsed by the shared parser, run here as the
// same REST calls the panel's buttons make. The server never reads chat text as a command.
// ---------------------------------------------------------------------------

/** A person named in a command: "Ana", "@Ana" or "Ana#K3QF" (the tag tells two look-alike names apart). */
export type PersonMatch = { ok: true; sessionId: string; nickname: string } | { ok: false; key: MessageKey; params: MessageParams };

/**
 * The person watching whose nickname is `name` (compared without case, accents or separators,
 * plainNameKey), among `sessions`. Several people with that name: the tags let the streamer pick
 * one ("Ana#K3QF"); nobody, or several, is an error that says what to do.
 */
export function resolvePerson(name: string, sessions: Iterable<ChatSessionInfo>): PersonMatch {
  let wanted = name.trim();
  let tag: string | null = null;
  const hash = wanted.lastIndexOf('#');
  if (hash > 0 && /^[a-z2-7]{4}$/i.test(wanted.slice(hash + 1))) {
    tag = wanted.slice(hash + 1).toUpperCase();
    wanted = wanted.slice(0, hash).trim();
  }
  const key = plainNameKey(wanted);
  const found = [...sessions].filter((s) => plainNameKey(s.nickname) === key && (tag === null || s.tag.toUpperCase() === tag));
  if (key === '' || found.length === 0) return { ok: false, key: 'chat.cmd.err.noOne', params: { name: wanted } };
  if (found.length > 1) {
    const names = found.map((s) => `${s.nickname} #${s.tag}`).join(', ');
    return { ok: false, key: 'chat.cmd.err.many', params: { names, example: `${found[0]!.nickname}#${found[0]!.tag}` } };
  }
  const one = found[0]!;
  return { ok: true, sessionId: one.sessionId, nickname: one.nickname };
}

/** What running a command needs from the panel: the same calls its buttons make. */
export interface CommandApi {
  startPoll(body: ChatPollCreate): Promise<unknown>;
  endPoll(): Promise<unknown>;
  resolvePoll(option: number): Promise<unknown>;
  cancelPoll(): Promise<unknown>;
  send(text: string): Promise<{ s: number }>;
  pin(s: number, minutes: number | null): Promise<unknown>;
  unpin(): Promise<unknown>;
  mute(sessionId: string, minutes: number | null): Promise<unknown>;
  unmute(sessionId: string): Promise<unknown>;
  protect(mode: ChatProtect): Promise<unknown>;
  /** Slow mode, in seconds (0: off), saved with the other chat settings. */
  slow(seconds: number): Promise<unknown>;
}

export interface CommandContext {
  /** People watching (mute, unmute resolve names among them). */
  sessions: Iterable<ChatSessionInfo>;
  /** The message being replied to (`/pin` alone pins it), or null. */
  replyTo: number | null;
}

/**
 * What a command did: something for the panel to show (`ui`: the command list, the Clear question,
 * the poll form), text to send as a message (`say`), a result line (`done`), or why it did not run
 * (`error`). A failed call throws, as the buttons' calls do.
 */
export type CommandOutcome =
  | { ui: 'help' | 'clear' | 'poll' | 'prediction' }
  | { say: string }
  | { done: { key: MessageKey; params?: MessageParams } }
  | { error: { key: MessageKey; params?: MessageParams } };

/** Run a parsed command. `/clear` never clears by itself: it asks first, as the Clear button does. */
export async function runCommand(cmd: ChatCommand, ctx: CommandContext, api: CommandApi): Promise<CommandOutcome> {
  switch (cmd.id) {
    case 'help':
      return { ui: 'help' };
    case 'clear':
      return { ui: 'clear' };
    case 'say':
      return { say: cmd.text };
    case 'poll':
    case 'prediction':
      if ('form' in cmd) return { ui: cmd.id };
      await api.startPoll({ kind: cmd.id, question: cmd.question, options: cmd.options, seconds: cmd.seconds });
      return { done: { key: cmd.id === 'poll' ? 'admin.chat.cmd.done.poll' : 'admin.chat.cmd.done.prediction' } };
    case 'end':
      await api.endPoll();
      return { done: { key: 'admin.chat.cmd.done.end' } };
    case 'answer':
      await api.resolvePoll(cmd.option);
      return { done: { key: 'admin.chat.cmd.done.answer' } };
    case 'cancel':
      await api.cancelPoll();
      return { done: { key: 'admin.chat.cmd.done.cancel' } };
    case 'pin': {
      if (cmd.text === undefined) {
        if (ctx.replyTo === null) return { error: { key: 'chat.cmd.err.noReply' } };
        await api.pin(ctx.replyTo, null);
      } else {
        const r = await api.send(cmd.text);
        await api.pin(r.s, null);
      }
      return { done: { key: 'admin.chat.cmd.done.pin' } };
    }
    case 'unpin':
      await api.unpin();
      return { done: { key: 'admin.chat.cmd.done.unpin' } };
    case 'slow':
      await api.slow(cmd.seconds);
      return { done: cmd.seconds === 0 ? { key: 'admin.chat.cmd.done.slowOff' } : { key: 'admin.chat.cmd.done.slow', params: { count: cmd.seconds } } };
    case 'mute':
    case 'unmute': {
      const who = resolvePerson(cmd.name, ctx.sessions);
      if (!who.ok) return { error: { key: who.key, params: who.params } };
      if (cmd.id === 'mute') await api.mute(who.sessionId, cmd.minutes);
      else await api.unmute(who.sessionId);
      return { done: { key: cmd.id === 'mute' ? 'admin.chat.cmd.done.mute' : 'admin.chat.cmd.done.unmute', params: { name: who.nickname } } };
    }
    case 'protect':
      await api.protect(cmd.mode);
      return { done: { key: 'admin.chat.cmd.done.protect', params: { modeKey: `chat.protect.${cmd.mode}` } } };
  }
}

/** Whole percentages of `c` (0 with no votes). */
export function pollPercents(c: readonly number[]): number[] {
  const total = c.reduce((a, b) => a + b, 0);
  return c.map((n) => (total > 0 ? Math.round((n / total) * 100) : 0));
}

/** The poll form's request, or why it cannot go yet (the server checks everything again). */
export function pollRequest(kind: 'poll' | 'prediction', question: string, options: readonly string[], seconds: number, newOnly: boolean): { ok: true; body: ChatPollCreate } | { ok: false; key: MessageKey; params?: MessageParams } {
  const q = question.trim();
  if (q === '') return { ok: false, key: 'admin.chat.err.pollQuestion', params: { max: CHAT_POLL_QUESTION_MAX_GRAPHEMES } };
  const opts = options.map((o) => o.trim());
  const empty = opts.findIndex((o) => o === '');
  if (empty >= 0) return { ok: false, key: 'admin.chat.err.pollOption', params: { n: empty + 1, max: CHAT_POLL_OPTION_MAX_GRAPHEMES } };
  return { ok: true, body: { kind, question: q, options: opts, seconds, newOnly } };
}
