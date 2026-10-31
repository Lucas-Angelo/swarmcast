import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BRAND_SLOTS, type BrandSlot } from '@swarmcast/shared/branding';
import { normalizeBrandImage } from '../../src/branding/image.js';

// Uploaded brand images: only PNG, JPEG and WebP of the slot's exact size, stripped to pixel data
// (EXIF, GPS, ICC, XMP, text chunks and trailing bytes removed), never animated, never a bomb.
// The fixtures (../fixtures/branding, made by make.py there) carry "MARKER" in every metadata chunk.

const dir = path.join(import.meta.dirname, '..', 'fixtures', 'branding');
const read = (f: string): Buffer => fs.readFileSync(path.join(dir, f));
const MARKERS = ['MARKER', 'Exif', 'GPS', 'ICC_PROFILE', 'http://ns.adobe.com/xap', 'Photoshop 3.0', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'tIME', 'XMP ', 'ICCP', 'EXIF'];

/** The metadata markers still found in `b` (none, once stripped). */
function metadataIn(b: Buffer): string[] {
  const s = b.toString('latin1');
  return MARKERS.filter((m) => s.includes(m));
}

/** `jpeg` with a comment segment (COM) of `size` bytes right after its start marker. */
function withJpegComment(jpeg: Buffer, size: number): Buffer {
  const com = Buffer.alloc(4 + size, 0x20);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(2 + size, 2);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
}

/** A valid w×h 8-bit RGB PNG of noise: pixel data that does not compress. */
function noisePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), crypto.createHash('shake256', { outputLength: w * 3 }).update(`row ${y}`).digest()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

describe('branding image validator and stripper (U6)', () => {
  it.each<[string, BrandSlot, string]>([
    ['banner-meta.jpg', 'banner', 'jpeg'],
    ['banner-progressive.jpg', 'banner', 'jpeg'],
    ['avatar-meta.png', 'avatar', 'png'],
    ['avatar-16bit.png', 'avatar', 'png'],
    ['avatar-trailing.png', 'avatar', 'png'],
    ['fav32.png', 'fav32', 'png'],
    ['banner-meta.webp', 'banner', 'webp'],
    ['avatar-alpha.webp', 'avatar', 'webp'],
    ['avatar-lossless.webp', 'avatar', 'webp'],
  ])('%s: accepted for %s as %s, every metadata chunk removed, idempotent', (file, slot, type) => {
    // Arrange
    const input = read(file);
    // Act
    const r = normalizeBrandImage(input, slot);
    // Assert
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    expect(r.type).toBe(type);
    expect(metadataIn(r.bytes)).toEqual([]);
    expect(r.bytes.length).toBeLessThanOrEqual(input.length);
    const again = normalizeBrandImage(r.bytes, slot);
    expect(again.ok && again.bytes.equals(r.bytes)).toBe(true);
  });

  it.each<[string, BrandSlot, string]>([
    ['banner-cmyk.jpg', 'banner', 'img.corrupt'],
    ['banner-wrong-size.jpg', 'banner', 'img.dims'],
    ['avatar-meta.png', 'banner', 'img.dims'],
    ['avatar-apng.png', 'avatar', 'img.animated'],
    ['avatar-animated.webp', 'avatar', 'img.animated'],
    ['avatar-interlaced.png', 'avatar', 'img.corrupt'],
    ['bomb.png', 'avatar', 'img.tooLarge'],
    ['avatar-overflow.png', 'avatar', 'img.corrupt'],
    ['avatar-badcrc.png', 'avatar', 'img.corrupt'],
    ['make.py', 'avatar', 'img.type'],
  ])('%s for %s: %s', (file, slot, code) => {
    // Act
    const r = normalizeBrandImage(read(file), slot);
    // Assert
    expect(r).toMatchObject({ ok: false, code });
  });

  it('SVG is refused by magic bytes whatever the content type said', () => {
    // Act
    const r = normalizeBrandImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'avatar');
    // Assert
    expect(r).toEqual({ ok: false, code: 'img.type' });
  });

  it('the byte cap per slot applies after stripping: metadata alone cannot push an image over it', () => {
    // Arrange
    const big = withJpegComment(read('banner-meta.jpg'), 16 * 1024);
    // Act
    const r = normalizeBrandImage(big, 'banner');
    // Assert
    expect(big.length).toBeGreaterThan(BRAND_SLOTS.banner.maxBytes);
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    expect(r.bytes.length).toBeLessThanOrEqual(BRAND_SLOTS.banner.maxBytes);
  });

  it('pixel data over the slot cap is refused with the size and the cap (KB)', () => {
    // Arrange
    const png = noisePng(256, 256);
    // Act
    const r = normalizeBrandImage(png, 'avatar');
    // Assert
    expect(r).toMatchObject({ ok: false, code: 'img.bytes', params: { max: BRAND_SLOTS.avatar.maxBytes / 1024 } });
    expect(!r.ok && r.params && Number(r.params.kb) > BRAND_SLOTS.avatar.maxBytes / 1024).toBe(true);
  });
});

describe('image fuzz (U7)', () => {
  const seeds: Array<[Buffer, BrandSlot]> = [
    [read('avatar-meta.png'), 'avatar'],
    [read('fav32.png'), 'fav32'],
    [read('avatar-alpha.webp'), 'avatar'],
    [read('avatar-lossless.webp'), 'avatar'],
    [read('banner-progressive.jpg').subarray(0, 4000), 'banner'],
  ];
  /** Byte flips, a cut and a tail applied to one seed file. */
  const mutation = fc.tuple(
    fc.integer({ min: 0, max: seeds.length - 1 }),
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
    fc.option(fc.nat()),
    fc.uint8Array({ maxLength: 32 }),
  );

  it('mutated, truncated and extended files: a typed result, never a throw, never a wrong size accepted, idempotent', () => {
    // Arrange
    const property = fc.property(mutation, ([s, flips, cut, tail]) => {
      const [seed, slot] = seeds[s]!;
      const b = Buffer.from(seed);
      for (const [pos, v] of flips) b[pos % b.length] = v;
      const input = Buffer.concat([cut === null ? b : b.subarray(0, cut % (b.length + 1)), Buffer.from(tail)]);
      const r = normalizeBrandImage(input, slot);
      if (r.ok) {
        expect([r.w, r.h]).toEqual([BRAND_SLOTS[slot].w, BRAND_SLOTS[slot].h]);
        const again = normalizeBrandImage(r.bytes, slot);
        expect(again.ok && again.bytes.equals(r.bytes)).toBe(true);
      } else expect(r.code).toMatch(/^img\./);
      return true;
    });
    // Act
    const run = () => fc.assert(property, { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x1a6e });
    // Assert
    expect(run).not.toThrow();
  });
});
