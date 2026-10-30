import { buildPixPayload, normalizePixKey, type PublicBrandLink, type PublicBranding } from '@swarmcast/shared/branding';
import type { Draft } from './types.js';
import { cleanDraft, linkOf } from './validate.js';

/**
 * What viewers would get (`PublicBranding`, the shape of the viewer's GET /api/brand) for the
 * draft being edited, so the preview can use the viewers' own renderer
 * (`@swarmcast/shared/branding` render-dom). Invalid parts are left out, as the server would.
 */

export interface PreviewImages {
  avatar?: string;
  banner?: string;
}

/** Only object URLs this panel made, or the panel's own branding file route. */
export function safeImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (/^blob:http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[0-9A-Fa-f-]+$/.test(src)) return src;
  return /^\/api\/branding\/file\/[0-9a-f]{64}\.(png|jpg|webp)$/.test(src) ? src : undefined;
}

function publicLink(label: string, url: string): PublicBrandLink | null {
  const r = linkOf(url);
  return r.ok && label ? { label, href: r.href, display: r.display, platform: r.platform } : null;
}

export function toPublic(draft: Draft, images: PreviewImages): PublicBranding {
  const d = cleanDraft(draft);
  const out: PublicBranding = {
    rev: 0,
    tags: d.tags,
    links: d.links.map((l) => publicLink(l.label, l.url)).filter((l): l is PublicBrandLink => l !== null),
    theme: { preset: d.theme.preset, corners: d.theme.corners },
    showCredit: d.showCredit,
  };
  if (d.name) out.name = d.name;
  if (d.tagline) out.tagline = d.tagline;
  if (d.about) out.about = d.about;
  if (d.endedMessage) out.endedMessage = d.endedMessage;
  const avatar = safeImageSrc(images.avatar);
  if (avatar) out.avatar = { s256: avatar };
  const banner = safeImageSrc(images.banner);
  if (banner) out.banner = { s1280: banner, ...(d.bannerAlt ? { alt: d.bannerAlt } : {}) };
  const s = d.support;
  if (s.enabled && s.mode === 'link' && s.url) {
    const link = publicLink('-', s.url);
    if (link) out.support = { label: s.label, link };
  }
  if (s.enabled && s.mode === 'pix' && s.pix) {
    const k = normalizePixKey(s.pix.type, s.pix.key);
    const p = k.ok ? buildPixPayload({ key: k.key, name: s.pix.name, city: s.pix.city }) : null;
    if (k.ok && p?.ok) out.support = { label: s.label, pix: { type: s.pix.type, key: k.key, name: s.pix.name, payload: p.payload } };
  }
  return out;
}
