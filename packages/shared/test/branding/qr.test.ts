import fc from 'fast-check';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { drawQr, qrMatrix } from '../../src/branding/qr.js';

/** Payload lengths that land in each of versions 1–10 and on their edges. */
const LENGTHS = [1, 10, 14, 20, 30, 50, 70, 90, 110, 130, 154, 180, 213];
/** A real Pix payload (the BCB manual example). */
const PIX = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

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
    // Arrange
    const texts = LENGTHS.map((len) => 'Ab1-'.repeat(60).slice(0, len));
    // Act
    const matrices = texts.map((text) => qrMatrix(text));
    // Assert
    for (const m of matrices) expect(m.length, `size ${m.length}`).toBe(m[0]!.length);
    expect(matrices.map(decode)).toEqual(texts);
  });

  it('decodes a real Pix payload, with UTF-8 bytes too', () => {
    // Act
    const decoded = [decode(qrMatrix(PIX)), decode(qrMatrix('Olá São Paulo ✓'))];
    // Assert
    expect(decoded).toEqual([PIX, 'Olá São Paulo ✓']);
  });

  it('property: random ASCII payloads round-trip', () => {
    // Arrange
    const ascii = fc.string({ minLength: 1, maxLength: 200, unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)) });
    // Act
    const run = () => fc.assert(fc.property(ascii, (s) => decode(qrMatrix(s)) === s), { numRuns: 200, seed: 7 });
    // Assert
    expect(run).not.toThrow();
  });

  it('refuses text beyond version 10', () => {
    // Act
    const encode = () => qrMatrix('x'.repeat(300));
    // Assert
    expect(encode).toThrow();
  });
});
