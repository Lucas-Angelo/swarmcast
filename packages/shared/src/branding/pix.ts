import { PIX_CITY_MAX, PIX_DESCRIPTION_MAX, PIX_NAME_MAX } from './limits.js';

/**
 * Pix (plan §2.6, user decision: key, "copia e cola" and QR code). Key validation per type and
 * the static BR Code (BCB "Manual de Padrões para Iniciação do Pix", EMV QRCPS merchant-presented
 * mode). Anyone who pays sees the receiver's full legal name and part of the CPF: the panel says so.
 */

export type PixKeyType = 'evp' | 'email' | 'phone' | 'cpf' | 'cnpj';
export type PixError = 'pix.key' | 'pix.cpf' | 'pix.cnpj' | 'pix.phone' | 'pix.email' | 'pix.evp' | 'pix.name' | 'pix.city';

const onlyDigits = (s: string): string => s.replace(/\D/g, '');

function cpfOk(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function cnpjOk(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const len of [12, 13]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i + 13 - len]!;
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[len])) return false;
  }
  return true;
}

/** Normalise a Pix key of a given type, or say what is wrong with it. */
export function normalizePixKey(type: PixKeyType, raw: string): { ok: true; key: string } | { ok: false; code: PixError } {
  const s = raw.trim();
  switch (type) {
    case 'evp': {
      const k = s.toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k) ? { ok: true, key: k } : { ok: false, code: 'pix.evp' };
    }
    case 'email': {
      const k = s.toLowerCase();
      const at = k.indexOf('@');
      const labels = k.slice(at + 1).split('.');
      const ok = k.length <= 77 && at > 0 && at === k.lastIndexOf('@') && /^[a-z0-9._%+-]+$/.test(k.slice(0, at)) && labels.length >= 2 && labels.every((l) => /^[a-z0-9-]+$/.test(l));
      return ok ? { ok: true, key: k } : { ok: false, code: 'pix.email' };
    }
    case 'phone': {
      let d = onlyDigits(s);
      if (!s.startsWith('+') || s.startsWith('+55')) {
        if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
        if (d.length !== 10 && d.length !== 11) return { ok: false, code: 'pix.phone' };
        if (d[0] === '0' || (d.length === 11 && d[2] !== '9')) return { ok: false, code: 'pix.phone' };
        return { ok: true, key: `+55${d}` };
      }
      return { ok: false, code: 'pix.phone' };
    }
    case 'cpf': {
      const d = onlyDigits(s);
      return cpfOk(d) ? { ok: true, key: d } : { ok: false, code: 'pix.cpf' };
    }
    case 'cnpj': {
      const d = onlyDigits(s);
      return cnpjOk(d) ? { ok: true, key: d } : { ok: false, code: 'pix.cnpj' };
    }
  }
}

/** Keys that reveal a personal number to everyone watching (the panel asks twice). */
export const PIX_PERSONAL_TYPES: readonly PixKeyType[] = ['cpf', 'phone'];

/**
 * BR Code text fields allow only a restricted ASCII set: accents removed, anything else dropped,
 * spaces collapsed, cut to `max`.
 */
export function pixAscii(s: string, max: number): string {
  const out = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 .,\-/&]/g, '')
    .replace(/ +/g, ' ')
    .trim();
  return out.slice(0, max).trim();
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as the BR Code requires; 4 uppercase hex digits. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(s)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const field = (id: string, value: string): string => `${id}${String(value.length).padStart(2, '0')}${value}`;

/**
 * The static "Pix copia e cola" payload (no amount: the payer types it). `name` and `city` are
 * transliterated to ASCII (bank apps show the name). `txid` defaults to "***" (no transaction id).
 */
export function buildPixPayload(o: { key: string; name: string; city: string; description?: string; txid?: string }): { ok: true; payload: string } | { ok: false; code: PixError } {
  const name = pixAscii(o.name, PIX_NAME_MAX);
  const city = pixAscii(o.city, PIX_CITY_MAX);
  if (!name) return { ok: false, code: 'pix.name' };
  if (!city) return { ok: false, code: 'pix.city' };
  if (!o.key || o.key.length > 77) return { ok: false, code: 'pix.key' };
  let desc = o.description ? pixAscii(o.description, PIX_DESCRIPTION_MAX) : '';
  // Field 26 holds at most 99 characters.
  const base = field('00', 'br.gov.bcb.pix') + field('01', o.key);
  if (desc && base.length + 4 + desc.length > 99) desc = desc.slice(0, Math.max(0, 99 - base.length - 4)).trim();
  const account = base + (desc ? field('02', desc) : '');
  const txid = o.txid && /^[A-Za-z0-9]{1,25}$/.test(o.txid) ? o.txid : '***';
  const body = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986') + field('58', 'BR') + field('59', name) + field('60', city) + field('62', field('05', txid)) + '6304';
  return { ok: true, payload: body + crc16(body) };
}
