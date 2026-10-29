import { CHAT_DEFAULT_PALETTE, CHAT_MIN_CONTRAST, CHAT_TARGET_CONTRAST } from './limits.js';

/**
 * Name colours (plan §5.4): the stored colour is the viewer's sRGB choice; at render time the
 * client makes it readable against the actual chat background (WCAG 2.2 contrast ≥ 4.5:1) by
 * moving its OKLCH lightness, keeping hue (chroma only shrinks to stay in gamut).
 */

/** Chat backgrounds of the two themes (assets/brand/tokens.css surfaces). */
export const CHAT_BG_LIGHT = '#fffdf8';
export const CHAT_BG_DARK = '#13221f';

type RGB = [number, number, number];

export function parseHex(hex: string): RGB | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: RGB): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const unlin = (l: number): number => {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** WCAG 2.2 relative luminance. */
export function luminance(rgb: RGB): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG 2.2 contrast ratio of two colours ("#rrggbb"); 1 when either is invalid. */
export function contrastRatio(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return 1;
  const la = luminance(x);
  const lb = luminance(y);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// OKLab (Björn Ottosson), on linear sRGB.
function toOklab(rgb: RGB): [number, number, number] {
  const r = lin(rgb[0]);
  const g = lin(rgb[1]);
  const b = lin(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → linear sRGB (may be out of gamut). */
function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (c: [number, number, number]): boolean => c.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** The sRGB colour at OKLCH (L, C, h), shrinking C until it fits the gamut. */
function oklch(L: number, C: number, h: number): RGB {
  let lo = 0;
  let hi = C;
  let best = fromOklab(L, 0, 0);
  if (inGamut(fromOklab(L, C * Math.cos(h), C * Math.sin(h)))) best = fromOklab(L, C * Math.cos(h), C * Math.sin(h));
  else {
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const c = fromOklab(L, mid * Math.cos(h), mid * Math.sin(h));
      if (inGamut(c)) {
        lo = mid;
        best = c;
      } else hi = mid;
    }
  }
  return [unlin(best[0]), unlin(best[1]), unlin(best[2])];
}

const adjusted = new Map<string, string>();

/**
 * The colour to render `hex` with on `bg`: unchanged when it already has 4.5:1, otherwise the
 * nearest lightness (same hue) that reaches the target, darker on a light background and lighter
 * on a dark one. Always returns a colour with contrast ≥ 4.5:1 (cached per pair).
 */
export function adjustNameColor(hex: string, bg: string): string {
  const key = `${hex}|${bg}`;
  const hit = adjusted.get(key);
  if (hit) return hit;
  const rgb = parseHex(hex) ?? parseHex(CHAT_DEFAULT_PALETTE[0])!;
  const back = parseHex(bg) ?? parseHex(CHAT_BG_LIGHT)!;
  let result = toHex(rgb);
  if (contrastRatio(result, toHex(back)) < CHAT_MIN_CONTRAST) {
    const [L0, a, b] = toOklab(rgb);
    const C = Math.hypot(a, b);
    const h = Math.atan2(b, a);
    const darker = luminance(back) > 0.18;
    // Search the lightness between the colour and black (or white) for the closest one that
    // reaches the target contrast.
    let near = L0;
    let far = darker ? 0 : 1;
    const bgHex = toHex(back);
    for (let i = 0; i < 24; i++) {
      const mid = (near + far) / 2;
      if (contrastRatio(toHex(oklch(mid, C, h)), bgHex) >= CHAT_TARGET_CONTRAST) far = mid;
      else near = mid;
    }
    result = toHex(oklch(far, C, h));
    // Rounding to 8 bits can still miss: fall back to plain black or white text.
    if (contrastRatio(result, bgHex) < CHAT_MIN_CONTRAST) result = darker ? '#000000' : '#ffffff';
  }
  if (adjusted.size > 2048) adjusted.clear();
  adjusted.set(key, result);
  return result;
}

/** Deterministic default colour for an author key (FNV-1a hash into the palette): no flicker on reconnect. */
export function defaultNameColor(authorKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < authorKey.length; i++) {
    h ^= authorKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CHAT_DEFAULT_PALETTE[h % CHAT_DEFAULT_PALETTE.length]!;
}
