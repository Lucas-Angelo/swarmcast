import { z } from 'zod';
import { translate } from '../i18n/index.js';
import { hexColorSchema } from '../chat/schemas.js';
import { BRAND_CORNERS, BRAND_MAX_LINKS, BRAND_MAX_TAGS, BRAND_PRESETS, BRAND_SLOTS, BRAND_SUPPORT_LABELS, BRAND_TEXT, BRAND_URL_MAX, type BrandTextProfile } from './limits.js';
import { normalizePixKey, type PixKeyType } from './pix.js';
import { canonicalizeBrandText } from './text.js';
import type { DerivedTheme } from './theme.js';
import { parseBrandUrl, type BrandPlatform } from './url.js';

/**
 * Branding data (plan §5.1): config.json → `branding`, the panel's PUT body, and what viewers get.
 * Text fields are canonicalised by the shared pipeline on parse; links by the shared URL rules.
 * Validation messages are the English texts of the error codes (brandingError maps them back).
 */

/** A text field with a profile; '' (nothing visible) becomes undefined. */
export function brandText(profile: BrandTextProfile) {
  return z.string().transform((s, ctx) => {
    const r = canonicalizeBrandText(s, profile);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: translate('en', r.code, r.params) });
      return z.NEVER;
    }
    return r.text === '' ? undefined : r.text;
  });
}

/** A link target: https or mailto, normalised (stored as the parser's href). */
export const brandUrlSchema = z
  .string()
  .max(BRAND_URL_MAX * 2)
  .transform((s, ctx) => {
    const r = parseBrandUrl(s);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: translate('en', r.code) });
      return z.NEVER;
    }
    return r.href;
  });

export const brandImageRefSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{64}$/),
  type: z.enum(['png', 'jpeg', 'webp']),
  w: z.number().int().min(1).max(4096),
  h: z.number().int().min(1).max(4096),
  bytes: z.number().int().min(1).max(512 * 1024),
});
export type BrandImageRef = z.infer<typeof brandImageRefSchema>;

export const brandSlotSchema = z.enum(Object.keys(BRAND_SLOTS) as [keyof typeof BRAND_SLOTS, ...Array<keyof typeof BRAND_SLOTS>]);

export const pixKeyTypeSchema = z.enum(['evp', 'email', 'phone', 'cpf', 'cnpj']);

/** Pix: the key (normalised per type), and the name and city the BR Code carries. */
export const brandPixSchema = z
  .object({
    type: pixKeyTypeSchema,
    key: z.string().max(100),
    /** Receiver name for the BR Code (ASCII, ≤ 25 after transliteration). */
    name: z.string().max(100),
    city: z.string().max(100),
  })
  .transform((p, ctx) => {
    const k = normalizePixKey(p.type as PixKeyType, p.key);
    if (!k.ok) {
      ctx.addIssue({ code: 'custom', message: translate('en', k.code), path: ['key'] });
      return z.NEVER;
    }
    return { ...p, key: k.key };
  });

const textFields = {
  name: brandText(BRAND_TEXT.name).optional(),
  tagline: brandText(BRAND_TEXT.tagline).optional(),
  about: brandText(BRAND_TEXT.about).optional(),
  tags: z
    .array(brandText(BRAND_TEXT.tag))
    .max(BRAND_MAX_TAGS)
    .default([])
    .transform((tags) => tags.filter((t): t is string => t !== undefined)),
  links: z
    .array(z.object({ label: brandText(BRAND_TEXT.linkLabel), url: brandUrlSchema }))
    .max(BRAND_MAX_LINKS)
    .default([])
    .transform((links, ctx) => {
      const out: Array<{ label: string; url: string }> = [];
      for (const l of links) {
        if (!l.label) {
          ctx.addIssue({ code: 'custom', message: translate('en', 'brand.err.linkLabel') });
          return z.NEVER;
        }
        out.push({ label: l.label, url: l.url });
      }
      return out;
    }),
  support: z
    .object({
      enabled: z.boolean().default(false),
      label: z.enum(BRAND_SUPPORT_LABELS).default('support'),
      mode: z.enum(['link', 'pix']).default('link'),
      url: brandUrlSchema.optional(),
      pix: brandPixSchema.optional(),
    })
    .prefault({}),
  theme: z
    .object({
      preset: z.enum(BRAND_PRESETS).default('forest'),
      accent: hexColorSchema.optional(),
      corners: z.enum(Object.keys(BRAND_CORNERS) as ['round', 'soft', 'square']).default('round'),
    })
    .prefault({}),
  preview: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  endedMessage: brandText(BRAND_TEXT.ended).optional(),
  bannerAlt: brandText(BRAND_TEXT.bannerAlt).optional(),
  showCredit: z.boolean().default(true),
};

/** PUT /api/branding: everything except the image references and the revision. */
export const brandingTextSchema = z.object({ enabled: z.boolean().default(true), ...textFields });
export type BrandingText = z.output<typeof brandingTextSchema>;

/** config.json → `branding` (every field has a default: old files need no migration). */
export const brandingSchema = z.object({
  enabled: z.boolean().default(true),
  ...textFields,
  images: z.partialRecord(brandSlotSchema, brandImageRefSchema).default({}),
  rev: z.number().int().min(0).default(0),
});
export type Branding = z.output<typeof brandingSchema>;

export function defaultBranding(): Branding {
  return brandingSchema.parse({});
}

/** A link as viewers get it (the display host and platform are derived again on the server). */
export interface PublicBrandLink {
  label: string;
  href: string;
  display: string;
  platform: BrandPlatform;
}

/** GET /api/brand (viewer pages): only what the page shows. */
export interface PublicBranding {
  rev: number;
  /** Under attack or a saturated uplink: skip the banner (names, colours and links still show). */
  lite?: boolean;
  name?: string;
  tagline?: string;
  about?: string;
  tags: string[];
  links: PublicBrandLink[];
  support?: {
    label: (typeof BRAND_SUPPORT_LABELS)[number];
    link?: PublicBrandLink;
    pix?: { type: PixKeyType; key: string; name: string; payload: string };
  };
  theme: { preset: (typeof BRAND_PRESETS)[number]; corners: 'round' | 'soft' | 'square' };
  avatar?: { s256: string; s128?: string };
  favicon?: { s32: string; s180?: string };
  banner?: { s1280: string; s640?: string; alt?: string };
  endedMessage?: string;
  showCredit: boolean;
}

/** GET /api/branding (panel): the config, the derived theme for the preview, image URLs. */
export interface AdminBrandingState {
  branding: Branding;
  derived: DerivedTheme;
  images: Partial<Record<keyof typeof BRAND_SLOTS, string>>;
  public: PublicBranding;
  disk: { files: number; bytes: number };
}
