// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPixPayload, type PublicBranding } from '@swarmcast/shared/branding';
import { sanitizeBranding, startBrand } from '../../src/branding/brand.js';
import { openPixSheet } from '../../src/branding/pix-sheet.js';

const IMG = (c: string, ext = 'png') => `/brand/${c.repeat(64)}.${ext}`;
const brand = (over: Partial<PublicBranding> = {}): PublicBranding => ({
  rev: 3,
  name: 'Ana Plays',
  tagline: 'Chill games every Friday',
  about: 'Hi!\nI stream indie games.',
  tags: ['cozy', 'indie'],
  links: [{ label: 'YouTube', href: 'https://www.youtube.com/@ana', host: 'youtube.com', platform: 'youtube' } as unknown as PublicBranding['links'][number]],
  support: { label: 'support', link: { label: 'Support', href: 'https://ko-fi.com/ana' } as unknown as PublicBranding['links'][number] },
  theme: { preset: 'forest', corners: 'round' },
  avatar: { s256: IMG('a'), s128: IMG('b') },
  favicon: { s32: IMG('c'), s180: IMG('d') },
  banner: { s1280: IMG('e', 'webp'), s640: IMG('f', 'webp') },
  endedMessage: 'Thanks! Back on Friday',
  showCredit: true,
  ...over,
});

function watchDom(): void {
  document.head.innerHTML = '<title>Live · SwarmCast</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">';
  document.body.className = 'watch';
  document.body.innerHTML = `<link rel="stylesheet" href="/brand/theme.css" data-brand-theme>
    <header class="site-head"><span class="sc-brand">SwarmCast</span><div id="brand-head" hidden></div><div id="brand-support" hidden></div></header>
    <main class="stage"><div id="brand-banner" hidden></div><div class="player"></div><div id="brand-about" hidden></div></main>
    <footer id="brand-credit" hidden><a href="#">on SwarmCast</a></footer>
    <div id="ended" hidden><div class="card"><span class="sc-mascot"></span><h1 id="ended-title">Ended</h1><p id="ended-text">Thanks for watching!</p></div></div>`;
}

function fetcher(body: unknown, etag = '"b3-x"') {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (inm === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { headers: { ETag: etag, 'content-type': 'application/json' } });
  });
}

describe('sanitizeBranding', () => {
  it('drops images that are not our own content-hash files, and "off"', () => {
    const b = sanitizeBranding({ ...brand(), avatar: { s256: 'https://evil.example/a.png' }, banner: { s1280: 'javascript:alert(1)' } });
    expect(b?.avatar).toBeUndefined();
    expect(b?.banner).toBeUndefined();
    expect(b?.favicon?.s32).toBe(IMG('c'));
    expect(sanitizeBranding({ off: true })).toBeNull();
    expect(sanitizeBranding('x')).toBeNull();
  });
});

describe('watch page branding', () => {
  beforeEach(() => watchDom());

  it('shows the streamer instead of the stock header, the about card, support, credit, favicon and title', async () => {
    const f = fetcher(brand());
    const c = startBrand('watch', { fetch: f as unknown as typeof fetch });
    await c.refresh();
    expect(document.querySelector<HTMLElement>('.site-head .sc-brand')!.hidden).toBe(true);
    const head = document.getElementById('brand-head')!;
    expect(head.hidden).toBe(false);
    expect(head.querySelector('bdi.sc-brand-name')!.textContent).toBe('Ana Plays');
    expect(head.querySelector('img.sc-brand-avatar')!.getAttribute('src')).toBe(IMG('b'));
    const about = document.getElementById('brand-about')!;
    expect(about.querySelector('.sc-brand-tagline')!.textContent).toBe('Chill games every Friday');
    expect(about.querySelector('.sc-brand-about-text')!.textContent).toBe('Hi!\nI stream indie games.');
    expect([...about.querySelectorAll('.sc-brand-tag')].map((x) => x.textContent)).toEqual(['cozy', 'indie']);
    const link = about.querySelector<HTMLAnchorElement>('a.sc-brand-link')!;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.target).toBe('_blank');
    const support = document.querySelector<HTMLAnchorElement>('#brand-support a.sc-brand-support')!;
    expect(support.getAttribute('href')).toBe('https://ko-fi.com/ana');
    expect(support.textContent).toBe('Support');
    expect(document.getElementById('brand-credit')!.hidden).toBe(false);
    expect(document.title).toBe('Ana Plays · live');
    expect(document.querySelector('link[rel=icon]')!.getAttribute('href')).toBe(IMG('c'));
    expect(document.querySelector('link[rel=apple-touch-icon]')!.getAttribute('href')).toBe(IMG('d'));
  });

  it('loads the banner only after the first fragment, and not at all in lite mode', async () => {
    const c = startBrand('watch', { fetch: fetcher(brand()) as unknown as typeof fetch });
    await c.refresh();
    expect(document.querySelector('#brand-banner img')).toBeNull();
    c.firstFrame();
    const img = document.querySelector<HTMLImageElement>('#brand-banner img')!;
    expect(img.getAttribute('src')).toBe(IMG('e', 'webp'));
    expect(img.getAttribute('srcset')).toContain('640w');
    expect(img.getAttribute('loading')).toBe('lazy');

    watchDom();
    const lite = startBrand('watch', { fetch: fetcher(brand({ lite: true })) as unknown as typeof fetch });
    await lite.refresh();
    lite.firstFrame();
    expect(document.querySelector('#brand-banner img')).toBeNull();
  });

  it('refreshes with If-None-Match, skips a revision it already has, and swaps the theme stylesheet', async () => {
    const f = fetcher(brand());
    const c = startBrand('watch', { fetch: f as unknown as typeof fetch });
    await c.refresh();
    await c.refresh(3);
    expect(f).toHaveBeenCalledTimes(1);
    await c.refresh(4);
    expect(f).toHaveBeenCalledTimes(2);
    expect(document.querySelector('link[data-brand-theme]')!.getAttribute('href')).toBe('/brand/theme.css?r=4');
    expect(c.data?.name).toBe('Ana Plays');
  });

  it('the ended screen shows the streamer message, picture and support button', async () => {
    const c = startBrand('watch', { fetch: fetcher(brand()) as unknown as typeof fetch });
    await c.refresh();
    c.ended();
    expect(document.getElementById('ended-text')!.textContent).toBe('Thanks! Back on Friday');
    expect(document.querySelector<HTMLElement>('#ended .sc-mascot')!.hidden).toBe(true);
    expect(document.querySelector('#ended img.sc-brand-ended-avatar')).not.toBeNull();
    expect(document.querySelector('#ended .sc-brand-support')).not.toBeNull();
  });

  it('branding off: the stock page stays', async () => {
    const c = startBrand('watch', { fetch: fetcher({ off: true }) as unknown as typeof fetch });
    await c.refresh();
    expect(document.querySelector<HTMLElement>('.site-head .sc-brand')!.hidden).toBe(false);
    expect(document.getElementById('brand-about')!.hidden).toBe(true);
    expect(document.getElementById('brand-credit')!.hidden).toBe(true);
    expect(document.title).toBe('Live · SwarmCast');
  });

  it('streamer text is text: markup in a name never becomes elements', async () => {
    const c = startBrand('watch', { fetch: fetcher(brand({ name: '<img src=x onerror=alert(1)>', about: '<b>hi</b>' })) as unknown as typeof fetch });
    await c.refresh();
    expect(document.querySelector('#brand-head bdi.sc-brand-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('#brand-head img').length).toBe(1);
    expect(document.querySelector('#brand-about b')).toBeNull();
  });
});

describe('join page branding', () => {
  it('"Join {name}\'s stream" with the name in its own bdi, the tagline as the intro', async () => {
    document.head.innerHTML = '<title>Join the stream · SwarmCast</title>';
    document.body.className = '';
    document.body.innerHTML = '<header class="site-head"><span class="sc-brand">SwarmCast</span><div id="brand-head" hidden></div></header><main class="card"><h1>Join the stream</h1><p class="muted">Pick a nickname.</p></main>';
    const c = startBrand('join', { fetch: fetcher(brand()) as unknown as typeof fetch });
    await c.refresh();
    const h1 = document.querySelector('main h1')!;
    expect(h1.textContent).toBe("Join Ana Plays's stream");
    expect(h1.querySelector('bdi')!.textContent).toBe('Ana Plays');
    expect(document.querySelector('main h1 + p')!.textContent).toBe('Chill games every Friday');
    expect(document.querySelector('#brand-head .sc-brand-tagline')).toBeNull();
  });
});

describe('Pix sheet', () => {
  const payload = buildPixPayload({ key: '123e4567-e89b-12d3-a456-426614174000', name: 'Ana Souza', city: 'Sao Paulo' });
  const pix = { type: 'evp' as const, key: '123e4567-e89b-12d3-a456-426614174000', name: 'ANA SOUZA', payload: payload.ok ? payload.payload : '' };

  it('shows the receiver name, the key, the copia e cola code and a QR code; copies; Escape closes and gives focus back', async () => {
    document.body.innerHTML = '<button id="from">Pix</button>';
    const from = document.getElementById('from')!;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const dlg = openPixSheet(pix, from);
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.querySelector('.pix-receiver bdi')!.textContent).toBe('ANA SOUZA');
    expect(dlg.querySelector<HTMLInputElement>('[data-testid="pix-key"]')!.value).toBe(pix.key);
    expect(dlg.querySelector<HTMLTextAreaElement>('[data-testid="pix-code"]')!.value).toBe(pix.payload);
    expect(pix.payload.startsWith('000201')).toBe(true);
    const qr = dlg.querySelector<HTMLCanvasElement>('[data-testid="pix-qr"]')!;
    expect(qr.width).toBeGreaterThan(100);
    expect(qr.width).toBe(qr.height);
    dlg.querySelector<HTMLButtonElement>('[data-testid="pix-code-copy"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(pix.payload);
    expect(dlg.textContent).toContain('Copied ✓');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-testid="pix-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(from);
  });

  it('a payload that is not a BR Code is not offered (key only)', () => {
    document.body.innerHTML = '';
    const dlg = openPixSheet({ ...pix, payload: '<script>' }, null);
    expect(dlg.querySelector('[data-testid="pix-code"]')).toBeNull();
    expect(dlg.querySelector('[data-testid="pix-qr"]')).toBeNull();
    expect(dlg.querySelector('[data-testid="pix-key"]')).not.toBeNull();
  });
});
