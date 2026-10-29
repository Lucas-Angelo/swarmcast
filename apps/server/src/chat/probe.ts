import { canonicalizeChatText, countGraphemes, validateNickname } from '@swarmcast/shared';
import { comparisonKey } from '@swarmcast/shared/chat/skeleton';
import { UCD_VERSION } from '@swarmcast/shared/chat/ucd';

export interface IntlProbe {
  ok: boolean;
  unicode: string | undefined;
  icu: string | undefined;
  expectedUnicode: string;
  /** Informational: the chat does not use these (the packaged Node has small ICU). */
  info: { segmenter: boolean; ptBR: boolean };
  problems: string[];
}

/**
 * What the chat pipeline needs from the runtime (`swarmcast --probe-intl`), checked on every
 * packaged binary the build can run. The packaged Node has small ICU (no break iterators, English
 * locale data only), so the pipeline uses its own grapheme segmentation (grapheme.ts) and relies
 * on ICU only for what small ICU has: normalization, case mapping and regex Unicode properties,
 * all at the Unicode version of the generated tables.
 */
export function probeIntl(): IntlProbe {
  const problems: string[] = [];
  const check = (name: string, fn: () => boolean): void => {
    try {
      if (!fn()) problems.push(name);
    } catch (e) {
      problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const unicode = process.versions.unicode;
  check(`Unicode ${unicode} = tables ${UCD_VERSION}`, () => unicode === UCD_VERSION);
  check('NFC', () => 'e\u{301}'.normalize('NFC') === '\u{E9}');
  check('NFD', () => '\u{E9}'.normalize('NFD') === 'e\u{301}');
  check('NFKC(U+FDFA) has 18 units', () => '\u{FDFA}'.normalize('NFKC').length === 18);
  check('NFKC fullwidth', () => '\u{FF46}\u{FF55}'.normalize('NFKC') === 'fu');
  check('case mapping', () => '\u{DF}'.toUpperCase() === 'SS' && '\u{130}'.toLowerCase().length === 2);
  check('regex Default_Ignorable_Code_Point', () => /^\p{Default_Ignorable_Code_Point}$/u.test('\u{3164}'));
  check('regex Script_Extensions', () => /^\p{Script_Extensions=Devanagari}$/u.test('\u{915}') && /^\p{Script_Extensions=Cyrillic}$/u.test('\u{430}'));
  check('regex Extended_Pictographic', () => /^\p{Extended_Pictographic}$/u.test('\u{1F600}'));
  check('regex RGI_Emoji (v flag)', () => new RegExp('^\\p{RGI_Emoji}$', 'v').test('\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'));
  check('grapheme segmentation', () => countGraphemes('\u{915}\u{94D}\u{937}\u{93F}\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}') === 2);
  check('pipeline', () => {
    const r = canonicalizeChatText('a\u{202E}b \u{1F44D}\u{1F3FD} Ol\u{E1}');
    return r.ok && r.text === 'ab \u{1F44D}\u{1F3FD} Ol\u{E1}' && r.graphemes === 8;
  });
  check('nickname rules', () => validateNickname('Nguye\u{302}\u{303}n').ok && !validateNickname('\u{405}treamer').ok);
  check('skeleton', () => comparisonKey('\u{FF46}\u{FF55}\u{FF43}\u{FF4B}') === comparisonKey('fuck'));
  const info = { segmenter: false, ptBR: false };
  try {
    info.segmenter = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment('ab')].length === 2;
  } catch {}
  try {
    info.ptBR = new Intl.NumberFormat('pt-BR').format(1.5) === '1,5';
  } catch {}
  return { ok: problems.length === 0, unicode, icu: process.versions.icu, expectedUnicode: UCD_VERSION, info, problems };
}
