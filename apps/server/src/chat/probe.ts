import { UCD_VERSION } from '@swarmcast/shared/chat/ucd';

export interface IntlProbe {
  ok: boolean;
  unicode: string | undefined;
  icu: string | undefined;
  expectedUnicode: string;
  /** Graphemes of a Devanagari conjunct + a family emoji: 2 with full ICU and current rules. */
  graphemes: number;
  /** NFKC of U+FDFA has 18 UTF-16 units (UAX #15). */
  nfkcFdfa: number;
  /** pt-BR locale data present (full ICU). */
  ptBR: boolean;
  problems: string[];
}

/**
 * What the chat pipeline needs from the runtime's ICU (`swarmcast --probe-intl`): the Unicode
 * version the generated tables were made from, grapheme segmentation and normalization. The
 * package build runs it on every binary it can execute.
 */
export function probeIntl(): IntlProbe {
  const problems: string[] = [];
  const unicode = process.versions.unicode;
  if (unicode !== UCD_VERSION) problems.push(`Unicode ${unicode} != tables ${UCD_VERSION}`);
  let graphemes = -1;
  try {
    graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment('क\u{94D}ष\u{93F}\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}')].length;
  } catch (e) {
    problems.push(`Intl.Segmenter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (graphemes !== 2) problems.push(`grapheme segmentation gave ${graphemes}, expected 2`);
  const nfkcFdfa = 'ﷺ'.normalize('NFKC').length;
  if (nfkcFdfa !== 18) problems.push(`NFKC(U+FDFA) has ${nfkcFdfa} units, expected 18`);
  let ptBR = false;
  try {
    ptBR = new Intl.NumberFormat('pt-BR').format(1.5) === '1,5';
  } catch {}
  if (!ptBR) problems.push('pt-BR locale data missing');
  return { ok: problems.length === 0, unicode, icu: process.versions.icu, expectedUnicode: UCD_VERSION, graphemes, nfkcFdfa, ptBR, problems };
}
