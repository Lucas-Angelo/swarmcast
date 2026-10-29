import { contrastRatio, mixHex, searchLightness } from '../chat/color.js';
import { BRAND_CORNERS, BRAND_SOFT_TEXT_CONTRAST, BRAND_TEXT_CONTRAST, BRAND_UI_CONTRAST, type BrandCorners, type BrandPreset } from './limits.js';

/**
 * Theme colour (plan §2.3, §3.4). The streamer picks a preset or one custom accent; only the
 * accent tokens change, per theme, with contrast enforced against the page's own backgrounds:
 *
 * - `--sc-accent` (buttons): ≥ 3:1 against the background, label ≥ 4.5:1 on it;
 * - `--sc-accent-strong` (links, accent text, button hover): ≥ 4.5:1 against background and
 *   surface, label ≥ 4.5:1 on it;
 * - `--sc-accent-soft` (selected rows, callouts): a tint whose ink text keeps ≥ 7:1.
 *
 * Status, focus, text and background colours are never overridable. Searches move only OKLCH
 * lightness (hue kept) and aim at 4.6 so 8-bit rounding still verifies at ≥ 4.5.
 */

export type ThemeMode = 'light' | 'dark';

/** The viewer pages' own colours (Forest & Cream, assets/brand/tokens.json): what accents must contrast with. */
export const THEME_BASE = {
  light: { bg: '#f6f1e6', surface: '#fffdf8', ink: '#12211f', onAccent: '#fffdf8' },
  dark: { bg: '#0c1716', surface: '#13221f', ink: '#eef3ee', onAccent: '#0c1716' },
} as const;

export interface ThemeTokens {
  accent: string;
  onAccent: string;
  accentStrong: string;
  accentSoft: string;
}

export interface DerivedTheme {
  light: ThemeTokens;
  dark: ThemeTokens;
  /** The custom colour had to change to stay readable (the panel says so). */
  adjusted: boolean;
}

/** The hand-tuned default (Forest & Cream), used as is. */
const FOREST: DerivedTheme = {
  light: { accent: '#0f5c53', onAccent: '#fffdf8', accentStrong: '#0a4740', accentSoft: '#e2eae4' },
  dark: { accent: '#3db5a2', onAccent: '#0c1716', accentStrong: '#7dd8c8', accentSoft: '#1b3f39' },
  adjusted: false,
};

/** Base accents of the other presets (light / dark), derived like a custom colour. */
export const PRESET_BASES: Record<Exclude<BrandPreset, 'forest' | 'custom'>, { light: string; dark: string }> = {
  honey: { light: '#f29e0c', dark: '#f5a623' },
  onair: { light: '#ff5a1f', dark: '#ff6a33' },
  ocean: { light: '#1d6fb8', dark: '#3d8bd7' },
  clay: { light: '#b5452b', dark: '#d8654a' },
  graphite: { light: '#4a5560', dark: '#7d8995' },
};

const TARGET = BRAND_TEXT_CONTRAST + 0.1;
const UI_TARGET = BRAND_UI_CONTRAST + 0.1;

function deriveMode(base: string, mode: ThemeMode): ThemeTokens {
  const b = THEME_BASE[mode];
  const dir = mode === 'light' ? 'down' : 'up';
  const accentOk = (c: string): boolean => contrastRatio(c, b.bg) >= UI_TARGET && contrastRatio(b.onAccent, c) >= TARGET;
  const strongOk = (c: string): boolean => contrastRatio(c, b.bg) >= TARGET && contrastRatio(c, b.surface) >= TARGET && contrastRatio(b.onAccent, c) >= TARGET;
  const accent = searchLightness(base, dir, accentOk) ?? FOREST[mode].accent;
  const accentStrong = searchLightness(accent, dir, strongOk) ?? FOREST[mode].accentStrong;
  let t = mode === 'light' ? 0.1 : 0.22;
  let accentSoft = mixHex(accent, b.surface, t);
  while (contrastRatio(b.ink, accentSoft) < BRAND_SOFT_TEXT_CONTRAST + 0.1 && t > 0) {
    t = Math.max(0, t - 0.02);
    accentSoft = mixHex(accent, b.surface, t);
  }
  return { accent, onAccent: b.onAccent, accentStrong, accentSoft };
}

/** Tokens for a preset or a custom colour, for both themes. */
export function deriveTheme(theme: { preset: BrandPreset; accent?: string }): DerivedTheme {
  if (theme.preset === 'forest' || (theme.preset === 'custom' && !theme.accent)) return FOREST;
  const bases = theme.preset === 'custom' ? { light: theme.accent!.toLowerCase(), dark: theme.accent!.toLowerCase() } : PRESET_BASES[theme.preset];
  const light = deriveMode(bases.light, 'light');
  const dark = deriveMode(bases.dark, 'dark');
  return { light, dark, adjusted: theme.preset === 'custom' && (light.accent !== bases.light || dark.accent !== bases.dark) };
}

/** Every constraint of §3.4 for one theme's tokens (tests, and a last check before writing CSS). */
export function themeTokensOk(t: ThemeTokens, mode: ThemeMode): boolean {
  const b = THEME_BASE[mode];
  return (
    contrastRatio(t.accent, b.bg) >= BRAND_UI_CONTRAST &&
    contrastRatio(t.onAccent, t.accent) >= BRAND_TEXT_CONTRAST &&
    contrastRatio(t.accentStrong, b.bg) >= BRAND_TEXT_CONTRAST &&
    contrastRatio(t.accentStrong, b.surface) >= BRAND_TEXT_CONTRAST &&
    contrastRatio(t.onAccent, t.accentStrong) >= BRAND_TEXT_CONTRAST &&
    contrastRatio(b.ink, t.accentSoft) >= BRAND_SOFT_TEXT_CONTRAST
  );
}

const HEX = /^#[0-9a-f]{6}$/;

function block(t: ThemeTokens): string {
  for (const v of [t.accent, t.onAccent, t.accentStrong, t.accentSoft]) if (!HEX.test(v)) throw new Error('invalid theme colour');
  return `--sc-accent:${t.accent};--sc-on-accent:${t.onAccent};--sc-accent-strong:${t.accentStrong};--sc-accent-soft:${t.accentSoft};`;
}

/**
 * The page's `/brand/theme.css`: only hex values that passed `^#[0-9a-f]{6}$` and fixed property
 * names, under the same selectors as assets/brand/tokens.css (same specificity, loaded later, so
 * it wins). No string from the config other than those values and the corner enum.
 */
export function themeCss(theme: DerivedTheme, corners: BrandCorners): string {
  const [sm, md, lg] = BRAND_CORNERS[corners];
  const light = block(theme.light);
  const dark = block(theme.dark);
  return (
    `:root{${light}--sc-radius-sm:${sm}px;--sc-radius-md:${md}px;--sc-radius-lg:${lg}px;}\n` +
    `:root[data-theme="dark"]{${dark}}\n` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]):not([data-palette]){${dark}}}\n`
  );
}
