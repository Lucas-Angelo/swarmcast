import { graphemeBounds } from './grapheme.js';
import { IDENTIFIER_ALLOWED_RANGES, JOINING_D_RANGES, JOINING_L_RANGES, JOINING_R_RANGES, JOINING_T_RANGES, VIRAMA_RANGES } from './ucd.generated.js';

/**
 * Lookups in the generated Unicode tables (ucd.generated.ts), and per-code-point properties the
 * pipeline needs, computed once per code point with single-character `u`-flag regexes (no
 * quantifiers over user input, so no ReDoS; and no `v` flag, which older Safari cannot parse).
 */

/** A set of code-point ranges, binary-searched. */
export class RangeSet {
  private readonly lo: Uint32Array;
  private readonly hi: Uint32Array;

  constructor(encoded: string) {
    const parts = encoded ? encoded.split(',') : [];
    this.lo = new Uint32Array(parts.length);
    this.hi = new Uint32Array(parts.length);
    let prev = 0;
    parts.forEach((p, i) => {
      const plus = p.indexOf('+');
      const start = prev + parseInt(plus < 0 ? p : p.slice(0, plus), 36);
      const end = plus < 0 ? start : start + parseInt(p.slice(plus + 1), 36);
      this.lo[i] = start;
      this.hi[i] = end;
      prev = end;
    });
  }

  has(cp: number): boolean {
    let a = 0;
    let b = this.lo.length - 1;
    while (a <= b) {
      const m = (a + b) >> 1;
      if (cp < this.lo[m]!) b = m - 1;
      else if (cp > this.hi[m]!) a = m + 1;
      else return true;
    }
    return false;
  }

  get size(): number {
    return this.lo.length;
  }
}

let tables: { virama: RangeSet; jL: RangeSet; jD: RangeSet; jR: RangeSet; jT: RangeSet; allowed: RangeSet } | null = null;
function t() {
  if (!tables) {
    tables = {
      virama: new RangeSet(VIRAMA_RANGES),
      jL: new RangeSet(JOINING_L_RANGES),
      jD: new RangeSet(JOINING_D_RANGES),
      jR: new RangeSet(JOINING_R_RANGES),
      jT: new RangeSet(JOINING_T_RANGES),
      allowed: new RangeSet(IDENTIFIER_ALLOWED_RANGES),
    };
  }
  return tables;
}

export const isVirama = (cp: number): boolean => t().virama.has(cp);
/** Joining type: 'L', 'D', 'R', 'T' or 'U' (non-joining). */
export function joiningType(cp: number): 'L' | 'D' | 'R' | 'T' | 'U' {
  const x = t();
  if (x.jD.has(cp)) return 'D';
  if (x.jR.has(cp)) return 'R';
  if (x.jL.has(cp)) return 'L';
  if (x.jT.has(cp)) return 'T';
  return 'U';
}
export const isIdentifierAllowed = (cp: number): boolean => t().allowed.has(cp);

// ---------------------------------------------------------------------------
// Per-code-point property bits
// ---------------------------------------------------------------------------

export const P_MARK = 1 << 0; // Mn | Me (variation selectors excluded: see P_VS)
export const P_DI = 1 << 1; // Default_Ignorable_Code_Point
export const P_GONE = 1 << 2; // Cc, Co, Cn, noncharacters (always removed)
export const P_EXTPICT = 1 << 3; // Extended_Pictographic
export const P_EMOJI = 1 << 4; // Emoji
export const P_RI = 1 << 5; // Regional_Indicator
export const P_MOD = 1 << 6; // Emoji_Modifier
export const P_MODBASE = 1 << 7; // Emoji_Modifier_Base
export const P_VISIBLE = 1 << 8; // L | N | P | S
export const P_IDEO = 1 << 9; // Ideographic
export const P_MONG = 1 << 10; // Script=Mongolian
export const P_ZS = 1 << 11; // Space_Separator
export const P_LATINISH = 1 << 12; // Script_Extensions ⊆ {Latin, Common, Inherited}
export const P_LETTER = 1 << 13; // L
export const P_DIGIT = 1 << 14; // Nd
export const P_ANYMARK = 1 << 15; // M (Mn, Mc, Me)
export const P_PUNCT = 1 << 16; // P
export const P_WS = 1 << 17; // White_Space

const RE: Array<[number, RegExp]> = [
  [P_MARK, /^[\p{Mn}\p{Me}]$/u],
  [P_DI, /^\p{Default_Ignorable_Code_Point}$/u],
  [P_GONE, /^[\p{Cc}\p{Co}\p{Cn}\p{Noncharacter_Code_Point}]$/u],
  [P_EXTPICT, /^\p{Extended_Pictographic}$/u],
  [P_EMOJI, /^\p{Emoji}$/u],
  [P_RI, /^\p{Regional_Indicator}$/u],
  [P_MOD, /^\p{Emoji_Modifier}$/u],
  [P_MODBASE, /^\p{Emoji_Modifier_Base}$/u],
  [P_VISIBLE, /^[\p{L}\p{N}\p{P}\p{S}]$/u],
  [P_IDEO, /^\p{Ideographic}$/u],
  [P_MONG, /^\p{Script=Mongolian}$/u],
  [P_ZS, /^\p{Zs}$/u],
  [P_LATINISH, /^[\p{Script_Extensions=Latin}\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]$/u],
  [P_LETTER, /^\p{L}$/u],
  [P_DIGIT, /^\p{Nd}$/u],
  [P_ANYMARK, /^\p{M}$/u],
  [P_PUNCT, /^\p{P}$/u],
  [P_WS, /^\p{White_Space}$/u],
];

const cache = new Map<number, number>();
const CACHE_MAX = 8192;

/** Property bits of one code point (cached; the cache is bounded). */
export function props(cp: number): number {
  const hit = cache.get(cp);
  if (hit !== undefined) return hit;
  const ch = String.fromCodePoint(cp);
  let bits = 0;
  for (const [bit, re] of RE) if (re.test(ch)) bits |= bit;
  if (isVariationSelector(cp)) bits &= ~P_MARK;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(cp, bits);
  return bits;
}

export const ZWNJ = 0x200c;
export const ZWJ = 0x200d;
export const VS15 = 0xfe0e;
export const VS16 = 0xfe0f;
export const KEYCAP = 0x20e3;

export function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180d) || cp === 0x180f;
}
export const isTag = (cp: number): boolean => cp >= 0xe0020 && cp <= 0xe007f;
/** Explicit bidi embeddings, overrides and isolates (removed). */
export const isBidiExplicit = (cp: number): boolean => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
/** Implicit bidi marks LRM, RLM, ALM (kept up to a cap). */
export const isBidiImplicit = (cp: number): boolean => cp === 0x200e || cp === 0x200f || cp === 0x061c;
/** Visually blank characters that are not default-ignorable (removed). */
export const isBlank = (cp: number): boolean => (cp >= 0xfff9 && cp <= 0xfffc) || cp === 0x2800 || cp === 0x1d159;
/** Line and paragraph breaks and tabs (become a space). */
export const isLineBreak = (cp: number): boolean => (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0x2028 || cp === 0x2029;

/**
 * Removal set R of the pipeline (plan §2.3 step 4), except the implicit-mark cap: always-removed
 * categories, bidi explicit controls, blank characters and default-ignorables other than the
 * joiners, variation selectors and tags, which later steps keep only in valid contexts.
 */
export function inRemovalSet(cp: number): boolean {
  const p = props(cp);
  if (p & P_GONE) return true;
  if (isBidiExplicit(cp) || isBlank(cp)) return true;
  if (p & P_DI) {
    if (cp === ZWJ || cp === ZWNJ || isVariationSelector(cp) || isTag(cp) || isBidiImplicit(cp)) return false;
    return true;
  }
  return false;
}

/** Code points of `s` (assumed well-formed). */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out.push(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000);
        i++;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** String.prototype.isWellFormed, without needing it (Safari before 16.4). */
export function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** UTF-8 length of a well-formed string. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Graphemes of `s` (UAX #29 extended grapheme clusters, pure TypeScript: grapheme.ts). */
export function graphemes(s: string): string[] {
  const cps = codePoints(s);
  const b = graphemeBounds(cps);
  const out: string[] = [];
  for (let i = 0; i + 1 < b.length; i++) out.push(String.fromCodePoint(...cps.slice(b[i], b[i + 1])));
  return out;
}

/** Graphemes of `s` as code-point arrays. */
export function graphemeCodePoints(s: string): number[][] {
  const cps = codePoints(s);
  const b = graphemeBounds(cps);
  const out: number[][] = [];
  for (let i = 0; i + 1 < b.length; i++) out.push(cps.slice(b[i], b[i + 1]));
  return out;
}

/** Number of graphemes (what users count as characters). */
export function countGraphemes(s: string): number {
  return graphemeBounds(codePoints(s)).length - 1;
}
