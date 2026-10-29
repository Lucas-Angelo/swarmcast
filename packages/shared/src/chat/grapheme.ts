import { EXTPICT_RANGES, GCB_RANGES, INCB_RANGES } from './grapheme.generated.js';
import { RangeSet } from './ucd.js';

/**
 * Extended grapheme clusters (UAX #29, Unicode 17.0) in plain TypeScript, from the pinned tables.
 * The chat never relies on Intl.Segmenter: the packaged server embeds a small-ICU Node without
 * break-iterator data, and browsers ship other Unicode versions. The server and every client
 * therefore count and cut graphemes identically. Checked against GraphemeBreakTest.txt.
 */

/** Classed range table (start, end, class letter), binary-searched. */
class ClassedRanges {
  private readonly lo: number[] = [];
  private readonly hi: number[] = [];
  private readonly cls: string[] = [];

  constructor(encoded: string) {
    let prev = 0;
    let num = '';
    let len = '';
    let inLen = false;
    for (const ch of encoded) {
      if (ch >= 'A' && ch <= 'Z') {
        const start = prev + parseInt(num, 36);
        const end = len ? start + parseInt(len, 36) : start;
        this.lo.push(start);
        this.hi.push(end);
        this.cls.push(ch);
        prev = end;
        num = '';
        len = '';
        inLen = false;
      } else if (ch === '+') inLen = true;
      else if (inLen) len += ch;
      else num += ch;
    }
  }

  get(cp: number): string {
    let a = 0;
    let b = this.lo.length - 1;
    while (a <= b) {
      const m = (a + b) >> 1;
      if (cp < this.lo[m]!) b = m - 1;
      else if (cp > this.hi[m]!) a = m + 1;
      else return this.cls[m]!;
    }
    return '';
  }
}

let tables: { gcb: ClassedRanges; incb: ClassedRanges; ext: RangeSet } | null = null;
function t() {
  if (!tables) tables = { gcb: new ClassedRanges(GCB_RANGES), incb: new ClassedRanges(INCB_RANGES), ext: new RangeSet(EXTPICT_RANGES) };
  return tables;
}

/** Grapheme_Cluster_Break class letter ('' = Other). */
export const gcbOf = (cp: number): string => t().gcb.get(cp);
export const isExtendedPictographic = (cp: number): boolean => t().ext.has(cp);

/**
 * Start index of every grapheme in `cps`, plus `cps.length` at the end
 * (so grapheme i is cps.slice(b[i], b[i + 1])).
 */
export function graphemeBounds(cps: readonly number[]): number[] {
  const out: number[] = [];
  if (cps.length === 0) return [0];
  const { gcb, incb, ext } = t();
  out.push(0);
  let prev = gcb.get(cps[0]!);
  let prevIncb = incb.get(cps[0]!);
  // GB11: an Extended_Pictographic, then Extend*, then (this) ZWJ.
  let emoji = ext.has(cps[0]!) ? 1 : 0;
  // GB12/13: regional indicators in the current run.
  let ri = prev === 'I' ? 1 : 0;
  // GB9c: 0 none, 1 consonant seen, 2 consonant + linker seen (through InCB Extend/Linker only).
  let conj = prevIncb === 'C' ? 1 : 0;
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i]!;
    const cur = gcb.get(cp);
    const curIncb = incb.get(cp);
    const curExt = ext.has(cp);
    let brk: boolean;
    if (prev === 'R' && cur === 'N') brk = false; // GB3
    else if (prev === 'R' || prev === 'N' || prev === 'C') brk = true; // GB4
    else if (cur === 'R' || cur === 'N' || cur === 'C') brk = true; // GB5
    else if (prev === 'L' && (cur === 'L' || cur === 'V' || cur === 'W' || cur === 'X')) brk = false; // GB6
    else if ((prev === 'W' || prev === 'V') && (cur === 'V' || cur === 'T')) brk = false; // GB7
    else if ((prev === 'X' || prev === 'T') && cur === 'T') brk = false; // GB8
    else if (cur === 'E' || cur === 'Z') brk = false; // GB9
    else if (cur === 'S') brk = false; // GB9a
    else if (prev === 'P') brk = false; // GB9b
    else if (curIncb === 'C' && conj === 2 && (prevIncb === 'E' || prevIncb === 'L')) brk = false; // GB9c
    else if (prev === 'Z' && emoji === 2 && curExt) brk = false; // GB11
    else if (prev === 'I' && cur === 'I' && ri % 2 === 1) brk = false; // GB12, GB13
    else brk = true; // GB999
    if (brk) out.push(i);

    // Update the context for the next pair.
    if (curExt) emoji = 1;
    else if (cur === 'E' && emoji === 1) emoji = 1;
    else if (cur === 'Z' && emoji === 1) emoji = 2;
    else emoji = 0;
    ri = cur === 'I' ? (prev === 'I' ? ri + 1 : 1) : 0;
    if (curIncb === 'C') conj = 1;
    else if (curIncb === 'L' && conj >= 1) conj = 2;
    else if (!(curIncb === 'E' && conj >= 1)) conj = 0;
    prev = cur;
    prevIncb = curIncb;
  }
  out.push(cps.length);
  return out;
}
