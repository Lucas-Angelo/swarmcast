// @mentions (chat/mentions.ts, docs/CHAT.md "Replies and mentions"): what counts as a mention of
// whom, the keys a message sends, and the @ list (query at the caret, suggestions, insertion).
import { describe, expect, it } from 'vitest';
import { applyMention, CHAT_MENTION_SUGGESTIONS, CHAT_MENTIONS_MAX, findMentionSpans, mentionKeys, mentionQuery, suggestMentions } from '@swarmcast/shared';

const ana = { a: '1', n: 'Ana' };
const anaMaria = { a: '2', n: 'Ana Maria' };
const joao = { a: '3', n: 'João' };
const bia = { a: '4', n: 'Bia_2' };
/** Right-to-left (Hebrew) and Arabic names. */
const dana = { a: '5', n: '\u{5D3}\u{5E0}\u{5D4}' };
const sara = { a: '6', n: '\u{633}\u{627}\u{631}\u{627}' };
const ALL = [ana, anaMaria, joao, bia, dana, sara];

const spans = (text: string, people = ALL) => findMentionSpans(text, people).map((s) => ({ a: s.a, at: text.slice(s.start, s.end) }));

describe('findMentionSpans', () => {
  it('finds "@Name" of the people given, left to right', () => {
    // Act
    const found = spans('@Ana oi, @João tudo bem?');

    // Assert
    expect(found).toEqual([
      { a: '1', at: '@Ana' },
      { a: '3', at: '@João' },
    ]);
  });

  it('the longest name wins: "Ana Maria" is not "Ana" followed by text', () => {
    // Act
    const found = spans('@Ana Maria e @Ana');

    // Assert
    expect(found).toEqual([
      { a: '2', at: '@Ana Maria' },
      { a: '1', at: '@Ana' },
    ]);
  });

  it('never inside a word: an e-mail address, a longer name, an underscore or digit after it', () => {
    // Act
    const found = ['ana@Ana.com', '@Anabela', '@Ana_x', '@Ana2', 'x@João'].map((t) => spans(t));

    // Assert
    expect(found).toEqual([[], [], [], [], []]);
  });

  it('punctuation, emoji and the end of the text end a name', () => {
    // Act
    const found = ['@Ana!', '(@Ana)', '@Ana,', '@Ana😀', '@Ana'].map((t) => spans(t).map((s) => s.at));

    // Assert
    expect(found).toEqual([['@Ana'], ['@Ana'], ['@Ana'], ['@Ana'], ['@Ana']]);
  });

  it('never in the middle of a grapheme: a mark or a joiner after the name belongs to its last letter', () => {
    // Act
    const found = ['@Ana\u{301}', '@Bia_2\u{FE0F}\u{20E3}', '@Ana\u{200D}x'].map((t) => spans(t));

    // Assert
    expect(found).toEqual([[], [], []]);
  });

  it('exact names only: a look-alike (Cyrillic А), another case or missing accents mention nobody', () => {
    // Act
    const found = ['@\u{410}na', '@ana', '@ANA', '@Joao'].map((t) => spans(t));

    // Assert
    expect(found).toEqual([[], [], [], []]);
  });

  it('right-to-left names, also next to left-to-right text', () => {
    // Act
    const found = spans(`hi @${dana.n} and @${sara.n}!`);

    // Assert
    expect(found.map((s) => s.a)).toEqual(['5', '6']);
  });

  it('nothing for no "@", no people, or people without a name', () => {
    // Act
    const found = [spans('Ana'), spans('@Ana', []), spans('@Ana', [{ a: '9', n: '' }])];

    // Assert
    expect(found).toEqual([[], [], []]);
  });

  it('works through many "@" and many look-alike names (no backtracking blow-up)', () => {
    // Arrange
    const people = Array.from({ length: 500 }, (_, i) => ({ a: i.toString(36), n: `Aa${i}` }));
    const text = '@A'.repeat(750);

    // Act
    const found = findMentionSpans(text, people);

    // Assert
    expect(found).toEqual([]);
  });
});

describe('mentionKeys', () => {
  it('distinct keys in order, never the sender, at most CHAT_MENTIONS_MAX', () => {
    // Act
    const keys = mentionKeys('@Ana @Ana @João @Bia_2 @Ana Maria', ALL, '3');

    // Assert
    expect(keys).toEqual(['1', '4', '2']);
    expect(mentionKeys(`@Ana @João @Bia_2 @${dana.n} @${sara.n}`, ALL)).toHaveLength(CHAT_MENTIONS_MAX);
  });

  it('a name that was picked and then deleted is not sent', () => {
    // Act
    const keys = mentionKeys('@Ana', [ana]).concat(mentionKeys('oi', [ana]));

    // Assert
    expect(keys).toEqual(['1']);
  });
});

describe('mentionQuery', () => {
  it('the name being typed after an "@" at the caret', () => {
    // Act
    const q = [mentionQuery('oi @An', 6), mentionQuery('@', 1), mentionQuery('@Ana M', 6), mentionQuery('oi @Ana tudo', 7)];

    // Assert
    expect(q).toEqual([{ start: 3, prefix: 'An' }, { start: 0, prefix: '' }, { start: 0, prefix: 'Ana M' }, { start: 3, prefix: 'Ana' }]);
  });

  it('none: no "@" before the caret, an "@" inside a word, a name already completed with a space, or too long a query', () => {
    // Act
    const q = [mentionQuery('oi Ana', 6), mentionQuery('a@b', 3), mentionQuery('@Ana ', 5), mentionQuery(`@${'x'.repeat(65)}`, 66), mentionQuery('', 0), mentionQuery('@Ana', 9)];

    // Assert
    expect(q).toEqual([null, null, null, null, null, null]);
  });
});

describe('suggestMentions', () => {
  it('ignores case, accents and separators; exact starts first, then the caller order (newest writer first)', () => {
    // Arrange: newest writers first.
    const recent = [joao, anaMaria, ana, bia];

    // Act
    const a = suggestMentions('An', recent).map((c) => c.n);
    const j = suggestMentions('joao', recent).map((c) => c.n);
    const spaced = suggestMentions('ana m', recent).map((c) => c.n);
    const all = suggestMentions('', recent).map((c) => c.n);

    // Assert
    expect(a).toEqual(['Ana Maria', 'Ana']);
    expect(j).toEqual(['João']);
    expect(spaced).toEqual(['Ana Maria']);
    expect(all).toEqual(['João', 'Ana Maria', 'Ana', 'Bia_2']);
  });

  it(`at most ${CHAT_MENTION_SUGGESTIONS}`, () => {
    // Arrange
    const people = Array.from({ length: 30 }, (_, i) => ({ a: String(i), n: `Ana${i}` }));

    // Act
    const out = suggestMentions('ana', people);

    // Assert
    expect(out).toHaveLength(CHAT_MENTION_SUGGESTIONS);
  });
});

describe('applyMention', () => {
  it('replaces the query with "@Name " and puts the caret after it', () => {
    // Act
    const mid = applyMention('oi @An tudo', 3, 6, 'Ana Maria');
    const end = applyMention('oi @a', 3, 5, 'Ana');

    // Assert
    expect(mid).toEqual({ text: 'oi @Ana Maria tudo', caret: 14 });
    expect(end).toEqual({ text: 'oi @Ana ', caret: 8 });
  });
});
