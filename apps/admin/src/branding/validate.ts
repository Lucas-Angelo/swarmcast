import type { MessageKey, MessageParams } from '@swarmcast/shared';
import {
  BRAND_MAX_LINKS,
  BRAND_MAX_TAGS,
  BRAND_TEXT,
  canonicalizeBrandText,
  normalizePixKey,
  parseBrandUrl,
  PIX_CITY_MAX,
  PIX_NAME_MAX,
  PIX_PERSONAL_TYPES,
  pixAscii,
  suggestBrandUrl,
  type BrandTextProfile,
} from '@swarmcast/shared/branding';
import type { Draft } from './types.js';

/**
 * Checks the panel runs while the streamer types, with the shared rules (the same functions the
 * server's schema runs on save), so every error is explained in plain words before Save.
 */

export interface FieldError {
  key: MessageKey;
  params?: MessageParams;
}

export type FieldErrors = Record<string, FieldError>;

type TextField = 'name' | 'tagline' | 'about' | 'endedMessage' | 'bannerAlt';
const PROFILES: Record<TextField, BrandTextProfile> = {
  name: BRAND_TEXT.name,
  tagline: BRAND_TEXT.tagline,
  about: BRAND_TEXT.about,
  endedMessage: BRAND_TEXT.ended,
  bannerAlt: BRAND_TEXT.bannerAlt,
};

/** A link row the streamer left completely empty is ignored (not an error, not sent). */
export const isEmptyLink = (l: { label: string; url: string }): boolean => l.label.trim() === '' && l.url.trim() === '';

/** What the panel will store for a typed address: "ko-fi.com/ana" gets its https:// (shown before Save). */
export function linkOf(raw: string, ownHost?: string): ReturnType<typeof parseBrandUrl> {
  return parseBrandUrl(suggestLink(raw), { ownHost });
}

/**
 * suggestBrandUrl, plus addresses whose path holds an "@" ("youtube.com/@ana", Mastodon
 * handles), which it leaves without a scheme.
 */
export function suggestLink(raw: string): string {
  const s = suggestBrandUrl(raw);
  if (s !== raw.trim() || s.includes(':') || s.includes(' ')) return s;
  const slash = s.indexOf('/');
  const at = s.indexOf('@');
  return slash > 0 && at > slash ? suggestBrandUrl(`${s.slice(0, slash)}/`) + s.slice(slash + 1) : s;
}

/** Case- and accent-insensitive key of a tag (duplicates are refused). */
export function tagKey(tag: string): string {
  return tag.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A tag about to be added: its canonical text, or why it cannot be added. */
export function checkNewTag(raw: string, tags: readonly string[]): { ok: true; tag: string } | { ok: false; error: FieldError } {
  const r = canonicalizeBrandText(raw, BRAND_TEXT.tag);
  if (!r.ok) return { ok: false, error: { key: r.code, params: r.params } };
  if (r.text === '') return { ok: false, error: { key: 'text.empty' } };
  if (tags.length >= BRAND_MAX_TAGS) return { ok: false, error: { key: 'admin.brand.err.tagsFull', params: { max: BRAND_MAX_TAGS } } };
  if (tags.some((x) => tagKey(x) === tagKey(r.text))) return { ok: false, error: { key: 'brand.err.tagDup' } };
  return { ok: true, tag: r.text };
}

export function validateDraft(d: Draft, o: { pixConfirmed?: boolean; ownHost?: string } = {}): FieldErrors {
  const errs: FieldErrors = {};
  for (const f of Object.keys(PROFILES) as TextField[]) {
    const v = d[f];
    if (!v) continue;
    const r = canonicalizeBrandText(v, PROFILES[f]);
    if (!r.ok) errs[f] = { key: r.code, params: r.params };
  }
  if (d.tags.length > BRAND_MAX_TAGS) errs.tags = { key: 'admin.brand.err.tagsFull', params: { max: BRAND_MAX_TAGS } };
  const links = d.links.filter((l) => !isEmptyLink(l));
  if (links.length > BRAND_MAX_LINKS) errs.links = { key: 'admin.brand.err.linksFull', params: { max: BRAND_MAX_LINKS } };
  d.links.forEach((l, i) => {
    if (isEmptyLink(l)) return;
    const label = canonicalizeBrandText(l.label, BRAND_TEXT.linkLabel);
    if (!label.ok) errs[`links.${i}.label`] = { key: label.code, params: label.params };
    else if (label.text === '') errs[`links.${i}.label`] = { key: 'brand.err.linkLabel' };
    const r = linkOf(l.url, o.ownHost);
    if (!r.ok) errs[`links.${i}.url`] = { key: r.code };
  });
  if (d.theme.preset === 'custom' && !/^#[0-9a-f]{6}$/i.test(d.theme.accent ?? '')) errs['theme.accent'] = { key: 'admin.brand.err.colour' };
  const s = d.support;
  if (s.enabled && s.mode === 'link') {
    const r = linkOf(s.url ?? '', o.ownHost);
    if (!r.ok) errs['support.url'] = { key: r.code };
  }
  if (s.enabled && s.mode === 'pix') {
    const p = s.pix;
    const k = p ? normalizePixKey(p.type, p.key) : null;
    if (!p || !k?.ok) errs['support.pixKey'] = { key: k && !k.ok ? k.code : 'pix.key' };
    else if (PIX_PERSONAL_TYPES.includes(p.type) && !o.pixConfirmed) errs['support.pixConfirm'] = { key: 'admin.brand.pix.err.confirm' };
    if (!pixAscii(p?.name ?? '', PIX_NAME_MAX)) errs['support.pixName'] = { key: 'pix.name' };
    if (!pixAscii(p?.city ?? '', PIX_CITY_MAX)) errs['support.pixCity'] = { key: 'pix.city' };
  }
  return errs;
}

/**
 * The draft as it is sent and compared with the saved config: texts in their canonical form,
 * empty texts and empty link rows dropped, links and the Pix key normalised, and only the
 * support target that is in use (and valid) kept.
 */
export function cleanDraft(d: Draft, ownHost?: string): Draft {
  const out: Draft = {
    ...d,
    tags: [...d.tags],
    theme: { ...d.theme },
    preview: { ...d.preview },
    links: d.links.filter((l) => !isEmptyLink(l)).map((l) => {
      const label = canonicalizeBrandText(l.label, BRAND_TEXT.linkLabel);
      const r = linkOf(l.url, ownHost);
      return { label: label.ok ? label.text : l.label, url: r.ok ? r.href : l.url.trim() };
    }),
    support: { ...d.support },
  };
  for (const f of Object.keys(PROFILES) as TextField[]) {
    const v = d[f];
    const r = v === undefined ? null : canonicalizeBrandText(v, PROFILES[f]);
    if (r?.ok && r.text !== '') out[f] = r.text;
    else if (r && !r.ok) out[f] = v;
    else delete out[f];
  }
  if (out.theme.preset !== 'custom') delete out.theme.accent;
  else if (out.theme.accent) out.theme.accent = out.theme.accent.toLowerCase();
  const s = out.support;
  const url = s.url !== undefined ? linkOf(s.url, ownHost) : null;
  if (url?.ok) s.url = url.href;
  else if (s.mode !== 'link' || !s.enabled) delete s.url;
  if (s.pix) {
    const k = normalizePixKey(s.pix.type, s.pix.key);
    if (k.ok) s.pix = { ...s.pix, key: k.key, name: s.pix.name.trim(), city: s.pix.city.trim() };
    else if (s.mode !== 'pix' || !s.enabled) delete s.pix;
  }
  if (s.mode === 'link') delete s.pix;
  if (s.mode === 'pix') delete s.url;
  return out;
}
