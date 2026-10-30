import fc from 'fast-check';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { drawQr, qrMatrix } from '../../src/branding/qr.js';

/** Render the matrix to RGBA pixels (quiet zone, 4 px per module) and decode it with jsQR. */
function decode(m: boolean[][]): string | null {
  const scale = 4;
  const side = (m.length + 8) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  const ctx = {
    fillStyle: '#ffffff' as unknown,
    fillRect(x: number, y: number, w: number, h: number) {
      const v = this.fillStyle === '#000000' ? 0 : 255;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px.fill(v, (yy * side + xx) * 4, (yy * side + xx) * 4 + 3);
    },
  };
  drawQr(ctx, m, scale);
  return jsQR(px, side, side)?.data ?? null;
}

describe('QR encoder', () => {
  it('decodes back to the input across versions 1–10', () => {
    for (const len of [1, 10, 14, 20, 30, 50, 70, 90, 110, 130, 154, 180, 213]) {
      const text = 'Ab1-'.repeat(60).slice(0, len);
      const m = qrMatrix(text);
      expect(m.length, `len ${len}`).toBe(m[0]!.length);
      expect(decode(m), `len ${len}, size ${m.length}`).toBe(text);
    }
  });

  it('decodes a real Pix payload, with UTF-8 bytes too', () => {
    const pix = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
    expect(decode(qrMatrix(pix))).toBe(pix);
    expect(decode(qrMatrix('Olá São Paulo ✓'))).toBe('Olá São Paulo ✓');
  });

  it('property: random ASCII payloads round-trip', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200, unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)) }), (s) => {
        expect(decode(qrMatrix(s))).toBe(s);
        return true;
      }),
      { numRuns: 200, seed: 7 },
    );
  });

  it('refuses text beyond version 10', () => {
    expect(() => qrMatrix('x'.repeat(300))).toThrow();
  });
});
