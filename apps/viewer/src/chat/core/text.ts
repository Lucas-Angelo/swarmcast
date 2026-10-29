// The client re-check of the server's output (plan §2.2, §2.3 "Client re-check").
// TEMPORARY local copy: packages/shared/src/chat/text.ts (lane A / C1, part 2) owns this; once
// they land, core/index.ts re-exports theirs. Kept to the same names and rules.
//
// Rules for code shipped to the viewer (plan §2.4.1b): no `v`-flag regex literal (Safari 16 would
// fail to parse the whole module), every property regex is built at first use inside try/catch,
// and each check degrades on its own when the browser lacks a feature (Intl.Segmenter,
// \p{…} escapes). The server's output is authoritative; this only stops a server bug from
// reaching the DOM.

import {
  CHAT_EMOJI_MAX_CODEPOINTS,
  CHAT_GRAPHEME_MAX_CODEPOINTS,
  CHAT_MAX_BIDI_MARKS,
  CHAT_MAX_EMOJI_MAX,
  CHAT_MAX_GRAPHEMES_MAX,
  CHAT_MAX_MARK_RUN,
  CHAT_TEXT_MAX_BYTES,
  CHAT_TEXT_MAX_UNITS,
} from '@swarmcast/shared/chat';

type Lazy = () => RegExp | null;
/** A regex built on first use; null where this browser cannot parse it (the check is skipped). */
function lazyRe(src: string): Lazy {
  let re: RegExp | null | undefined;
  return () => {
    if (re === undefined) {
      try {
        re = new RegExp(src, 'u');
      } catch {
        re = null;
      }
    }
    return re;
  };
}
const MARK = lazyRe('^[\\p{Mn}\\p{Me}]$');
const PICTO = lazyRe('\\p{Extended_Pictographic}');

let segmenter: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** Graphemes of `s` (code points where Intl.Segmenter is missing: Firefox before 125). */
export function graphemes(s: string): string[] {
  const seg = graphemeSegmenter();
  if (!seg) return Array.from(s);
  const out: string[] = [];
  for (const g of seg.segment(s)) out.push(g.segment);
  return out;
}

export function countGraphemes(s: string): number {
  const seg = graphemeSegmenter();
  if (!seg) return Array.from(s).length;
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

/** Plan §2.3 step 6c: the grapheme counts as emoji. */
export function isEmojiGrapheme(g: string): boolean {
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x1f1e6 && cp <= 0x1f1ff) || cp === 0x20e3 || cp === 0xfe0f || (cp >= 0xe0020 && cp <= 0xe007f)) return true;
  }
  return PICTO()?.test(g) ?? false;
}

export function countEmoji(s: string): number {
  let n = 0;
  for (const g of graphemes(s)) if (isEmojiGrapheme(g)) n++;
  return n;
}

export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** No lone surrogate (String.prototype.isWellFormed is missing before Safari 16.4). */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const isTag = (cp: number): boolean => cp >= 0xe0020 && cp <= 0xe007f;
const isSelector = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180d) || cp === 0x180f;
const isImplicitBidiMark = (cp: number): boolean => cp === 0x200e || cp === 0x200f || cp === 0x061c;

/**
 * Removal set R of plan §2.3 step 4 that may never reach the DOM, as fixed ranges (no regex):
 * controls, non-space separators, private use, noncharacters, bidi explicit controls, the
 * Default_Ignorable_Code_Point set (Unicode 17) minus the joiners, selectors, tags and implicit
 * marks that are checked in context, and the visually blank characters.
 */
export function isForbiddenCodePoint(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true; // Cc, newlines and tabs included
  if (cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000) return true; // Zs other than U+0020
  if (cp === 0x2028 || cp === 0x2029) return true; // Zl, Zp
  if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return true; // Co (planes 15 and 16 hold nothing else)
  if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true; // noncharacters
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return true; // bidi explicit
  // Default_Ignorable_Code_Point, except ZWNJ/ZWJ, LRM/RLM/ALM, selectors and tags
  if (cp === 0xad || cp === 0x34f || cp === 0x115f || cp === 0x1160 || cp === 0x17b4 || cp === 0x17b5 || cp === 0x180e || cp === 0x200b) return true;
  if ((cp >= 0x2060 && cp <= 0x206f) || cp === 0x3164 || cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff0 && cp <= 0xfff8)) return true;
  if ((cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a)) return true;
  if (cp >= 0xe0000 && cp <= 0xe0fff && !isTag(cp) && !(cp >= 0xe0100 && cp <= 0xe01ef)) return true;
  if ((cp >= 0xfff9 && cp <= 0xfffc) || cp === 0x2800 || cp === 0x1d159) return true; // visually blank
  return false;
}

export interface InvariantLimits {
  maxGraphemes: number;
  maxEmoji: number;
}

export type InvariantResult = { ok: true } | { ok: false; reason: string };

/**
 * The safety properties every rendered text must have (plan §2.3, "Client re-check"). Not a
 * second pipeline: it never rewrites, it only says whether the text may be shown.
 */
export function checkChatInvariants(text: string, limits: InvariantLimits = { maxGraphemes: CHAT_MAX_GRAPHEMES_MAX, maxEmoji: CHAT_MAX_EMOJI_MAX }): InvariantResult {
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > CHAT_TEXT_MAX_UNITS * 3) return { ok: false, reason: 'length' };
  if (!isWellFormed(text)) return { ok: false, reason: 'surrogate' };
  if (utf8Bytes(text) > CHAT_TEXT_MAX_BYTES) return { ok: false, reason: 'bytes' };
  const mark = MARK();
  let run = 0;
  let prevMark = -1;
  let bidiMarks = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isForbiddenCodePoint(cp)) return { ok: false, reason: `forbidden U+${cp.toString(16).toUpperCase()}` };
    if (isImplicitBidiMark(cp) && ++bidiMarks > CHAT_MAX_BIDI_MARKS) return { ok: false, reason: 'bidi marks' };
    if (mark) {
      if (mark.test(ch)) {
        if (++run > CHAT_MAX_MARK_RUN || cp === prevMark) return { ok: false, reason: 'marks' };
        prevMark = cp;
      } else {
        run = 0;
        prevMark = -1;
      }
    }
  }
  if (!graphemeSegmenter()) return { ok: true }; // the per-grapheme rules need Intl.Segmenter
  let count = 0;
  let emoji = 0;
  for (const g of graphemes(text)) {
    count++;
    const cps = Array.from(g);
    const isEmoji = isEmojiGrapheme(g);
    if (cps.length > (isEmoji ? CHAT_EMOJI_MAX_CODEPOINTS : CHAT_GRAPHEME_MAX_CODEPOINTS)) return { ok: false, reason: 'grapheme size' };
    let selectors = 0;
    for (const c of cps) {
      const cp = c.codePointAt(0) ?? 0;
      // RGI ZWJ sequences may carry one VS16 per component (🏌️‍♂️, 👁️‍🗨️): bounded by the 10
      // code points of an emoji grapheme. Everything else: one selector per grapheme.
      if (isSelector(cp) && !(isEmoji && cp === 0xfe0f) && ++selectors > 1) return { ok: false, reason: 'selectors' };
      if (isTag(cp) && cps[0]?.codePointAt(0) !== 0x1f3f4) return { ok: false, reason: 'tags' };
    }
    if (isEmoji) emoji++;
  }
  if (count > limits.maxGraphemes) return { ok: false, reason: 'graphemes' };
  if (emoji > limits.maxEmoji) return { ok: false, reason: 'emoji' };
  return { ok: true };
}
