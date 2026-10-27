// Reads the shared design tokens (assets/brand/tokens.css at the repo root) at build time, for
// the few places that need a literal value instead of a CSS variable (the browser's
// theme-color, the contrast test). The CSS itself is imported by src/styles/tokens.css.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKENS_CSS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/brand/tokens.css');

/**
 * The custom properties that apply to plain `:root` (light, the default palette) and to
 * `:root[data-theme="dark"]` (dark), as { light: { '--sc-bg': '#…', … }, dark: { … } }. Rules for
 * other palettes (`[data-palette=…]`) and the prefers-color-scheme copy are ignored. Dark
 * inherits light.
 * @param {string} [css]
 */
export function readTokens(css = fs.readFileSync(TOKENS_CSS, 'utf8')) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {Record<string, string>} */
  const light = {};
  /** @type {Record<string, string>} */
  const dark = {};
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((x) => x.trim().replace(/'/g, '"'));
    const target = selectors.includes(':root') ? light : selectors.includes(':root[data-theme="dark"]') ? dark : null;
    if (!target) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target[d[1]] = d[2].trim();
  }
  return { light, dark: { ...light, ...dark } };
}

/**
 * Background colours for <meta name="theme-color">. Pass the CSS text when the caller is bundled
 * (an Astro component: import it with `?raw`), where this file's own path no longer points at the
 * repository.
 * @param {string} [css]
 */
export function themeColors(css) {
  try {
    const { light, dark } = readTokens(css);
    return { light: light['--sc-bg'] ?? '#ffffff', dark: dark['--sc-bg'] ?? '#111111' };
  } catch {
    return { light: '#ffffff', dark: '#111111' };
  }
}
