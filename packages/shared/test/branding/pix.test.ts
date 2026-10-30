import { describe, expect, it } from 'vitest';
import { buildPixPayload, crc16, normalizePixKey, pixAscii } from '../../src/branding/pix.js';

describe('Pix', () => {
  it('reproduces the BCB manual example byte for byte', () => {
    const r = buildPixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' });
    expect(r).toEqual({ ok: true, payload: '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D' });
  });

  it('CRC16/CCITT-FALSE test vector', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('names and cities become ASCII within the field limits', () => {
    expect(pixAscii('João da Conceição', 25)).toBe('Joao da Conceicao');
    expect(pixAscii('São José dos Campos', 15)).toBe('Sao Jose dos Ca');
    expect(pixAscii('😀💸', 25)).toBe('');
    expect(buildPixPayload({ key: 'x@y.com', name: '😀', city: 'Rio' })).toEqual({ ok: false, code: 'pix.name' });
    const long = buildPixPayload({ key: 'a'.repeat(77), name: 'Ana', city: 'Rio', description: 'x'.repeat(40) });
    expect(long.ok).toBe(true);
    if (long.ok) expect(Number(long.payload.slice(10, 12))).toBeLessThanOrEqual(99);
  });

  it('validates keys per type', () => {
    expect(normalizePixKey('cpf', '529.982.247-25')).toEqual({ ok: true, key: '52998224725' });
    expect(normalizePixKey('cpf', '111.111.111-11')).toMatchObject({ ok: false });
    expect(normalizePixKey('cpf', '529.982.247-24')).toMatchObject({ ok: false });
    expect(normalizePixKey('cnpj', '11.222.333/0001-81')).toEqual({ ok: true, key: '11222333000181' });
    expect(normalizePixKey('cnpj', '11.222.333/0001-80')).toMatchObject({ ok: false });
    expect(normalizePixKey('phone', '(11) 91234-5678')).toEqual({ ok: true, key: '+5511912345678' });
    expect(normalizePixKey('phone', '+55 21 3456-7890')).toEqual({ ok: true, key: '+552134567890' });
    expect(normalizePixKey('phone', '+1 415 555 0100')).toMatchObject({ ok: false });
    expect(normalizePixKey('phone', '(11) 81234-5678')).toMatchObject({ ok: false });
    expect(normalizePixKey('email', 'Ana@Example.com')).toEqual({ ok: true, key: 'ana@example.com' });
    expect(normalizePixKey('email', 'ana@@example.com')).toMatchObject({ ok: false });
    expect(normalizePixKey('evp', '123E4567-E12B-12D1-A456-426655440000')).toEqual({ ok: true, key: '123e4567-e12b-12d1-a456-426655440000' });
    expect(normalizePixKey('evp', 'not-a-uuid')).toMatchObject({ ok: false });
  });
});
