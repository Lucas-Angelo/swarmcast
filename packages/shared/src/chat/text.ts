import {
  CHAT_EMOJI_MAX_CODEPOINTS,
  CHAT_EMOJI_MAX_ZWJ,
  CHAT_GRAPHEME_MAX_CODEPOINTS,
  CHAT_MAX_BIDI_MARKS,
  CHAT_MAX_DROPPED_MARKS,
  CHAT_MAX_EMOJI_DEFAULT,
  CHAT_MAX_GRAPHEMES_DEFAULT,
  CHAT_MAX_MARK_RUN,
  CHAT_TEXT_MAX_BYTES,
  CHAT_TEXT_MAX_UNITS,
} from './limits.js';
import {
  KEYCAP,
  P_EMOJI,
  P_EXTPICT,
  P_IDEO,
  P_LATINISH,
  P_MARK,
  P_MOD,
  P_MODBASE,
  P_MONG,
  P_RI,
  P_VISIBLE,
  P_ZS,
  VS15,
  VS16,
  ZWJ,
  ZWNJ,
  codePoints,
  graphemeCodePoints,
  inRemovalSet,
  isBidiExplicit,
  isBidiImplicit,
  isLineBreak,
  isTag,
  isVariationSelector,
  isVirama,
  isWellFormedString,
  joiningType,
  props,
  utf8Length,
} from './ucd.js';
import { graphemeBounds } from './grapheme.js';

/**
 * The chat's Unicode pipeline (docs/CHAT.md, plan §2.3). Pure, synchronous, linear in the input
 * (whose size is checked first). The server's output is authoritative; clients run
 * checkChatInvariants before rendering and use canonicalizeChatText only to count.
 */

export type ChatTextReject = 'text.tooLong' | 'text.empty' | 'text.invalid' | 'text.combining' | 'text.tooManyEmoji' | 'text.script';

export interface ChatTextOptions {
  maxGraphemes?: number;
  maxEmoji?: number;
  /** 'latin': every grapheme must be Latin, Common or Inherited. */
  scripts?: 'any' | 'latin';
}

export type ChatTextResult =
  | { ok: true; text: string; graphemes: number; emoji: number; dropped: number }
  | { ok: false; code: ChatTextReject; params?: Record<string, number>; dropped: number };

let rgiEmoji: RegExp | null | undefined;
/**
 * `^\p{RGI_Emoji}$` (needs the `v` flag: Node 20, Chrome 112, Firefox 116, Safari 17). Built at
 * first use inside try/catch: a `v` literal would be a parse error that takes the whole module
 * down on older browsers. null when unsupported.
 */
function rgi(): RegExp | null {
  if (rgiEmoji === undefined) {
    try {
      rgiEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
    } catch {
      rgiEmoji = null;
    }
  }
  return rgiEmoji;
}

/** Is this grapheme an emoji (pictograph, flag, keycap, tag sequence or emoji presentation)? */
function isEmojiGrapheme(cps: readonly number[]): boolean {
  for (const cp of cps) {
    const p = props(cp);
    if (p & (P_EXTPICT | P_RI) || cp === KEYCAP || isTag(cp) || cp === VS16) return true;
  }
  return false;
}

function isSimpleEmoji(cps: readonly number[]): boolean {
  const base = cps[0]!;
  if (cps.length === 1) return (props(base) & (P_EXTPICT | P_RI | P_EMOJI)) !== 0;
  if (cps.length !== 2 || !(props(base) & P_EMOJI)) return false;
  return cps[1] === VS16 || ((props(cps[1]!) & P_MOD) !== 0 && (props(base) & P_MODBASE) !== 0);
}

/** Steps 3 and 4: fold line breaks and spaces, drop the removal set, cap implicit bidi marks. */
function foldAndRemove(cps: readonly number[]): number[] {
  const out: number[] = [];
  let bidiMarks = 0;
  let space = true; // drops leading spaces
  for (const cp of cps) {
    if (isLineBreak(cp) || cp === 0x20 || props(cp) & P_ZS) {
      if (!space) out.push(0x20);
      space = true;
      continue;
    }
    if (inRemovalSet(cp)) continue;
    if (isBidiImplicit(cp)) {
      if (++bidiMarks > CHAT_MAX_BIDI_MARKS) continue;
    }
    out.push(cp);
    space = false;
  }
  while (out.length && out[out.length - 1] === 0x20) out.pop();
  return out;
}

/** Step 6b: may this ZWJ/ZWNJ (outside emoji) stay? RFC 5892 Appendix A.1 / A.2. */
function joinerAllowed(all: readonly number[], i: number): boolean {
  const prev = i > 0 ? all[i - 1]! : -1;
  if (prev >= 0 && isVirama(prev)) return true;
  if (all[i] !== ZWNJ) return false;
  let l = i - 1;
  while (l >= 0 && joiningType(all[l]!) === 'T') l--;
  const lt = l >= 0 ? joiningType(all[l]!) : 'U';
  if (lt !== 'L' && lt !== 'D') return false;
  let r = i + 1;
  while (r < all.length && joiningType(all[r]!) === 'T') r++;
  const rt = r < all.length ? joiningType(all[r]!) : 'U';
  return rt === 'R' || rt === 'D';
}

/** Step 6d: may this variation selector stay after `base`? */
function selectorAllowed(vs: number, base: number | undefined): boolean {
  if (base === undefined) return false;
  const p = props(base);
  if (vs === VS15 || vs === VS16) return (p & P_EMOJI) !== 0;
  if (vs >= 0xe0100) return (p & P_IDEO) !== 0;
  if (vs >= 0x180b && vs <= 0x180f) return (p & P_MONG) !== 0;
  return false;
}

interface Pass {
  cps: number[];
  dropped: number;
}

/** Step 6a–e over every grapheme of `s` (NFC already applied). */
function graphemePass(s: string): Pass {
  const all = codePoints(s);
  const bounds = graphemeBounds(all);

  const out: number[] = [];
  let dropped = 0;
  for (let b = 0; b + 1 < bounds.length; b++) {
    const start = bounds[b]!;
    const g = all.slice(start, bounds[b + 1]);
    let kept: number[];
    if (isEmojiGrapheme(g)) {
      const re = rgi();
      let zwj = 0;
      for (const cp of g) if (cp === ZWJ) zwj++;
      const valid = isSimpleEmoji(g) || (re !== null && re.test(fromCodePoints(g)) && g.length <= CHAT_EMOJI_MAX_CODEPOINTS && zwj <= CHAT_EMOJI_MAX_ZWJ);
      if (valid) kept = g;
      else {
        // Not a recommended sequence: keep the base characters, drop joiners, tags, keycaps,
        // selectors and stray skin-tone modifiers.
        kept = [];
        let run = 0;
        let prevMark = -1;
        for (const cp of g) {
          if (cp === ZWJ || cp === ZWNJ || isTag(cp) || cp === KEYCAP || isVariationSelector(cp)) continue;
          const p = props(cp);
          if (p & P_MARK) {
            if (run >= CHAT_MAX_MARK_RUN || cp === prevMark) {
              dropped++;
              continue;
            }
            run++;
            prevMark = cp;
            kept.push(cp);
            continue;
          }
          if (p & P_MOD) {
            const last = kept[kept.length - 1];
            if (last === undefined || !(props(last) & P_MODBASE)) continue;
          }
          run = 0;
          prevMark = -1;
          kept.push(cp);
        }
        // Nothing to split off (the next round sees the pieces as separate graphemes): cap it.
        if (kept.length === g.length && kept.length > CHAT_EMOJI_MAX_CODEPOINTS) kept.length = CHAT_EMOJI_MAX_CODEPOINTS;
      }
    } else {
      kept = [];
      let run = 0;
      let prevMark = -1;
      let selectors = 0;
      for (let k = 0; k < g.length; k++) {
        const cp = g[k]!;
        if (props(cp) & P_MARK) {
          if (run >= CHAT_MAX_MARK_RUN || cp === prevMark) {
            dropped++;
            continue;
          }
          run++;
          prevMark = cp;
          kept.push(cp);
          continue;
        }
        if (cp === ZWJ || cp === ZWNJ) {
          if (joinerAllowed(all, start + k)) kept.push(cp);
          continue;
        }
        if (isVariationSelector(cp)) {
          if (selectors === 0 && selectorAllowed(cp, kept[kept.length - 1])) {
            selectors++;
            kept.push(cp);
          }
          continue;
        }
        if (isTag(cp)) continue;
        run = 0;
        prevMark = -1;
        kept.push(cp);
      }
      if (kept.length > CHAT_GRAPHEME_MAX_CODEPOINTS) kept.length = CHAT_GRAPHEME_MAX_CODEPOINTS;
    }
    for (const cp of kept) out.push(cp);
  }
  return { cps: out, dropped };
}

/** Collapse space runs (left by removed joiners or selectors) and trim. */
function collapseSpaces(cps: readonly number[]): number[] {
  const out: number[] = [];
  for (const cp of cps) {
    if (cp === 0x20 && (out.length === 0 || out[out.length - 1] === 0x20)) continue;
    out.push(cp);
  }
  while (out.length && out[out.length - 1] === 0x20) out.pop();
  return out;
}

/** String of code points, in chunks (spreading a huge array can hit the argument limit). */
export function fromCodePoints(cps: readonly number[]): string {
  let out = '';
  for (let i = 0; i < cps.length; i += 4096) out += String.fromCodePoint(...cps.slice(i, i + 4096));
  return out;
}

/** Steps 1–6: canonical text plus the number of marks dropped. */
function canonicalText(input: string): { text: string; dropped: number } {
  let s = fromCodePoints(foldAndRemove(codePoints(input))).normalize('NFC');
  let dropped = 0;
  // Dropping marks or joiners can let NFC compose further, which can in turn change the mark
  // runs; repeat until stable (each round only removes code points, so it ends; 1–2 rounds).
  for (let round = 0; round < 4; round++) {
    const pass = graphemePass(s);
    dropped += pass.dropped;
    const next = fromCodePoints(collapseSpaces(pass.cps)).normalize('NFC');
    if (next === s) break;
    s = next;
  }
  return { text: s, dropped };
}


/** Count graphemes, visible graphemes and emoji graphemes of canonical text. */
export function measureChatText(s: string): { graphemes: number; visible: number; emoji: number; latinOnly: boolean } {
  const parts = graphemeCodePoints(s);
  let visible = 0;
  let emoji = 0;
  let latinOnly = true;
  for (const cps of parts) {
    let vis = false;
    for (const cp of cps) {
      const p = props(cp);
      if (p & P_VISIBLE) vis = true;
      if (!(p & P_LATINISH)) latinOnly = false;
    }
    if (vis) visible++;
    if (isEmojiGrapheme(cps)) emoji++;
  }
  return { graphemes: parts.length, visible, emoji, latinOnly };
}

/**
 * Canonicalise and validate one chat message (plan §2.3). Never truncates silently: too long is
 * a reject, so the sender keeps their text and can shorten it.
 */
export function canonicalizeChatText(input: string, opts: ChatTextOptions = {}): ChatTextResult {
  const maxGraphemes = opts.maxGraphemes ?? CHAT_MAX_GRAPHEMES_DEFAULT;
  const maxEmoji = opts.maxEmoji ?? CHAT_MAX_EMOJI_DEFAULT;
  // 1. Size guard, before any other work.
  if (input.length > CHAT_TEXT_MAX_UNITS) return { ok: false, code: 'text.tooLong', params: { max: maxGraphemes }, dropped: 0 };
  // 2. Well-formed UTF-16 (a lone surrogate means a broken or hostile client: never repaired).
  if (!isWellFormedString(input)) return { ok: false, code: 'text.invalid', dropped: 0 };
  // 3–6.
  const { text, dropped } = canonicalText(input);
  // 7. Decision.
  const m = measureChatText(text);
  if (m.visible === 0) return { ok: false, code: 'text.empty', dropped };
  if (dropped > CHAT_MAX_DROPPED_MARKS) return { ok: false, code: 'text.combining', dropped };
  if (m.graphemes > maxGraphemes) return { ok: false, code: 'text.tooLong', params: { max: maxGraphemes }, dropped };
  if (m.emoji > maxEmoji) return { ok: false, code: 'text.tooManyEmoji', params: { max: maxEmoji }, dropped };
  if (utf8Length(text) > CHAT_TEXT_MAX_BYTES) return { ok: false, code: 'text.tooLong', params: { max: maxGraphemes }, dropped };
  // 8. Script policy.
  if (opts.scripts === 'latin' && !m.latinOnly) return { ok: false, code: 'text.script', dropped };
  return { ok: true, text, graphemes: m.graphemes, emoji: m.emoji, dropped };
}

/**
 * The client's re-check before rendering (plan §2.3, "Client re-check"): the safety properties
 * of the server's output, not equality with this build's pipeline (browsers ship other Unicode
 * versions). Steps that need a missing feature are skipped; the server is authoritative.
 */
export function checkChatInvariants(text: string, opts: { maxGraphemes?: number; maxEmoji?: number } = {}): boolean {
  if (typeof text !== 'string' || text.length > CHAT_TEXT_MAX_UNITS) return false;
  if (!isWellFormedString(text)) return false;
  if (utf8Length(text) > CHAT_TEXT_MAX_BYTES) return false;
  let run = 0;
  let prevMark = -1;
  let bidi = 0;
  for (const cp of codePoints(text)) {
    if (isBidiExplicit(cp) || isLineBreak(cp)) return false;
    if (inRemovalSet(cp)) return false;
    if (isBidiImplicit(cp) && ++bidi > CHAT_MAX_BIDI_MARKS) return false;
    if (props(cp) & P_MARK) {
      if (run >= CHAT_MAX_MARK_RUN || cp === prevMark) return false;
      run++;
      prevMark = cp;
    } else if (!isVariationSelector(cp) && cp !== ZWJ && cp !== ZWNJ) {
      run = 0;
      prevMark = -1;
    }
  }
  let n = 0;
  let emoji = 0;
  for (const cps of graphemeCodePoints(text)) {
    n++;
    const isEmoji = isEmojiGrapheme(cps);
    if (cps.length > (isEmoji ? CHAT_EMOJI_MAX_CODEPOINTS : CHAT_GRAPHEME_MAX_CODEPOINTS)) return false;
    if (isEmoji) emoji++;
  }
  return n <= (opts.maxGraphemes ?? 500) && emoji <= (opts.maxEmoji ?? 100);
}
