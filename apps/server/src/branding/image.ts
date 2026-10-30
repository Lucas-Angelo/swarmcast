import zlib from 'node:zlib';
import { BRAND_SLOTS, isJpeg, isPng, isWebp, type BrandSlot } from '@swarmcast/shared/branding';

/**
 * Server stage of the image pipeline (docs/BRANDING.md, plan §3.1): validate the panel's
 * canvas-encoded variant and keep only the pixel data. A structural check, not a decoder: magic
 * bytes, a full chunk/marker walk with CRCs, exact slot dimensions, no animation, a bounded PNG
 * inflate whose size must match the header, and every non-pixel chunk dropped (EXIF, XMP, ICC,
 * IPTC, text, times, comments, vendor data). Viewers only ever get the bytes this returns.
 */

export type ImgError = 'img.type' | 'img.corrupt' | 'img.dims' | 'img.bytes' | 'img.animated' | 'img.tooLarge';

export type ImgResult = { ok: true; bytes: Buffer; type: 'png' | 'jpeg' | 'webp'; w: number; h: number } | { ok: false; code: ImgError; params?: Record<string, number> };

class Bad extends Error {
  constructor(readonly code: ImgError) {
    super(code);
  }
}

// ---- PNG ----

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

function png(b: Buffer): { bytes: Buffer; w: number; h: number } {
  let i = 8;
  const kept: Buffer[] = [b.subarray(0, 8)];
  const idat: Buffer[] = [];
  let w = 0;
  let h = 0;
  let expected = 0;
  let sawEnd = false;
  for (let n = 0; n < 10_000; n++) {
    if (i + 12 > b.length) throw new Bad('img.corrupt');
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    if (len > b.length || i + 12 + len > b.length) throw new Bad('img.corrupt');
    const data = b.subarray(i + 8, i + 8 + len);
    if (zlib.crc32(b.subarray(i + 4, i + 8 + len)) !== b.readUInt32BE(i + 8 + len)) throw new Bad('img.corrupt');
    if (n === 0) {
      if (type !== 'IHDR' || len !== 13) throw new Bad('img.corrupt');
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const depth = data[8]!;
      const color = data[9]!;
      const channels = PNG_CHANNELS[color];
      if (!channels || ![1, 2, 4, 8, 16].includes(depth) || data[10] !== 0 || data[11] !== 0) throw new Bad('img.corrupt');
      // Interlaced: canvases never write it, and it would complicate the size check.
      if (data[12] !== 0) throw new Bad('img.corrupt');
      if (w < 1 || h < 1 || w > 4096 || h > 4096) throw new Bad('img.tooLarge');
      expected = h * (1 + Math.ceil((w * channels * depth) / 8));
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Bad('img.animated');
    if (type === 'IDAT') idat.push(data);
    if (PNG_KEEP.has(type)) kept.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || idat.length === 0) throw new Bad('img.corrupt');
  // Bounded inflate: a bomb stops at expected + 1 bytes, and the size must match exactly.
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    throw new Bad('img.corrupt');
  }
  if (raw.length !== expected) throw new Bad('img.corrupt');
  return { bytes: Buffer.concat(kept), w, h };
}

// ---- JPEG ----

/** SOF markers we accept: baseline, extended sequential, progressive (Huffman). */
const JPEG_SOF_OK = new Set([0xc0, 0xc1, 0xc2]);

function jpeg(b: Buffer): { bytes: Buffer; w: number; h: number } {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let w = 0;
  let h = 0;
  let sawSos = false;
  for (let n = 0; n < 100_000; n++) {
    if (i + 2 > b.length) throw new Bad('img.corrupt');
    if (b[i] !== 0xff) throw new Bad('img.corrupt');
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd9) {
      if (!sawSos || w === 0) throw new Bad('img.corrupt');
      out.push(Buffer.from([0xff, 0xd9]));
      return { bytes: Buffer.concat(out), w, h };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) throw new Bad('img.corrupt');
    if (i + 4 > b.length) throw new Bad('img.corrupt');
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new Bad('img.corrupt');
    const seg = b.subarray(i, i + 2 + len);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (!JPEG_SOF_OK.has(m) || len < 8) throw new Bad('img.corrupt');
      h = b.readUInt16BE(i + 5);
      w = b.readUInt16BE(i + 7);
      const comps = b[i + 9]!;
      if (comps !== 1 && comps !== 3) throw new Bad('img.corrupt');
      out.push(seg);
    } else if (m === 0xdb || m === 0xc4 || m === 0xdd) {
      out.push(seg); // DQT, DHT, DRI
    } else if (m === 0xe0 && b.toString('latin1', i + 4, i + 9) === 'JFIF\0') {
      out.push(seg); // APP0 JFIF only
    } else if (m === 0xda) {
      if (w === 0) throw new Bad('img.corrupt');
      sawSos = true;
      // SOS header, then entropy-coded data up to the next real marker (FF00 is stuffing, FFD0–D7 restarts).
      let j = i + 2 + len;
      while (j + 1 < b.length) {
        if (b[j] === 0xff) {
          const nx = b[j + 1]!;
          if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) {
            j += 2;
            continue;
          }
          if (nx === 0xff) {
            j++;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(b.subarray(i, j));
      i = j;
      continue;
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      // APP1 (Exif, XMP), APP2 (ICC, MPF), APP13 (IPTC), APP14, other APPn, COM: dropped.
    } else {
      throw new Bad('img.corrupt');
    }
    i += 2 + len;
  }
  throw new Bad('img.corrupt');
}

// ---- WebP ----

function webp(b: Buffer): { bytes: Buffer; w: number; h: number } {
  if (b.readUInt32LE(4) !== b.length - 8) throw new Bad('img.corrupt');
  let i = 12;
  let w = 0;
  let h = 0;
  let bitstream: Buffer | null = null;
  let alpha: Buffer | null = null;
  let vp8x: Buffer | null = null;
  for (let n = 0; n < 1000 && i < b.length; n++) {
    if (i + 8 > b.length) throw new Bad('img.corrupt');
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const padded = len + (len & 1);
    if (i + 8 + len > b.length) throw new Bad('img.corrupt');
    const data = b.subarray(i + 8, i + 8 + len);
    if (type === 'ANIM' || type === 'ANMF') throw new Bad('img.animated');
    if (type === 'VP8X') {
      if (len < 10) throw new Bad('img.corrupt');
      if (data[0]! & 0x02) throw new Bad('img.animated');
      vp8x = Buffer.from(data.subarray(0, 10));
      w = 1 + data.readUIntLE(4, 3);
      h = 1 + data.readUIntLE(7, 3);
    } else if (type === 'ALPH') {
      alpha = b.subarray(i, Math.min(b.length, i + 8 + padded));
    } else if (type === 'VP8 ') {
      if (len < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Bad('img.corrupt');
      const bw = data.readUInt16LE(6) & 0x3fff;
      const bh = data.readUInt16LE(8) & 0x3fff;
      if (vp8x && (bw !== w || bh !== h)) throw new Bad('img.corrupt');
      w = bw;
      h = bh;
      bitstream = b.subarray(i, Math.min(b.length, i + 8 + padded));
    } else if (type === 'VP8L') {
      if (len < 5 || data[0] !== 0x2f) throw new Bad('img.corrupt');
      const bits = data.readUInt32LE(1);
      const bw = (bits & 0x3fff) + 1;
      const bh = ((bits >>> 14) & 0x3fff) + 1;
      if (vp8x && (bw !== w || bh !== h)) throw new Bad('img.corrupt');
      w = bw;
      h = bh;
      bitstream = b.subarray(i, Math.min(b.length, i + 8 + padded));
    }
    // EXIF, XMP, ICCP and unknown chunks: dropped.
    i += 8 + padded;
  }
  if (!bitstream || w === 0) throw new Bad('img.corrupt');
  const parts: Buffer[] = [];
  if (vp8x && alpha) {
    // Flags reset to "alpha" only (no ICC, EXIF, XMP, animation).
    vp8x[0] = 0x10;
    const head = Buffer.alloc(8);
    head.write('VP8X', 0, 'latin1');
    head.writeUInt32LE(10, 4);
    parts.push(head, vp8x, alpha);
  }
  parts.push(bitstream);
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return { bytes: Buffer.concat([riff, body]), w, h };
}

/** Validate an upload for `slot` and strip it to pixel data only. Never throws. */
export function normalizeBrandImage(input: Uint8Array, slot: BrandSlot): ImgResult {
  const spec = BRAND_SLOTS[slot];
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    let r: { bytes: Buffer; w: number; h: number };
    let type: 'png' | 'jpeg' | 'webp';
    if (isPng(b)) {
      r = png(b);
      type = 'png';
    } else if (isJpeg(b)) {
      r = jpeg(b);
      type = 'jpeg';
    } else if (isWebp(b) && b.length >= 20) {
      r = webp(b);
      type = 'webp';
    } else return { ok: false, code: 'img.type' };
    if (r.w !== spec.w || r.h !== spec.h) return { ok: false, code: 'img.dims', params: { w: spec.w, h: spec.h } };
    if (r.bytes.length > spec.maxBytes) return { ok: false, code: 'img.bytes', params: { kb: Math.ceil(r.bytes.length / 1024), max: spec.maxBytes / 1024 } };
    return { ok: true, bytes: r.bytes, type, w: r.w, h: r.h };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, code: e.code };
    // A RangeError from a Buffer read on a truncated file is a corrupt file too.
    return { ok: false, code: 'img.corrupt' };
  }
}
