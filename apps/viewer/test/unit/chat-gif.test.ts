// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { GifRef } from '@swarmcast/shared/chat';
import { gifSearchUrl, parseGifResponse, searchGifs } from '../../src/chat/gif-api.js';
import { createGifPicker } from '../../src/chat/gif-picker.js';
import { ChatList, LIVE_GIFS_MAX } from '../../src/chat/render.js';

const K = '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp';
const cfg = { provider: 'klipy' as const, key: 'Abcdefgh_123', rating: 'pg' };

/** The shape of docs.klipy.com's GIF search example (trimmed). */
const klipyBody = (items: unknown[]) => ({ result: true, data: { data: items, current_page: 1, per_page: 24, has_next: false } });
const klipyItem = (over: Record<string, unknown> = {}) => ({
  id: 1234,
  slug: 'happy-dance-1',
  title: 'Happy dance',
  type: 'gif',
  file: { sm: { webp: { url: `https://static.klipy.com${K}`, width: 220, height: 220, size: 1000 }, gif: { url: `https://static.klipy.com${K.replace('webp', 'gif')}`, width: 220, height: 220 } } },
  ...over,
});

describe('GIF search (provider API)', () => {
  it('builds the KLIPY search and trending URLs with the key in the path, the rating and only image formats', () => {
    const u = new URL(gifSearchUrl(cfg, ' gato '));
    expect(u.origin).toBe('https://api.klipy.com');
    expect(u.pathname).toBe('/api/v1/Abcdefgh_123/gifs/search');
    expect(u.searchParams.get('q')).toBe('gato');
    expect(u.searchParams.get('content_filter')).toBe('medium');
    expect(u.searchParams.get('format_filter')).toBe('webp,gif');
    expect(u.searchParams.has('customer_id')).toBe(false);
    expect(new URL(gifSearchUrl(cfg, '')).pathname).toBe('/api/v1/Abcdefgh_123/gifs/trending');
    const g = new URL(gifSearchUrl({ provider: 'giphy', key: 'Abcdefgh_123', rating: 'g' }, 'cat'));
    expect(g.href).toContain('https://api.giphy.com/v1/gifs/search');
    expect(g.searchParams.get('rating')).toBe('g');
  });

  it('turns a KLIPY response into checked references and drops anything off the media hosts or shapes', () => {
    const r = parseGifResponse(
      'klipy',
      klipyBody([
        klipyItem(),
        klipyItem({ slug: 'evil', file: { sm: { webp: { url: `https://evil.example${K}`, width: 220, height: 220 } } } }),
        klipyItem({ slug: 'svg', file: { sm: { webp: { url: 'https://static.klipy.com/ii/x.svg', width: 220, height: 220 } } } }),
        klipyItem({ slug: 'huge', file: { sm: { webp: { url: `https://static.klipy.com${K}`, width: 4000, height: 220 } } } }),
        klipyItem({ slug: 'bad id!' }),
        'junk',
        null,
      ]),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.ref).toEqual({ p: 'klipy', id: 'happy-dance-1', w: 220, h: 220, m: K });
    expect(r[0]!.url).toBe(`https://static.klipy.com${K}`);
    expect(parseGifResponse('klipy', { nope: 1 })).toEqual([]);
  });

  it('reads GIPHY fixed_width renditions', () => {
    const r = parseGifResponse('giphy', { data: [{ id: '3o7TKSjRrfIPjeiVyM', title: 'cat', images: { fixed_width: { url: 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.gif?cid=1', webp: 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.webp?cid=1', width: '200', height: '150' } } }] });
    expect(r[0]!.ref).toEqual({ p: 'giphy', id: '3o7TKSjRrfIPjeiVyM', w: 200, h: 150, m: '/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.webp', hi: 3 });
  });

  it('fetches without cookies or referrer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(klipyBody([klipyItem()]))));
    const r = await searchGifs(cfg, 'x', { fetch: f });
    expect(r).toHaveLength(1);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
  });
});

const ref: GifRef = { p: 'klipy', id: 'happy', w: 220, h: 220, m: K };

function list(state: { consented: boolean; animate: boolean }) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const frames: Array<() => void> = [];
  const consent = vi.fn();
  const l = new ChatList(root, { emotes: () => new Map(), nickColor: () => '#0f5c53', showTimes: () => false, visible: () => true, raf: (cb) => frames.push(cb), gifs: () => state, onGifConsent: consent });
  const flush = (): void => {
    while (frames.length) frames.shift()!();
  };
  return { l, flush, consent };
}
const author = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' as const };

describe('GIF messages', () => {
  it('without consent: a placeholder and no image request at all; a tap asks for consent', () => {
    const { l, flush, consent } = list({ consented: false, animate: true });
    l.append([{ kind: 'msg', s: 1, at: 1, author, gif: ref }]);
    flush();
    expect(l.list.querySelectorAll('img').length).toBe(0);
    const b = l.list.querySelector<HTMLButtonElement>('button.gif-consent')!;
    expect(b.textContent).toContain('KLIPY');
    b.click();
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('with consent: an image built from the checked reference, without referrer', () => {
    const state = { consented: false, animate: true };
    const { l, flush } = list(state);
    l.append([{ kind: 'msg', s: 1, at: 1, author, gif: ref }]);
    flush();
    state.consented = true;
    l.refreshGifs();
    const img = l.list.querySelector('img.gif-img')!;
    expect(img.getAttribute('src')).toBe(`https://static.klipy.com${K}`);
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('width')).toBe('220');
  });

  it('a reference that fails the shared rules shows a plain chip', () => {
    const { l, flush } = list({ consented: true, animate: true });
    l.append([{ kind: 'msg', s: 1, at: 1, author, gif: { ...ref, m: '/evil.svg' } }]);
    flush();
    expect(l.list.querySelector('img')).toBeNull();
    expect(l.list.querySelector('.gif-chip')!.textContent).toBe('GIF');
  });

  it('animation off: a play button; at most 10 animated GIFs, older ones go back to their button', () => {
    let m = list({ consented: true, animate: false });
    m.l.append([{ kind: 'msg', s: 1, at: 1, author, gif: ref }]);
    m.flush();
    expect(m.l.list.querySelector('img')).toBeNull();
    m.l.list.querySelector<HTMLButtonElement>('button.gif-play')!.click();
    expect(m.l.list.querySelectorAll('img.gif-img')).toHaveLength(1);

    m = list({ consented: true, animate: true });
    m.l.append(Array.from({ length: 14 }, (_, i) => ({ kind: 'msg' as const, s: i + 1, at: 1, author, gif: ref })));
    m.flush();
    expect(m.l.list.querySelectorAll('img.gif-img')).toHaveLength(LIVE_GIFS_MAX);
    expect(m.l.list.querySelectorAll('button.gif-play')).toHaveLength(4);
    expect(m.l.list.querySelector('li.msg')!.querySelector('button.gif-play')).not.toBeNull();
  });
});

describe('GIF picker', () => {
  function picker(consented: boolean) {
    document.body.replaceChildren();
    const button = document.createElement('button');
    const picks: GifRef[] = [];
    const state = { consented };
    const search = vi.fn(async () => [{ ref, url: `https://static.klipy.com${K}`, title: 'Happy' }]);
    const p = createGifPicker(button, { config: () => cfg, consented: () => state.consented, consent: () => (state.consented = true), onPick: (r) => picks.push(r), search, debounceMs: 0 });
    document.body.append(button, p.panel);
    return { button, p, picks, search, state };
  }

  it('asks first and contacts the provider only after "Allow"', async () => {
    const { button, p, search, state } = picker(false);
    button.click();
    expect(search).not.toHaveBeenCalled();
    expect(p.panel.textContent).toContain('your browser contacts KLIPY');
    p.panel.querySelector<HTMLButtonElement>('[data-testid="chat-gif-allow"]')!.click();
    expect(state.consented).toBe(true);
    await p.idle();
    expect(search).toHaveBeenCalledWith(cfg, '', expect.anything());
  });

  it('shows KLIPY attribution, trending results, and a pick sends the reference', async () => {
    const { button, p, picks } = picker(true);
    button.click();
    await p.idle();
    expect(p.panel.querySelector<HTMLInputElement>('input[type=search]')!.placeholder).toBe('Search KLIPY');
    expect(p.panel.textContent).toContain('Powered by KLIPY');
    p.panel.querySelector<HTMLButtonElement>('button.gif-pick')!.click();
    expect(picks).toEqual([ref]);
    expect(p.popover.isOpen).toBe(false);
  });

  it('a failed search says so', async () => {
    const { button, p, search } = picker(true);
    search.mockRejectedValueOnce(new Error('offline'));
    button.click();
    await p.idle();
    expect(p.panel.querySelector('.gif-status')!.textContent).toBe('GIFs could not be loaded right now. Try again later.');
  });
});
