import { countGraphemes, type MessageKey, type MessageParams } from '@swarmcast/shared';
import { parsePixKey, PIX_CITY_MAX, PIX_NAME_MAX, toPixAscii } from './pix.js';
import { normalizeHex } from './theme.js';
import { BRAND_LIMITS, type BrandingText } from './types.js';
import { LINK_LABEL_MAX_GRAPHEMES, LINKS_MAX, parseBrandUrl } from './url.js';

/**
 * Checks the panel runs while the streamer types (plan branding-0.4.0 §2.2). The server is
 * authoritative (it canonicalises every text with the chat's Unicode pipeline on save); these
 * checks only stop obvious mistakes early and explain them in plain words.
 */

export interface FieldError {
  key: MessageKey;
  params?: MessageParams;
}

export type FieldErrors = Record<string, FieldError>;

/** Lines of the About text as viewers see them: CR/LF folded, runs of blank lines collapsed. */
export function countLines(s: string): number {
  const lines = s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '').split('\n');
  return s.trim() === '' ? 0 : lines.length;
}

function tooLong(errs: FieldErrors, field: string, value: string | undefined, max: number): void {
  const n = countGraphemes(value ?? '');
  if (n > max) errs[field] = { key: 'admin.brand.err.tooLong', params: { count: n, max } };
}

/** Case- and accent-insensitive key of a tag (duplicates are refused). */
export function tagKey(tag: string): string {
  return tag.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A tag the streamer is about to add: null when fine, otherwise why not. */
export function checkNewTag(tag: string, tags: readonly string[]): FieldError | null {
  const t = tag.trim();
  const n = countGraphemes(t);
  if (n < 1 || n > BRAND_LIMITS.tag) return { key: 'admin.brand.err.tag' };
  if (tags.length >= BRAND_LIMITS.tags) return { key: 'admin.brand.err.tagsFull' };
  if (tags.some((x) => tagKey(x) === tagKey(t))) return { key: 'admin.brand.err.tagDup' };
  return null;
}

export function validateDraft(d: BrandingText, o: { pixConfirmed?: boolean; ownHost?: string } = {}): FieldErrors {
  const errs: FieldErrors = {};
  tooLong(errs, 'name', d.name, BRAND_LIMITS.name);
  tooLong(errs, 'tagline', d.tagline, BRAND_LIMITS.tagline);
  tooLong(errs, 'about', d.about, BRAND_LIMITS.about);
  if (!errs.about && d.about) {
    const lines = countLines(d.about);
    if (lines > BRAND_LIMITS.aboutLines) errs.about = { key: 'admin.brand.err.lines', params: { count: lines, max: BRAND_LIMITS.aboutLines } };
  }
  tooLong(errs, 'ended', d.endedMessage, BRAND_LIMITS.ended);
  if (d.tags.length > BRAND_LIMITS.tags) errs.tags = { key: 'admin.brand.err.tagsFull' };
  d.links.slice(0, LINKS_MAX).forEach((l, i) => {
    const n = countGraphemes(l.label.trim());
    if (n < 1 || n > LINK_LABEL_MAX_GRAPHEMES) errs[`links.${i}.label`] = { key: 'admin.brand.err.linkLabel' };
    const r = parseBrandUrl(l.url, { ownHost: o.ownHost });
    if (!r.ok) errs[`links.${i}.url`] = { key: r.code };
  });
  if (d.theme.preset === 'custom' && !normalizeHex(d.theme.accent)) errs['theme.accent'] = { key: 'admin.brand.err.colour' };
  const s = d.support;
  if (s?.mode === 'link') {
    const r = parseBrandUrl(s.url ?? '', { ownHost: o.ownHost });
    if (!r.ok) errs['support.url'] = { key: r.code };
  }
  if (s?.mode === 'pix') {
    const k = parsePixKey(s.pixKey ?? '');
    if (!k.ok) errs['support.pixKey'] = { key: k.code };
    else if (k.needsConfirm && !o.pixConfirmed) errs['support.pixConfirm'] = { key: 'admin.brand.pix.err.confirm' };
    if (!toPixAscii(s.pixName ?? '', PIX_NAME_MAX) || !toPixAscii(s.pixCity ?? '', PIX_CITY_MAX)) errs['support.pixNameCity'] = { key: 'admin.brand.pix.err.nameCity' };
  }
  return errs;
}

/** The draft as it is sent: texts trimmed, empty optional texts dropped, links normalised. */
export function cleanDraft(d: BrandingText, ownHost?: string): BrandingText {
  const out: BrandingText = { ...d, tags: d.tags.map((x) => x.trim()).filter(Boolean), theme: { ...d.theme }, preview: { ...d.preview } };
  for (const k of ['name', 'tagline', 'endedMessage'] as const) {
    const v = d[k]?.trim();
    if (v) out[k] = v;
    else delete out[k];
  }
  const about = d.about?.replace(/\r\n?/g, '\n').trim();
  if (about) out.about = about;
  else delete out.about;
  out.links = d.links.map((l) => {
    const r = parseBrandUrl(l.url, { ownHost });
    return { label: l.label.trim(), url: r.ok ? r.value.href : l.url.trim() };
  });
  if (out.theme.preset !== 'custom') delete out.theme.accent;
  else out.theme.accent = normalizeHex(out.theme.accent) ?? undefined;
  if (d.support) {
    const s = { ...d.support };
    if (s.mode === 'link') {
      const r = parseBrandUrl(s.url ?? '', { ownHost });
      if (r.ok) s.url = r.value.href;
      delete s.pixKey;
      delete s.pixName;
      delete s.pixCity;
    } else {
      const k = parsePixKey(s.pixKey ?? '');
      if (k.ok) s.pixKey = k.key;
      s.pixName = s.pixName?.trim();
      s.pixCity = s.pixCity?.trim();
      delete s.url;
    }
    out.support = s;
  }
  return out;
}
