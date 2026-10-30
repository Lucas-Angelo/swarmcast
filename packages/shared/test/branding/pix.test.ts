import { describe, expect, it } from 'vitest';
import { buildPixPayload, crc16, normalizePixKey, pixAscii } from '../../src/branding/pix.js';

/** The worked example of the BCB's Pix manual (BR Code), byte for byte. */
const BCB_EXAMPLE = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

describe('Pix', () => {
  it('reproduces the BCB manual example byte for byte', () => {
    // Act
    const r = buildPixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' });
    // Assert
    expect(r).toEqual({ ok: true, payload: BCB_EXAMPLE });
  });

  it('CRC16/CCITT-FALSE test vector', () => {
    // Act
    const crc = crc16('123456789');
    // Assert
    expect(crc).toBe('29B1');
  });

  it('names and cities become ASCII within the field limits', () => {
    // Act
    const ascii = [pixAscii('João da Conceição', 25), pixAscii('São José dos Campos', 15), pixAscii('😀💸', 25)];
    const emojiName = buildPixPayload({ key: 'x@y.com', name: '😀', city: 'Rio' });
    const long = buildPixPayload({ key: 'a'.repeat(77), name: 'Ana', city: 'Rio', description: 'x'.repeat(40) });
    // Assert
    expect(ascii).toEqual(['Joao da Conceicao', 'Sao Jose dos Ca', '']);
    expect(emojiName).toEqual({ ok: false, code: 'pix.name' });
    expect(long.ok).toBe(true);
    expect(long.ok && Number(long.payload.slice(10, 12))).toBeLessThanOrEqual(99);
  });

  it('validates keys per type', () => {
    // Arrange
    const cases = [
      ['cpf', '529.982.247-25', { ok: true, key: '52998224725' }],
      ['cpf', '111.111.111-11', { ok: false }],
      ['cpf', '529.982.247-24', { ok: false }],
      ['cnpj', '11.222.333/0001-81', { ok: true, key: '11222333000181' }],
      ['cnpj', '11.222.333/0001-80', { ok: false }],
      ['phone', '(11) 91234-5678', { ok: true, key: '+5511912345678' }],
      ['phone', '+55 21 3456-7890', { ok: true, key: '+552134567890' }],
      ['phone', '+1 415 555 0100', { ok: false }],
      ['phone', '(11) 81234-5678', { ok: false }],
      ['email', 'Ana@Example.com', { ok: true, key: 'ana@example.com' }],
      ['email', 'ana@@example.com', { ok: false }],
      ['evp', '123E4567-E12B-12D1-A456-426655440000', { ok: true, key: '123e4567-e12b-12d1-a456-426655440000' }],
      ['evp', 'not-a-uuid', { ok: false }],
    ] as const;
    // Act
    const results = cases.map(([type, raw]) => normalizePixKey(type, raw));
    // Assert
    expect(results).toMatchObject(cases.map(([, , expected]) => expected));
  });
});
