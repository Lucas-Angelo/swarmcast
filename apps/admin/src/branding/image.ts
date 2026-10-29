/**
 * Pictures for "Your page", stage 1 of plan branding-0.4.0 §3.1: in the panel, before anything
 * is uploaded. The file is sniffed and its header read before any pixel is decoded (so a
 * decompression bomb never reaches the decoder), then decoded with the EXIF orientation applied,
 * cropped to the slot's shape and re-encoded on a canvas. A canvas writes only pixels, so the
 * photo's EXIF/GPS, XMP, ICC, comments and anything crafted inside the original never leave the
 * panel. The server (BR2) validates and strips again.
 *
 * The sniffing and header parsing are pure (unit tested in node); they belong in
 * `packages/shared/src/branding/image-header.ts` once BR1 lands it (the server needs the same).
 */

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'heic' | 'svg' | 'unknown';
export type SlotId = 'avatar' | 'avatar128' | 'fav32' | 'fav180' | 'banner' | 'banner640' | 'card';
export type FieldId = 'avatar' | 'banner' | 'card';

export interface Slot {
  w: number;
  h: number;
  maxBytes: number;
}

/** Stored variants (plan §2.2 / §3.1). The panel renders each; the server only checks them. */
export const SLOTS: Record<SlotId, Slot> = {
  avatar: { w: 256, h: 256, maxBytes: 64 * 1024 },
  avatar128: { w: 128, h: 128, maxBytes: 24 * 1024 },
  fav32: { w: 32, h: 32, maxBytes: 6 * 1024 },
  fav180: { w: 180, h: 180, maxBytes: 32 * 1024 },
  banner: { w: 1280, h: 320, maxBytes: 150 * 1024 },
  banner640: { w: 640, h: 160, maxBytes: 50 * 1024 },
  card: { w: 1200, h: 630, maxBytes: 200 * 1024 },
};

/** Which variants each picture field produces, master first. */
export const FIELD_SLOTS: Record<FieldId, SlotId[]> = {
  avatar: ['avatar', 'avatar128', 'fav32', 'fav180'],
  banner: ['banner', 'banner640'],
  card: ['card'],
};

/** Crop shape of each field (width / height). */
export const FIELD_ASPECT: Record<FieldId, number> = { avatar: 1, banner: 4, card: 1200 / 630 };

/** Input limits, checked before decoding. */
export const INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const INPUT_MAX_SIDE = 12_000;
export const INPUT_MAX_PIXELS = 50_000_000;

export type ImageErrorCode =
  | 'admin.brand.img.err.svg'
  | 'admin.brand.img.err.type'
  | 'admin.brand.img.err.tooBig'
  | 'admin.brand.img.err.dims'
  | 'admin.brand.img.err.decode'
  | 'admin.brand.img.err.encode';

export class ImageError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

const ascii = (b: Uint8Array, from: number, len: number): string => String.fromCharCode(...b.subarray(from, from + len));
const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** What the first bytes say the file is (never the name or the MIME type alone). */
export function sniff(b: Uint8Array): ImageKind {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  // SVG or any other markup: refused (scripts, external references, XML bombs; plan §3.6 T1).
  let head = '';
  for (let i = 0; i < Math.min(b.length, 1024); i++) head += String.fromCharCode(b[i]!);
  const t = head.replace(/^﻿|^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  if (t.startsWith('<') || t.includes('<svg')) return 'svg';
  return 'unknown';
}

/** Width and height from the header, without decoding; null when the header cannot be read. */
export function headerSize(b: Uint8Array, kind: ImageKind = sniff(b)): { w: number; h: number } | null {
  switch (kind) {
    case 'png':
      return b.length >= 24 && ascii(b, 12, 4) === 'IHDR' ? { w: be32(b, 16), h: be32(b, 20) } : null;
    case 'gif':
      return b.length >= 10 ? { w: le16(b, 6), h: le16(b, 8) } : null;
    case 'jpeg': {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = be16(b, i + 2);
        if (len < 2) return null;
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: be16(b, i + 5), w: be16(b, i + 7) };
        if (marker === 0xda || marker === 0xd9) return null;
        i += 2 + len;
      }
      return null;
    }
    case 'webp': {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8X' && b.length >= 30) return { w: le24(b, 24) + 1, h: le24(b, 27) + 1 };
      if (chunk === 'VP8 ' && b.length >= 30) return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
      if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
        const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
        return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    case 'avif':
    case 'heic': {
      // ISO-BMFF: the first 'ispe' (image spatial extents) property.
      const end = Math.min(b.length - 16, 256 * 1024);
      for (let i = 4; i < end; i++) {
        if (b[i] === 0x69 && ascii(b, i, 4) === 'ispe') return { w: be32(b, i + 8), h: be32(b, i + 12) };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Animated PNG (acTL before the first IDAT) or animated WebP (VP8X animation flag). */
export function isAnimated(b: Uint8Array, kind: ImageKind = sniff(b)): boolean {
  if (kind === 'png') {
    let i = 8;
    while (i + 8 <= b.length) {
      const len = be32(b, i);
      const type = ascii(b, i + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }
  if (kind === 'webp') return ascii(b, 12, 4) === 'VP8X' && (b[20]! & 0x02) !== 0;
  if (kind === 'gif') {
    // Count image descriptors after the header and the global colour table (rough but bounded).
    let frames = 0;
    let i = 13 + (b[10]! & 0x80 ? 3 * 2 ** ((b[10]! & 7) + 1) : 0);
    while (i < b.length && frames < 2) {
      const tag = b[i]!;
      if (tag === 0x2c) {
        frames++;
        const packed = b[i + 9]!;
        i += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
        while (i < b.length && b[i] !== 0) i += b[i]! + 1;
        i++;
      } else if (tag === 0x21) {
        i += 2;
        while (i < b.length && b[i] !== 0) i += b[i]! + 1;
        i++;
      } else break;
    }
    return frames > 1;
  }
  return false;
}

/**
 * Everything checked before decoding: the type (never SVG), the file size and the declared
 * dimensions. Returns the kind and size, or throws an ImageError with plain-words params.
 */
export function precheck(bytes: Uint8Array, fileSize: number, mime = ''): { kind: ImageKind; w: number; h: number; animated: boolean } {
  if (/svg/i.test(mime)) throw new ImageError('admin.brand.img.err.svg');
  const kind = sniff(bytes);
  if (kind === 'svg') throw new ImageError('admin.brand.img.err.svg');
  if (kind === 'unknown') throw new ImageError('admin.brand.img.err.type');
  if (fileSize > INPUT_MAX_BYTES) throw new ImageError('admin.brand.img.err.tooBig', { mb: Math.ceil(fileSize / (1024 * 1024)), max: INPUT_MAX_BYTES / (1024 * 1024) });
  const size = headerSize(bytes, kind);
  if (!size || size.w < 1 || size.h < 1) throw new ImageError('admin.brand.img.err.decode');
  if (size.w > INPUT_MAX_SIDE || size.h > INPUT_MAX_SIDE || size.w * size.h > INPUT_MAX_PIXELS) throw new ImageError('admin.brand.img.err.dims', { w: size.w, h: size.h });
  return { kind, ...size, animated: isAnimated(bytes, kind) };
}

/** WebP/JPEG qualities to try, from 0.86 down by 0.08, until a variant fits its byte cap. */
export function qualitySteps(): number[] {
  const out: number[] = [];
  for (let q = 0.86; q >= 0.3; q -= 0.08) out.push(Math.round(q * 100) / 100);
  return out;
}

export interface Crop {
  /** Zoom 1 (whole picture fits the shape) to 4. */
  zoom: number;
  /** Centre of the crop, 0..1 of the picture. */
  cx: number;
  cy: number;
}

/** The source rectangle for a crop of shape `aspect` (w/h), clamped inside the picture. */
export function cropRect(srcW: number, srcH: number, aspect: number, c: Crop): { sx: number; sy: number; sw: number; sh: number } {
  const zoom = Math.min(4, Math.max(1, c.zoom));
  let sw = srcW;
  let sh = srcW / aspect;
  if (sh > srcH) {
    sh = srcH;
    sw = srcH * aspect;
  }
  sw /= zoom;
  sh /= zoom;
  const sx = Math.min(srcW - sw, Math.max(0, c.cx * srcW - sw / 2));
  const sy = Math.min(srcH - sh, Math.max(0, c.cy * srcH - sh / 2));
  return { sx, sy, sw, sh };
}

/** The format to use when the engine cannot encode WebP (Safari/WKWebView): PNG keeps transparency. */
export function fallbackType(hasAlpha: boolean): 'image/png' | 'image/jpeg' {
  return hasAlpha ? 'image/png' : 'image/jpeg';
}

const MIME_OF: Partial<Record<ImageKind, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

// ---------------------------------------------------------------------------------------------
// Browser part (canvas): decode, crop, encode.
// ---------------------------------------------------------------------------------------------

export interface Picked {
  bitmap: ImageBitmap;
  w: number;
  h: number;
  animated: boolean;
}

/** Check, then decode with the EXIF orientation applied (a portrait photo stays upright). */
export async function pickImage(file: File): Promise<Picked> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const pre = precheck(head, file.size, file.type);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('admin.brand.img.err.decode');
  }
  return { bitmap, w: bitmap.width, h: bitmap.height, animated: pre.animated };
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    if ('convertToBlob' in c) return c;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => (c as HTMLCanvasElement).toBlob(resolve, type, quality));
}

function hasAlpha(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true;
  return false;
}

/** One stored variant: the crop drawn at the slot's size, encoded to fit its byte cap. */
export async function encodeVariant(p: Picked, aspect: number, crop: Crop, slot: Slot): Promise<Blob> {
  const c = makeCanvas(slot.w, slot.h);
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new ImageError('admin.brand.img.err.encode');
  const r = cropRect(p.w, p.h, aspect, crop);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, slot.w, slot.h);
  const tryType = async (type: string, lossy: boolean): Promise<Blob | null> => {
    for (const q of lossy ? qualitySteps() : [undefined]) {
      const blob = await toBlob(c, type, q);
      // The HTML spec makes an engine without WebP output return PNG instead: detect it.
      if (!blob || blob.type !== type) return null;
      if (blob.size <= slot.maxBytes) return blob;
    }
    return null;
  };
  const out = (await tryType('image/webp', true)) ?? (hasAlpha(ctx, slot.w, slot.h) ? ((await tryType('image/png', false)) ?? (await tryType('image/jpeg', true))) : await tryType('image/jpeg', true));
  if (!out) throw new ImageError('admin.brand.img.err.encode');
  // The type is taken from the bytes, never assumed.
  const kind = sniff(new Uint8Array(await out.slice(0, 64).arrayBuffer()));
  const mime = MIME_OF[kind];
  if (!mime) throw new ImageError('admin.brand.img.err.encode');
  return mime === out.type ? out : new Blob([out], { type: mime });
}
