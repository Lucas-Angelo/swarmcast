import { describe, expect, it } from 'vitest';
import { GIF_PROVIDERS, gifMediaRef, gifMediaUrl, isGifMediaPath } from '../../src/chat/gif.js';

/** A Klipy media path as its API returns it. */
const K = '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp';

/** Paths a Klipy GIF message may never carry. */
const NOT_KLIPY = [
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
];

describe('GIF media paths (plan §5.6: a provider path, never a URL)', () => {
  it('builds URLs only on the provider media hosts', () => {
    // Act
    const urls = [gifMediaUrl({ p: 'klipy', m: K }), gifMediaUrl({ p: 'klipy', m: K, hi: 2 }), gifMediaUrl({ p: 'klipy', m: K, hi: 3 }), gifMediaUrl({ p: 'giphy', m: '/media/3o7TKSjRrfIPjeiVyM/200.webp', hi: 6 })];
    // Assert
    expect(urls).toEqual([`https://static.klipy.com${K}`, `https://static2.klipy.com${K}`, null, 'https://i.giphy.com/media/3o7TKSjRrfIPjeiVyM/200.webp']);
  });

  it('refuses anything that is not the provider shape', () => {
    // Act
    const klipy = NOT_KLIPY.filter((bad) => isGifMediaPath('klipy', bad));
    const giphy = [K, '/media/v1.abc/3o7TKSjRrfIPjeiVyM/200.webp', '/media/a/b/c/200.webp', '/media/3o7TKSjRrfIPjeiVyM/200.mp4'].map((m) => isGifMediaPath('giphy', m));
    // Assert
    expect(klipy).toEqual([]);
    expect(giphy).toEqual([false, true, false, false]);
  });

  it('reads a provider response URL back into {m, hi}, dropping the query', () => {
    // Act
    const refs = [
      gifMediaRef('klipy', `https://static1.klipy.com${K}`),
      gifMediaRef('giphy', 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200.webp?cid=x&rid=200.webp'),
      gifMediaRef('klipy', `https://evil.klipy.com${K}`),
      gifMediaRef('klipy', `https://user:pw@static.klipy.com${K}`),
      gifMediaRef('klipy', `http://static.klipy.com${K}`),
      gifMediaRef('klipy', 'not a url'),
    ];
    // Assert
    expect(refs).toEqual([{ m: K, hi: 1 }, { m: '/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200.webp', hi: 3 }, null, null, null, null]);
  });

  it('every media host is https', () => {
    // Act
    const hosts = Object.values(GIF_PROVIDERS).flatMap((p) => p.media);
    // Assert
    expect(hosts.filter((h) => !h.startsWith('https://'))).toEqual([]);
  });
});
