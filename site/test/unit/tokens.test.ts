// The shared brand tokens (assets/brand/tokens.css) must keep text readable (WCAG AA) in light
// and dark, whatever palette is dropped in. Run by the repo's root `npm test`.
import { describe, expect, it } from 'vitest';
import { readTokens } from '../../src/tokens.mjs';

/** '#rgb', '#rrggbb' (any case) or 'rgb(r g b)' / 'rgb(r, g, b)' -> [r, g, b] (0-255), else null. */
function parse(color: string | undefined): [number, number, number] | null {
  if (!color) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/i.exec(color.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string | undefined, b: string | undefined): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

// The brand tokens the site maps (assets/brand/tokens.css). Missing one = tell the brand work.
const REQUIRED = ['--sc-bg', '--sc-surface', '--sc-surface-2', '--sc-border', '--sc-ink', '--sc-muted', '--sc-accent', '--sc-on-accent', '--sc-accent-strong', '--sc-secondary', '--sc-on-secondary', '--sc-success', '--sc-warning', '--sc-live', '--sc-on-live', '--sc-danger', '--sc-focus', '--sc-text', '--sc-border-strong', '--sc-accent-soft', '--sc-on-danger', '--sc-font', '--sc-font-ui', '--sc-font-text', '--sc-font-mono', '--sc-radius-sm', '--sc-radius-md', '--sc-radius-lg', '--sc-shadow'];

const PAIRS: [fg: string, bg: string, min: number][] = [
  ['--sc-ink', '--sc-bg', 4.5],
  ['--sc-muted', '--sc-bg', 4.5],
  ['--sc-ink', '--sc-surface', 4.5],
  ['--sc-muted', '--sc-surface', 4.5],
  ['--sc-ink', '--sc-surface-2', 4.5],
  ['--sc-text', '--sc-bg', 4.5], // body text
  ['--sc-text', '--sc-surface', 4.5],
  ['--sc-text', '--sc-surface-2', 4.5],
  ['--sc-text', '--sc-accent-soft', 4.5], // Starlight accent-low backgrounds
  ['--sc-accent-strong', '--sc-accent-soft', 4.5],
  ['--sc-accent-strong', '--sc-bg', 4.5], // links
  ['--sc-accent-strong', '--sc-surface', 4.5],
  ['--sc-on-accent', '--sc-accent', 4.5], // primary button
  ['--sc-on-secondary', '--sc-secondary', 4.5], // "Your system" badge
  ['--sc-on-danger', '--sc-danger', 4.5],
  ['--sc-focus', '--sc-bg', 3],
];

describe('brand tokens', () => {
  const tokens = readTokens();
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: defines every token the site uses`, () => {
      for (const name of REQUIRED) expect(tokens[theme][name], name).toBeTruthy();
    });

    it(`${theme}: text colours meet WCAG AA`, () => {
      for (const [fg, bg, min] of PAIRS) {
        const ratio = contrast(tokens[theme][fg], tokens[theme][bg]);
        if (ratio === null) continue; // a colour syntax this check does not read (e.g. oklch)
        expect(ratio, `${fg} on ${bg} (${theme}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it('reads the default light and dark rules, not the other palettes', () => {
    const t = readTokens(
      ':root { --sc-font: x; } :root[data-palette="b"] { --sc-bg: #111; } :root, :root[data-palette="a"] { --sc-bg: #fff; --sc-ink: #000; } :root[data-theme="dark"], :root[data-palette="a"][data-theme="dark"] { --sc-bg: #000; } @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --sc-bg: #222; } }',
    );
    expect(t.light).toEqual({ '--sc-font': 'x', '--sc-bg': '#fff', '--sc-ink': '#000' });
    expect(t.dark).toEqual({ '--sc-font': 'x', '--sc-bg': '#000', '--sc-ink': '#000' });
  });
});
