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

/** The graphemes graphemeBounds() cuts `cps` into. */
function split(cps: number[]): number[][] {
  const b = graphemeBounds(cps);
  const got: number[][] = [];
  for (let i = 0; i + 1 < b.length; i++) got.push(cps.slice(b[i], b[i + 1]));
  return got;
}

describe('grapheme clusters (UAX #29, pure TypeScript)', () => {
  it(`passes every case of GraphemeBreakTest.txt (${GRAPHEME_BREAK_TESTS.length})`, () => {
    // Act
    const failures = GRAPHEME_BREAK_TESTS.filter((line) => {
      const expected = parseCase(line);
      return JSON.stringify(split(expected.flat())) !== JSON.stringify(expected);
    });
    // Assert
    expect(GRAPHEME_BREAK_TESTS.length).toBeGreaterThan(700);
    expect(failures).toEqual([]);
  });

  it('agrees with Intl.Segmenter of this Node (same Unicode version) on hostile input', () => {
    // Arrange
    const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
    // Act
    const run = () =>
      fc.assert(
        fc.property(hostile, (s) => {
          const w = s.toWellFormed();
          expect(graphemes(w)).toEqual(Array.from(seg.segment(w), (x) => x.segment));
          return true;
        }),
        { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x5ca7 },
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('handles the empty string and lone code points', () => {
    // Act
    const empty = { bounds: graphemeBounds([]), graphemes: graphemes('') };
    const lone = codePoints('a\u{D800}b');
    // Assert
    expect(empty).toEqual({ bounds: [0], graphemes: [] });
    expect(lone).toEqual([0x61, 0xd800, 0x62]);
  });
});
