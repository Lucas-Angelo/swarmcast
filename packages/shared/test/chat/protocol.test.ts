import { describe, expect, it } from 'vitest';
import {
  CHAT_FRAME_PREFIX,
  CHAT_REJECT_CODES,
  chatSettingsSchema,
  clientMessageSchema,
  defaultChatSettings,
  type ChatServerMessage,
  type ServerMessage,
} from '@swarmcast/shared';
import { isMessageKey, translate } from '@swarmcast/shared/i18n';

/**
 * Frozen wire examples (plan §4.7): a change that breaks the chat wire format fails here and has
 * to bump CHAT_PROTOCOL_VERSION on purpose.
 */
describe('chat protocol: client → server', () => {
  const parse = (raw: string) => clientMessageSchema.safeParse(JSON.parse(raw));

  it('accepts the frozen frames', () => {
    for (const raw of [
      '{"t":"chat.send","n":1,"text":"boa noite chat 😀"}',
      '{"t":"chat.send","n":2147483647,"gif":{"p":"klipy","id":"AbC_12-x","w":200,"h":150,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp"}}',
      '{"t":"chat.send","n":3,"gif":{"p":"klipy","id":"x","w":220,"h":220,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp","hi":2}}',
      '{"t":"chat.send","n":4,"gif":{"p":"giphy","id":"abc","w":200,"h":200,"m":"/media/v1.Y2lkPTc5MGI3NjEx/3o7TKSjRrfIPjeiVyM/200.webp","hi":1}}',
      '{"t":"chat.color","color":"#E5484D"}',
      '{"t":"chat.resume","after":0}',
      '{"t":"chat.resume","after":4711}',
    ]) {
      expect(raw.startsWith(CHAT_FRAME_PREFIX), raw).toBe(true);
      expect(parse(raw).success, raw).toBe(true);
    }
  });

  it('lower-cases colours', () => {
    const r = parse('{"t":"chat.color","color":"#E5484D"}');
    expect(r.success && r.data.t === 'chat.color' && r.data.color).toBe('#e5484d');
  });

  it('refuses malformed or hostile frames (exactly one of text or gif, bounds, no URLs)', () => {
    for (const raw of [
      '{"t":"chat.send","n":1}',
      '{"t":"chat.send","n":1,"text":"a","gif":{"p":"klipy","id":"x","w":20,"h":20}}',
      '{"t":"chat.send","n":0,"text":"a"}',
      '{"t":"chat.send","n":2147483648,"text":"a"}',
      '{"t":"chat.send","n":1.5,"text":"a"}',
      `{"t":"chat.send","n":1,"text":"${'a'.repeat(1501)}"}`,
      '{"t":"chat.send","n":1,"text":{"__proto__":1}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"https://evil.example/x.gif","w":20,"h":20}}',
      '{"t":"chat.send","n":1,"gif":{"p":"tenor","id":"abc","w":20,"h":20}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":2000,"h":20}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":20,"h":20,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp","url":"https://x"}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":20,"h":20}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":20,"h":20,"m":"https://evil.example/x.gif"}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":20,"h":20,"m":"/ii/../../x.svg"}}',
      '{"t":"chat.send","n":1,"gif":{"p":"klipy","id":"abc","w":20,"h":20,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp","hi":3}}',
      '{"t":"chat.send","n":1,"gif":{"p":"giphy","id":"abc","w":20,"h":20,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp"}}',
      '{"t":"chat.color","color":"red"}',
      '{"t":"chat.color","color":"#12345"}',
      '{"t":"chat.color","color":"url(javascript:1)"}',
      '{"t":"chat.resume","after":-1}',
      '{"t":"chat.unknown"}',
    ]) {
      expect(parse(raw).success, raw).toBe(false);
    }
  });

  it('keeps the old control messages working', () => {
    expect(parse('{"t":"pong"}').success).toBe(true);
  });
});

describe('chat protocol: server → client', () => {
  it('has the frozen compact shapes', () => {
    const batch: ChatServerMessage = {
      t: 'chat.batch',
      items: [
        { k: 'u', au: { a: 'k1f', n: 'Ana', c: '#e5484d', r: 'viewer' } },
        { k: 'm', s: 4711, at: 1761770012345, a: 'k1f', x: 'boa noite chat 😀' },
        { k: 'd', s: [4700] },
        { k: 'clr', s: 4711 },
        { k: 'sys', s: 4712, at: 1761770012999, code: 'chat.sys.protect' },
        { k: 'skip', n: 3 },
      ],
    };
    expect(JSON.stringify(batch.items[1])).toBe('{"k":"m","s":4711,"at":1761770012345,"a":"k1f","x":"boa noite chat 😀"}');
    const ack: ServerMessage = { t: 'chat.ack', n: 7, s: 4711 };
    const reject: ServerMessage = { t: 'chat.reject', n: 8, code: 'chat.err.slow', params: { count: 2 }, retryMs: 1500 };
    expect(JSON.stringify(ack)).toBe('{"t":"chat.ack","n":7,"s":4711}');
    expect(JSON.stringify(reject)).toBe('{"t":"chat.reject","n":8,"code":"chat.err.slow","params":{"count":2},"retryMs":1500}');
  });

  it('every reject code is a translated message key', () => {
    for (const code of CHAT_REJECT_CODES) {
      expect(isMessageKey(code), code).toBe(true);
      expect(translate('pt-BR', code, { count: 2, max: 200, allowedKey: 'chat.content.e' })).not.toBe(translate('en', code, { count: 2, max: 200, allowedKey: 'chat.content.e' }));
    }
  });
});

describe('chat settings', () => {
  it('has the decided defaults: on, GIFs off, slow mode 2 s, 200 characters', () => {
    const d = defaultChatSettings();
    expect(d).toMatchObject({
      enabled: true,
      content: { text: true, emotes: true, gifs: false },
      slowModeS: 2,
      maxGraphemes: 200,
      maxEmoji: 30,
      historyOnJoin: 50,
      links: 'text',
      autoProtect: true,
      budgetShare: 0.05,
      gif: { provider: 'klipy', key: '', rating: 'pg', consent: 'ask' },
    });
  });

  it('refuses no content at all, bad ranges and bad keys', () => {
    expect(chatSettingsSchema.safeParse({ content: { text: false, emotes: false, gifs: false } }).success).toBe(false);
    expect(chatSettingsSchema.safeParse({ slowModeS: 301 }).success).toBe(false);
    expect(chatSettingsSchema.safeParse({ maxGraphemes: 19 }).success).toBe(false);
    expect(chatSettingsSchema.safeParse({ gif: { key: 'short' } }).success).toBe(false);
    expect(chatSettingsSchema.safeParse({ gif: { key: 'abc/def?x=1' } }).success).toBe(false);
    expect(chatSettingsSchema.safeParse({ gif: { key: 'Abcdefgh_123-xyz' } }).success).toBe(true);
    // Every viewer must agree before their browser contacts the GIF provider: no automatic mode.
    expect(chatSettingsSchema.safeParse({ gif: { consent: 'auto' } }).success).toBe(false);
    expect(chatSettingsSchema.parse({ gif: { consent: 'ask' } }).gif.consent).toBe('ask');
  });
});
