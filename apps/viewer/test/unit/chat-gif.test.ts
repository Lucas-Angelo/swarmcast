// @vitest-environment happy-dom
// GIFs in the chat: the provider search (chat/gif-api.ts), GIF messages in the list
// (chat/render.ts) and the picker (chat/gif-picker.ts). Nothing contacts the provider before the
// viewer agrees. The KLIPY bodies are the shape of docs.klipy.com's GIF search example (trimmed).
import { describe, expect, it, vi } from 'vitest';
import type { GifRef } from '@swarmcast/shared/chat';
import { gifSearchUrl, parseGifResponse, searchGifs } from '../../src/chat/gif-api.js';
import { createGifPicker } from '../../src/chat/gif-picker.js';
import { ChatList, LIVE_GIFS_MAX } from '../../src/chat/render.js';
import type { ChatEntry } from '../../src/chat/session.js';

const K = '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp';
const cfg = { provider: 'klipy' as const, key: 'Abcdefgh_123', rating: 'pg' };
const ref: GifRef = { p: 'klipy', id: 'happy', w: 220, h: 220, m: K };
const author = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' as const };
const gifMessage = (s: number, gif: GifRef = ref): ChatEntry => ({ kind: 'msg', s, at: 1, author, gif });

const klipyBody = (items: unknown[]) => ({ result: true, data: { data: items, current_page: 1, per_page: 24, has_next: false } });
const klipyItem = (over: Record<string, unknown> = {}) => ({
  id: 1234,
  slug: 'happy-dance-1',
  title: 'Happy dance',
  type: 'gif',
  file: { sm: { webp: { url: `https://static.klipy.com${K}`, width: 220, height: 220, size: 1000 }, gif: { url: `https://static.klipy.com${K.replace('webp', 'gif')}`, width: 220, height: 220 } } },
  ...over,
});
const GIPHY_BODY = { data: [{ id: '3o7TKSjRrfIPjeiVyM', title: 'cat', images: { fixed_width: { url: 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.gif?cid=1', webp: 'https://media2.giphy.com/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.webp?cid=1', width: '200', height: '150' } } }] };

/** A chat list with GIFs on (`state` is read live); `consent` records taps on the consent placeholder. */
function list(state: { consented: boolean; animate: boolean }) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const frames: Array<() => void> = [];
  const consent = vi.fn();
  const l = new ChatList(root, { emotes: () => new Map(), nickColor: () => '#0f5c53', showTimes: () => false, visible: () => true, raf: (cb) => frames.push(cb), gifs: () => state, onGifConsent: consent });
  const show = (entries: ChatEntry[]): void => {
    l.append(entries);
    while (frames.length) frames.shift()!();
  };
  return { l, show, consent };
}

/** A GIF picker on its button; its search answers one result at once (no debounce). */
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

describe('GIF search (provider API)', () => {
  it('builds the KLIPY search URL with the key in the path, the rating and only image formats', () => {
    // Act
    const u = new URL(gifSearchUrl(cfg, ' gato '));

    // Assert
    expect(u.origin).toBe('https://api.klipy.com');
    expect(u.pathname).toBe('/api/v1/Abcdefgh_123/gifs/search');
    expect(u.searchParams.get('q')).toBe('gato');
    expect(u.searchParams.get('content_filter')).toBe('medium');
    expect(u.searchParams.get('format_filter')).toBe('webp,gif');
    expect(u.searchParams.has('customer_id')).toBe(false);
  });

  it('an empty query asks KLIPY for the trending GIFs', () => {
    // Act
    const u = new URL(gifSearchUrl(cfg, ''));

    // Assert
    expect(u.pathname).toBe('/api/v1/Abcdefgh_123/gifs/trending');
  });

  it('builds the GIPHY search URL with its rating', () => {
    // Act
    const g = new URL(gifSearchUrl({ provider: 'giphy', key: 'Abcdefgh_123', rating: 'g' }, 'cat'));

    // Assert
    expect(g.href).toContain('https://api.giphy.com/v1/gifs/search');
    expect(g.searchParams.get('rating')).toBe('g');
  });

  it('turns a KLIPY response into checked references and drops anything off the media hosts or shapes', () => {
    // Arrange
    const body = klipyBody([
      klipyItem(),
      klipyItem({ slug: 'evil', file: { sm: { webp: { url: `https://evil.example${K}`, width: 220, height: 220 } } } }),
      klipyItem({ slug: 'svg', file: { sm: { webp: { url: 'https://static.klipy.com/ii/x.svg', width: 220, height: 220 } } } }),
      klipyItem({ slug: 'huge', file: { sm: { webp: { url: `https://static.klipy.com${K}`, width: 4000, height: 220 } } } }),
      klipyItem({ slug: 'bad id!' }),
      'junk',
      null,
    ]);

    // Act
    const r = parseGifResponse('klipy', body);

    // Assert
    expect(r).toHaveLength(1);
    expect(r[0]!.ref).toEqual({ p: 'klipy', id: 'happy-dance-1', w: 220, h: 220, m: K });
    expect(r[0]!.url).toBe(`https://static.klipy.com${K}`);
  });

  it('a body that is not a KLIPY answer gives no results', () => {
    // Act
    const r = parseGifResponse('klipy', { nope: 1 });

    // Assert
    expect(r).toEqual([]);
  });

  it('reads GIPHY fixed_width renditions', () => {
    // Act
    const r = parseGifResponse('giphy', GIPHY_BODY);

    // Assert
    expect(r[0]!.ref).toEqual({ p: 'giphy', id: '3o7TKSjRrfIPjeiVyM', w: 200, h: 150, m: '/media/v1.Y2lk/3o7TKSjRrfIPjeiVyM/200w.webp', hi: 3 });
  });

  it('fetches without cookies or referrer', async () => {
    // Arrange
    const f = vi.fn(async () => new Response(JSON.stringify(klipyBody([klipyItem()]))));

    // Act
    const r = await searchGifs(cfg, 'x', { fetch: f });

    // Assert
    expect(r).toHaveLength(1);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
  });
});

describe('GIF messages', () => {
  it('without consent: a placeholder and no image request at all', () => {
    // Arrange
    const { l, show } = list({ consented: false, animate: true });

    // Act
    show([gifMessage(1)]);

    // Assert
    expect(l.list.querySelectorAll('img').length).toBe(0);
    expect(l.list.querySelector('button.gif-consent')!.textContent).toContain('KLIPY');
  });

  it('without consent: a tap on the placeholder asks for consent', () => {
    // Arrange
    const { l, show, consent } = list({ consented: false, animate: true });
    show([gifMessage(1)]);

    // Act
    l.list.querySelector<HTMLButtonElement>('button.gif-consent')!.click();

    // Assert
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it('with consent: an image built from the checked reference, without referrer', () => {
    // Arrange
    const state = { consented: false, animate: true };
    const { l, show } = list(state);
    show([gifMessage(1)]);

    // Act
    state.consented = true;
    l.refreshGifs();

    // Assert
    const img = l.list.querySelector('img.gif-img')!;
    expect(img.getAttribute('src')).toBe(`https://static.klipy.com${K}`);
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('width')).toBe('220');
  });

  it('a reference that fails the shared rules shows a plain chip', () => {
    // Arrange
    const { l, show } = list({ consented: true, animate: true });

    // Act
    show([gifMessage(1, { ...ref, m: '/evil.svg' })]);

    // Assert
    expect(l.list.querySelector('img')).toBeNull();
    expect(l.list.querySelector('.gif-chip')!.textContent).toBe('GIF');
  });

  it('animation off: a play button instead of the image', () => {
    // Arrange
    const { l, show } = list({ consented: true, animate: false });

    // Act
    show([gifMessage(1)]);

    // Assert
    expect(l.list.querySelector('img')).toBeNull();
    expect(l.list.querySelector('button.gif-play')).not.toBeNull();
  });

  it('animation off: the play button plays that GIF', () => {
    // Arrange
    const { l, show } = list({ consented: true, animate: false });
    show([gifMessage(1)]);

    // Act
    l.list.querySelector<HTMLButtonElement>('button.gif-play')!.click();

    // Assert
    expect(l.list.querySelectorAll('img.gif-img')).toHaveLength(1);
  });

  it(`at most ${LIVE_GIFS_MAX} animated GIFs: older ones go back to their button`, () => {
    // Arrange
    const { l, show } = list({ consented: true, animate: true });

    // Act
    show(Array.from({ length: 14 }, (_, i) => gifMessage(i + 1)));

    // Assert
    expect(l.list.querySelectorAll('img.gif-img')).toHaveLength(LIVE_GIFS_MAX);
    expect(l.list.querySelectorAll('button.gif-play')).toHaveLength(4);
    expect(l.list.querySelector('li.msg')!.querySelector('button.gif-play')).not.toBeNull();
  });
});

describe('GIF picker', () => {
  it('asks first: opening it contacts nobody and explains what happens', () => {
    // Arrange
    const { button, p, search } = picker(false);

    // Act
    button.click();

    // Assert
    expect(search).not.toHaveBeenCalled();
    expect(p.panel.textContent).toContain('your browser contacts KLIPY');
  });

  it('contacts the provider only after "Allow", for the trending GIFs', async () => {
    // Arrange
    const { button, p, search, state } = picker(false);
    button.click();

    // Act
    p.panel.querySelector<HTMLButtonElement>('[data-testid="chat-gif-allow"]')!.click();
    await p.idle();

    // Assert
    expect(state.consented).toBe(true);
    expect(search).toHaveBeenCalledWith(cfg, '', expect.anything());
  });

  it('shows the KLIPY attribution and the trending results', async () => {
    // Arrange
    const { button, p } = picker(true);

    // Act
    button.click();
    await p.idle();

    // Assert
    expect(p.panel.querySelector<HTMLInputElement>('input[type=search]')!.placeholder).toBe('Search KLIPY');
    expect(p.panel.textContent).toContain('Powered by KLIPY');
    expect(p.panel.querySelectorAll('button.gif-pick')).toHaveLength(1);
  });

  it('a pick sends the reference and closes the picker', async () => {
    // Arrange
    const { button, p, picks } = picker(true);
    button.click();
    await p.idle();

    // Act
    p.panel.querySelector<HTMLButtonElement>('button.gif-pick')!.click();

    // Assert
    expect(picks).toEqual([ref]);
    expect(p.popover.isOpen).toBe(false);
  });

  it('a failed search says so', async () => {
    // Arrange
    const { button, p, search } = picker(true);
    search.mockRejectedValueOnce(new Error('offline'));

    // Act
    button.click();
    await p.idle();

    // Assert
    expect(p.panel.querySelector('.gif-status')!.textContent).toBe('GIFs could not be loaded right now. Try again later.');
  });
});
