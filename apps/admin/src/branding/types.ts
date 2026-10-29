import type { SlotId } from './image.js';
import type { Corners, DerivedTheme, PresetId } from './theme.js';

/**
 * The panel's mirror of `brandingSchema` (plan branding-0.4.0 §5.1) and of the admin API
 * (§5.3). TEMPORARY: only until BR1 lands `packages/shared/src/branding/schemas.ts`; then these
 * types are imported from @swarmcast/shared and this file goes away.
 *
 * One addition to the §5.1 sketch, for the user's decision "Pix in full" (BR6): `support.mode`
 * plus the receiver name and city that the "Pix copia e cola" string needs (fields 59 and 60).
 */

export interface BrandImageRef {
  sha: string;
  type: 'png' | 'jpeg' | 'webp';
  w: number;
  h: number;
  bytes: number;
}

export interface BrandLinkConfig {
  label: string;
  url: string;
}

export type SupportLabel = 'tip' | 'support' | 'donate' | 'pix';

export interface SupportConfig {
  label: SupportLabel;
  /** 'link' opens `url`; 'pix' opens the Pix sheet (key, copia e cola, QR code). */
  mode: 'link' | 'pix';
  url?: string;
  pixKey?: string;
  pixName?: string;
  pixCity?: string;
}

/** Everything except image refs and `rev`: the body of PUT /api/branding. */
export interface BrandingText {
  enabled: boolean;
  name?: string;
  tagline?: string;
  about?: string;
  tags: string[];
  links: BrandLinkConfig[];
  support?: SupportConfig;
  theme: { preset: PresetId; accent?: string; corners: Corners };
  preview: { enabled: boolean };
  endedMessage?: string;
  showCredit: boolean;
}

export interface BrandingConfig extends BrandingText {
  avatar?: BrandImageRef;
  avatarVariants?: { s128: BrandImageRef; fav32: BrandImageRef; fav180: BrandImageRef };
  banner?: BrandImageRef;
  bannerVariants?: { s640: BrandImageRef };
  card?: BrandImageRef;
  rev: number;
}

/** GET /api/branding (and the answer of every write): the config, the derived theme, image URLs on the panel's origin. */
export interface BrandingResponse {
  branding: BrandingConfig;
  theme?: DerivedTheme;
  /** `/api/branding/file/<sha>.<ext>` per stored slot. */
  images: Partial<Record<SlotId, string>>;
}

/** Field limits (plan §2.2). */
export const BRAND_LIMITS = {
  name: 40,
  tagline: 100,
  about: 1000,
  aboutLines: 12,
  tags: 8,
  tag: 24,
  ended: 140,
} as const;

export function defaultBranding(): BrandingConfig {
  return {
    enabled: true,
    tags: [],
    links: [],
    theme: { preset: 'forest', corners: 'round' },
    preview: { enabled: false },
    showCredit: true,
    rev: 0,
  };
}

/** The editable part of a config (what the Save button sends). */
export function textOf(b: BrandingConfig): BrandingText {
  const t: BrandingText = {
    enabled: b.enabled,
    tags: [...b.tags],
    links: b.links.map((l) => ({ ...l })),
    theme: { ...b.theme },
    preview: { ...b.preview },
    showCredit: b.showCredit,
  };
  if (b.name) t.name = b.name;
  if (b.tagline) t.tagline = b.tagline;
  if (b.about) t.about = b.about;
  if (b.endedMessage) t.endedMessage = b.endedMessage;
  if (b.support) t.support = { ...b.support };
  if (t.theme.preset !== 'custom') delete t.theme.accent;
  return t;
}
