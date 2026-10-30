/**
 * Nasty-string corpus of the chat (plan §2.6). Exported for the unit tests, the E2E rendering
 * page and the manual device checks. Each entry: id, input, the expected pipeline result and
 * where the string comes from.
 */

export type CorpusExpect =
  /** ok, with exactly this output */
  | { ok: true; text: string }
  /** ok, and the output must satisfy this check */
  | { ok: true; check: (out: string) => boolean; note: string }
  | { ok: false; code: string };

export interface CorpusEntry {
  id: string;
  input: string;
  expect: CorpusExpect;
  /** Options for canonicalizeChatText. */
  opts?: { maxGraphemes?: number; maxEmoji?: number; scripts?: 'any' | 'latin' };
  source: string;
}

/** Deterministic pseudo-random (no Math.random: the corpus must be the same everywhere). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function zalgo(word: string, perLetter: number, seed: number): string {
  const r = lcg(seed);
  let out = '';
  for (const ch of word) {
    out += ch;
    for (let i = 0; i < perLetter; i++) out += String.fromCodePoint(0x300 + Math.floor(r() * 0x70));
  }
  return out;
}

const marksPerGraphemeOk = (s: string): boolean => {
  let run = 0;
  let prev = -1;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (/^[\p{Mn}\p{Me}]$/u.test(ch)) {
      if (run >= 4 || cp === prev) return false;
      run++;
      prev = cp;
    } else {
      run = 0;
      prev = -1;
    }
  }
  return true;
};

const FAMILY = '\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
/** Kiss: person, person, medium-light and medium-dark skin tones (10 code points, the longest RGI). */
const KISS_TONES = '\u{1F9D1}\u{1F3FC}\u{200D}❤\u{FE0F}\u{200D}\u{1F48B}\u{200D}\u{1F9D1}\u{1F3FE}';
const ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

export const CORPUS: CorpusEntry[] = [
  {
    id: 'zalgo-1',
    input: zalgo('ZALGO', 6, 1),
    expect: { ok: true, check: (o) => marksPerGraphemeOk(o) && o.startsWith('Z'), note: 'at most 4 marks per letter, no identical neighbours' },
    source: 'Zalgo text, light (dropped marks under the reject threshold)',
  },
  { id: 'zalgo-1b', input: zalgo('ZALGO', 30, 2), expect: { ok: false, code: 'text.combining' }, source: 'Zalgo text, heavy (20 to 40 marks per letter)' },
  { id: 'zalgo-2', input: 'e' + '\u{301}'.repeat(1499), expect: { ok: false, code: 'text.combining' }, source: 'CVE-2023-25193 shape (HarfBuzz O(n²) marks)' },
  {
    id: 'zalgo-3',
    input: 'a\u{300}\u{301}\u{302}\u{303}'.repeat(100),
    expect: { ok: true, check: (o) => marksPerGraphemeOk(o), note: 'a legitimate maximum: 4 distinct marks per letter' },
    source: 'UTS #39 §5.4 (100 letters: 200 would pass the 1,024-byte cap)',
  },
  { id: 'bidi-1', input: 'abc\u{202E}fdp.exe', expect: { ok: true, text: 'abcfdp.exe' }, source: 'Trojan Source / RLO file names' },
  { id: 'bidi-3', input: '\u{200E}\u{200F}'.repeat(700) + 'hi', expect: { ok: true, text: '\u{200E}\u{200F}\u{200E}\u{200F}hi' }, source: 'Black Dot (2018), shape' },
  { id: 'bidi-4', input: 'שלום 123\u{200F} עולם', expect: { ok: true, text: 'שלום 123\u{200F} עולם' }, source: 'Hebrew as written' },
  { id: 'zw-1', input: 'a' + '\u{200B}'.repeat(500) + 'b', expect: { ok: true, text: 'ab' }, source: 'zero-width spaces' },
  { id: 'zw-2', input: '\u{200B}\u{2060}\u{FEFF}\u{3164}\u{2800}', expect: { ok: false, code: 'text.empty' }, source: 'invisible-only message' },
  { id: 'zw-4', input: 'hi\u{E0041}\u{E0042}\u{E0043}', expect: { ok: true, text: 'hi' }, source: 'ASCII smuggling in tags (2024)' },
  { id: 'zw-5', input: '\u{1F600}' + '\u{E0100}'.repeat(64), expect: { ok: true, text: '\u{1F600}' }, source: 'variation-selector byte smuggling (2025)' },
  { id: 'zwj-1', input: FAMILY.repeat(30), expect: { ok: true, text: FAMILY.repeat(30) }, source: 'family ZWJ sequence, at the emoji cap' },
  { id: 'zwj-1b', input: FAMILY.repeat(31), expect: { ok: false, code: 'text.tooManyEmoji' }, source: 'family ZWJ sequence, over the emoji cap' },
  {
    id: 'zwj-2',
    input: Array(30).fill('\u{1F600}').join('\u{200D}'),
    expect: { ok: true, text: '\u{1F600}'.repeat(30) },
    source: 'non-RGI ZWJ chain: split into pictographs',
  },
  { id: 'zwj-3', input: KISS_TONES, expect: { ok: true, text: KISS_TONES }, source: 'longest RGI sequence (10 code points)' },
  { id: 'zwj-4', input: ENGLAND, expect: { ok: true, text: ENGLAND }, source: 'RGI subdivision flag' },
  { id: 'zwj-4b', input: '\u{1F3F4}\u{E0061}\u{E0062}\u{E007F}', expect: { ok: true, text: '\u{1F3F4}' }, source: 'random tag sequence after a black flag' },
  { id: 'ctl-1', input: 'a\u0000\u0007\u001b[31mb\u007f\u0085c\u{2028}d', expect: { ok: true, text: 'a[31mb c d' }, source: 'C0/C1 controls, separators' },
  { id: 'ctl-2', input: 'line1\nline2\r\nline3', expect: { ok: true, text: 'line1 line2 line3' }, source: 'newlines' },
  { id: 'norm-1', input: 'e\u{301}', expect: { ok: true, text: 'é' }, source: 'decomposed é' },
  { id: 'norm-2', input: 'ﷺ'.repeat(200), expect: { ok: true, text: 'ﷺ'.repeat(200) }, source: 'NFKC expansion bomb (UAX #15)' },
  { id: 'crash-1', input: 'జ\u{C4D}ఞ\u{200C}\u{C3E}', expect: { ok: true, text: 'జ\u{C4D}ఞ\u{C3E}' }, source: 'CVE-2018-4124 Telugu' },
  { id: 'crash-2a', input: 'জ\u{9CD}ঞ\u{200C}\u{9BE}', expect: { ok: true, text: 'জ\u{9CD}ঞ\u{9BE}' }, source: 'Bengali variant of the 2018 pattern' },
  { id: 'crash-2b', input: 'ज\u{94D}ञ\u{200C}\u{93E}', expect: { ok: true, text: 'ज\u{94D}ञ\u{93E}' }, source: 'Devanagari variant of the 2018 pattern' },
  { id: 'crash-3', input: 'می\u{200C}خواهم', expect: { ok: true, text: 'می\u{200C}خواهم' }, source: 'Persian ZWNJ in a joining context' },
  { id: 'crash-4', input: 'क\u{94D}\u{200D}ष', expect: { ok: true, text: 'क\u{94D}\u{200D}ष' }, source: 'Hindi ZWJ after a virama' },
  {
    id: 'crash-5',
    input:
      'effective.\nPower\nل\u{64F}ل\u{64F}ص\u{651}ب\u{64F}ل\u{64F}لص\u{651}ب\u{64F}رر\u{64B} \u{963} \u{963}h \u{963} \u{963}\n冗',
    expect: { ok: true, check: (o) => marksPerGraphemeOk(o) && !o.includes('\n'), note: 'mark caps hold, one line' },
    source: 'CVE-2015-1157 "Effective Power", as published',
  },
  {
    id: 'crash-6',
    input: '\u{1F1EE}\u{1F1F9}ځڄڃچڇ\u{200C}ٺٻ\u{200F}\u{200E}',
    expect: { ok: true, check: (o) => marksPerGraphemeOk(o), note: 'structural rules hold' },
    source: '2020 Sindhi + Italian flag crash: shape only (the exact code points were not published in a primary source)',
  },
  { id: 'len-1', input: 'a'.repeat(501), opts: { maxGraphemes: 500 }, expect: { ok: false, code: 'text.tooLong' }, source: 'length' },
  { id: 'len-2', input: 'ท\u{E35}\u{E48}'.repeat(100), expect: { ok: true, text: 'ท\u{E35}\u{E48}'.repeat(100) }, source: 'Thai graphemes with tone marks (9 bytes each: 100 fit the byte cap)' },
  { id: 'len-2b', input: 'ท\u{E35}\u{E48}'.repeat(120), expect: { ok: false, code: 'text.tooLong' }, source: 'Thai over the 1,024-byte cap' },
  { id: 'len-3', input: 'a'.repeat(10_000), expect: { ok: false, code: 'text.tooLong' }, source: '10k-character input' },
  { id: 'sur-1', input: 'a\uD800', expect: { ok: false, code: 'text.invalid' }, source: 'lone surrogate' },
  { id: 'sur-2', input: '\uDC00b', expect: { ok: false, code: 'text.invalid' }, source: 'lone low surrogate' },
  { id: 'nul-1', input: '\u0000', expect: { ok: false, code: 'text.empty' }, source: 'NUL only' },
  { id: 'pua-1', input: 'a\u{E000}\u{E0FF}\u{F0000}b', expect: { ok: true, text: 'ab' }, source: 'private use' },
  { id: 'nonchar-1', input: 'a\u{FFFE}\u{FDD0}b', expect: { ok: true, text: 'ab' }, source: 'noncharacters' },
  { id: 'emoji-1', input: '1\u{FE0F}\u{20E3} #\u{FE0F}\u{20E3}', expect: { ok: true, text: '1\u{FE0F}\u{20E3} #\u{FE0F}\u{20E3}' }, source: 'keycaps' },
  { id: 'emoji-2', input: '\u{1F1E7}\u{1F1F7} \u{1F1E6}', expect: { ok: true, text: '\u{1F1E7}\u{1F1F7} \u{1F1E6}' }, source: 'flag and a lone regional indicator' },
  { id: 'mixed-1', input: 'boa noite galera 😀 tá ótimo, kkkkk 👍🏽', expect: { ok: true, text: 'boa noite galera 😀 tá ótimo, kkkkk 👍🏽' }, source: 'normal pt-BR chat' },
  { id: 'url-1', input: 'javascript:alert(1) https://evil.example/x.png', expect: { ok: true, text: 'javascript:alert(1) https://evil.example/x.png' }, source: 'links stay text' },
  { id: 'script-1', input: 'Привет', opts: { scripts: 'latin' }, expect: { ok: false, code: 'text.script' }, source: 'Latin-only policy' },
  { id: 'script-2', input: 'Olá, 😀!', opts: { scripts: 'latin' }, expect: { ok: true, text: 'Olá, 😀!' }, source: 'Latin-only policy allows Common' },
];

/** Nickname corpus: input → accepted value or the refusal code. */
export const NICKNAME_CORPUS: Array<{ id: string; input: string; ok: string | null; code?: string }> = [
  { id: 'ok-ascii', input: 'Ana', ok: 'Ana' },
  { id: 'ok-trim', input: '  Ana   Clara  ', ok: 'Ana Clara' },
  { id: 'ok-pt', input: 'João_123', ok: 'João_123' },
  { id: 'ok-nfc', input: 'Jose\u{301}', ok: 'José' },
  { id: 'ok-vi', input: 'Nguyễn', ok: 'Nguyễn' },
  { id: 'ok-vi-decomposed', input: 'Nguye\u{302}\u{303}n', ok: 'Nguyễn' },
  { id: 'ok-hindi', input: 'क\u{943}ष\u{94D}ण\u{93E}', ok: 'क\u{943}ष\u{94D}ण\u{93E}' },
  { id: 'ok-hindi-conjunct', input: 'लक\u{94D}ष\u{94D}म\u{940}', ok: 'लक\u{94D}ष\u{94D}म\u{940}' },
  { id: 'ok-bengali', input: 'স\u{9CC}ম\u{9BF}ত\u{9CD}র', ok: 'স\u{9CC}ম\u{9BF}ত\u{9CD}র' },
  { id: 'ok-tamil', input: 'க\u{BBE}ர\u{BCD}த\u{BCD}த\u{BBF}க\u{BCD}', ok: 'க\u{BBE}ர\u{BCD}த\u{BCD}த\u{BBF}க\u{BCD}' },
  { id: 'ok-thai', input: 'ท\u{E35}\u{E48}ร\u{E31}ก', ok: 'ท\u{E35}\u{E48}ร\u{E31}ก' },
  { id: 'ok-arabic-harakat', input: 'م\u{64F}ح\u{64E}م\u{64E}\u{651}د', ok: 'م\u{64F}ح\u{64E}م\u{64E}\u{651}د' },
  { id: 'ok-japanese', input: 'アナ', ok: 'アナ' },
  { id: 'ok-japanese-mixed', input: '山田たろう', ok: '山田たろう' },
  { id: 'ok-korean', input: '김민준', ok: '김민준' },
  { id: 'ok-cyrillic', input: 'Иван', ok: 'Иван' },
  { id: 'ok-greek', input: 'Νίκος', ok: 'Νίκος' },
  { id: 'ok-digits', input: 'ana2', ok: 'ana2' },
  { id: 'ok-latin-plus-han', input: 'Ana山', ok: 'Ana山' },
  { id: 'ok-max', input: 'a'.repeat(24), ok: 'a'.repeat(24) },
  { id: 'empty', input: '   ', ok: null, code: 'nickname.empty' },
  { id: 'short', input: 'A', ok: null, code: 'nickname.tooShort' },
  { id: 'long', input: 'a'.repeat(25), ok: null, code: 'nickname.tooLong' },
  { id: 'long-10k', input: 'a'.repeat(10_000), ok: null, code: 'nickname.tooLong' },
  { id: 'bytes', input: '가'.repeat(22), ok: null, code: 'nickname.tooLong' },
  { id: 'bytes-ok', input: '가'.repeat(21), ok: '가'.repeat(21) },
  { id: 'emoji', input: 'Ana😀', ok: null, code: 'nickname.chars' },
  { id: 'emoji-only', input: '👩\u{200D}👩\u{200D}👧\u{200D}👦👩\u{200D}👩\u{200D}👧\u{200D}👦', ok: null, code: 'nickname.chars' },
  { id: 'symbol', input: 'Ana♥', ok: null, code: 'nickname.chars' },
  { id: 'punct', input: 'Ana!', ok: null, code: 'nickname.chars' },
  { id: 'only-punct', input: '_._', ok: null, code: 'nickname.chars' },
  { id: 'zw-3', input: '\u{3164}\u{3164}', ok: null, code: 'nickname.chars' },
  { id: 'hangul-filler', input: 'Ana\u{3164}', ok: null, code: 'nickname.chars' },
  { id: 'hangul-filler-2', input: '\u{115F}\u{1160}', ok: null, code: 'nickname.chars' },
  { id: 'hangul-filler-3', input: 'ab\u{FFA0}', ok: null, code: 'nickname.chars' },
  { id: 'zwj', input: 'An\u{200D}a', ok: null, code: 'nickname.chars' },
  { id: 'zwnj', input: 'An\u{200C}a', ok: null, code: 'nickname.chars' },
  { id: 'zwsp', input: 'An\u{200B}a', ok: null, code: 'nickname.chars' },
  { id: 'vs', input: 'Ana\u{FE0F}', ok: null, code: 'nickname.chars' },
  { id: 'tag', input: 'Ana\u{E0041}', ok: null, code: 'nickname.chars' },
  { id: 'bidi-2', input: 'Mark\u{202E}kram', ok: null, code: 'nickname.chars' },
  { id: 'bidi-mark', input: 'Ana\u{200F}', ok: null, code: 'nickname.chars' },
  { id: 'nul', input: 'An\u0000a', ok: null, code: 'nickname.chars' },
  { id: 'lone-surrogate', input: 'Ana\uD800', ok: null, code: 'nickname.chars' },
  { id: 'pua', input: 'Ana\u{E000}', ok: null, code: 'nickname.chars' },
  { id: 'unassigned', input: 'Ana\u{378}', ok: null, code: 'nickname.chars' },
  { id: 'fullwidth', input: 'ａｎａ', ok: null, code: 'nickname.chars' },
  { id: 'superscript', input: 'ana²', ok: null, code: 'nickname.chars' },
  { id: 'zalgo', input: 'Z\u{300}\u{301}\u{302}algo', ok: null, code: 'nickname.marks' },
  { id: 'zalgo-long', input: 'A' + '\u0301\u0300'.repeat(15) + 'na', ok: null, code: 'nickname.marks' },
  { id: 'zalgo-random', input: zalgo('Ana', 30, 3), ok: null, code: 'nickname.chars' },
  { id: 'mark-first', input: '\u{301}ana', ok: null, code: 'nickname.chars' },
  { id: 'mark-after-space', input: 'ana \u{301}b', ok: null, code: 'nickname.chars' },
  { id: 'homo-1', input: 'Ѕtreamer', ok: null, code: 'nickname.mixed' },
  { id: 'mixed-cyrillic', input: 'Аnа', ok: null, code: 'nickname.mixed' },
  { id: 'mixed-greek', input: 'Anaα', ok: null, code: 'nickname.mixed' },
  { id: 'reserved', input: 'Streamer', ok: null, code: 'nickname.reserved' },
  { id: 'reserved-pt', input: 'transmissão', ok: null, code: 'nickname.reserved' },
  { id: 'reserved-spaced', input: 'Swarm Cast', ok: null, code: 'nickname.reserved' },
  { id: 'crash-telugu', input: 'జ\u{C4D}ఞ\u{200C}\u{C3E}', ok: null, code: 'nickname.chars' },
  { id: 'newline', input: 'Ana\nClara', ok: 'Ana Clara' },
  { id: 'nbsp', input: 'Ana\u{A0}Clara', ok: 'Ana Clara' },
];
