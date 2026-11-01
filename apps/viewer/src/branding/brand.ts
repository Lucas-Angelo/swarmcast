// The streamer's page on the viewer side (branding plan 2.8, 5.4, 5.6): fetch /api/brand (a ticket
// or session is enough), draw it with the shared renderer, keep it current when the panel saves
// ({t:'branding', rev} on /control), and swap the theme stylesheet. Loaded as its own chunk by
// loader.ts; a failure leaves the stock SwarmCast page.
import './brand.css';
import { t } from '@swarmcast/shared/i18n';
import { renderBrandAbout, renderBrandHeader, renderSupportButton, type PublicBranding } from '@swarmcast/shared/branding';

export type BrandPage = 'watch' | 'join';

export interface BrandController {
  /** The page's revision changed (hello.brandRev or a branding message): fetch again. */
  refresh(rev?: number): Promise<void>;
  /** The player has its first fragment: the banner may load now (it never delays the first frame). */
  firstFrame(): void;
  /** The stream ended: the streamer's ended message, picture and support button. */
  ended(): void;
  /** Current data (tests). */
  readonly data: PublicBranding | null;
}

/** Brand images are served from our own origin under content-hash names; anything else is dropped. */
const IMAGE = /^\/brand\/[0-9a-f]{64}\.(png|jpg|webp)$/;
const okImage = (u: unknown): u is string => typeof u === 'string' && IMAGE.test(u);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Keep only well-formed fields of the server's answer (defence in depth; rendering is textContent anyway). */
export function sanitizeBranding(raw: unknown): PublicBranding | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if ((b as { off?: unknown }).off === true || typeof b.rev !== 'number') return null;
  const avatar = b.avatar as PublicBranding['avatar'] | undefined;
  const favicon = b.favicon as PublicBranding['favicon'] | undefined;
  const banner = b.banner as PublicBranding['banner'] | undefined;
  const theme = (b.theme ?? {}) as PublicBranding['theme'];
  const out: PublicBranding = {
    rev: b.rev,
    ...(b.lite === true ? { lite: true } : {}),
    tags: Array.isArray(b.tags) ? b.tags.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(0, 8) : [],
    links: Array.isArray(b.links) ? (b.links as PublicBranding['links']).filter((l) => l && typeof l.label === 'string' && typeof l.href === 'string').slice(0, 6) : [],
    theme: { preset: theme.preset ?? 'forest', corners: theme.corners ?? 'round' },
    showCredit: b.showCredit !== false,
  };
  const name = str(b.name, 400);
  const tagline = str(b.tagline, 1000);
  const about = str(b.about, 8000);
  const endedMessage = str(b.endedMessage, 1000);
  if (name) out.name = name;
  if (tagline) out.tagline = tagline;
  if (about) out.about = about;
  if (endedMessage) out.endedMessage = endedMessage;
  if (avatar && okImage(avatar.s256)) out.avatar = { s256: avatar.s256, ...(okImage(avatar.s128) ? { s128: avatar.s128 } : {}) };
  if (favicon && okImage(favicon.s32)) out.favicon = { s32: favicon.s32, ...(okImage(favicon.s180) ? { s180: favicon.s180 } : {}) };
  if (banner && okImage(banner.s1280)) out.banner = { s1280: banner.s1280, ...(okImage(banner.s640) ? { s640: banner.s640 } : {}), ...(str(banner.alt, 600) ? { alt: banner.alt } : {}) };
  const s = b.support as PublicBranding['support'] | undefined;
  if (s && typeof s.label === 'string') {
    const pix = s.pix && typeof s.pix.key === 'string' && typeof s.pix.payload === 'string' && typeof s.pix.name === 'string' ? s.pix : undefined;
    const link = s.link && typeof s.link.href === 'string' ? s.link : undefined;
    if (pix || link) out.support = { label: s.label, ...(pix ? { pix } : {}), ...(link ? { link } : {}) };
  }
  return out;
}

const byId = (id: string): HTMLElement | null => document.getElementById(id);
const dom = { doc: document, t };

/** Favicon and home-screen icon from the streamer's picture; the stock icon otherwise. */
function applyIcons(b: PublicBranding | null): void {
  const head = document.head;
  const icon = head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon && !icon.dataset.stock) icon.dataset.stock = icon.getAttribute('href') ?? '';
  if (b?.favicon && icon) {
    icon.href = b.favicon.s32;
    icon.type = 'image/png';
  } else if (icon?.dataset.stock) {
    icon.setAttribute('href', icon.dataset.stock);
    icon.type = 'image/svg+xml';
  }
  let touch = head.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (b?.favicon?.s180) {
    if (!touch) {
      touch = document.createElement('link');
      touch.rel = 'apple-touch-icon';
      head.append(touch);
    }
    touch.href = b.favicon.s180;
  } else touch?.remove();
}

/** Reload /brand/theme.css after a save (a new URL so the browser asks again). */
function reloadTheme(rev: number): void {
  const link = document.querySelector<HTMLLinkElement>('link[data-brand-theme]');
  if (link) link.href = `/brand/theme.css?r=${rev}`;
}

/** "Join {name}'s stream" with the name as its own <bdi> node (never concatenated into markup). */
export function sentenceWithName(key: 'brand.viewer.joinTitle', name: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const marker = '\u0000';
  const [before, after] = t(key, { name: marker }).split(marker);
  const nameEl = document.createElement('bdi');
  nameEl.className = 'sc-brand-inline';
  nameEl.setAttribute('dir', 'auto');
  nameEl.textContent = name;
  // One inline box: the page's h1 is a flex row with a gap, which would otherwise put a gap
  // between the name and the text around it ("Join Ana Plays 's stream").
  const sentence = document.createElement('span');
  sentence.append(before ?? '', nameEl, after ?? '');
  frag.append(sentence);
  return frag;
}

function aboutCard(b: PublicBranding): HTMLElement | null {
  const card = renderBrandAbout(b, dom);
  if (!card && !b.tagline) return null;
  const section = card ?? Object.assign(document.createElement('section'), { className: 'sc-brand-about' });
  if (b.tagline) {
    const tag = document.createElement('bdi');
    tag.className = 'sc-brand-tagline';
    tag.setAttribute('dir', 'auto');
    tag.textContent = b.tagline;
    const title = section.querySelector('.sc-brand-about-title');
    if (title) title.after(tag);
    else section.prepend(tag);
  }
  const text = section.querySelector<HTMLElement>('.sc-brand-about-text');
  if (text) {
    // Six lines, then "Show more" (plan 2.4).
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sc-brand-more secondary';
    more.textContent = t('brand.viewer.showMore');
    more.hidden = true;
    more.addEventListener('click', () => {
      const open = text.classList.toggle('open');
      more.textContent = t(open ? 'brand.viewer.showLess' : 'brand.viewer.showMore');
    });
    text.after(more);
    requestAnimationFrame(() => {
      more.hidden = text.scrollHeight <= text.clientHeight + 1;
    });
  }
  return section;
}

async function openPix(b: PublicBranding, from: HTMLElement): Promise<void> {
  if (!b.support?.pix) return;
  const { openPixSheet } = await import('./pix-sheet.js');
  openPixSheet(b.support.pix, from);
}

function supportButton(b: PublicBranding): HTMLElement | null {
  const el = renderSupportButton(b, dom);
  if (el instanceof HTMLButtonElement) el.addEventListener('click', () => void openPix(b, el));
  if (el) el.dataset.testid = 'brand-support';
  return el;
}

export interface BrandOptions {
  fetch?: typeof fetch;
  /**
   * Join page: whether the streamer's header, title and tagline may still go in. They are taller
   * than the stock ones, so once the page shows they would move the form under a press in progress
   * (startJoinBranding: true until the page shows). The tab title and icon change regardless.
   */
  canChangeLayout?: () => boolean;
  /** Called with the page's data each time it is applied (null: no page, or it is off). */
  onData?: (data: PublicBranding | null) => void;
}

export function startBrand(page: BrandPage, o: BrandOptions = {}): BrandController {
  const f = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const canChangeLayout = o.canChangeLayout ?? (() => true);
  let data: PublicBranding | null = null;
  let etag: string | null = null;
  let framed = false;
  let isEnded = false;
  const stock = { title: document.title };

  const load = async (): Promise<boolean> => {
    const res = await f('/api/brand', { credentials: 'same-origin', cache: 'no-cache', headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) return false;
    if (!res.ok) {
      data = null;
      return true;
    }
    etag = res.headers.get('ETag');
    data = sanitizeBranding(await res.json());
    return true;
  };

  const banner = (): void => {
    const slot = byId('brand-banner');
    if (!slot) return;
    const b = data?.banner;
    if (!b || data?.lite) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    // The slot shows as soon as the branding is known (its 4:1 box, brand.css), so the player under
    // it does not move when the picture comes; the picture waits for the first fragment, so it
    // never delays the first frame.
    slot.hidden = false;
    if (!framed) {
      slot.replaceChildren();
      return;
    }
    const img = document.createElement('img');
    img.className = 'sc-brand-banner-img';
    img.alt = b.alt ?? '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.setAttribute('fetchpriority', 'low');
    img.width = 1280;
    img.height = 320;
    if (b.s640) {
      img.srcset = `${b.s640} 640w, ${b.s1280} 1280w`;
      img.sizes = '(max-width: 720px) 100vw, 1280px';
    }
    img.src = b.s1280;
    slot.replaceChildren(img);
  };

  const endedScreen = (): void => {
    if (!isEnded) return;
    const card = document.querySelector('#ended .card');
    if (!card) return;
    card.querySelector('.sc-brand-ended-extra')?.remove();
    const text = byId('ended-text');
    if (data?.endedMessage && text) {
      text.textContent = '';
      const m = document.createElement('bdi');
      m.setAttribute('dir', 'auto');
      m.textContent = data.endedMessage;
      text.append(m);
    }
    const mascot = card.querySelector<HTMLElement>('.sc-mascot');
    if (data?.avatar && mascot) {
      mascot.hidden = true;
      const img = document.createElement('img');
      img.className = 'sc-brand-avatar sc-brand-ended-avatar';
      img.alt = '';
      img.src = data.avatar.s256;
      img.width = 96;
      img.height = 96;
      mascot.after(img);
    }
    const extra = document.createElement('div');
    extra.className = 'sc-brand-ended-extra';
    if (data) {
      const s = supportButton(data);
      if (s) extra.append(s);
    }
    card.append(extra);
  };

  const applyWatch = (): void => {
    const b = data;
    const branded = !!(b && (b.name || b.avatar));
    const stockMark = document.querySelector<HTMLElement>('.site-head .sc-brand');
    if (stockMark) stockMark.hidden = branded;
    const head = byId('brand-head');
    if (head) {
      head.replaceChildren(...(b && branded ? [renderBrandHeader(b, dom)] : []));
      head.hidden = !branded;
    }
    const support = byId('brand-support');
    if (support) {
      const s = b ? supportButton(b) : null;
      support.replaceChildren(...(s ? [s] : []));
      support.hidden = !s;
    }
    const about = byId('brand-about');
    if (about) {
      const card = b ? aboutCard(b) : null;
      about.replaceChildren(...(card ? [card] : []));
      about.hidden = !card;
    }
    const credit = byId('brand-credit');
    if (credit) credit.hidden = !(b && branded && b.showCredit);
    document.body.classList.toggle('branded', branded);
    document.title = b?.name ? t('brand.viewer.titleLive', { name: b.name }) : stock.title;
    banner();
  };

  const applyJoin = (): void => {
    const b = data;
    document.title = b?.name ? t('brand.viewer.joinTitle', { name: b.name }) : stock.title;
    if (!canChangeLayout()) return;
    const branded = !!(b && (b.name || b.avatar));
    const h1 = document.querySelector<HTMLElement>('main.card h1');
    const intro = document.querySelector<HTMLElement>('main.card h1 + p');
    const head = byId('brand-head');
    const stockMark = document.querySelector<HTMLElement>('.site-head .sc-brand');
    if (stockMark) stockMark.hidden = branded;
    if (head) {
      head.replaceChildren(...(b && branded ? [renderBrandHeader({ ...b, tagline: undefined }, dom)] : []));
      head.hidden = !branded;
    }
    if (h1) {
      if (!h1.dataset.stock) h1.dataset.stock = h1.textContent ?? '';
      if (b?.name) h1.replaceChildren(sentenceWithName('brand.viewer.joinTitle', b.name));
      else h1.textContent = h1.dataset.stock;
    }
    if (intro) {
      if (intro.dataset.stock === undefined) intro.dataset.stock = intro.textContent ?? '';
      if (b?.tagline) {
        const tag = document.createElement('bdi');
        tag.setAttribute('dir', 'auto');
        tag.textContent = b.tagline;
        intro.replaceChildren(tag);
      } else intro.textContent = intro.dataset.stock;
    }
    document.body.classList.toggle('branded', branded);
  };

  const apply = (): void => {
    applyIcons(data);
    if (page === 'watch') {
      applyWatch();
      endedScreen();
    } else applyJoin();
    o.onData?.(data);
  };

  const api: BrandController = {
    get data() {
      return data;
    },
    async refresh(rev?: number) {
      if (rev !== undefined && data && rev === data.rev) return;
      if (rev !== undefined) reloadTheme(rev);
      try {
        if (await load()) apply();
      } catch {
        /* keep what is shown */
      }
    },
    firstFrame() {
      if (framed) return;
      framed = true;
      banner();
    },
    ended() {
      isEnded = true;
      endedScreen();
    },
  };
  return api;
}
