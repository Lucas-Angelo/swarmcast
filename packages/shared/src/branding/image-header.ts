import { BRAND_INPUT_MAX_BYTES, BRAND_INPUT_MAX_PIXELS, BRAND_INPUT_MAX_SIDE } from './limits.js';

/**
 * Image sniffing and header dimensions, without decoding a pixel (plan §3.1, stage 1): the panel
 * refuses SVG, unknown types and decompression bombs before `createImageBitmap` ever sees them.
 * Bounded loops only; every read is range-checked. The server's stricter validator
 * (apps/server/src/branding/image.ts) reuses the magic-byte part.
 */

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'heic' | 'svg' | 'unknown';

export interface ImageHeader {
  kind: ImageKind;
  width?: number;
  height?: number;
  /** APNG, animated WebP or a multi-frame GIF (only the first frame is used). */
  animated?: boolean;
}

export type ImageInputError = 'img.svg' | 'img.type' | 'img.tooBig' | 'img.tooLarge' | 'img.corrupt';

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const ascii = (b: Uint8Array, i: number, n: number): string => (i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '');

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);
}
export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
export function isWebp(b: Uint8Array): boolean {
  return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
}

function looksLikeSvg(b: Uint8Array): boolean {
  let head = ascii(b, 0, Math.min(b.length, 1024)).toLowerCase();
  // A UTF-8 byte order mark (EF BB BF) may come first.
  if (head.startsWith('\u00ef\u00bb\u00bf')) head = head.slice(3);
  return head.includes('<svg') || head.trimStart().startsWith('<?xml') || head.includes('<!doctype svg');
}

function png(b: Uint8Array): ImageHeader {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return { kind: 'png' };
  const h: ImageHeader = { kind: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  // acTL before the first IDAT means APNG.
  for (let i = 8, n = 0; i + 8 <= b.length && n < 64; n++) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === 'acTL') h.animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return h;
}

function jpeg(b: Uint8Array): ImageHeader {
  let i = 2;
  for (let n = 0; i + 9 < b.length && n < 512; n++) {
    if (b[i] !== 0xff) return { kind: 'jpeg' };
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { kind: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xda || len < 2) return { kind: 'jpeg' };
    i += 2 + len;
  }
  return { kind: 'jpeg' };
}

function webp(b: Uint8Array): ImageHeader {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) {
    return { kind: 'webp', animated: (b[20]! & 0x02) !== 0, width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { kind: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { kind: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return { kind: 'webp' };
}

function gif(b: Uint8Array): ImageHeader {
  if (b.length < 10) return { kind: 'gif' };
  const head = ascii(b, 0, Math.min(b.length, 64 * 1024));
  return { kind: 'gif', width: u16le(b, 6), height: u16le(b, 8), animated: head.includes('NETSCAPE2.0') };
}

/** AVIF/HEIC (ISO-BMFF): the brand in `ftyp`, the size from the first `ispe` box. */
function isobmff(b: Uint8Array): ImageHeader | null {
  if (ascii(b, 4, 4) !== 'ftyp') return null;
  const brand = ascii(b, 8, 4);
  const kind: ImageKind | null = brand === 'avif' || brand === 'avis' ? 'avif' : ['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis'].includes(brand) ? 'heic' : null;
  if (!kind) return null;
  const limit = Math.min(b.length - 20, 256 * 1024);
  for (let i = 0; i < limit; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) return { kind, width: u32be(b, i + 8), height: u32be(b, i + 12), animated: brand === 'avis' };
  }
  return { kind };
}

/** What kind of image this is and its declared size (no decoding). */
export function sniffImage(b: Uint8Array): ImageHeader {
  if (isPng(b)) return png(b);
  if (isJpeg(b)) return jpeg(b);
  if (isWebp(b)) return webp(b);
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return gif(b);
  const bmff = isobmff(b);
  if (bmff) return bmff;
  if (looksLikeSvg(b)) return { kind: 'svg' };
  return { kind: 'unknown' };
}

/**
 * The panel's pre-decode check of a picked file: refused in plain words when it is SVG, not an
 * image we decode, over 20 MB, or declares more than 12,000 px a side or 50 megapixels.
 */
export function checkImageInput(b: Uint8Array, fileSize = b.length): { ok: true; header: ImageHeader } | { ok: false; code: ImageInputError; params?: Record<string, number> } {
  if (fileSize > BRAND_INPUT_MAX_BYTES) return { ok: false, code: 'img.tooBig', params: { mb: Math.ceil(fileSize / 1024 / 1024), max: BRAND_INPUT_MAX_BYTES / 1024 / 1024 } };
  const h = sniffImage(b);
  if (h.kind === 'svg') return { ok: false, code: 'img.svg' };
  if (h.kind === 'unknown') return { ok: false, code: 'img.type' };
  if (h.width === undefined || h.height === undefined || h.width < 1 || h.height < 1) return { ok: false, code: 'img.corrupt' };
  if (h.width > BRAND_INPUT_MAX_SIDE || h.height > BRAND_INPUT_MAX_SIDE || h.width * h.height > BRAND_INPUT_MAX_PIXELS) return { ok: false, code: 'img.tooLarge' };
  return { ok: true, header: h };
}
