import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHAT_BG_DARK, CHAT_BG_LIGHT, contrastRatio, defaultChatSettings, type ChatCounters, type ChatPublicSettings } from '@swarmcast/shared';
import {
  CONTENT_PRESETS,
  chatStatus,
  draftLength,
  feedBackground,
  isMuted,
  messageTokens,
  mutedText,
  parseBlockedWords,
  presetNeedsGifs,
  presetOf,
  readableName,
  sameSettings,
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
    for (const p of CONTENT_PRESETS) expect(presetOf(p.content)).toBe(p.id);
    expect(presetOf({ text: true, emotes: false, gifs: true })).toBeNull();
  });
  it('the default settings are "text + emotes" (GIFs off by default)', () => {
    expect(presetOf(defaultChatSettings().content)).toBe('textEmotes');
  });
  it('only presets with GIFs need a key', () => {
    expect(CONTENT_PRESETS.filter((p) => presetNeedsGifs(p.id)).map((p) => p.id)).toEqual(['all', 'gifs']);
  });
});

describe('status pill', () => {
  it('off, on, slow mode, automatic slow mode, lockdown and broken', () => {
    expect(chatStatus(false, eff(), counters()).key).toBe('admin.chat.status.off');
    expect(chatStatus(true, eff({ slowS: 0 }), counters())).toMatchObject({ key: 'admin.chat.status.on', tone: 'ok' });
    expect(chatStatus(true, eff({ slowS: 2 }), counters())).toMatchObject({ key: 'admin.chat.status.slow', params: { count: 2 } });
    expect(chatStatus(true, eff({ slowS: 10, autoSlow: true }), counters())).toMatchObject({ key: 'admin.chat.status.autoSlow', params: { count: 10 }, tone: 'wait' });
    expect(chatStatus(true, eff(), counters({ protect: 'lockdown' }))).toMatchObject({ key: 'admin.chat.status.lockdown', tone: 'wait' });
    expect(chatStatus(true, eff(), counters({ broken: true }))).toMatchObject({ key: 'admin.chat.status.broken', tone: 'bad' });
  });
});

describe('mutes', () => {
  const clock = (at: number) => `@${at}`;
  it('"live" is muted until the stream ends; a past time is not muted', () => {
    expect(isMuted('live')).toBe(true);
    expect(isMuted(2000, 1000)).toBe(true);
    expect(isMuted(1000, 2000)).toBe(false);
    expect(isMuted(null)).toBe(false);
    expect(mutedText('live', clock)).toEqual({ key: 'admin.chat.mutedLive' });
    expect(mutedText(5000, clock, 1000)).toEqual({ key: 'admin.chat.mutedUntil', params: { clock: '@5000' } });
    expect(mutedText(500, clock, 1000)).toBeNull();
  });
});

describe('blocked words', () => {
  it('one per line, trimmed, empty lines and repeats (any case) dropped', () => {
    expect(parseBlockedWords('  spam \n\nSPAM\r\nscam\n')).toEqual({ words: ['spam', 'scam'], tooLong: [] });
  });
  it('flags entries over 40 graphemes; an emoji flag counts as one', () => {
    const long = 'a'.repeat(41);
    expect(parseBlockedWords(`${long}\nok`).tooLong).toEqual([long]);
    expect(parseBlockedWords('🇧🇷'.repeat(40)).tooLong).toEqual([]);
  });
  it('keeps at most 200 entries', () => {
    const text = Array.from({ length: 250 }, (_, i) => `w${i}`).join('\n');
    expect(parseBlockedWords(text).words).toHaveLength(200);
  });
});

describe('name colours on the panel feed', () => {
  it('any colour is readable (≥ 4.5:1) on the light and the dark feed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.boolean(), (n, dark) => {
        const hex = `#${n.toString(16).padStart(6, '0')}`;
        return contrastRatio(readableName(hex, dark), feedBackground(dark)) >= 4.5;
      }),
      { numRuns: 2000, seed: 0x5c }
    );
    expect(feedBackground(false)).toBe(CHAT_BG_LIGHT);
    expect(feedBackground(true)).toBe(CHAT_BG_DARK);
  });
});

describe('message tokens (render safety)', () => {
  it('plain text, emoji and :emote: codes; links stay plain text', () => {
    // The whole token list: the address is a plain text token (never a link token), next to an emoji and an emote.
    expect(messageTokens('oi https://x.example 😀 :gg:')).toEqual([
      { k: 't', v: 'oi https://x.example ' },
      { k: 'j', v: '😀' },
      { k: 't', v: ' ' },
      { k: 'e', code: 'gg' },
    ]);
  });
  it('text that breaks the safety invariants is not rendered (bidi override, newline, zalgo)', () => {
    expect(messageTokens('abc‮def')).toBeNull();
    expect(messageTokens('a\nb')).toBeNull();
    expect(messageTokens(`Z${'́̀̂̃̄'}`)).toBeNull();
    expect(messageTokens('\uD800')).toBeNull();
  });
});

describe('draft length and settings equality', () => {
  it('counts graphemes like the server', () => {
    expect(draftLength('🇧🇷👍🏽', 2)).toEqual({ count: 2, over: false });
    expect(draftLength('abc', 2)).toEqual({ count: 3, over: true });
  });
  it('sameSettings', () => {
    const a = defaultChatSettings();
    expect(sameSettings(a, defaultChatSettings())).toBe(true);
    expect(sameSettings(a, { ...a, slowModeS: 5 })).toBe(false);
  });
});
