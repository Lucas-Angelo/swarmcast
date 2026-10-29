import { describe, expect, it } from 'vitest';
import { canonicalizeChatText, checkChatInvariants, joinRequestSchema, nicknameError, validateNickname } from '@swarmcast/shared';
import { UCD_SHA256, UCD_VERSION } from '@swarmcast/shared/chat/ucd';
import { CONFUSABLES_SHA256 } from '../../src/chat/confusables.generated.js';
import pins from '../../../../scripts/build/unicode-data.json' with { type: 'json' };
import { CORPUS, NICKNAME_CORPUS } from './corpus.js';

describe('Unicode data', () => {
  it('matches the runtime and the pinned files', () => {
    expect(UCD_VERSION).toBe(process.versions.unicode);
    expect(pins.version).toBe(UCD_VERSION);
    for (const [f, sha] of Object.entries(UCD_SHA256)) expect(sha, f).toBe(pins.files[f as keyof typeof pins.files].sha256);
    expect(CONFUSABLES_SHA256).toBe(pins.files['confusables.txt'].sha256);
  });
});

describe('chat text pipeline: corpus', () => {
  for (const e of CORPUS) {
    it(`${e.id} (${e.source})`, () => {
      const r = canonicalizeChatText(e.input, e.opts);
      if (!e.expect.ok) {
        expect(r.ok ? `ok: ${JSON.stringify(r.text)}` : r.code).toBe(e.expect.code);
        return;
      }
      if (!r.ok) throw new Error(`rejected ${r.code}`);
      if ('text' in e.expect) expect(r.text).toBe(e.expect.text);
      else expect(e.expect.check(r.text), e.expect.note).toBe(true);
      // The server's output always passes the client's check, and is stable.
      expect(checkChatInvariants(r.text, e.opts)).toBe(true);
      const again = canonicalizeChatText(r.text, e.opts);
      expect(again.ok && again.text).toBe(r.text);
    });
  }

  it('norm-1: decomposed and composed forms give the same text', () => {
    const a = canonicalizeChatText('cafe\u{301}');
    const b = canonicalizeChatText('café');
    expect(a.ok && b.ok && a.text === b.text).toBe(true);
  });

  it('counts graphemes, not code units', () => {
    const r = canonicalizeChatText('👩\u{200D}👩\u{200D}👧\u{200D}👦é');
    expect(r.ok && r.graphemes).toBe(2);
    expect(r.ok && r.emoji).toBe(1);
  });

  it('passes the limits as params for the translated reject text', () => {
    expect(canonicalizeChatText('a'.repeat(21), { maxGraphemes: 20 })).toMatchObject({ ok: false, code: 'text.tooLong', params: { max: 20 } });
    expect(canonicalizeChatText('😀😀', { maxEmoji: 1 })).toMatchObject({ ok: false, code: 'text.tooManyEmoji', params: { max: 1 } });
  });

  it('checkChatInvariants refuses unsafe text', () => {
    for (const bad of ['a\u{202E}b', 'a\u{200B}b', 'a\nb', 'a\uD800', 'e\u{301}\u{301}', 'e\u{300}\u{301}\u{302}\u{303}\u{304}', 'a\u0000', '\u{3164}x', 'x'.repeat(1501)]) {
      expect(checkChatInvariants(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(checkChatInvariants('ok 😀 é')).toBe(true);
  });
});

describe('nicknames v2', () => {
  for (const n of NICKNAME_CORPUS) {
    it(`${n.id}: ${JSON.stringify(n.input).slice(0, 40)}`, () => {
      const r = validateNickname(n.input);
      if (n.ok !== null) expect(r).toEqual({ ok: true, value: n.ok });
      else expect(r.ok ? `ok: ${r.value}` : r.code).toBe(n.code);
    });
  }

  it('the zod schema uses the same rules and maps errors back to codes', () => {
    expect(joinRequestSchema.parse({ nickname: '  Nguyễn  ' })).toEqual({ nickname: 'Nguyễn' });
    for (const [input, code] of [
      ['A', 'nickname.tooShort'],
      ['Ana😀', 'nickname.chars'],
      ['Ѕtreamer', 'nickname.mixed'],
      ['admin', 'nickname.reserved'],
      ['', 'nickname.empty'],
    ] as const) {
      const r = joinRequestSchema.safeParse({ nickname: input });
      expect(r.success).toBe(false);
      expect(nicknameError(r.error?.issues[0]?.message).code, input).toBe(code);
    }
    expect(joinRequestSchema.safeParse({ nickname: 42 }).success).toBe(false);
  });

  it('refuses the streamer\'s own chat name as an extra reserved name', () => {
    expect(validateNickname('Lucas Live', { reserved: ['lucas-live'] })).toMatchObject({ ok: false, code: 'nickname.reserved' });
  });
});
