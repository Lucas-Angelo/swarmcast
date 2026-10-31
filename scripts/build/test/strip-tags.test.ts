import { describe, expect, it } from 'vitest';
import { stripTags } from '../strip-tags.mjs';

describe('stripTags: removes every <…> span; a "<" with no ">" after it stays', () => {
  it.each([
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
  ])('%j -> %j', (input, expected) => {
    // Act
    const out = stripTags(input);

    // Assert
    expect(out).toBe(expected);
  });
});
