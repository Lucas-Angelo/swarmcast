import { describe, expect, it } from 'vitest';
import { GIF_PROVIDERS, gifMediaRef, gifMediaUrl, isGifMediaPath } from '../../src/chat/gif.js';

const K = '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp';

describe('GIF media paths (plan §5.6: a provider path, never a URL)', () => {
  it('builds URLs only on the provider media hosts', () => {
    expect(gifMediaUrl({ p: 'klipy', m: K })).toBe(`https://static.klipy.com${K}`);
    expect(gifMediaUrl({ p: 'klipy', m: K, hi: 2 })).toBe(`https://static2.klipy.com${K}`);
    expect(gifMediaUrl({ p: 'klipy', m: K, hi: 3 })).toBeNull();
    expect(gifMediaUrl({ p: 'giphy', m: '/media/3o7TKSjRrfIPjeiVyM/200.webp', hi: 6 })).toBe('https://i.giphy.com/media/3o7TKSjRrfIPjeiVyM/200.webp');
  });

  it('refuses anything that is not the provider shape', () => {
    for (const bad of [
      '',
      'https://evil.example/x.gif',
      '//evil.example/ii/x.gif',
      '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.svg',
      '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp?x=1',
      '/ii/935d7ab9d8c6202580a668421940ec81/14/af/../SE72470w.webp',
      '/ii/935D7AB9D8C6202580A668421940EC81/14/af/SE72470w.webp',
      '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.mp4',
      `${K}\n`,
      `/ii/${'a'.repeat(400)}`,
    ]) {
      expect(isGifMediaPath('klipy', bad), bad).toBe(false);
    }
    expect(isGifMediaPath('giphy', K)).toBe(false);
    expect(isGifMediaPath('giphy', '/media/v1.abc/3o7TKSjRrfIPjeiVyM/200.webp')).toBe(true);
    expect(isGifMediaPath('giphy', '/media/a/b/c/200.webp')).toBe(false);
    expect(isGifMediaPath('giphy', '/media/3o7TKSjRrfIPjeiVyM/200.mp4')).toBe(false);
  });

  it('reads a provider response URL back into {m, hi}, dropping the query', () => {
    expect(gifMediaRef('klipy', `https://static1.klipy.com${K}`)).toEqual({ m: K, hi: 1 });
    expect(gifMediaRef('giphy', 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200.webp?cid=x&rid=200.webp')).toEqual({ m: '/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200.webp', hi: 3 });
    expect(gifMediaRef('klipy', `https://evil.klipy.com${K}`)).toBeNull();
    expect(gifMediaRef('klipy', `https://user:pw@static.klipy.com${K}`)).toBeNull();
    expect(gifMediaRef('klipy', `http://static.klipy.com${K}`)).toBeNull();
    expect(gifMediaRef('klipy', 'not a url')).toBeNull();
  });

  it('every media host is https', () => {
    for (const p of Object.values(GIF_PROVIDERS)) for (const h of p.media) expect(h.startsWith('https://')).toBe(true);
  });
});
