import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_PIN_MAX_MIN, chatPinSchema, contrastRatio, defaultChatSettings, type ChatCounters, type ChatPublicSettings } from '@swarmcast/shared';
import { setLang, t } from '@swarmcast/shared/i18n';
import {
  CONTENT_PRESETS,
  chatColumnShown,
  chatStatus,
  draftLength,
  feedBackground,
  isMuted,
  messageTokens,
  mutedText,
  parseBlockedWords,
  PIN_CHOICES,
  presetNeedsGifs,
  presetOf,
  readableName,
  sameSettings,
  systemText,
} from '../../src/chat/logic.js';

const eff = (o: Partial<ChatPublicSettings> = {}): ChatPublicSettings => ({
  enabled: true,
  content: ['text', 'emotes'],
  slowS: 2,
  autoSlow: false,
  maxGraphemes: 200,
  maxEmoji: 30,
  newViewerWaitS: 0,
  colors: 'choose',
  linksBlocked: false,
  emotes: [],
  builtinEmotes: true,
  protect: 'off',
  streamerName: '',
  ...o,
});
const counters = (o: Partial<ChatCounters> = {}): ChatCounters => ({ acceptedPerMin: 0, rejectedPerMin: 0, skipped: 0, globalPerS: 5, egressKbps: 0, budgetKbps: 128, guard: 'ok', protect: 'off', broken: false, ...o });

describe('content presets (modes)', () => {
  it('every preset is recognised from its own mix; other mixes are "custom"', () => {
    // Act
    const recognised = CONTENT_PRESETS.map((p) => presetOf(p.content));
    const custom = presetOf({ text: true, emotes: false, gifs: true });
    // Assert
    expect(recognised).toEqual(CONTENT_PRESETS.map((p) => p.id));
    expect(custom).toBeNull();
  });

  it('the default settings are "text + emotes" (GIFs off by default)', () => {
    // Act
    const preset = presetOf(defaultChatSettings().content);
    // Assert
    expect(preset).toBe('textEmotes');
  });

  it('only presets with GIFs need a key', () => {
    // Act
    const needKey = CONTENT_PRESETS.filter((p) => presetNeedsGifs(p.id)).map((p) => p.id);
    // Assert
    expect(needKey).toEqual(['all', 'gifs']);
  });
});

describe('live chat column', () => {
  it.each([
    ['off', true, false],
    ['starting', true, false],
    ['waiting-obs', true, false],
    ['live', true, true],
    ['live', false, false],
    ['stopping', true, false],
  ] as const)('phase %s with the chat on = %s: shown = %s', (phase, chatEnabled, shown) => {
    // Act
    const result = chatColumnShown(phase, chatEnabled);
    // Assert
    expect(result).toBe(shown);
  });
});

describe('status pill', () => {
  it('off, on, slow mode, automatic slow mode, lockdown and broken', () => {
    // Act
    const pills = [
      chatStatus(false, eff(), counters()),
      chatStatus(true, eff({ slowS: 0 }), counters()),
      chatStatus(true, eff({ slowS: 2 }), counters()),
      chatStatus(true, eff({ slowS: 10, autoSlow: true }), counters()),
      chatStatus(true, eff(), counters({ protect: 'lockdown' })),
      chatStatus(true, eff(), counters({ broken: true })),
    ];
    // Assert
    expect(pills).toMatchObject([
      { key: 'admin.chat.status.off' },
      { key: 'admin.chat.status.on', tone: 'ok' },
      { key: 'admin.chat.status.slow', params: { count: 2 } },
      { key: 'admin.chat.status.autoSlow', params: { count: 10 }, tone: 'wait' },
      { key: 'admin.chat.status.lockdown', tone: 'wait' },
      { key: 'admin.chat.status.broken', tone: 'bad' },
    ]);
  });
});

describe('mutes', () => {
  const clock = (at: number) => `@${at}`;

  it('"live" is muted until the stream ends; a past time is not muted', () => {
    // Act
    const muted = [isMuted('live'), isMuted(2000, 1000), isMuted(1000, 2000), isMuted(null)];
    const texts = [mutedText('live', clock), mutedText(5000, clock, 1000), mutedText(500, clock, 1000)];
    // Assert
    expect(muted).toEqual([true, true, false, false]);
    expect(texts).toEqual([{ key: 'admin.chat.mutedLive' }, { key: 'admin.chat.mutedUntil', params: { clock: '@5000' } }, null]);
  });
});

describe('blocked words', () => {
  it('one per line, trimmed, empty lines and repeats (any case) dropped', () => {
    // Act
    const parsed = parseBlockedWords('  spam \n\nSPAM\r\nscam\n');
    // Assert
    expect(parsed).toEqual({ words: ['spam', 'scam'], tooLong: [] });
  });

  it('flags entries over 40 graphemes; an emoji flag counts as one', () => {
    // Arrange
    const long = 'a'.repeat(41);
    // Act
    const flagged = parseBlockedWords(`${long}\nok`).tooLong;
    const flags = parseBlockedWords('🇧🇷'.repeat(40)).tooLong;
    // Assert
    expect(flagged).toEqual([long]);
    expect(flags).toEqual([]);
  });

  it('keeps at most 200 entries', () => {
    // Arrange
    const text = Array.from({ length: 250 }, (_, i) => `w${i}`).join('\n');
    // Act
    const { words } = parseBlockedWords(text);
    // Assert
    expect(words).toHaveLength(200);
  });
});

describe('name colours on the panel feed', () => {
  it('any colour is readable (≥ 4.5:1) on the light and the dark feed', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.boolean(), (n, dark) => {
          const hex = `#${n.toString(16).padStart(6, '0')}`;
          return contrastRatio(readableName(hex, dark), feedBackground(dark)) >= 4.5;
        }),
        { numRuns: 2000, seed: 0x5c },
      );
    // Assert
    expect(run).not.toThrow();
    expect([feedBackground(false), feedBackground(true)]).toEqual([CHAT_BG_LIGHT, CHAT_BG_DARK]);
  });
});

describe('message tokens (render safety)', () => {
  it('plain text, emoji and :emote: codes; an address stays a plain text token, never a link', () => {
    // Act
    const tokens = messageTokens('oi https://x.example 😀 :gg:');
    // Assert
    expect(tokens).toEqual([
      { k: 't', v: 'oi https://x.example ' },
      { k: 'j', v: '😀' },
      { k: 't', v: ' ' },
      { k: 'e', code: 'gg' },
    ]);
  });

  it('text that breaks the safety invariants is not rendered (bidi override, newline, zalgo, lone surrogate)', () => {
    // Act
    const rendered = ['abc\u202Edef', 'a\nb', `Z${'\u0301\u0300\u0302\u0303\u0304'}`, '\uD800'].map(messageTokens);
    // Assert
    expect(rendered).toEqual([null, null, null, null]);
  });
});

describe('draft length and settings equality', () => {
  it('counts graphemes like the server', () => {
    // Act
    const lengths = [draftLength('🇧🇷👍🏽', 2), draftLength('abc', 2)];
    // Assert
    expect(lengths).toEqual([{ count: 2, over: false }, { count: 3, over: true }]);
  });

  it('sameSettings', () => {
    // Arrange
    const a = defaultChatSettings();
    // Act
    const same = [sameSettings(a, defaultChatSettings()), sameSettings(a, { ...a, slowModeS: 5 })];
    // Assert
    expect(same).toEqual([true, false]);
  });
});

describe('system lines', () => {
  it('a known code is translated; one this panel does not know (a newer server) gives a neutral line', () => {
    // Arrange
    const known = { k: 'sys', s: 1, at: 1, code: 'chat.sys.muted', params: { nickname: 'Ana', minutes: 10 } } as const;
    const future = { k: 'sys', s: 2, at: 1, code: 'chat.sys.pollStarted' } as unknown as Parameters<typeof systemText>[0];
    // Act
    const texts = [systemText(known), systemText(future)];
    // Assert
    expect(texts).toEqual(['Ana was muted for 10 min.', 'Something changed in the chat that this page cannot show. Reload the page to see it.']);
  });
});

describe('pin choices', () => {
  it('"until I unpin it" first, then lengths the server accepts, each with its own words in both languages', () => {
    // Arrange
    const labels = (lang: 'en' | 'pt-BR') => {
      setLang(lang);
      return PIN_CHOICES.map((c) => t(c.key, c.params));
    };
    // Act
    const en = labels('en');
    const pt = labels('pt-BR');
    setLang('en');
    // Assert
    expect(PIN_CHOICES[0]!.minutes).toBeNull();
    for (const c of PIN_CHOICES) expect(chatPinSchema.safeParse({ s: 1, minutes: c.minutes }).success).toBe(true);
    expect(PIN_CHOICES.every((c) => c.minutes === null || (c.minutes >= 1 && c.minutes <= CHAT_PIN_MAX_MIN))).toBe(true);
    expect(en).toEqual(['Until I unpin it', 'For 5 min', 'For 15 min', 'For 1 hour']);
    expect(pt).toEqual(['Até eu desafixar', 'Por 5 min', 'Por 15 min', 'Por 1 hora']);
  });
});
