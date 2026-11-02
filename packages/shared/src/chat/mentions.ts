import { gcbOf } from './grapheme.js';
import { CHAT_MENTION_SUGGESTIONS, CHAT_MENTIONS_MAX } from './limits.js';
import { plainNameKey } from './nickname.js';
import { P_ANYMARK, P_DIGIT, P_LETTER, props } from './ucd.js';

/**
 * @mentions (docs/CHAT.md, "Replies and mentions"), shared by the server, the viewer and the panel.
 *
 * A mention is "@" + a person's nickname, exactly as it is (canonical text), not inside a word
 * (nothing that is a letter, digit or mark right before the "@", nor right after a name that ends in
 * one), so "ana@Ana.com" or "@Anabela" never mention "Ana", and never in the middle of a grapheme
 * (a mark or a joiner right after the name belongs to its last character). The client finds them in the text it
 * sends and names the people by author key (`mn`); the server checks each key against the text again
 * and against its own rules, so the key list is only a claim. Resolving by key plus the exact name is
 * what makes a look-alike name ("@Аna" with a Cyrillic А) mention nobody: nicknames are unique by
 * confusable skeleton among the people watching (skeleton.ts).
 *
 * Everything here is linear in the text (one pass, candidates looked up by the name's first unit),
 * and client-safe (no `v`-flag regex, no big tables).
 */

/** Someone who can be mentioned: author key and nickname. */
export interface MentionCandidate {
  a: string;
  n: string;
}

/** A mention found in a text: UTF-16 offsets of "@Name" (`end` exclusive) and whom it names. */
export interface MentionSpan {
  start: number;
  end: number;
  a: string;
}

const UNDERSCORE = 0x5f;

/** Letters, digits, marks and "_": what a mention may not touch on either side. */
function isWordCp(cp: number): boolean {
  return cp === UNDERSCORE || (props(cp) & (P_LETTER | P_DIGIT | P_ANYMARK)) !== 0;
}

/** Extend, ZWJ, SpacingMark: a code point that joins the grapheme before it (UAX #29 GB9, GB9a). */
function joinsPrevious(cp: number): boolean {
  const g = gcbOf(cp);
  return g === 'E' || g === 'Z' || g === 'S';
}

/** The code point that ends right before offset `i` (-1 at the start). */
function cpBefore(s: string, i: number): number {
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.codePointAt(i - 2)!;
  }
  return c;
}

/** Candidates grouped by the first UTF-16 unit of their name, longest name first ("Ana Maria" before "Ana"). */
function index(candidates: Iterable<MentionCandidate>): Map<string, MentionCandidate[]> {
  const by = new Map<string, MentionCandidate[]>();
  for (const c of candidates) {
    if (typeof c.n !== 'string' || c.n.length === 0) continue;
    const k = c.n[0]!;
    let list = by.get(k);
    if (!list) by.set(k, (list = []));
    list.push(c);
  }
  for (const list of by.values()) list.sort((x, y) => y.n.length - x.n.length);
  return by;
}

/**
 * Every mention of a candidate in `text`, left to right, without overlaps: at each "@" the longest
 * name that fits wins. Candidates with an empty name are ignored.
 */
export function findMentionSpans(text: string, candidates: Iterable<MentionCandidate>): MentionSpan[] {
  const out: MentionSpan[] = [];
  if (typeof text !== 'string' || text.indexOf('@') < 0) return out;
  const by = index(candidates);
  if (by.size === 0) return out;
  for (let i = text.indexOf('@'); i >= 0 && i < text.length; i = text.indexOf('@', i + 1)) {
    const before = cpBefore(text, i);
    // A Prepend character before the "@" would make the "@" part of its grapheme.
    if (before >= 0 && (isWordCp(before) || gcbOf(before) === 'P')) continue;
    const list = by.get(text[i + 1] ?? '');
    if (!list) continue;
    for (const c of list) {
      const end = i + 1 + c.n.length;
      if (!text.startsWith(c.n, i + 1)) continue;
      // A name that ends in a letter, digit or mark must not run on into a longer word.
      const last = cpBefore(text, end);
      const next = end < text.length ? text.codePointAt(end)! : -1;
      if (next >= 0 && (joinsPrevious(next) || (isWordCp(last) && isWordCp(next)))) continue;
      out.push({ start: i, end, a: c.a });
      i = end - 1;
      break;
    }
  }
  return out;
}

/**
 * The author keys a text mentions (`mn` of chat.send): distinct, in order, never `self`, at most
 * CHAT_MENTIONS_MAX. Derived from the text at send time, so a name picked from the list and then
 * deleted is not sent.
 */
export function mentionKeys(text: string, candidates: Iterable<MentionCandidate>, self?: string): string[] {
  const keys: string[] = [];
  for (const sp of findMentionSpans(text, candidates)) {
    if (sp.a === self || keys.includes(sp.a)) continue;
    keys.push(sp.a);
    if (keys.length >= CHAT_MENTIONS_MAX) break;
  }
  return keys;
}

/** Longest query the @ list reacts to (UTF-16 units after the "@"): a nickname is at most 64 bytes. */
const QUERY_MAX = 64;

/**
 * The name being typed at the caret: the "@" it starts at and what follows it. Null when the caret is
 * not inside a mention being typed (no "@" before it in this word, an "@" inside a word, a query that
 * ends in a space, which is how a picked name ends, or one too long to be a name).
 */
export function mentionQuery(text: string, caret: number): { start: number; prefix: string } | null {
  if (typeof text !== 'string' || caret < 1 || caret > text.length) return null;
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0 || caret - at - 1 > QUERY_MAX) return null;
  const before = cpBefore(text, at);
  if (before >= 0 && isWordCp(before)) return null;
  const prefix = text.slice(at + 1, caret);
  if (prefix.includes('@') || /\s$/.test(prefix)) return null;
  return { start: at, prefix };
}

/**
 * Up to `max` candidates whose name starts like `prefix`, ignoring case, accents and separators
 * (plainNameKey: "ana m" finds "Ana Maria", "joao" finds "João"). Names that start with the prefix
 * exactly come first; otherwise the caller's order is kept (most recent writer first).
 */
export function suggestMentions<T extends MentionCandidate>(prefix: string, candidates: readonly T[], max = CHAT_MENTION_SUGGESTIONS): T[] {
  const key = plainNameKey(prefix);
  const exact: T[] = [];
  const loose: T[] = [];
  for (const c of candidates) {
    if (!c.n) continue;
    if (c.n.startsWith(prefix)) exact.push(c);
    else if (plainNameKey(c.n).startsWith(key)) loose.push(c);
  }
  return [...exact, ...loose].slice(0, max);
}

/** The text with the query at `start`…`caret` replaced by "@Name " and the caret after it. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const insert = `@${name}${rest.startsWith(' ') ? '' : ' '}`;
  return { text: text.slice(0, start) + insert + rest, caret: start + insert.length + (rest.startsWith(' ') ? 1 : 0) };
}
