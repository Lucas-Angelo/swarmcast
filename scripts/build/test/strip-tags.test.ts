import { describe, expect, it } from 'vitest';
import { stripTags } from '../strip-tags.mjs';

describe('stripTags', () => {
  it('removes every <…> span, exactly like /<[^>]*>/g', () => {
    const samples = ['Mads <m@x>', 'a <b>c</b> d', '<<a>script>', 'x < y', 'a<b<c>d', '<>', '', 'no tags', 'end <open', '<a><b>', 'x > y <z>'];
    for (const s of samples) expect(stripTags(s), s).toBe(s.replace(/<[^>]*>/g, ''));
  });
});
