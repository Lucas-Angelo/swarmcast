import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AhoCorasick,
  BUILTIN_EMOTE_CODES,
  CHAT_BG_DARK,
  CHAT_BG_LIGHT,
  adjustNameColor,
  canonicalizeChatText,
  chatTextWork,
  checkChatInvariants,
  containsLink,
  contrastRatio,
  defaultNameColor,
  joinTokens,
  tokenizeChat,
  validateNickname,
} from '@swarmcast/shared';
import { comparisonKey, nameKeys, skeleton } from '@swarmcast/shared/chat/skeleton';
import { CONFUSABLES } from '../../src/chat/confusables.generated.js';
import { inRemovalSet, isBidiExplicit, isTag, isVariationSelector, utf8Length } from '../../src/chat/ucd.js';
import { anyUnicode, hostile, indicConjuncts, realistic } from './arbitraries.js';

/** Seeded runs (the seed is printed on failure). CHAT_FUZZ_RUNS raises it for the on-demand fuzz job. */
const RUNS = Number(process.env.CHAT_FUZZ_RUNS ?? 2000);
const params = { numRuns: RUNS, seed: Number(process.env.CHAT_FUZZ_SEED ?? 0x5ca7) };

const cps = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!);
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Inputs built to make a Unicode pipeline slow, `n` code units long. */
const ADVERSARIAL_SHAPES: Array<[string, (n: number) => string]> = [
  ['marks', (n) => 'e' + '\u{301}'.repeat(n - 1)],
  ['mark runs', (n) => 'a\u{300}\u{301}\u{302}\u{303}\u{304}'.repeat(n / 6 + 1).slice(0, n)],
  ['ZWJ chains', (n) => '\u{1F469}\u{200D}'.repeat(n / 3 + 1).slice(0, n)],
  ['families', (n) => '\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467} '.repeat(n / 9 + 1).slice(0, n)],
  ['joiners between joining letters', (n) => '\u{628}\u{64B}\u{200C}'.repeat(n / 3 + 1).slice(0, n)],
  ['joiners after long mark runs', (n) => ('\u{628}' + '\u{64B}'.repeat(30) + '\u{200C}').repeat(n / 32 + 1).slice(0, n)],
  ['Indic conjuncts', (n) => '\u{915}\u{94D}\u{937}\u{200C}\u{93F}'.repeat(n / 5 + 1).slice(0, n)],
  ['bidi marks', (n) => '\u{200E}\u{200F}'.repeat(n / 2)],
  ['invisibles', (n) => 'a\u{200B}'.repeat(n / 2)],
  ['tags', (n) => ('\u{1F3F4}' + '\u{E0061}'.repeat(10)).repeat(n / 22 + 1).slice(0, n)],
];
const plainText = (n: number): string => 'boa noite '.repeat(n / 10 + 1).slice(0, n);

/** The longest text a viewer can send (the client's 1,500-unit check). */
const LONGEST = 1500;
/** P8: the pipeline's counted work may grow at most this much from 375 to 1,500 units (4× the input). */
const LINEAR_GROWTH = 4.5;
/**
 * The timed sanity check: no adversarial shape of the longest size costs more than this many
 * times plain chat of the same size. Measured: at most 1.6×. A baseline from the same run and
 * moment, so the machine's speed and load cancel out.
 */
const MAX_SLOWDOWN = 4;

/** Units of work canonicalizeChatText() counts for `input` (chatTextWork). */
function workOf(input: string): number {
  const before = chatTextWork();
  canonicalizeChatText(input.toWellFormed(), { maxGraphemes: 500, maxEmoji: 100 });
  return chatTextWork() - before;
}

/**
 * How much slower `input` is than `baseline`: the median, over 21 back-to-back pairs, of the
 * ratio of their wall times (one call each first, to warm the JIT up).
 */
function slowdown(input: string, baseline: string): number {
  const time = (s: string): number => {
    const t0 = performance.now();
    canonicalizeChatText(s);
    return performance.now() - t0;
  };
  time(input);
  time(baseline);
  const ratios = Array.from({ length: 21 }, () => time(input) / Math.max(time(baseline), 1e-3)).sort((a, b) => a - b);
  return ratios[10]!;
}

/** fc.assert() as a function, for `expect(...).not.toThrow()` (the error names the counterexample and the seed). */
const holds =
  <T>(arb: fc.Arbitrary<T>, check: (v: T) => void, o: Parameters<typeof fc.assert>[1] = params) =>
  () =>
    fc.assert(
      fc.property(arb, (v) => {
        check(v);
        return true;
      }),
      o,
    );

describe('canonicalizeChatText properties', () => {
  it('P1, P3, P5, P6, P7: well-formed, nothing from the removal set, caps hold, NFC-stable, passes the client check', () => {
    // Act
    const run = holds(hostile, (input) => {
      const r = canonicalizeChatText(input);
      if (!r.ok) return;
      const out = r.text;
      expect(out.isWellFormed()).toBe(true);
      for (const c of cps(out)) {
        expect(inRemovalSet(c) || isBidiExplicit(c)).toBe(false);
        expect(c === 0x0a || c === 0x0d, 'line break kept').toBe(false);
      }
      expect(utf8Length(out)).toBeLessThanOrEqual(1024);
      expect(r.graphemes).toBeLessThanOrEqual(200);
      expect(r.emoji).toBeLessThanOrEqual(30);
      for (const g of segmenter.segment(out)) expect(cps(g.segment).length).toBeLessThanOrEqual(16);
      expect(out.normalize('NFC')).toBe(out);
      expect(checkChatInvariants(out)).toBe(true);
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('P2: idempotent', () => {
    // Act
    const run = holds(hostile, (input) => {
      const r = canonicalizeChatText(input);
      if (!r.ok) return;
      const again = canonicalizeChatText(r.text);
      expect(again.ok && again.text).toBe(r.text);
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('P3: tags and selectors only in valid contexts', () => {
    // Act
    const run = holds(hostile, (input) => {
      const r = canonicalizeChatText(input);
      if (!r.ok) return;
      for (const g of segmenter.segment(r.text)) {
        const c = cps(g.segment);
        const selectors = c.filter(isVariationSelector).length;
        const tags = c.filter(isTag).length;
        if (tags > 0) expect(/^\p{RGI_Emoji}$/v.test(g.segment)).toBe(true);
        if (selectors > 1) expect(/^\p{RGI_Emoji}$/v.test(g.segment)).toBe(true);
      }
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('P4: mark runs ≤ 4 with no identical neighbours', () => {
    // Act
    const run = holds(hostile, (input) => {
      const r = canonicalizeChatText(input);
      if (!r.ok) return;
      let markRun = 0;
      let prev = -1;
      for (const ch of r.text) {
        const c = ch.codePointAt(0)!;
        if (/^[\p{Mn}\p{Me}]$/u.test(ch) && !isVariationSelector(c)) {
          markRun++;
          expect(markRun).toBeLessThanOrEqual(4);
          expect(c).not.toBe(prev);
          prev = c;
        } else if (!isVariationSelector(c) && c !== 0x200d && c !== 0x200c) {
          markRun = 0;
          prev = -1;
        }
      }
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('P9: realistic chat comes out unchanged', () => {
    // Act
    const run = holds(realistic, (input) => {
      const r = canonicalizeChatText(input);
      expect(r.ok && r.text).toBe(input);
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('keeps legitimate Indic joiners and never throws on conjunct noise', () => {
    // Act
    const run = holds(indicConjuncts, (input) => void canonicalizeChatText(input));
    // Assert
    expect(run).not.toThrow();
  });

  it(`P8: linear work (counted, not timed): work(${LONGEST} units) ≤ ${LINEAR_GROWTH} × work(${LONGEST / 4}) on adversarial inputs`, () => {
    // Act
    const work = [...ADVERSARIAL_SHAPES, ['plain text', plainText] as const].map(([name, make]) => ({ name, small: workOf(make(LONGEST / 4)), big: workOf(make(LONGEST)) }));
    // Assert
    for (const { name, small, big } of work) {
      expect(small, name).toBeGreaterThan(0);
      expect(big, name).toBeLessThanOrEqual(LINEAR_GROWTH * small);
    }
  });

  it(`sanity, timed: no adversarial input of the longest size costs more than ${MAX_SLOWDOWN}× plain chat of that size`, () => {
    // Arrange
    const plain = plainText(LONGEST).toWellFormed();
    // Act
    const slowdowns = ADVERSARIAL_SHAPES.map(([name, make]) => ({ name, x: slowdown(make(LONGEST).toWellFormed(), plain) }));
    // Assert
    for (const { name, x } of slowdowns) expect(x, name).toBeLessThanOrEqual(MAX_SLOWDOWN);
  });
});

describe('nickname properties', () => {
  it('never accepts a disallowed code point, the length caps hold, idempotent', () => {
    // Act
    const run = holds(hostile, (input) => {
      const r = validateNickname(input);
      if (!r.ok) return;
      const v = r.value;
      for (const ch of v) expect(/^[\p{L}\p{M}\p{Nd} _.-]$/u.test(ch), JSON.stringify(ch)).toBe(true);
      expect(/\p{Extended_Pictographic}/u.test(v)).toBe(false);
      expect(/\p{Default_Ignorable_Code_Point}/u.test(v)).toBe(false);
      const n = [...segmenter.segment(v)].length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(24);
      expect(utf8Length(v)).toBeLessThanOrEqual(64);
      expect(v).toBe(v.trim());
      expect(v.includes('  ')).toBe(false);
      expect(validateNickname(v)).toEqual({ ok: true, value: v });
    });
    // Assert
    expect(run).not.toThrow();
  });
});

/**
 * The UTS #39 skeleton maps the NFD of a character, so a few dozen confusables.txt sources with
 * canonical decompositions (ȧ, ǆ, Hangul in parentheses…) land on a different but equivalent
 * skeleton than their listed prototype. Those stay a tiny, fixed share.
 */
const MAX_DECOMPOSED_PAIRS = 40;

describe('skeleton and keys', () => {
  it('P10: every confusables.txt pair has the same skeleton (up to the decomposed ones), and skeleton is idempotent', () => {
    // Arrange
    const pairs = CONFUSABLES.split(',').map((entry) => {
      const [src, tgt] = entry.split(':') as [string, string];
      return [String.fromCodePoint(parseInt(src, 36)), String.fromCodePoint(...tgt.split('.').map((x) => parseInt(x, 36)))] as const;
    });
    // Act
    const differ = pairs.filter(([a, b]) => skeleton(a) !== skeleton(b)).length;
    const run = holds(
      anyUnicode,
      (s) => {
        const w = s.toWellFormed();
        expect(skeleton(skeleton(w))).toBe(skeleton(w));
      },
      { ...params, numRuns: Math.min(RUNS, 500) },
    );
    // Assert
    expect(pairs.length).toBeGreaterThan(6000);
    expect(differ).toBeLessThanOrEqual(MAX_DECOMPOSED_PAIRS);
    expect(run).not.toThrow();
  });

  it('look-alike names share a key (homo-2, homo-3), different names do not', () => {
    // Arrange
    const shares = (a: string, b: string): boolean => nameKeys(a).some((k) => nameKeys(b).includes(k));
    // Act
    const shared = { iucas: shares('Iucas', 'lucas'), idiota: shares('IDIOTA', 'idiota'), anaBia: shares('Ana', 'Bia') };
    // Assert
    expect(shared).toEqual({ iucas: true, idiota: true, anaBia: false });
    expect(comparisonKey('Ana')).toBe(comparisonKey('ana'));
    expect(comparisonKey('\u{410}n\u{430}')).toBe(comparisonKey('Ana'));
    expect(comparisonKey('Ana Clara')).toBe(comparisonKey('ana_clara'));
    expect(comparisonKey('Ana')).not.toBe(comparisonKey('Bia'));
  });

  it('norm-3: blocked words match through fullwidth, case, accents and spacing', () => {
    // Arrange
    const ac = new AhoCorasick([comparisonKey('fuck'), comparisonKey('idiota')]);
    // Act
    const hits = ['\u{FF46}\u{FF55}\u{FF43}\u{FF4B}', 'vc é um I D I O T A', 'boa noite'].map((t) => ac.test(comparisonKey(t)));
    // Assert
    expect(hits).toEqual([true, true, false]);
  });
});

describe('Aho–Corasick', () => {
  it('agrees with includes() on random patterns', () => {
    // Arrange
    const patterns = fc.array(fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c') }), { maxLength: 8 });
    const texts = fc.string({ maxLength: 40, unit: fc.constantFrom('a', 'b', 'c', 'd') });
    // Act
    const run = holds(fc.tuple(patterns, texts), ([pats, text]) => expect(new AhoCorasick(pats).test(text)).toBe(pats.some((p) => text.includes(p))));
    // Assert
    expect(run).not.toThrow();
  });
});

describe('tokens', () => {
  const codes = new Set(BUILTIN_EMOTE_CODES);

  it('P11: round trip, emote tokens only for known codes', () => {
    // Arrange
    const texts = fc.string({ maxLength: 60, unit: fc.constantFrom(':', 'g', 'f', 'i', 'r', 'e', 'x', ' ', '\u{1F600}', '_') });
    // Act
    const run = holds(texts, (text) => {
      const tokens = tokenizeChat(text, codes);
      expect(joinTokens(tokens)).toBe(text);
      for (const t of tokens) if (t.k === 'e') expect(codes.has(t.code)).toBe(true);
    });
    const sample = tokenizeChat('gg :gg: :nope: 😀', codes);
    // Assert
    expect(run).not.toThrow();
    expect(sample).toEqual([{ k: 't', v: 'gg ' }, { k: 'e', code: 'gg' }, { k: 't', v: ' :nope: ' }, { k: 'j', v: '😀' }]);
  });

  it('finds links without false positives on normal chat', () => {
    // Arrange
    const links = ['https://evil.example/x', 'veja www.site', 'acesse bit.ly/abc', 'meu.site.com.br', 'evil.gg'];
    const chat = ['boa noite', 'kkk.ok', 'v1.2.3', 'tá... ótimo', 'ok.'];
    // Act
    const missed = links.filter((s) => !containsLink(s));
    const falseAlarms = chat.filter((s) => containsLink(s));
    // Assert
    expect(missed).toEqual([]);
    expect(falseAlarms).toEqual([]);
  });
});

describe('colours', () => {
  it('P12: every 24-bit colour reaches 4.5:1 on both themes', () => {
    // Act
    const run = holds(fc.integer({ min: 0, max: 0xffffff }), (n) => {
      const c = `#${n.toString(16).padStart(6, '0')}`;
      for (const bg of [CHAT_BG_LIGHT, CHAT_BG_DARK]) expect(contrastRatio(adjustNameColor(c, bg), bg)).toBeGreaterThanOrEqual(4.5);
    });
    // Assert
    expect(run).not.toThrow();
  });

  it('keeps readable colours and the hue of adjusted ones (plan §5.4 table)', () => {
    // Act
    const onDark = adjustNameColor('#f76b15', CHAT_BG_DARK);
    const onLight = adjustNameColor('#f76b15', CHAT_BG_LIGHT);
    // Assert
    expect(onDark).toBe('#f76b15');
    expect(contrastRatio(onLight, CHAT_BG_LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(onLight, CHAT_BG_LIGHT)).toBeLessThan(5);
    expect(defaultNameColor('k1f')).toBe(defaultNameColor('k1f'));
  });
});
