import { CHAT_DEFAULT_PALETTE, CHAT_MIN_CONTRAST, CHAT_TARGET_CONTRAST } from '@swarmcast/shared/chat';

// Name colours: WCAG 2.2 contrast and the OKLCH lightness search of plan §5.4.
// TEMPORARY local copy: packages/shared/src/chat/color.ts (lane A / C1) owns this; once it lands,
// core/index.ts re-exports it.

export type Rgb = readonly [number, number, number];


const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(c: unknown): c is string {
  return typeof c === 'string' && HEX.test(c);
}

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** "rgb(255, 253, 248)" / "rgba(…)" / "#fffdf8" (getComputedStyle) to channels; null if unknown. */
export function parseCssColor(css: string): Rgb | null {
  const s = css.trim();
  if (isHexColor(s)) return hexToRgb(s);
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const lin = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const unlin = (c: number): number => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.2 relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRgb(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type Lch = [number, number, number];

function rgbToOklch([r, g, b]: Rgb): Lch {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}

/** OKLCH to linear sRGB (may be out of gamut). */
function oklchToLinear([L, C, h]: Lch): [number, number, number] {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (c: [number, number, number]): boolean => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The colour at OKLCH (L, C, h), chroma reduced until it fits sRGB, rounded to 8 bits. */
function fromOklch(L: number, C: number, h: number): Rgb {
  let lo = 0;
  let hi = C;
  let c = oklchToLinear([L, C, h]);
  if (!inGamut(c)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear([L, mid, h]))) lo = mid;
      else hi = mid;
    }
    c = oklchToLinear([L, lo, h]);
  }
  return [unlin(Math.min(1, Math.max(0, c[0]))), unlin(Math.min(1, Math.max(0, c[1]))), unlin(Math.min(1, Math.max(0, c[2])))].map((v) => Math.round(v)) as unknown as Rgb;
}

const cache = new Map<string, string>();

/**
 * `color` itself when it reaches 4.5:1 against `bg`; otherwise the same hue and chroma with the
 * OKLCH lightness moved toward the background's opposite (binary search, about 24 steps, aiming
 * at 4.6 to absorb 8-bit rounding), verified ≥ 4.5. Cached per (colour, background).
 */
export function adjustNameColor(color: string, bgHex: string): string {
  const bg = hexToRgb(isHexColor(bgHex) ? bgHex : '#ffffff');
  const fg = isHexColor(color) ? color.toLowerCase() : CHAT_DEFAULT_PALETTE[0];
  const key = `${fg}|${bg.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rgb = hexToRgb(fg);
  let out = fg;
  if (contrastRgb(rgb, bg) < CHAT_MIN_CONTRAST) {
    const [L0, C, h] = rgbToOklch(rgb);
    const darken = luminance(bg) > 0.18; // light background: go darker
    // Search between the current lightness and the extreme; the extreme always passes.
    let pass = darken ? 0 : 1;
    let fail = L0;
    let best: Rgb = fromOklch(pass, C, h);
    for (let i = 0; i < 24; i++) {
      const mid = (pass + fail) / 2;
      const cand = fromOklch(mid, C, h);
      if (contrastRgb(cand, bg) >= CHAT_TARGET_CONTRAST) {
        pass = mid;
        best = cand;
      } else fail = mid;
    }
    if (contrastRgb(best, bg) < CHAT_MIN_CONTRAST) best = darken ? [0, 0, 0] : [255, 255, 255];
    out = rgbToHex(best);
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}

/** A stable default colour for an author key (no randomness, no flicker on reconnect). */
export function defaultNameColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return CHAT_DEFAULT_PALETTE[(h >>> 0) % CHAT_DEFAULT_PALETTE.length] ?? CHAT_DEFAULT_PALETTE[0];
}

/** WCAG 2.2 contrast ratio of two "#rrggbb" colours. */
export function contrastRatio(a: string, b: string): number {
  return contrastRgb(hexToRgb(a), hexToRgb(b));
}
