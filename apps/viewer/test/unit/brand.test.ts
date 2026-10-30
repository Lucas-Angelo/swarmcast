// @vitest-environment happy-dom
// The streamer's page on the viewer side (branding/brand.ts) and the Pix support sheet
// (branding/pix-sheet.ts). /api/brand is a fake fetch that answers with an ETag and a 304 for a
// matching If-None-Match, like the server. Streamer text is untrusted: it must stay text.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildPixPayload, type PublicBranding } from '@swarmcast/shared/branding';
import { sanitizeBranding, startBrand, type BrandPage } from '../../src/branding/brand.js';
import { openPixSheet } from '../../src/branding/pix-sheet.js';

// The pages link the theme stylesheet; happy-dom loads no files and would log every such link
// as a failed load: here a link counts as loaded, as in a browser.
(window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;

const ETAG = '"b3-x"';
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

/** The watch page's markup around the player, as watch.html has it. */
function watchDom(): void {
  document.head.innerHTML = '<title>Live · SwarmCast</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">';
  document.body.className = 'watch';
  document.body.innerHTML = `<link rel="stylesheet" href="/brand/theme.css" data-brand-theme>
    <header class="site-head"><span class="sc-brand">SwarmCast</span><div id="brand-head" hidden></div><div id="brand-support" hidden></div></header>
    <main class="stage"><div id="brand-banner" hidden></div><div class="player"></div><div id="brand-about" hidden></div></main>
    <footer id="brand-credit" hidden><a href="#">on SwarmCast</a></footer>
    <div id="ended" hidden><div class="card"><span class="sc-mascot"></span><h1 id="ended-title">Ended</h1><p id="ended-text">Thanks for watching!</p></div></div>`;
}

/** The join page's markup, as join.html has it. */
function joinDom(): void {
  document.head.innerHTML = '<title>Join the stream · SwarmCast</title>';
  document.body.className = '';
  document.body.innerHTML = '<header class="site-head"><span class="sc-brand">SwarmCast</span><div id="brand-head" hidden></div></header><main class="card"><h1>Join the stream</h1><p class="muted">Pick a nickname.</p></main>';
}

/** /api/brand answering `body`, or 304 when the request carries its ETag. */
function fetcher(body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (inm === ETAG) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { headers: { ETag: ETAG, 'content-type': 'application/json' } });
  });
}

/** The page's markup, then startBrand on it with `body` as /api/brand, refreshed once. */
async function branded(page: BrandPage, body: unknown = brand()) {
  if (page === 'watch') watchDom();
  else joinDom();
  const f = fetcher(body);
  const c = startBrand(page, { fetch: f as unknown as typeof fetch });
  await c.refresh();
  return { c, f };
}

const byId = (id: string): HTMLElement => document.getElementById(id)!;

describe('sanitizeBranding', () => {
  it('drops images that are not our own content-hash files', () => {
    // Act
    const b = sanitizeBranding({ ...brand(), avatar: { s256: 'https://evil.example/a.png' }, banner: { s1280: 'javascript:alert(1)' } });

    // Assert
    expect(b?.avatar).toBeUndefined();
    expect(b?.banner).toBeUndefined();
    expect(b?.favicon?.s32).toBe(IMG('c'));
  });

  it.each([
    ['branding off', { off: true }],
    ['not an object', 'x'],
  ])('%s gives null', (_case, raw) => {
    // Act
    const b = sanitizeBranding(raw);

    // Assert
    expect(b).toBeNull();
  });
});

describe('watch page branding', () => {
  it('shows the streamer instead of the stock header', async () => {
    // Act
    await branded('watch');

    // Assert
    expect(document.querySelector<HTMLElement>('.site-head .sc-brand')!.hidden).toBe(true);
    const head = byId('brand-head');
    expect(head.hidden).toBe(false);
    expect(head.querySelector('bdi.sc-brand-name')!.textContent).toBe('Ana Plays');
    expect(head.querySelector('img.sc-brand-avatar')!.getAttribute('src')).toBe(IMG('b'));
  });

  it('shows the about card with tagline, text, tags and links that open safely in a new tab', async () => {
    // Act
    await branded('watch');

    // Assert
    const about = byId('brand-about');
    expect(about.querySelector('.sc-brand-tagline')!.textContent).toBe('Chill games every Friday');
    expect(about.querySelector('.sc-brand-about-text')!.textContent).toBe('Hi!\nI stream indie games.');
    expect([...about.querySelectorAll('.sc-brand-tag')].map((x) => x.textContent)).toEqual(['cozy', 'indie']);
    const link = about.querySelector<HTMLAnchorElement>('a.sc-brand-link')!;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.target).toBe('_blank');
  });

  it('shows the support button and the credit', async () => {
    // Act
    await branded('watch');

    // Assert
    const support = document.querySelector<HTMLAnchorElement>('#brand-support a.sc-brand-support')!;
    expect(support.getAttribute('href')).toBe('https://ko-fi.com/ana');
    expect(support.textContent).toBe('Support');
    expect(byId('brand-credit').hidden).toBe(false);
  });

  it('names the tab after the streamer and uses their picture as favicon and home-screen icon', async () => {
    // Act
    await branded('watch');

    // Assert
    expect(document.title).toBe('Ana Plays · live');
    expect(document.querySelector('link[rel=icon]')!.getAttribute('href')).toBe(IMG('c'));
    expect(document.querySelector('link[rel=apple-touch-icon]')!.getAttribute('href')).toBe(IMG('d'));
  });

  it('loads no banner before the first fragment (it never delays the first frame)', async () => {
    // Act
    await branded('watch');

    // Assert
    expect(document.querySelector('#brand-banner img')).toBeNull();
  });

  it('loads the banner after the first fragment, lazily and responsive', async () => {
    // Arrange
    const { c } = await branded('watch');

    // Act
    c.firstFrame();

    // Assert
    const img = document.querySelector<HTMLImageElement>('#brand-banner img')!;
    expect(img.getAttribute('src')).toBe(IMG('e', 'webp'));
    expect(img.getAttribute('srcset')).toContain('640w');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('lite mode: no banner, even after the first fragment', async () => {
    // Arrange
    const { c } = await branded('watch', brand({ lite: true }));

    // Act
    c.firstFrame();

    // Assert
    expect(document.querySelector('#brand-banner img')).toBeNull();
  });

  it('skips a refresh for the revision it already has', async () => {
    // Arrange
    const { c, f } = await branded('watch');

    // Act
    await c.refresh(3);

    // Assert
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a newer revision asks again with If-None-Match and swaps the theme stylesheet', async () => {
    // Arrange
    const { c, f } = await branded('watch');

    // Act
    await c.refresh(4);

    // Assert
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[1]![1]?.headers as Record<string, string>)['If-None-Match']).toBe(ETAG);
    expect(document.querySelector('link[data-brand-theme]')!.getAttribute('href')).toBe('/brand/theme.css?r=4');
    expect(c.data?.name).toBe('Ana Plays');
  });

  it('the ended screen shows the streamer message, picture and support button', async () => {
    // Arrange
    const { c } = await branded('watch');

    // Act
    c.ended();

    // Assert
    expect(byId('ended-text').textContent).toBe('Thanks! Back on Friday');
    expect(document.querySelector<HTMLElement>('#ended .sc-mascot')!.hidden).toBe(true);
    expect(document.querySelector('#ended img.sc-brand-ended-avatar')).not.toBeNull();
    expect(document.querySelector('#ended .sc-brand-support')).not.toBeNull();
  });

  it('branding off: the stock page stays', async () => {
    // Act
    await branded('watch', { off: true });

    // Assert
    expect(document.querySelector<HTMLElement>('.site-head .sc-brand')!.hidden).toBe(false);
    expect(byId('brand-about').hidden).toBe(true);
    expect(byId('brand-credit').hidden).toBe(true);
    expect(document.title).toBe('Live · SwarmCast');
  });

  it('streamer text is text: markup in a name or the about text never becomes elements', async () => {
    // Act
    await branded('watch', brand({ name: '<img src=x onerror=alert(1)>', about: '<b>hi</b>' }));

    // Assert
    expect(document.querySelector('#brand-head bdi.sc-brand-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('#brand-head img').length).toBe(1);
    expect(document.querySelector('#brand-about b')).toBeNull();
  });
});

describe('join page branding', () => {
  it('"Join {name}\'s stream" with the name in its own bdi, the tagline as the intro', async () => {
    // Act
    await branded('join');

    // Assert
    const h1 = document.querySelector('main h1')!;
    expect(h1.textContent).toBe("Join Ana Plays's stream");
    expect(h1.querySelector('bdi')!.textContent).toBe('Ana Plays');
    expect(document.querySelector('main h1 + p')!.textContent).toBe('Chill games every Friday');
    expect(document.querySelector('#brand-head .sc-brand-tagline')).toBeNull();
  });
});

describe('Pix sheet', () => {
  const KEY = '123e4567-e89b-12d3-a456-426614174000';
  const payload = buildPixPayload({ key: KEY, name: 'Ana Souza', city: 'Sao Paulo' });
  const pix = { type: 'evp' as const, key: KEY, name: 'ANA SOUZA', payload: payload.ok ? payload.payload : '' };

  /** The sheet opened from a Pix button in an empty page; the clipboard is a fake for this test only. */
  function sheet(info = pix) {
    document.body.innerHTML = '<button id="from">Pix</button>';
    const from = document.getElementById('from')!;
    const writeText = vi.fn(async () => {});
    const clipboard = vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
    onTestFinished(() => clipboard.mockRestore());
    const dlg = openPixSheet(info, from);
    return { dlg, from, writeText };
  }

  it('is a modal dialog with the receiver name, the key, the copia e cola code and a square QR code', () => {
    // Act
    const { dlg } = sheet();

    // Assert
    expect(pix.payload.startsWith('000201')).toBe(true);
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.querySelector('.pix-receiver bdi')!.textContent).toBe('ANA SOUZA');
    expect(dlg.querySelector<HTMLInputElement>('[data-testid="pix-key"]')!.value).toBe(KEY);
    expect(dlg.querySelector<HTMLTextAreaElement>('[data-testid="pix-code"]')!.value).toBe(pix.payload);
    const qr = dlg.querySelector<HTMLCanvasElement>('[data-testid="pix-qr"]')!;
    expect(qr.width).toBeGreaterThan(100);
    expect(qr.width).toBe(qr.height);
  });

  it('copies the code and says so', async () => {
    // Arrange
    const { dlg, writeText } = sheet();
    const copy = dlg.querySelector<HTMLButtonElement>('[data-testid="pix-code-copy"]')!;
    const status = copy.closest('.pix-field')!.querySelector('[role="status"]')!;

    // Act
    copy.click();
    await vi.waitFor(() => expect(status.textContent).not.toBe(''), { interval: 5 });

    // Assert
    expect(status.textContent).toBe('Copied ✓');
    expect(writeText).toHaveBeenCalledWith(pix.payload);
  });

  it('Escape closes it and gives focus back to the button that opened it', () => {
    // Arrange
    const { from } = sheet();

    // Act
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Assert
    expect(document.querySelector('[data-testid="pix-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(from);
  });

  it('a payload that is not a BR Code is not offered (key only)', () => {
    // Act
    const { dlg } = sheet({ ...pix, payload: '<script>' });

    // Assert
    expect(dlg.querySelector('[data-testid="pix-code"]')).toBeNull();
    expect(dlg.querySelector('[data-testid="pix-qr"]')).toBeNull();
    expect(dlg.querySelector('[data-testid="pix-key"]')).not.toBeNull();
  });
});
