import type { GifProvider } from './schemas.js';

/**
 * GIF providers (docs/CHAT.md, plan §3.3 and §5.6; user decision: KLIPY with the streamer's own
 * key, off by default, every viewer agrees before their browser contacts it). Viewers' browsers
 * talk to the provider directly; nothing goes through the streamer. The viewer CSP lists these
 * hosts only while GIFs are on.
 */
export const GIF_PROVIDERS: Record<GifProvider, { api: string; media: readonly string[]; attribution: string }> = {
  klipy: {
    // docs.klipy.com/network-requirements: API endpoint and media delivery hosts.
    api: 'https://api.klipy.com',
    media: ['https://static.klipy.com', 'https://static1.klipy.com', 'https://static2.klipy.com'],
    attribution: 'Search KLIPY',
  },
  giphy: {
    api: 'https://api.giphy.com',
    media: ['https://media.giphy.com', 'https://media0.giphy.com', 'https://media1.giphy.com', 'https://media2.giphy.com', 'https://media3.giphy.com', 'https://media4.giphy.com', 'https://i.giphy.com'],
    attribution: 'Powered by GIPHY',
  },
};

/** Content-filter value each provider expects for our rating setting. */
export function gifRatingParam(provider: GifProvider, rating: 'g' | 'pg' | 'pg-13'): { name: string; value: string } {
  if (provider === 'giphy') return { name: 'rating', value: rating };
  return { name: 'content_filter', value: rating === 'g' ? 'high' : rating === 'pg' ? 'medium' : 'low' };
}

// ---- chat: GIF media paths (lane B, C8 viewer half) ----
/** Longest provider media path a GIF reference may carry. */
export const GIF_PATH_MAX = 300;
/** KLIPY media path (docs.klipy.com, GIF search response): /ii/<32 hex>/<2 hex>/<2 hex>/<file>.webp|gif */
export const KLIPY_PATH_RE = /^\/ii\/[0-9a-f]{32}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[A-Za-z0-9_-]{4,40}\.(webp|gif)$/;
const GIPHY_V1_RE = /^v1\.[A-Za-z0-9_=-]{1,200}$/;
const GIPHY_ID_RE = /^[A-Za-z0-9]{6,40}$/;
const GIPHY_FILE_RE = /^(200|200w|200_d|200w_d|100|100w|giphy)\.(webp|gif)$/;

/**
 * Is `path` a media path of `provider` (host-relative, no query)? Strict per-provider shapes, so a
 * GIF reference can only ever point at an image file on the provider's own media hosts.
 */
export function isGifMediaPath(provider: GifProvider, path: string): boolean {
  if (typeof path !== 'string' || path.length > GIF_PATH_MAX) return false;
  if (provider === 'klipy') return KLIPY_PATH_RE.test(path);
  const seg = path.split('/');
  if (seg[0] !== '' || seg[1] !== 'media') return false;
  if (seg.length === 5) return GIPHY_V1_RE.test(seg[2]!) && GIPHY_ID_RE.test(seg[3]!) && GIPHY_FILE_RE.test(seg[4]!);
  return seg.length === 4 && GIPHY_ID_RE.test(seg[2]!) && GIPHY_FILE_RE.test(seg[3]!);
}

/**
 * The image URL of a GIF reference: one of the provider's media hosts (GIF_PROVIDERS) + the
 * checked path. null when the reference does not pass; the client then shows nothing.
 */
export function gifMediaUrl(ref: { p: GifProvider; m: string; hi?: number }): string | null {
  const hosts = GIF_PROVIDERS[ref.p]?.media;
  const host = hosts?.[ref.hi ?? 0];
  if (!host || !isGifMediaPath(ref.p, ref.m)) return null;
  return `${host}${ref.m}`;
}

/** The reverse, for the picker: a provider media URL as {m, hi}, or null when it is not one. */
export function gifMediaRef(provider: GifProvider, url: string): { m: string; hi: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hi = GIF_PROVIDERS[provider].media.indexOf(u.origin);
  if (hi < 0 || u.username || u.password || !isGifMediaPath(provider, u.pathname)) return null;
  return { m: u.pathname, hi };
}
// ---- end chat: GIF media paths ----
