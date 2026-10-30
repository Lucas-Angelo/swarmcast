// Reading colours back from the page (getComputedStyle) for the contrast check.
import { parseHex, toHex } from '@swarmcast/shared/chat';

const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(c: unknown): c is string {
  return typeof c === 'string' && HEX.test(c);
}

/** "rgb(255, 253, 248)" / "rgba(…)" / "#fffdf8" to "#rrggbb"; null when unknown or mostly transparent. */
export function cssColorToHex(css: string): string | null {
  const s = css.trim();
  if (isHexColor(s)) return toHex(parseHex(s)!);
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (a < 0.5) return null;
  }
  return toHex([Number(m[1]), Number(m[2]), Number(m[3])]);
}
