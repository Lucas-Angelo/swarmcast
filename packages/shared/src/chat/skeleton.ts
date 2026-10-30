import { CONFUSABLES } from './confusables.generated.js';
import { P_DI, P_PUNCT, P_WS, codePoints, props } from './ucd.js';

/**
 * UTS #39 confusable skeletons and the chat's comparison key. Server only: the confusables table
 * is ~60 KB and never goes into the viewer bundle (import '@swarmcast/shared/chat/skeleton').
 */

let table: Map<number, string> | null = null;
function prototypes(): Map<number, string> {
  if (!table) {
    table = new Map();
    for (const entry of CONFUSABLES.split(',')) {
      const colon = entry.indexOf(':');
      const src = parseInt(entry.slice(0, colon), 36);
      const target = String.fromCodePoint(...entry.slice(colon + 1).split('.').map((c) => parseInt(c, 36)));
      table.set(src, target);
    }
  }
  return table;
}

/** UTS #39 §4 skeleton: NFD, drop default-ignorables, map each character to its prototype, NFD. */
export function skeleton(s: string): string {
  const map = prototypes();
  let out = '';
  for (const cp of codePoints(s.normalize('NFD'))) {
    if (props(cp) & P_DI) continue;
    out += map.get(cp) ?? String.fromCodePoint(cp);
  }
  return out.normalize('NFD');
}

/** Full case folding, approximated with the case mappings JavaScript has (ß → ss, ς → σ). */
export function caseFold(s: string): string {
  return s.toLowerCase().toUpperCase().toLowerCase();
}

/** Drop spaces and punctuation from a key. */
function strip(k: string): string {
  let out = '';
  for (const cp of codePoints(k)) if (!(props(cp) & (P_WS | P_PUNCT))) out += String.fromCodePoint(cp);
  return out;
}

/**
 * Comparison key of a text (never displayed): skeleton(casefold(NFKC(s))) with spaces and
 * punctuation removed. Used for blocked words and duplicate detection.
 */
export function comparisonKey(s: string): string {
  return strip(skeleton(caseFold(s.normalize('NFKC'))));
}

/**
 * Keys of a nickname for uniqueness and reserved names: two people clash when any key matches.
 * The second key folds case after the skeleton, because the skeleton maps "I" to "l" but folding
 * first would turn it into "i" ("Iucas" must clash with "lucas", "IDIOTA" with "idiota").
 */
export function nameKeys(s: string): [string, string] {
  const n = s.normalize('NFKC');
  return [strip(skeleton(caseFold(n))), strip(skeleton(caseFold(skeleton(n))))];
}
