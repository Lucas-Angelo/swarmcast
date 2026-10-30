import { resolveLang, translate, type Lang } from '@swarmcast/shared/i18n';
import type { Branding } from '@swarmcast/shared/branding';

/**
 * Link previews (docs/BRANDING.md, plan §2.5). A messaging app fetching `/join/<secret>` to build
 * a preview gets a tiny static page with Open Graph tags (200, no cookie, no ticket) instead of
 * the 303, which today makes it show "Link not valid". With the preview card off (the default) the
 * page is a neutral invitation that reveals nothing about the stream; with it on, the channel
 * name, tagline and card image. No script, no style; every value attribute-escaped.
 */

/** Substrings of the User-Agent of known preview fetchers (lowercase). */
const PREVIEW_AGENTS = [
  'facebookexternalhit',
  'facebot',
  'meta-externalagent',
  'twitterbot',
  'whatsapp/',
  'telegrambot',
  'discordbot',
  'slackbot',
  'linkedinbot',
  'skypeuripreview',
  'embedly',
  'redditbot',
  'applebot',
  'iframely',
  'pinterestbot',
  'vkshare',
  'mastodon/',
  'bluesky',
  'signallinkpreview',
];

export function isPreviewAgent(ua: string | undefined): boolean {
  if (!ua || ua.length > 512) return false;
  const l = ua.toLowerCase();
  return PREVIEW_AGENTS.some((a) => l.includes(a));
}

/** HTML attribute and text escaping (the only server-rendered HTML with streamer text in it). */
export function escapeHtml(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&#39;'; break;
      default: out += ch;
    }
  }
  return out;
}

export interface PreviewInput {
  branding: Branding;
  /** The URL that was pasted (og:url and the "Open the stream" link). */
  url: string;
  /** Absolute URL of the card image (only with the card on and a card uploaded). */
  imageUrl?: string;
  imageType?: string;
  acceptLanguage?: string;
}

/** The preview page. */
export function previewPage(p: PreviewInput): string {
  const lang: Lang = resolveLang((p.acceptLanguage ?? '').split(',').map((x) => x.split(';')[0]!.trim()));
  const b = p.branding;
  const on = b.enabled && b.preview.enabled && !!b.name;
  const title = on ? translate(lang, 'brand.og.live', { name: b.name! }) : translate(lang, 'brand.og.invite');
  const description = on ? (b.tagline ?? '') : translate(lang, 'brand.og.inviteDesc');
  const image = on && p.imageUrl && b.images.card ? { url: p.imageUrl, w: b.images.card.w, h: b.images.card.h } : null;
  const meta = (property: string, content: string, attr = 'property'): string => `<meta ${attr}="${property}" content="${escapeHtml(content)}">`;
  const head = [
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<meta name="robots" content="noindex, nofollow">',
    meta('og:type', 'website'),
    meta('og:title', title),
    ...(description ? [meta('og:description', description), meta('description', description, 'name')] : []),
    meta('og:url', p.url),
    meta('og:site_name', 'SwarmCast'),
    ...(image ? [meta('og:image', image.url), meta('og:image:type', p.imageType ?? 'image/jpeg'), meta('og:image:width', String(image.w)), meta('og:image:height', String(image.h)), meta('twitter:card', 'summary_large_image', 'name')] : [meta('twitter:card', 'summary', 'name')]),
  ];
  return `<!doctype html>\n<html lang="${lang}"><head>${head.join('')}</head><body><p><a href="${escapeHtml(p.url)}">${escapeHtml(translate(lang, 'brand.og.open'))}</a></p></body></html>\n`;
}
