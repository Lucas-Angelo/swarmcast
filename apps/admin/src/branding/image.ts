import type { MessageKey, MessageParams } from '@swarmcast/shared';
import { BRAND_SLOTS, checkImageInput, sniffImage, type BrandSlot, type ImageInputError } from '@swarmcast/shared/branding';

/**
 * Pictures for "Your page", the panel's part of plan branding-0.4.0 §3.1: the shared pre-decode
 * check (SVG, type, over 20 MB, over 50 MP: `checkImageInput`), then decode with the EXIF
 * orientation applied, crop to the slot's shape and re-encode every variant on a canvas. A
 * canvas writes only pixels, so the photo's GPS, camera data, comments and anything crafted
 * inside the original never leave the panel. Engines add their own colour profile (Chromium)
 * or a minimal EXIF block (WebKit); the server strips every non-pixel chunk anyway (BR2).
 */

export type FieldId = 'avatar' | 'banner' | 'card';
export type Slot = (typeof BRAND_SLOTS)[BrandSlot];

/** Which variants each picture field produces, master first. */
export const FIELD_SLOTS: Record<FieldId, BrandSlot[]> = {
  avatar: ['avatar', 'avatar128', 'fav32', 'fav180'],
  banner: ['banner', 'banner640'],
  card: ['card'],
};

/** Crop shape of each field (width / height). */
export const FIELD_ASPECT: Record<FieldId, number> = { avatar: 1, banner: 4, card: 1200 / 630 };

export class ImageError extends Error {
  constructor(
    readonly code: ImageInputError | 'admin.brand.img.err.decode' | 'admin.brand.img.err.encode',
    readonly params: MessageParams = {},
  ) {
    super(code);
  }

  get key(): MessageKey {
    return this.code;
  }
}

/** WebP/JPEG qualities to try, from 0.86 down by 0.08, until a variant fits its byte cap. */
export function qualitySteps(): number[] {
  const out: number[] = [];
  for (let q = 0.86; q >= 0.3; q -= 0.08) out.push(Math.round(q * 100) / 100);
  return out;
}

export interface Crop {
  /** Zoom 1 (the whole shape fits the picture) to 4. */
  zoom: number;
  /** Centre of the crop, 0..1 of the picture. */
  cx: number;
  cy: number;
}

/** The source rectangle for a crop of shape `aspect` (w/h), clamped inside the picture. */
export function cropRect(srcW: number, srcH: number, aspect: number, c: Crop): { sx: number; sy: number; sw: number; sh: number } {
  const zoom = Math.min(4, Math.max(1, Number.isFinite(c.zoom) ? c.zoom : 1));
  let sw = srcW;
  let sh = srcW / aspect;
  if (sh > srcH) {
    sh = srcH;
    sw = srcH * aspect;
  }
  sw /= zoom;
  sh /= zoom;
  const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  const sx = Math.min(srcW - sw, Math.max(0, clamp01(c.cx) * srcW - sw / 2));
  const sy = Math.min(srcH - sh, Math.max(0, clamp01(c.cy) * srcH - sh / 2));
  return { sx, sy, sw, sh };
}

/** The format to use when the engine cannot encode WebP (WebKit answers PNG): PNG keeps transparency. */
export function fallbackType(hasAlpha: boolean): 'image/png' | 'image/jpeg' {
  return hasAlpha ? 'image/png' : 'image/jpeg';
}

/** The MIME type of encoded bytes, from their magic bytes (never from what was asked for). */
export function encodedType(head: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const k = sniffImage(head).kind;
  return k === 'png' ? 'image/png' : k === 'jpeg' ? 'image/jpeg' : k === 'webp' ? 'image/webp' : null;
}

// ---------------------------------------------------------------------------------------------
// Browser part (canvas): decode, crop, encode.
// ---------------------------------------------------------------------------------------------

export interface Picked {
  bitmap: ImageBitmap;
  w: number;
  h: number;
  animated: boolean;
}

/** Check before decoding (SVG and bombs never reach the decoder), then decode upright. */
export async function pickImage(file: File): Promise<Picked> {
  if (/svg/i.test(file.type)) throw new ImageError('img.svg');
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const pre = checkImageInput(head, file.size);
  if (!pre.ok) throw new ImageError(pre.code, pre.params);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('admin.brand.img.err.decode');
  }
  return { bitmap, w: bitmap.width, h: bitmap.height, animated: pre.header.animated === true };
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    if (typeof c.convertToBlob === 'function') return c;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

function hasAlpha(ctx: Ctx2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true;
  return false;
}

/** One stored variant: the crop drawn at the slot's exact size, encoded to fit its byte cap. */
export async function encodeVariant(p: Picked, aspect: number, crop: Crop, slot: Slot): Promise<Blob> {
  const c = makeCanvas(slot.w, slot.h);
  const ctx = c.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new ImageError('admin.brand.img.err.encode');
  const r = cropRect(p.w, p.h, aspect, crop);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, slot.w, slot.h);
  const tryType = async (type: string, lossy: boolean): Promise<Blob | null> => {
    for (const q of lossy ? qualitySteps() : [undefined]) {
      const blob = await toBlob(c, type, q);
      // An engine without that encoder returns PNG instead (HTML spec): take the type from the bytes.
      if (!blob) return null;
      const real = encodedType(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
      if (real !== type) return null;
      if (blob.size <= slot.maxBytes) return blob.type === type ? blob : new Blob([blob], { type });
    }
    return null;
  };
  const alpha = hasAlpha(ctx, slot.w, slot.h);
  const out = (await tryType('image/webp', true)) ?? (alpha ? await tryType(fallbackType(true), false) : null) ?? (await tryType('image/jpeg', true));
  if (!out) throw new ImageError('admin.brand.img.err.encode');
  return out;
}
