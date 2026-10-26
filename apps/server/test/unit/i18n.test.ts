import { describe, expect, it } from 'vitest';
import { estimateCapacity, nicknameError } from '@swarmcast/shared';
import { formatNumber, humanDuration, isMessageKey, resolveLang, tc, translate, type MessageKey } from '@swarmcast/shared/i18n';
import { en } from '../../../../packages/shared/src/i18n/en.js';
import { ptBR } from '../../../../packages/shared/src/i18n/pt-BR.js';

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const texts = (e: string | { one: string; other: string }): string[] => (typeof e === 'string' ? [e] : [e.one, e.other]);

describe('i18n dictionaries', () => {
  it('pt-BR has every key, non-empty, with the same placeholders as English', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      const a = texts(en[key]);
      const b = texts(ptBR[key]);
      expect(b.every((s) => s.trim().length > 0), key).toBe(true);
      expect(b.map(placeholders), key).toEqual(a.map(placeholders));
    }
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
  });

  it('interpolates, pluralizes (0 uses the plural form) and formats decimals per language', () => {
    expect(translate('en', 'admin.status.live', { count: 1 })).toBe('Live: 1 viewer');
    expect(translate('en', 'admin.status.live', { count: 0 })).toBe('Live: 0 viewers');
    expect(translate('pt-BR', 'admin.status.live', { count: 1 })).toBe('Ao vivo: 1 espectador');
    expect(translate('pt-BR', 'admin.status.live', { count: 0 })).toBe('Ao vivo: 0 espectadores');
    expect(translate('en', 'admin.obs.pillSending', { mbps: 2.6 })).toBe('OBS: sending · 2.6 Mbps');
    expect(translate('pt-BR', 'admin.obs.pillSending', { mbps: 2.6 })).toBe('OBS: enviando · 2,6 Mbps');
    // Integers are never grouped (ports).
    expect(formatNumber(38080, 'en')).toBe('38080');
    // Params named *Key holding a message key are translated too.
    expect(translate('pt-BR', 'log.stepOk', { stepKey: 'step.tunnel' })).toBe('✓ Abrir o túnel seguro');
  });

  it('keeps the English texts the tests and older clients rely on', () => {
    expect(translate('en', 'viewer.err.linkInvalid')).toMatch(/no longer valid/);
    expect(translate('en', 'watch.removed.title')).toBe('You were removed');
    expect(translate('en', 'watch.live')).toBe('Live');
    expect(estimateCapacity({ uploadMbps: 100, limitMbps: 1000, bitrateKbps: 6000, p2pShare: 0, alsoStreamingElsewhere: true, viewers: 0 })).toMatchObject({
      code: 'capacity.ok',
      params: { count: 10 },
      message: 'Your internet can handle about 10 viewers directly from your PC.',
    });
  });

  it('picks pt-BR from the first "pt*" browser language, honors an override', () => {
    expect(resolveLang(['pt-BR', 'en'])).toBe('pt-BR');
    expect(resolveLang(['en-US', 'pt'])).toBe('pt-BR');
    expect(resolveLang(['en-US', 'de'])).toBe('en');
    expect(resolveLang([])).toBe('en');
    expect(resolveLang(['pt-BR'], 'en')).toBe('en');
    expect(resolveLang(['en'], 'pt-br')).toBe('pt-BR');
    expect(resolveLang(['en'], 'xx')).toBe('en');
  });

  it('translates coded server texts and falls back to the English text for unknown codes', () => {
    expect(tc({ code: 'nope.unknown' }, 'English fallback')).toBe('English fallback');
    expect(tc(undefined, 'x')).toBe('x');
    expect(isMessageKey('step.server')).toBe(true);
    expect(isMessageKey('toString')).toBe(false);
  });

  it('maps nickname validation messages to codes', () => {
    expect(nicknameError('Please choose a nickname.')).toMatchObject({ code: 'nickname.empty' });
    expect(nicknameError('Use at most 24 characters.')).toMatchObject({ code: 'nickname.tooLong', params: { max: 24 } });
    expect(nicknameError('something else')).toMatchObject({ code: 'viewer.err.invalidNickname', text: 'Invalid nickname.' });
  });

  it('formats durations in human terms', () => {
    expect(humanDuration(30_000, 'en')).toBe('less than a minute');
    expect(humanDuration(61_000, 'en')).toBe('2 minutes');
    expect(humanDuration(60 * 60_000, 'pt-BR')).toBe('1 hora');
    expect(humanDuration(65 * 60_000, 'en')).toBe('1 h 5 min');
  });
});
