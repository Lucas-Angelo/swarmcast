import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BrandSlot } from '@swarmcast/shared/branding';
import { normalizeBrandImage } from '../../src/branding/image.js';

const dir = path.join(import.meta.dirname, '..', 'fixtures', 'branding');
const read = (f: string): Buffer => fs.readFileSync(path.join(dir, f));
const MARKERS = ['MARKER', 'Exif', 'GPS', 'ICC_PROFILE', 'http://ns.adobe.com/xap', 'Photoshop 3.0', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'tIME', 'XMP ', 'ICCP', 'EXIF'];

function noMetadata(b: Buffer): string[] {
  const s = b.toString('latin1');
  return MARKERS.filter((m) => s.includes(m));
}

describe('branding image validator and stripper (U6)', () => {
  const accepted: Array<[string, BrandSlot, string]> = [
    ['banner-meta.jpg', 'banner', 'jpeg'],
    ['banner-progressive.jpg', 'banner', 'jpeg'],
    ['avatar-meta.png', 'avatar', 'png'],
    ['avatar-16bit.png', 'avatar', 'png'],
    ['avatar-trailing.png', 'avatar', 'png'],
    ['fav32.png', 'fav32', 'png'],
    ['banner-meta.webp', 'banner', 'webp'],
    ['avatar-alpha.webp', 'avatar', 'webp'],
    ['avatar-lossless.webp', 'avatar', 'webp'],
  ];
  for (const [file, slot, type] of accepted) {
    it(`${file}: accepted for ${slot}, every metadata chunk removed, idempotent`, () => {
      const r = normalizeBrandImage(read(file), slot);
      if (!r.ok) throw new Error(`refused: ${r.code}`);
      expect(r.type).toBe(type);
      expect(noMetadata(r.bytes)).toEqual([]);
      expect(r.bytes.length).toBeLessThanOrEqual(read(file).length);
      const again = normalizeBrandImage(r.bytes, slot);
      expect(again.ok && again.bytes.equals(r.bytes)).toBe(true);
    });
  }

  const refused: Array<[string, BrandSlot, string]> = [
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
  ];
  for (const [file, slot, code] of refused) {
    it(`${file} for ${slot}: ${code}`, () => {
      expect(normalizeBrandImage(read(file), slot)).toMatchObject({ ok: false, code });
    });
  }

  it('SVG is refused by magic bytes whatever the content type said', () => {
    expect(normalizeBrandImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'avatar')).toEqual({ ok: false, code: 'img.type' });
  });

  it('the byte cap per slot applies after stripping', () => {
    const big = read('banner-meta.jpg');
    expect(normalizeBrandImage(big, 'banner').ok).toBe(true);
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
  it('mutated, truncated and extended files: a typed result, never a throw, never a wrong size accepted, idempotent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: seeds.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
        fc.option(fc.nat()),
        fc.uint8Array({ maxLength: 32 }),
        (s, flips, cut, tail) => {
          const [seed, slot] = seeds[s]!;
          const b = Buffer.from(seed);
          for (const [pos, v] of flips) b[pos % b.length] = v;
          const input = Buffer.concat([cut === null ? b : b.subarray(0, cut % (b.length + 1)), Buffer.from(tail)]);
          const r = normalizeBrandImage(input, slot);
          if (r.ok) {
            expect([r.w, r.h]).toEqual(slot === 'fav32' ? [32, 32] : slot === 'avatar' ? [256, 256] : [1280, 320]);
            const again = normalizeBrandImage(r.bytes, slot);
            expect(again.ok && again.bytes.equals(r.bytes)).toBe(true);
          } else expect(r.code).toMatch(/^img\./);
          return true;
        },
      ),
      { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x1a6e },
    );
  });
});
