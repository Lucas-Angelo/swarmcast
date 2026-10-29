/**
 * Link rules for "Your page" (plan branding-0.4.0 §3.3, with the user decision: https and
 * mailto only). Panel-side copy until BR1 lands `packages/shared/src/branding/url.ts`; the
 * server runs the same rules again on save and before every render.
 *
 * Pure: no DOM. Uses the WHATWG URL parser, the one browsers use for `href`, so the panel, the
 * server and the viewer's browser agree on what a link is.
 */

export const LINK_MAX_CHARS = 512;
export const LINKS_MAX = 6;
export const LINK_LABEL_MAX_GRAPHEMES = 32;

export type LinkErrorCode =
  | 'admin.brand.link.err.empty'
  | 'admin.brand.link.err.tooLong'
  | 'admin.brand.link.err.invalid'
  | 'admin.brand.link.err.scheme'
  | 'admin.brand.link.err.credentials'
  | 'admin.brand.link.err.ip'
  | 'admin.brand.link.err.local'
  | 'admin.brand.link.err.host'
  | 'admin.brand.link.err.port'
  | 'admin.brand.link.err.own'
  | 'admin.brand.link.err.mailto';

export type Platform =
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
  | 'facebook'
  | 'email';

export interface BrandLink {
  /** Normalised `URL.href` (or `mailto:local@host`): the only value ever put in an `href`. */
  href: string;
  kind: 'https' | 'mailto';
  /** ASCII (punycode) host. */
  host: string;
  /** What the viewer sees under the label: the ASCII host without `www.`, or the address. */
  display: string;
  /** Decided from the parsed host at render time; never stored. */
  platform: Platform | null;
  /** `https://` (or `mailto:`) was added to what the streamer typed. */
  prefixed: boolean;
}

export type LinkResult = { ok: true; value: BrandLink } | { ok: false; code: LinkErrorCode };

// C0 and C1 controls, DEL, and every kind of white space or invisible separator inside a link.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000- \u007f-  ᠎ -‏ -  -⁯　﻿]/;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Labels a public name never ends in: LAN, mDNS, special-use and test names. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'corp', 'intranet', 'private', 'test', 'invalid', 'onion', 'localdomain'];
const EMAIL_LOCAL = /^[A-Za-z0-9!#$&'*+/=^_`{|}~-]+(\.[A-Za-z0-9!#$&'*+/=^_`{|}~-]+)*$/;

const fail = (code: LinkErrorCode): LinkResult => ({ ok: false, code });

/** Host rules shared by https links and e-mail domains. `host` is URL.hostname (ASCII). */
function checkHost(host: string, ownHost?: string): LinkErrorCode | null {
  if (host.startsWith('[') || IPV4.test(host) || /^[0-9.]+$/.test(host)) return 'admin.brand.link.err.ip';
  const h = host.toLowerCase();
  if (LOCAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return 'admin.brand.link.err.local';
  const labels = h.split('.');
  if (labels.length < 2 || labels.some((l) => l === '' || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-')))
    return 'admin.brand.link.err.host';
  const tld = labels[labels.length - 1]!;
  // A public suffix is letters only (or an IDN TLD in punycode).
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) return 'admin.brand.link.err.host';
  if (ownHost && h === ownHost.toLowerCase().replace(/:\d+$/, '')) return 'admin.brand.link.err.own';
  return null;
}

function hostOf(domain: string): string | null {
  try {
    const u = new URL(`https://${domain}/`);
    return u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash ? null : u.hostname;
  } catch {
    return null;
  }
}

function parseMailto(rest: string, prefixed: boolean, ownHost?: string): LinkResult {
  // One plain address: no headers (?subject=, ?body=, ?cc=), no fragments, no lists, no escapes.
  if (/[?#,;%<>()[\]\\"\s]/.test(rest)) return fail('admin.brand.link.err.mailto');
  const at = rest.lastIndexOf('@');
  if (at <= 0 || at !== rest.indexOf('@')) return fail('admin.brand.link.err.mailto');
  const local = rest.slice(0, at);
  const domain = rest.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return fail('admin.brand.link.err.mailto');
  const host = hostOf(domain);
  if (!host) return fail('admin.brand.link.err.mailto');
  const bad = checkHost(host, ownHost);
  if (bad) return fail(bad === 'admin.brand.link.err.host' ? 'admin.brand.link.err.mailto' : bad);
  const address = `${local}@${host}`;
  return { ok: true, value: { href: `mailto:${address}`, kind: 'mailto', host, display: address, platform: 'email', prefixed } };
}

/**
 * Check and normalise one link typed by the streamer. `ownHost` is the stream's own host (a
 * link may not point viewers at our own origin, whose paths carry their cookies).
 */
export function parseBrandUrl(raw: string, opts: { ownHost?: string } = {}): LinkResult {
  const text = raw.trim();
  if (text === '') return fail('admin.brand.link.err.empty');
  if (text.length > LINK_MAX_CHARS) return fail('admin.brand.link.err.tooLong');
  if (BAD_CHARS.test(text)) return fail('admin.brand.link.err.invalid');

  let candidate = text;
  let prefixed = false;
  const m = SCHEME.exec(text);
  // "ko-fi.com/ana" and "youtube.com:443/x" have no scheme: the part before ':' is a host.
  const scheme = m && !m[1]!.includes('.') ? m[1]!.toLowerCase() : null;
  if (scheme === 'mailto') return parseMailto(text.slice(m![0].length), false, opts.ownHost);
  if (scheme === null) {
    if (/^[^/@:]+@[^/@]+$/.test(text)) return parseMailto(text, true, opts.ownHost);
    if (text.startsWith('//')) return fail('admin.brand.link.err.invalid');
    candidate = `https://${text}`;
    prefixed = true;
  } else if (scheme !== 'https') return fail('admin.brand.link.err.scheme');

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return fail('admin.brand.link.err.invalid');
  }
  if (u.protocol !== 'https:') return fail('admin.brand.link.err.scheme');
  if (u.username !== '' || u.password !== '') return fail('admin.brand.link.err.credentials');
  if (u.port !== '') return fail('admin.brand.link.err.port');
  const bad = checkHost(u.hostname, opts.ownHost);
  if (bad) return fail(bad);
  const href = u.href;
  if (href.length > LINK_MAX_CHARS) return fail('admin.brand.link.err.tooLong');
  const host = u.hostname;
  return { ok: true, value: { href, kind: 'https', host, display: host.replace(/^www\./, ''), platform: platformOf(host, u.pathname), prefixed } };
}

const PLATFORM_HOSTS: Record<string, Platform> = {
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'twitch.tv': 'twitch',
  'kick.com': 'kick',
  'instagram.com': 'instagram',
  'tiktok.com': 'tiktok',
  'x.com': 'x',
  'twitter.com': 'x',
  'bsky.app': 'bluesky',
  'discord.gg': 'discord',
  'discord.com': 'discord',
  'github.com': 'github',
  'ko-fi.com': 'kofi',
  'patreon.com': 'patreon',
  'livepix.gg': 'livepix',
  'paypal.com': 'paypal',
  'paypal.me': 'paypal',
  'apoia.se': 'apoiase',
  'facebook.com': 'facebook',
};

/** The platform of a parsed host (and path, for Mastodon's `/@user` shape); null = generic link. */
export function platformOf(host: string, pathname = '/'): Platform | null {
  const h = host.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const direct = PLATFORM_HOSTS[h];
  if (direct) return direct;
  if (/^\/@[A-Za-z0-9_.]{1,64}\/?$/.test(pathname)) return 'mastodon';
  return null;
}

/** Display names of the platforms (brand names, not translated). */
export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  discord: 'Discord',
  github: 'GitHub',
  kofi: 'Ko-fi',
  patreon: 'Patreon',
  livepix: 'LivePix',
  paypal: 'PayPal',
  apoiase: 'Apoia.se',
  facebook: 'Facebook',
  email: 'E-mail',
};
