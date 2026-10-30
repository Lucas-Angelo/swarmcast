import { BRAND_URL_MAX } from './limits.js';

/**
 * Link rules for streamer links and the support button (plan §3.3; user decision: https and
 * mailto only). Parsed with the WHATWG URL parser, the one browsers use for `href`, so server and
 * browser agree on what the link is. The same check runs on save, on load and before render.
 */

export type BrandUrlError = 'url.empty' | 'url.tooLong' | 'url.chars' | 'url.scheme' | 'url.credentials' | 'url.host' | 'url.port' | 'url.local' | 'url.own' | 'url.mail';

export type BrandUrl =
  | {
      ok: true;
      kind: 'https' | 'mailto';
      /** Normalised href to store and to set as `a.href`. */
      href: string;
      /** What viewers see under the label: the ASCII (punycode) host, or the e-mail address. */
      display: string;
      /** Known platform for the icon ('link' or 'mail' otherwise); decided from the host, never stored. */
      platform: BrandPlatform;
    }
  | { ok: false; code: BrandUrlError };

export type BrandPlatform =
  | 'youtube'
  | 'twitch'
  | 'kick'
  | 'instagram'
  | 'tiktok'
  | 'x'
  | 'bluesky'
  | 'mastodon'
  | 'discord'
  | 'github'
  | 'kofi'
  | 'patreon'
  | 'livepix'
  | 'paypal'
  | 'apoiase'
  | 'link'
  | 'mail';

const PLATFORMS: Array<[BrandPlatform, string[]]> = [
  ['youtube', ['youtube.com', 'youtu.be']],
  ['twitch', ['twitch.tv']],
  ['kick', ['kick.com']],
  ['instagram', ['instagram.com']],
  ['tiktok', ['tiktok.com']],
  ['x', ['x.com', 'twitter.com']],
  ['bluesky', ['bsky.app']],
  ['discord', ['discord.gg', 'discord.com']],
  ['github', ['github.com']],
  ['kofi', ['ko-fi.com']],
  ['patreon', ['patreon.com']],
  ['livepix', ['livepix.gg']],
  ['paypal', ['paypal.com', 'paypal.me']],
  ['apoiase', ['apoia.se']],
];

/** Hosts that point into the viewer's own network or are not public names. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'test', 'example', 'invalid', 'onion', 'corp', 'intranet', 'private', 'localdomain'];

function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || c === 0x205f || c === 0x3000 || c === 0xfeff || (c >= 0x2060 && c <= 0x206f)) return true;
  }
  return false;
}

/** A DNS label: 1–63 of [a-z0-9-], not starting or ending with "-" (a loop, no regex). */
function labelOk(l: string): boolean {
  if (l.length < 1 || l.length > 63 || l.startsWith('-') || l.endsWith('-')) return false;
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d)) return false;
  }
  return true;
}

/** Characters never allowed in a mailto address (headers, recipients lists, comments, paths). */
const MAIL_BAD = new Set('?&,;:/\\<>()[]"\''.split(''));

/** A public DNS name (ASCII, as the URL parser gives it): dotted, valid labels, a real-looking TLD. */
function hostProblem(host: string): BrandUrlError | null {
  if (host.length === 0 || host.length > 253) return 'url.host';
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'url.local';
  const labels = host.split('.');
  if (labels.length < 2) return 'url.local';
  if (!labels.every(labelOk)) return 'url.host';
  const tld = labels[labels.length - 1]!;
  if (LOCAL_SUFFIXES.includes(tld) || host === 'localhost') return 'url.local';
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) return 'url.host';
  return null;
}

export function platformOf(hostname: string, path = ''): BrandPlatform {
  const h = hostname.replace(/^www\./, '').replace(/^m\./, '');
  for (const [p, hosts] of PLATFORMS) if (hosts.some((x) => h === x || h.endsWith(`.${x}`))) return p;
  // Mastodon instances: any host with a /@user path.
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  if (/^\/@[A-Za-z0-9_]{1,30}$/.test(p)) return 'mastodon';
  return 'link';
}

const MAIL_LOCAL = /^[A-Za-z0-9._%+-]{1,64}$/;

/**
 * Validate and normalise a streamer link. `ownHost`: the stream's own host (refused, so a link
 * cannot point at our own origin, whose paths carry viewers' cookies).
 */
export function parseBrandUrl(raw: string, opts: { ownHost?: string } = {}): BrandUrl {
  const s = raw.trim();
  if (s === '') return { ok: false, code: 'url.empty' };
  if (s.length > BRAND_URL_MAX) return { ok: false, code: 'url.tooLong' };
  if (hasControlOrSpace(s)) return { ok: false, code: 'url.chars' };
  if (/^mailto:/i.test(s)) {
    const addr = s.slice(7);
    // One plain address: no headers (?subject=, &cc=), no second recipient, no comments.
    const at = addr.indexOf('@');
    if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1 || [...addr].some((ch) => MAIL_BAD.has(ch))) return { ok: false, code: 'url.mail' };
    const local = addr.slice(0, at);
    let domain: string;
    try {
      domain = new URL(`https://${addr.slice(at + 1)}/`).hostname;
    } catch {
      return { ok: false, code: 'url.mail' };
    }
    if (!MAIL_LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return { ok: false, code: 'url.mail' };
    const hp = hostProblem(domain);
    if (hp) return { ok: false, code: hp === 'url.host' ? 'url.mail' : hp };
    const address = `${local}@${domain}`;
    return { ok: true, kind: 'mailto', href: `mailto:${address}`, display: address, platform: 'mail' };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, code: 'url.scheme' };
  }
  if (u.protocol !== 'https:') return { ok: false, code: 'url.scheme' };
  if (u.username || u.password) return { ok: false, code: 'url.credentials' };
  if (u.port !== '') return { ok: false, code: 'url.port' };
  const hp = hostProblem(u.hostname);
  if (hp) return { ok: false, code: hp };
  const own = opts.ownHost?.toLowerCase().replace(/:\d+$/, '');
  if (own && (u.hostname === own || u.hostname.endsWith(`.${own}`))) return { ok: false, code: 'url.own' };
  if (u.href.length > BRAND_URL_MAX) return { ok: false, code: 'url.tooLong' };
  return { ok: true, kind: 'https', href: u.href, display: u.hostname.replace(/^www\./, ''), platform: platformOf(u.hostname, u.pathname) };
}

/**
 * What the panel offers when the streamer types an address without a scheme: "ko-fi.com/ana"
 * becomes "https://ko-fi.com/ana", "ana@example.com" becomes "mailto:ana@example.com". Shown to
 * her before saving; never applied silently on the server.
 */
export function suggestBrandUrl(raw: string): string {
  const s = raw.trim();
  if (s === '' || s.includes(' ')) return s;
  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  // Already has a scheme ("https:", "mailto:"…): leave it to parseBrandUrl.
  if (colon > 0 && (slash < 0 || colon < slash)) return s;
  const at = s.indexOf('@');
  if (at > 0 && at === s.lastIndexOf('@') && slash < 0 && s.slice(at + 1).includes('.')) return `mailto:${s}`;
  const host = s.slice(0, slash < 0 ? s.length : slash).split(/[?#]/)[0]!;
  const dot = host.lastIndexOf('.');
  if (at < 0 && dot > 0 && /^[a-z]{2,63}$/i.test(host.slice(dot + 1))) return `https://${s}`;
  return s;
}
