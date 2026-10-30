import { describe, expect, it } from 'vitest';
import { canonicalizeChatText, checkChatInvariants, joinRequestSchema, nicknameError, validateNickname } from '@swarmcast/shared';
import { UCD_SHA256, UCD_VERSION } from '@swarmcast/shared/chat/ucd';
import { CONFUSABLES_SHA256 } from '../../src/chat/confusables.generated.js';
import pins from '../../../../scripts/build/unicode-data.json' with { type: 'json' };
import { CORPUS, NICKNAME_CORPUS } from './corpus.js';

type Entry = (typeof CORPUS)[number];
type Accepted = Entry & { expect: { ok: true } };
type Rejected = Entry & { expect: { ok: false; code: string } };

const accepted = CORPUS.filter((e): e is Accepted => e.expect.ok);
const rejected = CORPUS.filter((e): e is Rejected => !e.expect.ok);
const exact = accepted.filter((e) => 'text' in e.expect);
const checked = accepted.filter((e) => 'check' in e.expect);
const accepting = NICKNAME_CORPUS.filter((n) => n.ok !== null);
const refusing = NICKNAME_CORPUS.filter((n) => n.ok === null);
const caseName = (e: { id: string; source?: string; input: string }): string => (e.source ? `${e.id} (${e.source})` : `${e.id}: ${JSON.stringify(e.input).slice(0, 40)}`);

/** Unsafe text the client never renders. */
const UNSAFE = ['a\u{202E}b', 'a\u{200B}b', 'a\nb', 'a\uD800', 'e\u{301}\u{301}', 'e\u{300}\u{301}\u{302}\u{303}\u{304}', 'a\u0000', '\u{3164}x', 'x'.repeat(1501)];

describe('Unicode data', () => {
  it('matches the runtime and the pinned files', () => {
    // Act
    const shas = Object.entries(UCD_SHA256).map(([f, sha]) => ({ f, sha, pinned: pins.files[f as keyof typeof pins.files].sha256 }));
    // Assert
    expect(UCD_VERSION).toBe(process.versions.unicode);
    expect(pins.version).toBe(UCD_VERSION);
    for (const { f, sha, pinned } of shas) expect(sha, f).toBe(pinned);
    expect(CONFUSABLES_SHA256).toBe(pins.files['confusables.txt'].sha256);
  });
});

describe('chat text pipeline: corpus', () => {
  it.each(rejected.map((e) => [caseName(e), e] as const))('%s is refused with its code', (_name, e) => {
    // Act
    const r = canonicalizeChatText(e.input, e.opts);
    // Assert
    expect(r.ok ? `ok: ${JSON.stringify(r.text)}` : r.code).toBe(e.expect.code);
  });

  it.each(exact.map((e) => [caseName(e), e] as const))('%s comes out as expected', (_name, e) => {
    // Act
    const r = canonicalizeChatText(e.input, e.opts);
    // Assert
    expect(r.ok && r.text).toBe('text' in e.expect ? e.expect.text : null);
  });

  it.each(checked.map((e) => [caseName(e), e] as const))('%s passes its check', (_name, e) => {
    // Act
    const r = canonicalizeChatText(e.input, e.opts);
    // Assert
    expect(r.ok).toBe(true);
    expect(r.ok && 'check' in e.expect && e.expect.check(r.text), 'check' in e.expect ? e.expect.note : '').toBe(true);
  });

  it.each(accepted.map((e) => [caseName(e), e] as const))("%s: the server's output passes the client's check and is stable", (_name, e) => {
    // Arrange
    const first = canonicalizeChatText(e.input, e.opts);
    if (!first.ok) throw new Error(`rejected ${first.code}`);
    // Act
    const again = canonicalizeChatText(first.text, e.opts);
    // Assert
    expect(checkChatInvariants(first.text, e.opts)).toBe(true);
    expect(again.ok && again.text).toBe(first.text);
  });

  it('norm-1: decomposed and composed forms give the same text', () => {
    // Act
    const a = canonicalizeChatText('cafe\u{301}');
    const b = canonicalizeChatText('café');
    // Assert
    expect(a.ok && b.ok && a.text === b.text).toBe(true);
  });

  it('counts graphemes, not code units', () => {
    // Act
    const r = canonicalizeChatText('👩\u{200D}👩\u{200D}👧\u{200D}👦é');
    // Assert
    expect(r).toMatchObject({ ok: true, graphemes: 2, emoji: 1 });
  });

  it('passes the limits as params for the translated reject text', () => {
    // Act
    const tooLong = canonicalizeChatText('a'.repeat(21), { maxGraphemes: 20 });
    const tooManyEmoji = canonicalizeChatText('😀😀', { maxEmoji: 1 });
    // Assert
    expect(tooLong).toMatchObject({ ok: false, code: 'text.tooLong', params: { max: 20 } });
    expect(tooManyEmoji).toMatchObject({ ok: false, code: 'text.tooManyEmoji', params: { max: 1 } });
  });

  it('checkChatInvariants refuses unsafe text', () => {
    // Act
    const passed = UNSAFE.filter((bad) => checkChatInvariants(bad));
    const safe = checkChatInvariants('ok 😀 é');
    // Assert
    expect(passed).toEqual([]);
    expect(safe).toBe(true);
  });
});

describe('nicknames v2', () => {
  it.each(accepting.map((n) => [caseName(n), n] as const))('%s', (_name, n) => {
    // Act
    const r = validateNickname(n.input);
    // Assert
    expect(r).toEqual({ ok: true, value: n.ok });
  });

  it.each(refusing.map((n) => [caseName(n), n] as const))('%s', (_name, n) => {
    // Act
    const r = validateNickname(n.input);
    // Assert
    expect(r.ok ? `ok: ${r.value}` : r.code).toBe(n.code);
  });

  it('the zod schema uses the same rules and maps errors back to codes', () => {
    // Arrange
    const refusals = [
      ['A', 'nickname.tooShort'],
      ['Ana😀', 'nickname.chars'],
      ['Ѕtreamer', 'nickname.mixed'],
      ['admin', 'nickname.reserved'],
      ['', 'nickname.empty'],
    ] as const;
    // Act
    const trimmed = joinRequestSchema.parse({ nickname: '  Nguyễn  ' });
    const codes = refusals.map(([input]) => {
      const r = joinRequestSchema.safeParse({ nickname: input });
      return { input, success: r.success, code: nicknameError(r.error?.issues[0]?.message).code };
    });
    const notAString = joinRequestSchema.safeParse({ nickname: 42 }).success;
    // Assert
    expect(trimmed).toEqual({ nickname: 'Nguyễn' });
    expect(codes).toEqual(refusals.map(([input, code]) => ({ input, success: false, code })));
    expect(notAString).toBe(false);
  });

  it("refuses the streamer's own chat name as an extra reserved name", () => {
    // Act
    const r = validateNickname('Lucas Live', { reserved: ['lucas-live'] });
    // Assert
    expect(r).toMatchObject({ ok: false, code: 'nickname.reserved' });
  });
});
