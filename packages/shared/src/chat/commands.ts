import type { MessageKey, MessageParams } from '../i18n/index.js';
import { CHAT_MUTE_MAX_MIN, CHAT_POLL_OPTIONS_MAX, CHAT_POLL_OPTIONS_MIN, CHAT_POLL_SECONDS_DEFAULT, CHAT_POLL_SECONDS_MAX, CHAT_POLL_SECONDS_MIN, CHAT_SLOW_MODE_MAX_S } from './limits.js';

/**
 * Slash commands (docs/CHAT.md, "Slash commands"): a pure parser shared by the panel's message box
 * and the viewer's. No DOM, no network, never throws, linear in its input (no regex that can
 * backtrack). The server never reads commands: the panel turns one into the same REST call its
 * buttons make, and a viewer's `/help` is answered on the page. Text that does not start with a
 * known command name is not a command (`null`), so chat habits like "/o/" or "/s" stay text.
 *
 * Names and words are matched in both languages whatever the page's language, ignoring case and
 * accents (`/AJUDA` = `/ajúda` = `/help`). `//text` sends "/text" as a message.
 */

export type CommandId = 'help' | 'poll' | 'prediction' | 'end' | 'answer' | 'cancel' | 'pin' | 'unpin' | 'clear' | 'slow' | 'mute' | 'unmute' | 'protect';

export interface ChatCommandDef {
  id: CommandId;
  /** Names without the "/", in English and in Portuguese (the first of each is the one shown). */
  aliases: { en: readonly string[]; pt: readonly string[] };
  /** Who may use it: viewers have only /help. */
  who: 'streamer' | 'everyone';
  /** How to write it ("/poll [time] Question | Option 1 | Option 2") and what it does, in one line. */
  usage: MessageKey;
  help: MessageKey;
}

export const CHAT_COMMANDS: readonly ChatCommandDef[] = [
  { id: 'help', aliases: { en: ['help', '?'], pt: ['ajuda'] }, who: 'everyone', usage: 'chat.cmd.help.usage', help: 'chat.cmd.help.help' },
  { id: 'poll', aliases: { en: ['poll'], pt: ['enquete'] }, who: 'streamer', usage: 'chat.cmd.poll.usage', help: 'chat.cmd.poll.help' },
  { id: 'prediction', aliases: { en: ['prediction'], pt: ['palpite'] }, who: 'streamer', usage: 'chat.cmd.prediction.usage', help: 'chat.cmd.prediction.help' },
  { id: 'end', aliases: { en: ['end'], pt: ['encerrar'] }, who: 'streamer', usage: 'chat.cmd.end.usage', help: 'chat.cmd.end.help' },
  { id: 'answer', aliases: { en: ['answer'], pt: ['resposta'] }, who: 'streamer', usage: 'chat.cmd.answer.usage', help: 'chat.cmd.answer.help' },
  { id: 'cancel', aliases: { en: ['cancel'], pt: ['cancelar'] }, who: 'streamer', usage: 'chat.cmd.cancel.usage', help: 'chat.cmd.cancel.help' },
  { id: 'pin', aliases: { en: ['pin'], pt: ['fixar'] }, who: 'streamer', usage: 'chat.cmd.pin.usage', help: 'chat.cmd.pin.help' },
  { id: 'unpin', aliases: { en: ['unpin'], pt: ['desafixar'] }, who: 'streamer', usage: 'chat.cmd.unpin.usage', help: 'chat.cmd.unpin.help' },
  { id: 'clear', aliases: { en: ['clear'], pt: ['limpar'] }, who: 'streamer', usage: 'chat.cmd.clear.usage', help: 'chat.cmd.clear.help' },
  { id: 'slow', aliases: { en: ['slow'], pt: ['lento'] }, who: 'streamer', usage: 'chat.cmd.slow.usage', help: 'chat.cmd.slow.help' },
  { id: 'mute', aliases: { en: ['mute'], pt: ['silenciar'] }, who: 'streamer', usage: 'chat.cmd.mute.usage', help: 'chat.cmd.mute.help' },
  { id: 'unmute', aliases: { en: ['unmute'], pt: ['dessilenciar'] }, who: 'streamer', usage: 'chat.cmd.unmute.usage', help: 'chat.cmd.unmute.help' },
  { id: 'protect', aliases: { en: ['protect'], pt: ['proteger'] }, who: 'streamer', usage: 'chat.cmd.protect.usage', help: 'chat.cmd.protect.help' },
];

/** A mute without a length lasts this many minutes (the panel's middle choice). */
export const COMMAND_MUTE_DEFAULT_MIN = 10;

export type ChatCommand =
  | { id: 'help' }
  /** Without arguments: open the form. */
  | { id: 'poll' | 'prediction'; form: true }
  | { id: 'poll' | 'prediction'; question: string; options: string[]; seconds: number }
  | { id: 'end' }
  /** The right answer, from 0 (people type it from 1, as the options are numbered on screen). */
  | { id: 'answer'; option: number }
  | { id: 'cancel' }
  /** With text: post it and pin it; without: pin the message being replied to. */
  | { id: 'pin'; text?: string }
  | { id: 'unpin' }
  | { id: 'clear' }
  | { id: 'slow'; seconds: number }
  /** `name` as typed (an "@" in front dropped; "Name#TAG" picks one of two look-alikes); `minutes` null: until the end of the live. */
  | { id: 'mute'; name: string; minutes: number | null }
  | { id: 'unmute'; name: string }
  | { id: 'protect'; mode: 'off' | 'slow' | 'lockdown' }
  /** "//text": not a command, send "/text" as a message. */
  | { id: 'say'; text: string };

export type ParsedCommand = { ok: true; cmd: ChatCommand } | { ok: false; id?: CommandId; code: MessageKey; params?: MessageParams };

/** Case and accents folded ("Enquête" → "enquete"): how names and words are compared. */
export function foldCommandWord(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const BY_ALIAS = new Map<string, ChatCommandDef>();
for (const c of CHAT_COMMANDS) for (const a of [...c.aliases.en, ...c.aliases.pt]) BY_ALIAS.set(foldCommandWord(a), c);

const OFF_WORDS = new Set(['off', 'desligar', 'desligado', 'desliga', 'normal', 'nao', 'no', 'none', 'nenhum']);
const SLOW_WORDS = new Set(['slow', 'lento', 'devagar']);
const LOCKDOWN_WORDS = new Set(['lockdown', 'bloqueio', 'bloquear', 'travar', 'lock']);
const LIVE_WORDS = new Set(['live', 'end', 'ao-vivo', 'aovivo', 'ate-o-fim', 'ateofim', 'fim', 'stream']);

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0 || c === 0x3000;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** Whitespace-separated words (one pass). */
function words(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const end = i === s.length || isSpace(s.charCodeAt(i));
    if (end) {
      if (start >= 0) out.push(s.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
  }
  return out;
}

/** `s` without leading and trailing whitespace (one pass each way). */
function trim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

const UNITS: Record<string, number> = { s: 1, sec: 1, seg: 1, segs: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600 };

/**
 * A length such as "30s", "2m", "2min", "1m30s" or "1h", in seconds; a bare number counts as
 * `bareUnit` seconds each (null: a bare number is not a length). Null when it is not a length.
 */
export function parseCommandDuration(word: string, bareUnit: number | null): number | null {
  const w = foldCommandWord(word);
  if (w.length === 0 || w.length > 16) return null;
  let total = 0;
  let i = 0;
  let parts = 0;
  while (i < w.length) {
    const d0 = i;
    while (i < w.length && isDigit(w.charCodeAt(i))) i++;
    if (i === d0 || i - d0 > 5) return null;
    const n = Number(w.slice(d0, i));
    const u0 = i;
    while (i < w.length && !isDigit(w.charCodeAt(i))) i++;
    const unit = w.slice(u0, i);
    parts++;
    if (unit === '') {
      if (bareUnit === null || parts > 1) return null;
      total += n * bareUnit;
      continue;
    }
    const mult = UNITS[unit];
    if (mult === undefined) return null;
    total += n * mult;
  }
  return total;
}

/** A known command name typed so far ("/enq" → poll), for the panel's suggestion list: every command whose name starts with `prefix`. */
export function suggestCommands(prefix: string, who: 'streamer' | 'viewer'): ChatCommandDef[] {
  const p = foldCommandWord(prefix);
  return CHAT_COMMANDS.filter((c) => (who === 'streamer' || c.who === 'everyone') && [...c.aliases.en, ...c.aliases.pt].some((a) => foldCommandWord(a).startsWith(p)));
}

/** The name a command is shown with in `lang` ("enquete" in Portuguese), and the other language's. */
export function commandNames(c: ChatCommandDef, lang: 'en' | 'pt-BR'): { main: string; other: string } {
  const [mine, theirs] = lang === 'pt-BR' ? [c.aliases.pt, c.aliases.en] : [c.aliases.en, c.aliases.pt];
  return { main: mine[0]!, other: theirs[0]! };
}

const usage = (def: ChatCommandDef): ParsedCommand => ({ ok: false, id: def.id, code: 'chat.cmd.err.usage', params: { usageKey: def.usage } });

/**
 * Read a line the person typed. `null`: not a command, send it as a message. Otherwise the command
 * with its arguments, or why it cannot run (a message key: wrong use, a viewer typing a streamer
 * command…). `who`: a viewer has only /help; any other known name gets "only the streamer".
 */
export function parseCommand(input: string, who: 'streamer' | 'viewer'): ParsedCommand | null {
  if (typeof input !== 'string') return null;
  const line = trim(input);
  if (line.charCodeAt(0) !== 0x2f /* / */) return null;
  if (line.charCodeAt(1) === 0x2f) return { ok: true, cmd: { id: 'say', text: line.slice(1) } };
  let end = 1;
  while (end < line.length && !isSpace(line.charCodeAt(end))) end++;
  const name = line.slice(1, end);
  if (name.length === 0 || name.length > 20) return null;
  const def = BY_ALIAS.get(foldCommandWord(name));
  if (!def) return null;
  if (def.who === 'streamer' && who === 'viewer') return { ok: false, id: def.id, code: 'chat.cmd.err.streamerOnly' };
  const rest = trim(line.slice(end));
  switch (def.id) {
    case 'help':
    case 'end':
    case 'cancel':
    case 'unpin':
    case 'clear':
      return { ok: true, cmd: { id: def.id } };
    case 'poll':
    case 'prediction':
      return parsePoll(def, rest);
    case 'answer': {
      const w = words(rest);
      const n = w.length === 1 && /^\d{1,2}$/.test(w[0]!) ? Number(w[0]) : NaN;
      if (!(n >= 1 && n <= CHAT_POLL_OPTIONS_MAX)) return { ok: false, id: def.id, code: 'chat.cmd.err.answer', params: { max: CHAT_POLL_OPTIONS_MAX } };
      return { ok: true, cmd: { id: 'answer', option: n - 1 } };
    }
    case 'pin':
      return { ok: true, cmd: rest === '' ? { id: 'pin' } : { id: 'pin', text: rest } };
    case 'slow': {
      const w = words(rest);
      if (w.length !== 1) return usage(def);
      if (OFF_WORDS.has(foldCommandWord(w[0]!))) return { ok: true, cmd: { id: 'slow', seconds: 0 } };
      const s = parseCommandDuration(w[0]!, 1);
      if (s === null || s > CHAT_SLOW_MODE_MAX_S) return { ok: false, id: def.id, code: 'chat.cmd.err.slow', params: { max: CHAT_SLOW_MODE_MAX_S } };
      return { ok: true, cmd: { id: 'slow', seconds: s } };
    }
    case 'mute': {
      const w = words(rest);
      if (w.length === 0) return usage(def);
      let minutes: number | null = COMMAND_MUTE_DEFAULT_MIN;
      const last = w[w.length - 1]!;
      if (w.length > 1 && LIVE_WORDS.has(foldCommandWord(last))) {
        minutes = null;
        w.pop();
      } else if (w.length > 1) {
        const s = parseCommandDuration(last, 60);
        if (s !== null) {
          if (s < 60 || s > CHAT_MUTE_MAX_MIN * 60) return { ok: false, id: def.id, code: 'chat.cmd.err.muteLength', params: { max: CHAT_MUTE_MAX_MIN } };
          minutes = Math.round(s / 60);
          w.pop();
        }
      }
      return { ok: true, cmd: { id: 'mute', name: personName(w.join(' ')), minutes } };
    }
    case 'unmute':
      if (rest === '') return usage(def);
      return { ok: true, cmd: { id: 'unmute', name: personName(rest) } };
    case 'protect': {
      const w = words(rest).map(foldCommandWord);
      const word = w.length === 1 ? w[0]! : '';
      if (OFF_WORDS.has(word)) return { ok: true, cmd: { id: 'protect', mode: 'off' } };
      if (SLOW_WORDS.has(word)) return { ok: true, cmd: { id: 'protect', mode: 'slow' } };
      if (LOCKDOWN_WORDS.has(word)) return { ok: true, cmd: { id: 'protect', mode: 'lockdown' } };
      return usage(def);
    }
  }
}

/** A person's name as typed after a command: without an "@" in front. */
function personName(s: string): string {
  return s.startsWith('@') ? trim(s.slice(1)) : s;
}

/**
 * "/poll [time] Question | Option 1 | Option 2 …": a length first is optional ("30s", "2m",
 * "1m30s"; a bare number is part of the question), options split on "|" (or ";" when there is
 * no "|"); empty options are dropped.
 */
function parsePoll(def: ChatCommandDef, rest: string): ParsedCommand {
  const id = def.id as 'poll' | 'prediction';
  if (rest === '') return { ok: true, cmd: { id, form: true } };
  let seconds = CHAT_POLL_SECONDS_DEFAULT;
  let body = rest;
  let end = 0;
  while (end < rest.length && !isSpace(rest.charCodeAt(end))) end++;
  const first = rest.slice(0, end);
  const after = trim(rest.slice(end));
  const len = parseCommandDuration(first, null);
  if (len !== null && after !== '') {
    seconds = len;
    body = after;
  }
  const sep = body.includes('|') ? '|' : ';';
  const parts = body.split(sep).map(trim);
  const question = parts[0] ?? '';
  const options = parts.slice(1).filter((o) => o !== '');
  if (question === '' || parts.length < 2) return usage(def);
  if (options.length < CHAT_POLL_OPTIONS_MIN || options.length > CHAT_POLL_OPTIONS_MAX) return { ok: false, id, code: 'chat.cmd.err.options', params: { min: CHAT_POLL_OPTIONS_MIN, max: CHAT_POLL_OPTIONS_MAX } };
  if (seconds < CHAT_POLL_SECONDS_MIN || seconds > CHAT_POLL_SECONDS_MAX) return { ok: false, id, code: 'chat.cmd.err.duration', params: { min: CHAT_POLL_SECONDS_MIN, max: CHAT_POLL_SECONDS_MAX / 60 } };
  return { ok: true, cmd: { id, question, options, seconds } };
}
