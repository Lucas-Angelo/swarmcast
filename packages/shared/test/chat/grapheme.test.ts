import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { graphemeBounds } from '../../src/chat/grapheme.js';
import { codePoints, graphemes } from '../../src/chat/ucd.js';
import { GRAPHEME_BREAK_TESTS } from './grapheme-break-test.generated.js';
import { hostile } from './arbitraries.js';

/** "/0020x0308/0020/" → expected graphemes as code-point arrays. */
function parseCase(line: string): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let hex = '';
  for (const ch of line) {
    if (ch === '/' || ch === 'x') {
      if (hex) cur.push(parseInt(hex, 16));
      hex = '';
      if (ch === '/' && cur.length) {
        out.push(cur);
        cur = [];
      }
    } else hex += ch;
  }
  return out;
}

describe('grapheme clusters (UAX #29, pure TypeScript)', () => {
  it(`passes every case of GraphemeBreakTest.txt (${GRAPHEME_BREAK_TESTS.length})`, () => {
    expect(GRAPHEME_BREAK_TESTS.length).toBeGreaterThan(700);
    const failures: string[] = [];
    for (const line of GRAPHEME_BREAK_TESTS) {
      const expected = parseCase(line);
      const cps = expected.flat();
      const b = graphemeBounds(cps);
      const got: number[][] = [];
      for (let i = 0; i + 1 < b.length; i++) got.push(cps.slice(b[i], b[i + 1]));
      if (JSON.stringify(got) !== JSON.stringify(expected)) failures.push(line);
    }
    expect(failures).toEqual([]);
  });

  it('agrees with Intl.Segmenter of this Node (same Unicode version) on hostile input', () => {
    const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
    fc.assert(
      fc.property(hostile, (s) => {
        const w = s.toWellFormed();
        expect(graphemes(w)).toEqual(Array.from(seg.segment(w), (x) => x.segment));
        return true;
      }),
      { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x5ca7 },
    );
  });

  it('handles the empty string and lone code points', () => {
    expect(graphemeBounds([])).toEqual([0]);
    expect(graphemes('')).toEqual([]);
    expect(codePoints('a\u{D800}b')).toEqual([0x61, 0xd800, 0x62]);
  });
});
