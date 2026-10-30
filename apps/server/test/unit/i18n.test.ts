import { describe, expect, it } from 'vitest';
import { estimateCapacity, nicknameError } from '@swarmcast/shared';
import { formatNumber, humanDuration, isMessageKey, resolveLang, tc, translate, type MessageKey } from '@swarmcast/shared/i18n';
import { en } from '../../../../packages/shared/src/i18n/en.js';
import { ptBR } from '../../../../packages/shared/src/i18n/pt-BR.js';

// The message dictionaries (English and Brazilian Portuguese) and the helpers around them.
// Number formats come from Intl with an explicit language, so the machine's locale never matters.

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const texts = (e: string | { one: string; other: string }): string[] => (typeof e === 'string' ? [e] : [e.one, e.other]);

/** What is wrong with the pt-BR text of `key` (an empty form, other placeholders than English), or null. */
function translationProblem(key: MessageKey): string | null {
  const pt = texts(ptBR[key]);
  if (!pt.every((s) => s.trim().length > 0)) return `${key}: empty`;
  const want = JSON.stringify(texts(en[key]).map(placeholders));
  const got = JSON.stringify(pt.map(placeholders));
  return got === want ? null : `${key}: placeholders ${got}, English has ${want}`;
}

describe('i18n dictionaries', () => {
  it('pt-BR has exactly the keys of English', () => {
    // Act
    const keys = Object.keys(ptBR).sort();
    // Assert
    expect(keys).toEqual(Object.keys(en).sort());
  });

  it('every pt-BR text is non-empty and has the placeholders of its English text', () => {
    // Act
    const problems = (Object.keys(en) as MessageKey[]).flatMap((key) => translationProblem(key) ?? []);
    // Assert
    expect(problems).toEqual([]);
  });

  it.each([
    ['en', 1, 'Live: 1 viewer'],
    ['en', 0, 'Live: 0 viewers'],
    ['pt-BR', 1, 'Ao vivo: 1 espectador'],
    ['pt-BR', 0, 'Ao vivo: 0 espectadores'],
  ] as const)('%s, %i viewers: interpolates and pluralizes (0 uses the plural form)', (lang, count, text) => {
    // Act
    const t = translate(lang, 'admin.status.live', { count });
    // Assert
    expect(t).toBe(text);
  });

  it.each([
    ['en', 'OBS: sending · 2.6 Mbps'],
    ['pt-BR', 'OBS: enviando · 2,6 Mbps'],
  ] as const)('%s formats decimals in its own way', (lang, text) => {
    // Act
    const t = translate(lang, 'admin.obs.pillSending', { mbps: 2.6 });
    // Assert
    expect(t).toBe(text);
  });

  it('never groups integers (ports)', () => {
    // Act
    const t = formatNumber(38080, 'en');
    // Assert
    expect(t).toBe('38080');
  });

  it('translates params named *Key that hold a message key', () => {
    // Act
    const t = translate('pt-BR', 'log.stepOk', { stepKey: 'step.tunnel' });
    // Assert
    expect(t).toBe('✓ Abrir o túnel seguro');
  });

  it('keeps the English texts the tests and older clients rely on', () => {
    // Act
    const capacity = estimateCapacity({ uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 });
    // Assert
    expect(translate('en', 'viewer.err.linkInvalid')).toMatch(/no longer valid/);
    expect(translate('en', 'watch.removed.title')).toBe('You were removed');
    expect(translate('en', 'watch.live')).toBe('Live');
    expect(capacity).toMatchObject({ code: 'capacity.ok', params: { count: 10 }, message: 'Your internet can handle about 10 viewers directly from your PC.' });
  });

  it.each([
    [['pt-BR', 'en'], undefined, 'pt-BR'],
    [['en-US', 'pt'], undefined, 'pt-BR'],
    [['en-US', 'de'], undefined, 'en'],
    [[], undefined, 'en'],
    [['pt-BR'], 'en', 'en'],
    [['en'], 'pt-br', 'pt-BR'],
    [['en'], 'xx', 'en'],
  ])('browser languages %j with override %s: %s (pt-BR from the first "pt*")', (langs, override, lang) => {
    // Act
    const l = resolveLang(langs, override);
    // Assert
    expect(l).toBe(lang);
  });

  it('translates coded server texts and falls back to the English text for unknown codes', () => {
    // Act
    const unknown = tc({ code: 'nope.unknown' }, 'English fallback');
    const none = tc(undefined, 'x');
    // Assert
    expect(unknown).toBe('English fallback');
    expect(none).toBe('x');
  });

  it.each([
    ['step.server', true],
    ['toString', false],
  ])('%s is a message key: %s', (key, is) => {
    // Act
    const k = isMessageKey(key);
    // Assert
    expect(k).toBe(is);
  });

  it.each([
    ['Please choose a nickname.', { code: 'nickname.empty' }],
    ['Use at most 24 characters.', { code: 'nickname.tooLong', params: { max: 24 } }],
    ['something else', { code: 'viewer.err.invalidNickname', text: 'Invalid nickname.' }],
  ])('maps the nickname message %j to a code', (message, coded) => {
    // Act
    const e = nicknameError(message);
    // Assert
    expect(e).toMatchObject(coded);
  });

  it.each([
    [30_000, 'en', 'less than a minute'],
    [61_000, 'en', '2 minutes'],
    [60 * 60_000, 'pt-BR', '1 hora'],
    [65 * 60_000, 'en', '1 h 5 min'],
  ] as const)('formats %i ms in human terms (%s): %s', (ms, lang, text) => {
    // Act
    const t = humanDuration(ms, lang);
    // Assert
    expect(t).toBe(text);
  });
});
