/**
 * Branding limits (docs/BRANDING.md, plan §2.2). The panel, the server and the viewer import the
 * same constants.
 */

/** Text field profiles: grapheme cap, UTF-8 byte cap, line cap (1 = one line, folded). */
export interface BrandTextProfile {
  maxGraphemes: number;
  maxBytes: number;
  maxLines: number;
  /** Tag rules: letters, numbers, spaces, "-", "_" and emoji only. */
  tag?: boolean;
}

export const BRAND_TEXT = {
  name: { maxGraphemes: 40, maxBytes: 160, maxLines: 1 },
  tagline: { maxGraphemes: 100, maxBytes: 400, maxLines: 1 },
  about: { maxGraphemes: 1000, maxBytes: 4000, maxLines: 12 },
  tag: { maxGraphemes: 24, maxBytes: 96, maxLines: 1, tag: true },
  linkLabel: { maxGraphemes: 32, maxBytes: 128, maxLines: 1 },
  ended: { maxGraphemes: 140, maxBytes: 560, maxLines: 1 },
  /** Pix merchant name and city are separate (ASCII) rules in pix.ts. */
  bannerAlt: { maxGraphemes: 120, maxBytes: 480, maxLines: 1 },
} as const satisfies Record<string, BrandTextProfile>;

/** Raw input bound before any work (UTF-16 units), per field: 4× the byte cap is plenty. */
export const BRAND_TEXT_MAX_INPUT = 6000;

export const BRAND_MAX_TAGS = 8;
export const BRAND_MAX_LINKS = 6;
export const BRAND_URL_MAX = 512;

/** Image slots: exact pixel size and byte cap of what the panel uploads (plan §3.1). */
export const BRAND_SLOTS = {
  avatar: { w: 256, h: 256, maxBytes: 64 * 1024 },
  avatar128: { w: 128, h: 128, maxBytes: 24 * 1024 },
  fav32: { w: 32, h: 32, maxBytes: 6 * 1024 },
  fav180: { w: 180, h: 180, maxBytes: 32 * 1024 },
  banner: { w: 1280, h: 320, maxBytes: 150 * 1024 },
  banner640: { w: 640, h: 160, maxBytes: 50 * 1024 },
  card: { w: 1200, h: 630, maxBytes: 200 * 1024 },
} as const;
export type BrandSlot = keyof typeof BRAND_SLOTS;
export const BRAND_SLOT_NAMES = Object.keys(BRAND_SLOTS) as BrandSlot[];

/** Any upload above this is refused before it is parsed (route body limit). */
export const BRAND_UPLOAD_MAX = 512 * 1024;
/** Files and bytes kept in <data>/branding/. */
export const BRAND_MAX_FILES = 9;
export const BRAND_MAX_DISK = 1.5 * 1024 * 1024;

/** What the panel accepts before decoding (pre-decode bomb check). */
export const BRAND_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const BRAND_INPUT_MAX_SIDE = 12_000;
export const BRAND_INPUT_MAX_PIXELS = 50_000_000;

/** Contrast targets for the theme (WCAG 2.2: 3:1 non-text, 4.5:1 text). */
export const BRAND_UI_CONTRAST = 3;
export const BRAND_TEXT_CONTRAST = 4.5;
export const BRAND_SOFT_TEXT_CONTRAST = 7;

/** Theme presets (no purple or indigo). */
export const BRAND_PRESETS = ['forest', 'honey', 'onair', 'ocean', 'clay', 'graphite', 'custom'] as const;
export type BrandPreset = (typeof BRAND_PRESETS)[number];
export const BRAND_CORNERS = { round: [6, 10, 16], soft: [4, 6, 10], square: [2, 2, 4] } as const;
export type BrandCorners = keyof typeof BRAND_CORNERS;

/** Support button labels (always translated: support.label.*). Default "Support" / "Apoiar". */
export const BRAND_SUPPORT_LABELS = ['support', 'tip', 'donate', 'pix'] as const;

/** Pix BR Code field limits (BCB manual: merchant name 25, city 15, ASCII). */
export const PIX_NAME_MAX = 25;
export const PIX_CITY_MAX = 15;
export const PIX_DESCRIPTION_MAX = 40;
