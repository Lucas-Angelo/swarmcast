import { adjustNameColor, contrastRatio, parseHex, toHex } from '@swarmcast/shared';

/**
 * Theme colour for "Your page" (plan branding-0.4.0 §2.3 and §3.4). Panel-side copy until BR1
 * lands `packages/shared/src/branding/theme.ts`; the server derives the same tokens when it
 * writes theme.css. The panel uses this for the live preview.
 *
 * A preset is a hand-tuned token set (Forest, Honey, On Air from assets/brand/tokens.css) or a
 * base colour pair derived like a custom colour (Ocean, Clay, Graphite, until BR1 tunes them).
 * Only the four accent tokens change; status, focus, body text and backgrounds never do.
 */

export type ThemeName = 'light' | 'dark';
export type PresetId = 'forest' | 'honey' | 'onair' | 'ocean' | 'clay' | 'graphite' | 'custom';
export type Corners = 'round' | 'soft' | 'square';

export const PRESETS: readonly PresetId[] = ['forest', 'honey', 'onair', 'ocean', 'clay', 'graphite', 'custom'];

export interface AccentTokens {
  accent: string;
  onAccent: string;
  accentStrong: string;
  accentSoft: string;
}

export interface DerivedTheme {
  light: AccentTokens;
  dark: AccentTokens;
  /** The colour had to change in that theme so everyone can read it. */
  adjusted: { light: boolean; dark: boolean };
}

/** Page tokens that never change with the streamer's colour (Forest & Cream, tokens.css). */
export const BASE: Record<ThemeName, { bg: string; surface: string; surface2: string; border: string; ink: string; text: string; muted: string }> = {
  light: { bg: '#f6f1e6', surface: '#fffdf8', surface2: '#eee7d7', border: '#e1d9c7', ink: '#12211f', text: '#2d3a37', muted: '#58665f' },
  dark: { bg: '#0c1716', surface: '#13221f', surface2: '#1a2d29', border: '#26403a', ink: '#eef3ee', text: '#d3d9d4', muted: '#9cb0a9' },
};

/** Label colour on the accent, fixed per theme (cream on light, ink on dark), as in Forest & Cream. */
export const ON_ACCENT: Record<ThemeName, string> = { light: '#fffdf8', dark: '#0c1716' };

/** WCAG 2.2: 3:1 for UI components (SC 1.4.11), 4.5:1 for text (SC 1.4.3), 7:1 for ink on the soft tint. */
export const MIN_UI = 3;
export const MIN_TEXT = 4.5;
export const MIN_SOFT_INK = 7;

const HAND_TUNED: Partial<Record<PresetId, Record<ThemeName, AccentTokens>>> = {
  forest: {
    light: { accent: '#0f5c53', onAccent: '#fffdf8', accentStrong: '#0a4740', accentSoft: '#e2eae4' },
    dark: { accent: '#3db5a2', onAccent: '#0c1716', accentStrong: '#7dd8c8', accentSoft: '#1b3f39' },
  },
  honey: {
    light: { accent: '#f29e0c', onAccent: '#1d1812', accentStrong: '#8f5300', accentSoft: '#fdf3e2' },
    dark: { accent: '#f5a623', onAccent: '#1d1812', accentStrong: '#ffc15e', accentSoft: '#493617' },
  },
  onair: {
    light: { accent: '#ff5a1f', onAccent: '#1c1b1a', accentStrong: '#b83a0b', accentSoft: '#ffebe4' },
    dark: { accent: '#ff6a33', onAccent: '#121212', accentStrong: '#ff9466', accentSoft: '#492b1f' },
  },
};

/** Base colours of the derived presets (plan §2.3, "about"): light / dark. */
const DERIVED_PRESETS: Partial<Record<PresetId, Record<ThemeName, string>>> = {
  ocean: { light: '#1d6fb8', dark: '#3d8bd7' },
  clay: { light: '#b5452b', dark: '#d8654a' },
  graphite: { light: '#4a5560', dark: '#7d8995' },
};

/** The swatch shown for each preset in the picker (its light-theme accent). */
export function presetSwatch(id: PresetId, custom?: string): string {
  if (id === 'custom') return normalizeHex(custom) ?? '#0f5c53';
  return HAND_TUNED[id]?.light.accent ?? DERIVED_PRESETS[id]!.light;
}

export function normalizeHex(hex: string | undefined): string | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** `base` over `under` at `alpha` (0..1), in sRGB. */
export function mix(base: string, under: string, alpha: number): string {
  const a = parseHex(base)!;
  const b = parseHex(under)!;
  return toHex([0, 1, 2].map((i) => Math.round(a[i]! * alpha + b[i]! * (1 - alpha))) as [number, number, number]);
}

/** Derive the accent tokens of one theme from a base colour (§3.4). Always meets every constraint. */
export function deriveAccent(baseHex: string, theme: ThemeName): { tokens: AccentTokens; adjusted: boolean } {
  const base = normalizeHex(baseHex) ?? '#0f5c53';
  const { bg, surface, ink } = BASE[theme];
  const label = ON_ACCENT[theme];
  // Button: the label must read on it (≥ 4.5:1), which on these backgrounds also gives ≥ 3:1
  // against the page; checked anyway, with a stronger push when it is not.
  let accent = adjustNameColor(base, label);
  if (contrastRatio(accent, bg) < MIN_UI) accent = adjustNameColor(accent, bg);
  if (contrastRatio(accent, label) < MIN_TEXT || contrastRatio(accent, bg) < MIN_UI) accent = theme === 'light' ? '#0f5c53' : '#3db5a2';
  // Links and accent text: ≥ 4.5:1 on both the page and the cards (and the label on it, as hover).
  let strong = accent;
  for (let i = 0; i < 3 && (contrastRatio(strong, bg) < MIN_TEXT || contrastRatio(strong, surface) < MIN_TEXT); i++) {
    strong = adjustNameColor(adjustNameColor(strong, surface), bg);
  }
  if (contrastRatio(strong, bg) < MIN_TEXT || contrastRatio(strong, surface) < MIN_TEXT || contrastRatio(strong, label) < MIN_TEXT) strong = ink;
  // Selected rows and callouts: a tint of the accent over the card, with ink ≥ 7:1 on it.
  let alpha = theme === 'light' ? 0.1 : 0.22;
  let soft = mix(accent, surface, alpha);
  while (contrastRatio(ink, soft) < MIN_SOFT_INK && alpha > 0) {
    alpha = Math.max(0, alpha - 0.02);
    soft = mix(accent, surface, alpha);
  }
  return { tokens: { accent, onAccent: label, accentStrong: strong, accentSoft: soft }, adjusted: accent !== base };
}

/** The accent tokens of a saved theme, for both light and dark. */
export function deriveTheme(preset: PresetId, custom?: string): DerivedTheme {
  const hand = HAND_TUNED[preset];
  if (hand) return { light: hand.light, dark: hand.dark, adjusted: { light: false, dark: false } };
  const pair = preset === 'custom' ? { light: normalizeHex(custom) ?? '#0f5c53', dark: normalizeHex(custom) ?? '#0f5c53' } : DERIVED_PRESETS[preset]!;
  const l = deriveAccent(pair.light, 'light');
  const d = deriveAccent(pair.dark, 'dark');
  // A derived preset is ours: only a custom colour counts as "adjusted" for the streamer.
  const flag = preset === 'custom';
  return { light: l.tokens, dark: d.tokens, adjusted: { light: flag && l.adjusted, dark: flag && d.adjusted } };
}

/** Corner radii (px) for --sc-radius-sm / md / lg. */
export const CORNERS: Record<Corners, [number, number, number]> = {
  round: [6, 10, 16],
  soft: [4, 6, 10],
  square: [2, 2, 4],
};

/**
 * CSS custom properties for a preview container: the fixed page tokens of `theme`, the derived
 * accent tokens and the corner radii. Applied with CSSOM (Preact style object), never an inline
 * style attribute string.
 */
export function previewVars(theme: ThemeName, d: DerivedTheme, corners: Corners): Record<string, string> {
  const b = BASE[theme];
  const a = d[theme];
  const [sm, md, lg] = CORNERS[corners];
  return {
    '--sc-bg': b.bg,
    '--sc-surface': b.surface,
    '--sc-surface-2': b.surface2,
    '--sc-border': b.border,
    '--sc-ink': b.ink,
    '--sc-text': b.text,
    '--sc-muted': b.muted,
    '--sc-accent': a.accent,
    '--sc-on-accent': a.onAccent,
    '--sc-accent-strong': a.accentStrong,
    '--sc-accent-soft': a.accentSoft,
    '--sc-radius-sm': `${sm}px`,
    '--sc-radius-md': `${md}px`,
    '--sc-radius-lg': `${lg}px`,
  };
}
