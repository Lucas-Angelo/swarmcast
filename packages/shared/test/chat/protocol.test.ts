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
const ACCEPTED_FRAMES = [
  '{"t":"chat.send","n":1,"text":"boa noite chat 😀"}',
  '{"t":"chat.send","n":2147483647,"gif":{"p":"klipy","id":"AbC_12-x","w":200,"h":150,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp"}}',
  '{"t":"chat.send","n":3,"gif":{"p":"klipy","id":"x","w":220,"h":220,"m":"/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp","hi":2}}',
  '{"t":"chat.send","n":4,"gif":{"p":"giphy","id":"abc","w":200,"h":200,"m":"/media/v1.Y2lkPTc5MGI3NjEx/3o7TKSjRrfIPjeiVyM/200.webp","hi":1}}',
  '{"t":"chat.color","color":"#E5484D"}',
  '{"t":"chat.resume","after":0}',
  '{"t":"chat.resume","after":4711}',
];

/** Malformed or hostile frames: exactly one of text or gif, bounds, no URLs. */
const REFUSED_FRAMES = [
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
];

const parse = (raw: string) => clientMessageSchema.safeParse(JSON.parse(raw));

describe('chat protocol: client → server', () => {
  it('accepts the frozen frames', () => {
    // Act
    const results = ACCEPTED_FRAMES.map((raw) => ({ raw, prefixed: raw.startsWith(CHAT_FRAME_PREFIX), ok: parse(raw).success }));
    // Assert
    expect(results).toEqual(ACCEPTED_FRAMES.map((raw) => ({ raw, prefixed: true, ok: true })));
  });

  it('lower-cases colours', () => {
    // Act
    const r = parse('{"t":"chat.color","color":"#E5484D"}');
    // Assert
    expect(r.success && r.data.t === 'chat.color' && r.data.color).toBe('#e5484d');
  });

  it('refuses malformed or hostile frames (exactly one of text or gif, bounds, no URLs)', () => {
    // Act
    const accepted = REFUSED_FRAMES.filter((raw) => parse(raw).success);
    // Assert
    expect(accepted).toEqual([]);
  });

  it('keeps the old control messages working', () => {
    // Act
    const pong = parse('{"t":"pong"}');
    // Assert
    expect(pong.success).toBe(true);
  });
});

describe('chat protocol: server → client', () => {
  it('has the frozen compact shapes', () => {
    // Arrange
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
    const ack: ServerMessage = { t: 'chat.ack', n: 7, s: 4711 };
    const reject: ServerMessage = { t: 'chat.reject', n: 8, code: 'chat.err.slow', params: { count: 2 }, retryMs: 1500 };
    // Act
    const wire = [JSON.stringify(batch.items[1]), JSON.stringify(ack), JSON.stringify(reject)];
    // Assert
    expect(wire).toEqual([
      '{"k":"m","s":4711,"at":1761770012345,"a":"k1f","x":"boa noite chat 😀"}',
      '{"t":"chat.ack","n":7,"s":4711}',
      '{"t":"chat.reject","n":8,"code":"chat.err.slow","params":{"count":2},"retryMs":1500}',
    ]);
  });

  it('every reject code is a translated message key', () => {
    // Arrange
    const params = { count: 2, max: 200, allowedKey: 'chat.content.e' } as const;
    // Act
    const texts = CHAT_REJECT_CODES.map((code) => ({ code, key: isMessageKey(code), translated: translate('pt-BR', code, params) !== translate('en', code, params) }));
    // Assert
    expect(texts).toEqual(CHAT_REJECT_CODES.map((code) => ({ code, key: true, translated: true })));
  });
});

describe('chat settings', () => {
  it('has the decided defaults: on, GIFs off, slow mode 2 s, 200 characters', () => {
    // Act
    const d = defaultChatSettings();
    // Assert
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

  it('refuses no content at all, bad ranges and bad keys; GIFs need every viewer to agree first (no automatic consent)', () => {
    // Arrange
    const inputs = [
      { content: { text: false, emotes: false, gifs: false } },
      { slowModeS: 301 },
      { maxGraphemes: 19 },
      { gif: { key: 'short' } },
      { gif: { key: 'abc/def?x=1' } },
      { gif: { key: 'Abcdefgh_123-xyz' } },
      { gif: { consent: 'auto' } },
    ];
    // Act
    const valid = inputs.map((i) => chatSettingsSchema.safeParse(i).success);
    const consent = chatSettingsSchema.parse({ gif: { consent: 'ask' } }).gif.consent;
    // Assert
    expect(valid).toEqual([false, false, false, false, false, true, false]);
    expect(consent).toBe('ask');
  });
});
