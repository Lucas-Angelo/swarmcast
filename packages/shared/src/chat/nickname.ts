import { CHAT_RESERVED_NAMES } from './limits.js';
import { NICKNAME_MAX } from '../constants.js';
import { P_ANYMARK, P_DI, P_DIGIT, P_LETTER, P_WS, codePoints, graphemeCodePoints, isIdentifierAllowed, isWellFormedString, props, utf8Length } from './ucd.js';

/**
 * Nickname rules v2 (docs/CHAT.md). Nicknames are visible to everyone in the live, so they must
 * never break a layout, hide, or impersonate. An allowlist:
 *
 * - NFC; whitespace of any kind becomes one space; trimmed;
 * - each code point is a letter or decimal digit allowed by UTS #39 (Identifier_Status=Allowed,
 *   which excludes default-ignorables, the Hangul fillers, obsolete scripts and compatibility
 *   forms), a combining mark directly after a letter, or one of space, "_", "." and "-";
 *   no emoji, symbols, other punctuation, controls, format, private-use or unassigned characters;
 * - marks: at most 2 in a row after a letter and 3 per grapheme (accents, Indic vowel signs and
 *   Thai tone marks fit; stacking does not);
 * - at least one letter or digit; 2 to 24 graphemes and at most 64 UTF-8 bytes;
 * - one script (UTS #39 Moderately Restrictive: one script, or Latin plus one other except
 *   Cyrillic and Greek; Han with Hiragana/Katakana, Hangul or Bopomofo counts as one);
 * - not a reserved name ("Streamer", "admin", …) in any case, spacing or accents.
 *
 * The server also refuses names whose confusable skeleton matches a live viewer's (skeleton.ts).
 */

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX_BYTES = 64;
/** Raw input bound (UTF-16 units) before any work. */
const NICKNAME_MAX_INPUT = 200;
const MAX_MARK_RUN = 2;
const MAX_MARKS_PER_GRAPHEME = 3;

export type NicknameError = 'nickname.empty' | 'nickname.tooShort' | 'nickname.tooLong' | 'nickname.chars' | 'nickname.marks' | 'nickname.mixed' | 'nickname.reserved';

export type NicknameResult = { ok: true; value: string } | { ok: false; code: NicknameError; params?: Record<string, number> };

const SEPARATORS = new Set([0x20, 0x5f, 0x2e, 0x2d]); // space _ . -

// UTS #39 Table 5, Recommended scripts. Identifier_Status=Allowed only has these (plus Common
// and Inherited).
const SCRIPTS = ['Arab', 'Armn', 'Beng', 'Bopo', 'Cyrl', 'Deva', 'Ethi', 'Geor', 'Grek', 'Gujr', 'Guru', 'Hang', 'Hani', 'Hebr', 'Hira', 'Knda', 'Kana', 'Khmr', 'Laoo', 'Latn', 'Mlym', 'Mymr', 'Orya', 'Sinh', 'Taml', 'Telu', 'Thaa', 'Thai', 'Tibt'] as const;
const BIT = Object.fromEntries(SCRIPTS.map((s, i) => [s, 2 ** i])) as Record<(typeof SCRIPTS)[number], number>;
const JPAN = 2 ** 29;
const KORE = 2 ** 30;
const HANB = 2 ** 31;
const ALL = 2 ** 32 - 1;
const CYRL_GREK = BIT.Cyrl + BIT.Grek;

let scriptRes: Array<[number, RegExp]> | null = null;
let commonRe: RegExp | null = null;
const scriptCache = new Map<number, number>();

/** Augmented script set of a code point (UTS #39 §5.1) as a bit set; ALL for Common/Inherited. */
function scriptSet(cp: number): number {
  const hit = scriptCache.get(cp);
  if (hit !== undefined) return hit;
  if (!scriptRes) {
    scriptRes = SCRIPTS.map((s) => [BIT[s], new RegExp(`^\\p{Script_Extensions=${s}}$`, 'u')]);
    commonRe = /^[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]$/u;
  }
  const ch = String.fromCodePoint(cp);
  let set = 0;
  for (const [bit, re] of scriptRes) if (re.test(ch)) set += bit;
  if (set === 0 && commonRe!.test(ch)) set = ALL;
  else {
    // Bit arithmetic with >>> 0: the set uses all 32 bits.
    if (set & BIT.Hani) set = (set | JPAN | KORE | HANB) >>> 0;
    if (set & (BIT.Hira | BIT.Kana)) set = (set | JPAN) >>> 0;
    if (set & BIT.Hang) set = (set | KORE) >>> 0;
    if (set & BIT.Bopo) set = (set | HANB) >>> 0;
  }
  if (scriptCache.size > 4096) scriptCache.clear();
  scriptCache.set(cp, set);
  return set;
}

/** UTS #39 Moderately Restrictive over the letters, digits and marks of `cps`. */
export function scriptsOk(cps: readonly number[]): boolean {
  let all = ALL;
  let nonLatin = ALL;
  let anyNonLatin = false;
  for (const cp of cps) {
    if (SEPARATORS.has(cp)) continue;
    const s = scriptSet(cp);
    if (s === 0) return false;
    all = (all & s) >>> 0;
    if (!(s & BIT.Latn)) {
      nonLatin = (nonLatin & s) >>> 0;
      anyNonLatin = true;
    }
  }
  if (all !== 0) return true;
  // Latin plus one other script, except Cyrillic and Greek (the classic Latin look-alikes).
  return anyNonLatin && nonLatin !== 0 && (nonLatin & ~CYRL_GREK) >>> 0 !== 0;
}

/** A name with case, accents, spaces and "_.-" removed: for the reserved-name check. */
export function plainNameKey(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKD').toLowerCase().toUpperCase().toLowerCase()) {
    const cp = ch.codePointAt(0)!;
    if (SEPARATORS.has(cp) || props(cp) & P_ANYMARK) continue;
    out += ch;
  }
  return out;
}

const RESERVED = new Set<string>(CHAT_RESERVED_NAMES);

/** Is this (already canonical) name reserved? `extra`: more reserved plain keys (the streamer's chat name). */
export function isReservedName(value: string, extra: Iterable<string> = []): boolean {
  const k = plainNameKey(value);
  if (RESERVED.has(k)) return true;
  for (const e of extra) if (e && plainNameKey(e) === k) return true;
  return false;
}

/** Validate and canonicalise a nickname. The same function runs on the join page and on the server. */
export function validateNickname(raw: unknown, opts: { reserved?: Iterable<string> } = {}): NicknameResult {
  if (typeof raw !== 'string') return { ok: false, code: 'nickname.empty' };
  if (raw.length > NICKNAME_MAX_INPUT) return { ok: false, code: 'nickname.tooLong', params: { max: NICKNAME_MAX } };
  if (!isWellFormedString(raw)) return { ok: false, code: 'nickname.chars' };
  // NFC, any whitespace to one space, trim (one linear pass).
  const folded: number[] = [];
  let space = true;
  for (const cp of codePoints(raw.normalize('NFC'))) {
    if (props(cp) & P_WS) {
      if (!space) folded.push(0x20);
      space = true;
      continue;
    }
    folded.push(cp);
    space = false;
  }
  while (folded.length && folded[folded.length - 1] === 0x20) folded.pop();
  if (folded.length === 0) return { ok: false, code: 'nickname.empty' };

  let letters = 0;
  let run = 0;
  let afterLetter = false;
  for (const cp of folded) {
    if (SEPARATORS.has(cp)) {
      run = 0;
      afterLetter = false;
      continue;
    }
    const p = props(cp);
    if (p & P_DI || !isIdentifierAllowed(cp)) return { ok: false, code: 'nickname.chars' };
    if (p & P_ANYMARK) {
      if (!afterLetter) return { ok: false, code: 'nickname.chars' };
      if (++run > MAX_MARK_RUN) return { ok: false, code: 'nickname.marks' };
      continue;
    }
    if (p & P_LETTER) {
      letters++;
      afterLetter = true;
      run = 0;
      continue;
    }
    if (p & P_DIGIT) {
      letters++;
      afterLetter = false;
      run = 0;
      continue;
    }
    return { ok: false, code: 'nickname.chars' };
  }
  if (letters === 0) return { ok: false, code: 'nickname.chars' };

  const value = String.fromCodePoint(...folded);
  let count = 0;
  for (const g of graphemeCodePoints(value)) {
    count++;
    let marks = 0;
    for (const cp of g) if (props(cp) & P_ANYMARK) marks++;
    if (marks > MAX_MARKS_PER_GRAPHEME) return { ok: false, code: 'nickname.marks' };
  }
  if (count < NICKNAME_MIN) return { ok: false, code: 'nickname.tooShort', params: { min: NICKNAME_MIN } };
  if (count > NICKNAME_MAX || utf8Length(value) > NICKNAME_MAX_BYTES) return { ok: false, code: 'nickname.tooLong', params: { max: NICKNAME_MAX } };
  if (!scriptsOk(folded)) return { ok: false, code: 'nickname.mixed' };
  if (isReservedName(value, opts.reserved)) return { ok: false, code: 'nickname.reserved' };
  return { ok: true, value };
}
