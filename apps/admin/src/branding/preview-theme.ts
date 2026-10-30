import { BRAND_CORNERS, deriveTheme, THEME_BASE, type BrandCorners, type BrandPreset, type DerivedTheme, type ThemeMode } from '@swarmcast/shared/branding';

/**
 * The preview's colours: the viewer pages' own tokens (Forest & Cream, assets/brand/tokens.css;
 * never changed by the streamer) plus the shared derived accent tokens and corner radii. Applied
 * to the preview container through CSSOM (a Preact style object), never a style attribute.
 */

const PAGE: Record<ThemeMode, { surface2: string; border: string; text: string; muted: string }> = {
  light: { surface2: '#eee7d7', border: '#e1d9c7', text: '#2d3a37', muted: '#58665f' },
  dark: { surface2: '#1a2d29', border: '#26403a', text: '#d3d9d4', muted: '#9cb0a9' },
};

export function previewVars(mode: ThemeMode, d: DerivedTheme, corners: BrandCorners): Record<string, string> {
  const b = THEME_BASE[mode];
  const p = PAGE[mode];
  const a = d[mode];
  const [sm, md, lg] = BRAND_CORNERS[corners];
  return {
    '--sc-bg': b.bg,
    '--sc-surface': b.surface,
    '--sc-surface-2': p.surface2,
    '--sc-border': p.border,
    '--sc-ink': b.ink,
    '--sc-text': p.text,
    '--sc-muted': p.muted,
    '--sc-accent': a.accent,
    '--sc-on-accent': a.onAccent,
    '--sc-accent-strong': a.accentStrong,
    '--sc-accent-soft': a.accentSoft,
    '--sc-radius-sm': `${sm}px`,
    '--sc-radius-md': `${md}px`,
    '--sc-radius-lg': `${lg}px`,
  };
}

/** The swatch shown for a preset in the picker: its light-mode button colour. */
export function presetSwatch(preset: BrandPreset, accent?: string): string {
  if (preset === 'custom') return /^#[0-9a-f]{6}$/i.test(accent ?? '') ? accent!.toLowerCase() : '#0f5c53';
  return deriveTheme({ preset }).light.accent;
}
