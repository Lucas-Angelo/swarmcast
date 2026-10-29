import { canonicalizeLine, measureChatText } from '../chat/text.js';
import { P_ANYMARK, P_DIGIT, P_EXTPICT, P_LETTER, P_RI, codePoints, graphemeCodePoints, isWellFormedString, props, utf8Length } from '../chat/ucd.js';
import { BRAND_TEXT_MAX_INPUT, type BrandTextProfile } from './limits.js';

/**
 * Streamer text fields (plan §2.4): the chat's Unicode pipeline line by line, with a field
 * profile. Only multi-line profiles keep line breaks (LF), at most `maxLines`, with blank-line
 * runs collapsed to one. Shown as typed (never translated); rendered with textContent only.
 */

export type BrandTextError = 'text.tooLong' | 'text.invalid' | 'text.combining' | 'brand.err.lines' | 'brand.err.tagChars';

export type BrandTextResult = { ok: true; text: string; graphemes: number } | { ok: false; code: BrandTextError; params?: Record<string, number> };

/** More dropped marks than this in one field: refused (as in chat). */
const MAX_DROPPED_MARKS = 20;

function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c || c === 0x85 || c === 0x2028 || c === 0x2029;
}

/** A tag grapheme: an emoji, or only letters, marks, digits, space, "-" and "_". */
function tagGraphemeOk(cps: readonly number[]): boolean {
  if (cps.some((c) => props(c) & (P_EXTPICT | P_RI))) return true;
  return cps.every((c) => c === 0x20 || c === 0x2d || c === 0x5f || (props(c) & (P_LETTER | P_ANYMARK | P_DIGIT)) !== 0);
}

/**
 * Canonicalise one branding text field. An empty result is `{ ok: true, text: '' }` (the field is
 * unset); callers treat '' as absent.
 */
export function canonicalizeBrandText(input: string, profile: BrandTextProfile): BrandTextResult {
  if (input.length > BRAND_TEXT_MAX_INPUT) return { ok: false, code: 'text.tooLong', params: { max: profile.maxGraphemes } };
  if (!isWellFormedString(input)) return { ok: false, code: 'text.invalid' };
  // Split into lines (any line break), or fold everything into one line.
  const rawLines: string[] = [];
  if (profile.maxLines > 1) {
    let cur = '';
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (isLineBreak(c)) {
        if (c === 0x0d && input.charCodeAt(i + 1) === 0x0a) i++;
        rawLines.push(cur);
        cur = '';
      } else cur += input[i];
    }
    rawLines.push(cur);
  } else rawLines.push(input);
  const lines: string[] = [];
  let dropped = 0;
  for (const raw of rawLines) {
    const r = canonicalizeLine(raw);
    dropped += r.dropped;
    // A line with nothing visible counts as blank.
    const line = measureChatText(r.text).visible > 0 ? r.text : '';
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (dropped > MAX_DROPPED_MARKS) return { ok: false, code: 'text.combining' };
  if (lines.length > profile.maxLines) return { ok: false, code: 'brand.err.lines', params: { max: profile.maxLines } };
  const text = lines.join('\n');
  if (text === '') return { ok: true, text: '', graphemes: 0 };
  const cps = graphemeCodePoints(text);
  if (cps.length > profile.maxGraphemes || utf8Length(text) > profile.maxBytes) return { ok: false, code: 'text.tooLong', params: { max: profile.maxGraphemes } };
  if (profile.tag && !cps.every(tagGraphemeOk)) return { ok: false, code: 'brand.err.tagChars' };
  return { ok: true, text, graphemes: cps.length };
}

/** Number of lines of a canonical text. */
export function lineCount(text: string): number {
  return text === '' ? 0 : codePoints(text).filter((c) => c === 0x0a).length + 1;
}
