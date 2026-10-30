import fc from 'fast-check';

/** fast-check arbitraries for the chat pipeline (plan §10.1). All escapes, no literal invisibles. */

const cp = (n: number): string => String.fromCodePoint(n);
const range = (lo: number, hi: number): fc.Arbitrary<string> => fc.integer({ min: lo, max: hi }).map(cp);

/** Any UTF-16 string, lone surrogates included. */
export const anyUnicode = fc.string({ unit: 'binary', maxLength: 400 });
/** Any UTF-16 code units, lone surrogates included. */
export const anyUnits = fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((u) => String.fromCharCode(u)), maxLength: 400 });

const MARKS = fc.oneof(range(0x300, 0x36f), range(0x1ab0, 0x1aff), range(0x20d0, 0x20ff));
export const zalgoish = fc.tuple(fc.constantFrom('a', 'Z', 'e', '\u{3B1}', '\u{430}', '1'), fc.array(MARKS, { maxLength: 60 })).map(([b, m]) => b + m.join(''));
export const zalgoText = fc.array(zalgoish, { maxLength: 20 }).map((a) => a.join(''));

const BIDI = ['\u{200E}', '\u{200F}', '\u{61C}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}'];
export const bidiMix = fc.array(fc.oneof(fc.constantFrom(...BIDI), fc.constantFrom('abc', '\u{5E9}\u{5DC}\u{5D5}\u{5DD}', '\u{633}\u{644}\u{627}\u{645}', '123', ' ')), { maxLength: 60 }).map((a) => a.join(''));

const INVISIBLE = [0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2064, 0x2065, 0x206f, 0x3164, 0xfeff, 0xffa0, 0xfff0, 0x1bca0, 0x1d173, 0x2800, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef, 0xfe00, 0xfe0f];
export const invisibles = fc.array(fc.oneof(fc.constantFrom(...INVISIBLE.map(cp)), fc.constantFrom('a', 'b', ' ', '\u{1F600}')), { maxLength: 80 }).map((a) => a.join(''));

const EMOJI_PARTS = ['\u{1F469}', '\u{1F468}', '\u{1F467}', '\u{1F44D}', '\u{2764}', '\u{1F3F4}', '\u{200D}', '\u{FE0E}', '\u{FE0F}', '\u{1F3FB}', '\u{1F3FF}', '\u{E0067}', '\u{E0062}', '\u{E007F}', '\u{1F1E7}', '\u{1F1F7}', '\u{20E3}', '1', '#'];
export const emojiParts = fc.array(fc.constantFrom(...EMOJI_PARTS), { maxLength: 80 }).map((a) => a.join(''));

const CONJ: Array<[string, string, string, string]> = [
  ['\u{C1C}', '\u{C4D}', '\u{C1E}', '\u{C3E}'], // Telugu
  ['\u{99C}', '\u{9CD}', '\u{99E}', '\u{9BE}'], // Bengali
  ['\u{915}', '\u{94D}', '\u{937}', '\u{93F}'], // Devanagari
];
export const indicConjuncts = fc
  .array(fc.tuple(fc.constantFrom(...CONJ), fc.constantFrom('\u{200D}', '\u{200C}', '')), { maxLength: 30 })
  .map((a) => a.map(([[c1, v, c2, s], j]) => c1 + v + c2 + j + s).join(''));

const SAMPLES = [
  'boa noite chat',
  'kkkkkkk',
  'tá ótimo, valeu! 😀',
  'que jogada 🔥🔥',
  'GG',
  'alguém sabe a música?',
  'hello everyone 👋🏽',
  'nice play!!',
  'ção, ñ, ü, ø, ß',
  'top demais 👍',
];
export const realistic = fc.array(fc.constantFrom(...SAMPLES), { minLength: 1, maxLength: 4 }).map((a) => a.join(' '));

/** Everything mixed. */
export const hostile = fc.oneof(anyUnicode, anyUnits, zalgoText, bidiMix, invisibles, emojiParts, indicConjuncts, realistic);
