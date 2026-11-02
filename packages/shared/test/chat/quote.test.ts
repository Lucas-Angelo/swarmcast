// The quote of a reply (chat/quote.ts, docs/CHAT.md "Replies and mentions"): the start of a
// message, cut only between graphemes, within the grapheme and byte caps, and always text the client
// renders (checkChatInvariants). The hostile corpus runs through it; the generated inputs are in
// properties.test.ts (P13).
import { describe, expect, it } from 'vitest';
import { canonicalizeChatText, checkChatInvariants, CHAT_REPLY_QUOTE_MAX_BYTES, CHAT_REPLY_QUOTE_MAX_GRAPHEMES, cutQuote, graphemes, utf8Length } from '@swarmcast/shared';
import { CORPUS } from './corpus.js';

const FAMILY = '\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
const FLAG_BR = '\u{1F1E7}\u{1F1F7}';
const KEYCAP = '1\u{FE0F}\u{20E3}';

/** The quote is the first graphemes of `text`, whole. */
function isGraphemePrefix(q: string, text: string): boolean {
  const all = graphemes(text);
  const head = graphemes(q);
  return head.every((g, i) => g === all[i]);
}

describe('cutQuote', () => {
  it('keeps a short message whole, with nothing left out', () => {
    // Act
    const r = cutQuote('boa noite!');

    // Assert
    expect(r).toEqual({ q: 'boa noite!', cut: false });
  });

  it(`cuts after ${CHAT_REPLY_QUOTE_MAX_GRAPHEMES} graphemes and drops the space the cut left at the end`, () => {
    // Arrange
    const text = `${'abcd '.repeat(8)}rest of the message`;

    // Act
    const r = cutQuote(text);

    // Assert
    expect(r.cut).toBe(true);
    expect(r.q).toBe('abcd abcd abcd abcd abcd abcd abcd abcd');
    expect(graphemes(r.q).length).toBeLessThanOrEqual(CHAT_REPLY_QUOTE_MAX_GRAPHEMES);
  });

  it('never splits an emoji ZWJ sequence, a flag, a keycap or a letter and its marks', () => {
    // Arrange: each unit is one grapheme of several code points, placed across the 40th grapheme.
    const units = [FAMILY, FLAG_BR, KEYCAP, 'e\u{301}\u{302}', '\u{915}\u{94D}\u{937}'];

    for (const unit of units) {
      const text = 'x'.repeat(CHAT_REPLY_QUOTE_MAX_GRAPHEMES - 1) + unit + unit;

      // Act
      const r = cutQuote(text);

      // Assert
      expect(r.q, JSON.stringify(unit)).toBe('x'.repeat(CHAT_REPLY_QUOTE_MAX_GRAPHEMES - 1) + unit);
      expect(r.cut).toBe(true);
    }
  });

  it(`stops at ${CHAT_REPLY_QUOTE_MAX_BYTES} UTF-8 bytes on a grapheme boundary (long emoji sequences)`, () => {
    // Arrange: a family is 25 bytes, so 6 of them (150) fit and the 7th does not.
    const text = FAMILY.repeat(10);

    // Act
    const r = cutQuote(text);

    // Assert
    expect(r.q).toBe(FAMILY.repeat(6));
    expect(utf8Length(r.q)).toBeLessThanOrEqual(CHAT_REPLY_QUOTE_MAX_BYTES);
    expect(r.cut).toBe(true);
  });

  it('keeps no surrogate half: astral characters at the cut stay whole', () => {
    // Arrange
    const text = '𝒜'.repeat(60);

    // Act
    const r = cutQuote(text);

    // Assert
    expect(r.q).toBe('𝒜'.repeat(CHAT_REPLY_QUOTE_MAX_GRAPHEMES));
    expect(r.q.isWellFormed()).toBe(true);
  });

  it('bidi text and zero-width joiners: the quote is still text the client renders', () => {
    // Arrange: right-to-left with implicit marks, and Persian with a ZWNJ inside a word.
    const inputs = ['\u{5E9}\u{5DC}\u{5D5}\u{5DD} abc \u{200F}123\u{200E} '.repeat(6), 'می\u{200C}خواهم '.repeat(10)];

    for (const input of inputs) {
      const c = canonicalizeChatText(input);
      if (!c.ok) throw new Error(`not accepted: ${c.code}`);

      // Act
      const r = cutQuote(c.text);

      // Assert
      expect(checkChatInvariants(r.q, { maxGraphemes: CHAT_REPLY_QUOTE_MAX_GRAPHEMES, maxBytes: CHAT_REPLY_QUOTE_MAX_BYTES })).toBe(true);
      expect(isGraphemePrefix(r.q, c.text)).toBe(true);
    }
  });

  it('the hostile corpus: every accepted text gives a quote that passes the client check and is a grapheme prefix', () => {
    // Arrange
    const texts = CORPUS.map((e) => canonicalizeChatText(e.input, e.opts)).flatMap((r) => (r.ok ? [r.text] : []));
    expect(texts.length).toBeGreaterThan(20);

    for (const text of texts) {
      // Act
      const r = cutQuote(text);

      // Assert
      expect(checkChatInvariants(r.q, { maxGraphemes: CHAT_REPLY_QUOTE_MAX_GRAPHEMES, maxBytes: CHAT_REPLY_QUOTE_MAX_BYTES }), JSON.stringify(text).slice(0, 60)).toBe(true);
      expect(text.startsWith(r.q)).toBe(true);
      expect(isGraphemePrefix(r.q, text)).toBe(true);
      expect(r.cut).toBe(r.q !== text);
    }
  });
});
