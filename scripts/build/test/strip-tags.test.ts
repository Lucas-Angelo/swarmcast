import { describe, expect, it } from 'vitest';
import { stripTags } from '../strip-tags.mjs';

describe('stripTags', () => {
  it('removes every <…> span; a "<" with no ">" after it stays', () => {
    const cases: Array<[string, string]> = [
      ['Mads <m@x>', 'Mads '],
      ['a <b>c</b> d', 'a c d'],
      ['<<a>script>', 'script>'],
      ['x < y', 'x < y'],
      ['a<b<c>d', 'ad'],
      ['<>', ''],
      ['', ''],
      ['no tags', 'no tags'],
      ['end <open', 'end <open'],
      ['<a><b>', ''],
      ['x > y <z>', 'x > y '],
    ];
    for (const [input, out] of cases) expect(stripTags(input), input).toBe(out);
  });
});
