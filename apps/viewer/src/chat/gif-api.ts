// GIF search, straight from the viewer's browser to the provider (plan 3.3, 5.6), only after the
// viewer agreed. No cookies, no referrer, no customer id, no analytics pingbacks. Results become
// GIF references (provider id, size, media path checked by the shared rules); a result whose
// media URL is not on the provider's listed hosts, or not in its path shape, is dropped.
import { GIF_DIM_MAX, GIF_DIM_MIN, GIF_ID_RE, GIF_PROVIDERS, gifMediaRef, gifMediaUrl, gifRatingParam, type GifProvider, type GifRef } from './core/index.js';

export interface GifConfig {
  provider: GifProvider;
  key: string;
  rating: string;
}

export interface GifResult {
  ref: GifRef;
  /** The image URL, rebuilt from the checked reference (never the provider's string as it came). */
  url: string;
  title: string;
}

const PER_PAGE = 24;
const MAX_RESPONSE = 1024 * 1024;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const rating = (r: string): 'g' | 'pg' | 'pg-13' => (r === 'g' || r === 'pg-13' ? r : 'pg');

/** The search (or trending, when `q` is empty) request URL. */
export function gifSearchUrl(cfg: GifConfig, q: string): string {
  const p = GIF_PROVIDERS[cfg.provider];
  const r = gifRatingParam(cfg.provider, rating(cfg.rating));
  const query = q.trim().slice(0, 100);
  if (cfg.provider === 'klipy') {
    const u = new URL(`${p.api}/api/v1/${encodeURIComponent(cfg.key)}/gifs/${query ? 'search' : 'trending'}`);
    u.searchParams.set('per_page', String(PER_PAGE));
    if (query) u.searchParams.set('q', query);
    u.searchParams.set(r.name, r.value);
    u.searchParams.set('format_filter', 'webp,gif');
    return u.href;
  }
  const u = new URL(`${p.api}/v1/gifs/${query ? 'search' : 'trending'}`);
  u.searchParams.set('api_key', cfg.key);
  u.searchParams.set('limit', String(PER_PAGE));
  if (query) u.searchParams.set('q', query);
  u.searchParams.set(r.name, r.value);
  return u.href;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

function toResult(provider: GifProvider, id: unknown, title: unknown, file: Json | null): GifResult | null {
  if (!file) return null;
  const sid = String(id ?? '');
  const media = gifMediaRef(provider, String(file.url ?? ''));
  const w = Math.round(num(file.width));
  const h = Math.round(num(file.height));
  if (!GIF_ID_RE.test(sid) || !media || !(w >= GIF_DIM_MIN && w <= GIF_DIM_MAX && h >= GIF_DIM_MIN && h <= GIF_DIM_MAX)) return null;
  const ref: GifRef = { p: provider, id: sid, w, h, m: media.m, ...(media.hi ? { hi: media.hi } : {}) };
  const url = gifMediaUrl(ref);
  return url ? { ref, url, title: typeof title === 'string' ? title.slice(0, 100) : '' } : null;
}

/** Parse a provider response into checked results (shape changes or junk give fewer results, never a throw). */
export function parseGifResponse(provider: GifProvider, body: unknown): GifResult[] {
  const out: GifResult[] = [];
  if (provider === 'klipy') {
    const items = obj(obj(body)?.data)?.data;
    if (!Array.isArray(items)) return out;
    for (const it of items) {
      const o = obj(it);
      const f = obj(o?.file);
      const size = obj(f?.sm) ?? obj(f?.xs) ?? obj(f?.md);
      const r = toResult(provider, o?.slug ?? o?.id, o?.title, obj(size?.webp) ?? obj(size?.gif));
      if (r) out.push(r);
    }
    return out;
  }
  const items = obj(body)?.data;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const o = obj(it);
    const img = obj(obj(o?.images)?.fixed_width);
    const r = toResult(provider, o?.id, o?.title, img ? { url: img.webp ?? img.url, width: img.width, height: img.height } : null);
    if (r) out.push(r);
  }
  return out;
}

/** Search the provider (only ever called after the viewer's consent). */
export async function searchGifs(cfg: GifConfig, q: string, o: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<GifResult[]> {
  const f: Fetch = o.fetch ?? ((input, init) => fetch(input, init));
  const res = await f(gifSearchUrl(cfg, q), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', ...(o.signal ? { signal: o.signal } : {}) });
  if (!res.ok) throw new Error(`gif search: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_RESPONSE) throw new Error('gif search: response too large');
  return parseGifResponse(cfg.provider, JSON.parse(text) as unknown);
}
