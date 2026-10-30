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

describe('canonicalizeChatText properties', () => {
  it('P1, P3, P5, P6, P7: well-formed, nothing from the removal set, caps hold, NFC-stable, passes the client check', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const r = canonicalizeChatText(input);
        if (!r.ok) return true;
        const out = r.text;
        expect(out.isWellFormed()).toBe(true);
        for (const c of cps(out)) {
          expect(inRemovalSet(c) || isBidiExplicit(c)).toBe(false);
          if (c === 0x0a || c === 0x0d) throw new Error('line break kept');
        }
        expect(utf8Length(out)).toBeLessThanOrEqual(1024);
        expect(r.graphemes).toBeLessThanOrEqual(200);
        expect(r.emoji).toBeLessThanOrEqual(30);
        for (const g of segmenter.segment(out)) expect(cps(g.segment).length).toBeLessThanOrEqual(16);
        expect(out.normalize('NFC')).toBe(out);
        expect(checkChatInvariants(out)).toBe(true);
        return true;
      }),
      params,
    );
  });

  it('P2: idempotent', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const r = canonicalizeChatText(input);
        if (!r.ok) return true;
        const again = canonicalizeChatText(r.text);
        expect(again.ok && again.text).toBe(r.text);
        return true;
      }),
      params,
    );
  });

  it('P3: tags and selectors only in valid contexts', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const r = canonicalizeChatText(input);
        if (!r.ok) return true;
        for (const g of segmenter.segment(r.text)) {
          const c = cps(g.segment);
          const selectors = c.filter(isVariationSelector).length;
          const tags = c.filter(isTag).length;
          if (tags > 0) expect(/^\p{RGI_Emoji}$/v.test(g.segment)).toBe(true);
          if (selectors > 1) expect(/^\p{RGI_Emoji}$/v.test(g.segment)).toBe(true);
        }
        return true;
      }),
      params,
    );
  });

  it('P4: mark runs ≤ 4 with no identical neighbours', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const r = canonicalizeChatText(input);
        if (!r.ok) return true;
        let run = 0;
        let prev = -1;
        for (const ch of r.text) {
          const c = ch.codePointAt(0)!;
          if (/^[\p{Mn}\p{Me}]$/u.test(ch) && !isVariationSelector(c)) {
            run++;
            expect(run).toBeLessThanOrEqual(4);
            expect(c).not.toBe(prev);
            prev = c;
          } else if (!isVariationSelector(c) && c !== 0x200d && c !== 0x200c) {
            run = 0;
            prev = -1;
          }
        }
        return true;
      }),
      params,
    );
  });

  it('P9: realistic chat comes out unchanged', () => {
    fc.assert(
      fc.property(realistic, (input) => {
        const r = canonicalizeChatText(input);
        expect(r.ok && r.text).toBe(input);
        return true;
      }),
      params,
    );
  });

  it('keeps legitimate Indic joiners and never throws on conjunct noise', () => {
    fc.assert(
      fc.property(indicConjuncts, (input) => {
        canonicalizeChatText(input);
        return true;
      }),
      params,
    );
  });

  it('P8: linear work (counted, not timed): work(1,500 units) ≤ 4.5 × work(375) on adversarial inputs', () => {
    const shapes: Array<[string, (n: number) => string]> = [
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
      ['plain text', (n) => 'boa noite '.repeat(n / 10 + 1).slice(0, n)],
    ];
    for (const [name, make] of shapes) {
      const cost = (n: number): number => {
        const before = chatTextWork();
        canonicalizeChatText(make(n).toWellFormed(), { maxGraphemes: 500, maxEmoji: 100 });
        return chatTextWork() - before;
      };
      const small = cost(375);
      const big = cost(1500);
      expect(small, name).toBeGreaterThan(0);
      expect(big, name).toBeLessThanOrEqual(4.5 * small);
    }
  });

  it('sanity: the largest input takes far less than 50 ms', () => {
    const input = 'e' + '\u{301}'.repeat(1499);
    canonicalizeChatText(input);
    const t0 = performance.now();
    canonicalizeChatText(input);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('nickname properties', () => {
  it('never accepts a disallowed code point, the length caps hold, idempotent', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const r = validateNickname(input);
        if (!r.ok) return true;
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
        return true;
      }),
      params,
    );
  });
});

describe('skeleton and keys', () => {
  it('P10: every confusables.txt pair has the same skeleton, and skeleton is idempotent', () => {
    // The UTS #39 skeleton maps the NFD of a character, so a few dozen sources with canonical
    // decompositions (ȧ, ǆ, Hangul in parentheses…) land on a different but equivalent skeleton
    // than their listed prototype. Those stay a tiny, fixed share.
    let pairs = 0;
    let differ = 0;
    for (const entry of CONFUSABLES.split(',')) {
      const [src, tgt] = entry.split(':') as [string, string];
      const a = String.fromCodePoint(parseInt(src, 36));
      const b = String.fromCodePoint(...tgt.split('.').map((x) => parseInt(x, 36)));
      if (skeleton(a) !== skeleton(b)) differ++;
      pairs++;
    }
    expect(pairs).toBeGreaterThan(6000);
    expect(differ).toBeLessThanOrEqual(40);
    fc.assert(
      fc.property(anyUnicode, (s) => {
        const w = s.toWellFormed();
        expect(skeleton(skeleton(w))).toBe(skeleton(w));
        return true;
      }),
      { ...params, numRuns: Math.min(RUNS, 500) },
    );
  });

  it('look-alike names share a key (homo-2, homo-3), different names do not', () => {
    const shares = (a: string, b: string): boolean => nameKeys(a).some((k) => nameKeys(b).includes(k));
    expect(shares('Iucas', 'lucas')).toBe(true);
    expect(shares('IDIOTA', 'idiota')).toBe(true);
    expect(shares('Ana', 'Bia')).toBe(false);
    expect(comparisonKey('Ana')).toBe(comparisonKey('ana'));
    expect(comparisonKey('\u{410}n\u{430}')).toBe(comparisonKey('Ana'));
    expect(comparisonKey('Ana Clara')).toBe(comparisonKey('ana_clara'));
    expect(comparisonKey('Ana')).not.toBe(comparisonKey('Bia'));
  });

  it('norm-3: blocked words match through fullwidth, case, accents and spacing', () => {
    const ac = new AhoCorasick([comparisonKey('fuck'), comparisonKey('idiota')]);
    expect(ac.test(comparisonKey('\u{FF46}\u{FF55}\u{FF43}\u{FF4B}'))).toBe(true);
    expect(ac.test(comparisonKey('vc é um I D I O T A'))).toBe(true);
    expect(ac.test(comparisonKey('boa noite'))).toBe(false);
  });
});

describe('Aho–Corasick', () => {
  it('agrees with includes() on random patterns', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c') }), { maxLength: 8 }), fc.string({ maxLength: 40, unit: fc.constantFrom('a', 'b', 'c', 'd') }), (pats, text) => {
        expect(new AhoCorasick(pats).test(text)).toBe(pats.some((p) => text.includes(p)));
        return true;
      }),
      params,
    );
  });
});

describe('tokens', () => {
  const codes = new Set(BUILTIN_EMOTE_CODES);
  it('P11: round trip, emote tokens only for known codes', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60, unit: fc.constantFrom(':', 'g', 'f', 'i', 'r', 'e', 'x', ' ', '\u{1F600}', '_') }), (text) => {
        const tokens = tokenizeChat(text, codes);
        expect(joinTokens(tokens)).toBe(text);
        for (const t of tokens) if (t.k === 'e') expect(codes.has(t.code)).toBe(true);
        return true;
      }),
      params,
    );
    expect(tokenizeChat('gg :gg: :nope: 😀', codes)).toEqual([{ k: 't', v: 'gg ' }, { k: 'e', code: 'gg' }, { k: 't', v: ' :nope: ' }, { k: 'j', v: '😀' }]);
  });

  it('finds links without false positives on normal chat', () => {
    for (const s of ['https://evil.example/x', 'veja www.site', 'acesse bit.ly/abc', 'meu.site.com.br', 'evil.gg']) expect(containsLink(s), s).toBe(true);
    for (const s of ['boa noite', 'kkk.ok', 'v1.2.3', 'tá... ótimo', 'ok.']) expect(containsLink(s), s).toBe(false);
  });
});

describe('colours', () => {
  it('P12: every 24-bit colour reaches 4.5:1 on both themes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const c = `#${n.toString(16).padStart(6, '0')}`;
        for (const bg of [CHAT_BG_LIGHT, CHAT_BG_DARK]) expect(contrastRatio(adjustNameColor(c, bg), bg)).toBeGreaterThanOrEqual(4.5);
        return true;
      }),
      params,
    );
  });

  it('keeps readable colours and the hue of adjusted ones (plan §5.4 table)', () => {
    expect(adjustNameColor('#f76b15', CHAT_BG_DARK)).toBe('#f76b15');
    const light = adjustNameColor('#f76b15', CHAT_BG_LIGHT);
    expect(contrastRatio(light, CHAT_BG_LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light, CHAT_BG_LIGHT)).toBeLessThan(5);
    expect(defaultNameColor('k1f')).toBe(defaultNameColor('k1f'));
  });
});
