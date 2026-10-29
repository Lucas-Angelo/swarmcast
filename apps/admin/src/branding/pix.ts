/**
 * Pix for the support button (plan branding-0.4.0 §2.6, BR6; user decision: full Pix with the
 * key, "Pix copia e cola" and a QR code). Panel-side copy until BR1 lands
 * `packages/shared/src/branding/pix.ts`; the viewer's support sheet (BR4/BR6, lane B) needs the
 * same builder.
 *
 * "Copia e cola" is the static BR Code of the Banco Central do Brasil: EMV QRCPS
 * merchant-presented TLV fields, with a CRC16-CCITT (poly 0x1021, init 0xFFFF) at the end.
 */

export type PixKeyType = 'cpf' | 'cnpj' | 'phone' | 'email' | 'random';

export type PixKeyResult =
  | { ok: true; type: PixKeyType; key: string; /** CPF and phone keys are personal numbers: ask twice. */ needsConfirm: boolean }
  | { ok: false; code: 'admin.brand.pix.err.empty' | 'admin.brand.pix.err.invalid' | 'admin.brand.pix.err.cpf' | 'admin.brand.pix.err.cnpj' | 'admin.brand.pix.err.phone' | 'admin.brand.pix.err.email' };

/** Max lengths of the BR Code merchant name (field 59) and city (field 60). */
export const PIX_NAME_MAX = 25;
export const PIX_CITY_MAX = 15;
/** The longest key the DICT accepts is an e-mail of 77 characters. */
export const PIX_KEY_MAX = 77;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[a-z0-9.!#$&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** CPF check digits (mod 11). Rejects the eleven repeated-digit numbers. */
export function validCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i]! * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== d[len]) return false;
  }
  return true;
}

/** CNPJ check digits (weights 5..2,9..2 and 6..2,9..2). */
export function validCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, ...w1];
  for (const w of [w1, w2]) {
    const sum = w.reduce((s, x, i) => s + x * d[i]!, 0);
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== d[w.length]) return false;
  }
  return true;
}

/**
 * Detect and normalise a Pix key as typed (formatted or not):
 * random key (UUID) → lower case; e-mail → lower case; phone → +55DDNNNNNNNNN;
 * CPF → 11 digits; CNPJ → 14 digits.
 */
export function parsePixKey(raw: string): PixKeyResult {
  const s = raw.trim();
  if (s === '') return { ok: false, code: 'admin.brand.pix.err.empty' };
  if (s.length > PIX_KEY_MAX) return { ok: false, code: 'admin.brand.pix.err.invalid' };
  const lower = s.toLowerCase();
  if (UUID.test(lower)) return { ok: true, type: 'random', key: lower, needsConfirm: false };
  if (s.includes('@')) return EMAIL.test(lower) ? { ok: true, type: 'email', key: lower, needsConfirm: false } : { ok: false, code: 'admin.brand.pix.err.email' };
  if (/[^\d\s().+/-]/.test(s)) return { ok: false, code: 'admin.brand.pix.err.invalid' };
  const digits = s.replace(/\D/g, '');
  const looksPhone = s.startsWith('+') || s.includes('(');
  if (!looksPhone && digits.length === 11 && validCpf(digits)) return { ok: true, type: 'cpf', key: digits, needsConfirm: true };
  if (!looksPhone && digits.length === 14) return validCnpj(digits) ? { ok: true, type: 'cnpj', key: digits, needsConfirm: false } : { ok: false, code: 'admin.brand.pix.err.cnpj' };
  // Phone: +55, a two-digit area code (11..99) and 8 or 9 digits (mobile numbers start with 9).
  const national = digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits;
  if (/^[1-9][1-9](9\d{8}|[2-8]\d{7})$/.test(national) && (looksPhone || !validCpf(digits))) return { ok: true, type: 'phone', key: `+55${national}`, needsConfirm: true };
  if (!looksPhone && digits.length === 11) return { ok: false, code: 'admin.brand.pix.err.cpf' };
  return { ok: false, code: looksPhone ? 'admin.brand.pix.err.phone' : 'admin.brand.pix.err.invalid' };
}

/** Plain ASCII for the BR Code name and city: accents dropped, only letters, digits, space and . - kept. */
export function toPixAscii(s: string, max: number): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) over the ASCII bytes, as 4 upper-case hex digits. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new RangeError(`BR Code field ${id} is too long`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export interface BrCodeInput {
  key: string;
  /** Receiver name as bank apps show it (≤ 25 ASCII characters after transliteration). */
  name: string;
  /** Receiver city (≤ 15 ASCII characters after transliteration). */
  city: string;
  /** Optional message shown to the payer (dropped when it does not fit). */
  description?: string;
  /** Optional fixed amount in BRL ("10.00"); a support button leaves it to the payer. */
  amount?: string;
}

/**
 * The static "Pix copia e cola" string (also the QR code's content). Throws on a name or city
 * that is empty after transliteration; the panel checks those before calling.
 */
export function buildBrCode(o: BrCodeInput): string {
  const name = toPixAscii(o.name, PIX_NAME_MAX);
  const city = toPixAscii(o.city, PIX_CITY_MAX);
  if (!name || !city) throw new RangeError('name and city are required');
  const gui = tlv('00', 'br.gov.bcb.pix') + tlv('01', o.key);
  const desc = o.description ? toPixAscii(o.description, 72) : '';
  const account = desc && gui.length + 4 + desc.length <= 99 ? gui + tlv('02', desc) : gui;
  if (o.amount !== undefined && !/^\d{1,10}\.\d{2}$/.test(o.amount)) throw new RangeError('amount must look like 10.00');
  const body =
    tlv('00', '01') +
    tlv('26', account) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (o.amount ? tlv('54', o.amount) : '') +
    tlv('58', 'BR') +
    tlv('59', name) +
    tlv('60', city) +
    tlv('62', tlv('05', '***')) +
    '6304';
  return body + crc16(body);
}

/** Split a BR Code into its top-level fields (tests and the panel's sanity check). */
export function parseTlv(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) throw new SyntaxError(`bad TLV at ${i}`);
    out.push([id, s.slice(i + 4, i + 4 + len)]);
    i += 4 + len;
  }
  return out;
}
