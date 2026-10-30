import type { MessageKey, MessageParams } from '../i18n/index.js';
import type { PublicBrandLink, PublicBranding } from './schemas.js';
import { parseBrandUrl } from './url.js';

/**
 * DOM rendering of the streamer's page (header, About card, links, support button), shared by the
 * viewer pages and the panel's preview so both look the same (plan §2.4, §3.3).
 *
 * Rules: createElement + textContent + setAttribute with constant names only (never innerHTML);
 * every streamer string inside <bdi dir="auto">; links re-checked with the shared URL rules right
 * before `a.href` is set, opened with rel="noopener noreferrer nofollow" and no referrer.
 * Class names (`sc-brand-*`) are styled by each app.
 */

export interface BrandDomOptions {
  doc: Document;
  t: (key: MessageKey, params?: MessageParams) => string;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function bdi(doc: Document, cls: string, text: string): HTMLElement {
  const b = el(doc, 'bdi', cls, text);
  b.setAttribute('dir', 'auto');
  return b;
}

/** One link: label, then the display host (or e-mail) in a secondary line. null when the href is no longer valid. */
export function renderBrandLink(link: PublicBrandLink, o: BrandDomOptions): HTMLAnchorElement | null {
  const checked = parseBrandUrl(link.href);
  if (!checked.ok || checked.href !== link.href) return null;
  const a = el(o.doc, 'a', `sc-brand-link sc-brand-link--${checked.platform}`);
  a.href = checked.href;
  if (checked.kind === 'https') {
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.referrerPolicy = 'no-referrer';
  }
  a.setAttribute('data-platform', checked.platform);
  a.append(bdi(o.doc, 'sc-brand-link-label', link.label), bdi(o.doc, 'sc-brand-link-host', checked.display));
  return a;
}

/** Avatar, name and tagline. */
export function renderBrandHeader(b: PublicBranding, o: BrandDomOptions): HTMLElement {
  const h = el(o.doc, 'div', 'sc-brand-header');
  if (b.avatar) {
    const img = el(o.doc, 'img', 'sc-brand-avatar');
    img.src = b.avatar.s128 ?? b.avatar.s256;
    img.alt = '';
    img.decoding = 'async';
    img.width = 128;
    img.height = 128;
    h.append(img);
  }
  const text = el(o.doc, 'div', 'sc-brand-titles');
  if (b.name) text.append(bdi(o.doc, 'sc-brand-name', b.name));
  if (b.tagline) text.append(bdi(o.doc, 'sc-brand-tagline', b.tagline));
  h.append(text);
  return h;
}

/** The About card (tagline, about text, tags, links), or null when there is nothing to show. */
export function renderBrandAbout(b: PublicBranding, o: BrandDomOptions): HTMLElement | null {
  const links = b.links.map((l) => renderBrandLink(l, o)).filter((a): a is HTMLAnchorElement => a !== null);
  if (!b.about && b.tags.length === 0 && links.length === 0) return null;
  const card = el(o.doc, 'section', 'sc-brand-about');
  card.append(el(o.doc, 'h2', 'sc-brand-about-title', o.t('brand.about')));
  if (b.about) card.append(bdi(o.doc, 'sc-brand-about-text', b.about));
  if (b.tags.length) {
    const ul = el(o.doc, 'ul', 'sc-brand-tags');
    for (const tag of b.tags) {
      const li = el(o.doc, 'li', 'sc-brand-tag');
      li.append(bdi(o.doc, 'sc-brand-tag-text', tag));
      ul.append(li);
    }
    card.append(ul);
  }
  if (links.length) {
    const ul = el(o.doc, 'ul', 'sc-brand-links');
    for (const a of links) {
      const li = el(o.doc, 'li');
      li.append(a);
      ul.append(li);
    }
    card.append(ul);
  }
  return card;
}

/**
 * The support button: a link, or (Pix) a button the app wires to its Pix sheet (key, "copia e
 * cola" and QR code). null when there is no valid target.
 */
export function renderSupportButton(b: PublicBranding, o: BrandDomOptions): HTMLElement | null {
  const s = b.support;
  if (!s) return null;
  const label = o.t(`support.label.${s.label}` as MessageKey);
  if (s.pix) {
    const btn = el(o.doc, 'button', 'sc-brand-support sc-brand-support--pix', label);
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    return btn;
  }
  if (s.link) {
    const a = renderBrandLink({ ...s.link, label }, o);
    if (!a) return null;
    a.className = 'sc-brand-support';
    a.replaceChildren(label);
    return a;
  }
  return null;
}
