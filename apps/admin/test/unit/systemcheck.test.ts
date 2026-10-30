import { afterEach, describe, expect, it } from 'vitest';
import { isMessageKey, setLang } from '@swarmcast/shared/i18n';
import { belowMinimum, CHECK_IDS, checkRow, checkRows, loadSystemCheck, translateValue, type SystemCheck } from '../../src/onboarding/systemcheck.js';

const base: SystemCheck = {
  version: 1,
  at: '2026-10-25T18:00:00Z',
  os: 'Windows 11',
  arch: 'x64',
  results: [],
  belowMinimum: [],
};

// The panel's language is module state (the whole panel follows it): tests that switch it set it
// in Arrange, and every test leaves it in English.
afterEach(() => setLang('en'));

describe('installer system check rows', () => {
  it('shows ✓ with value and targets, no advice, for passing checks', () => {
    // Act
    const r = checkRow({ id: 'ram', status: 'ok', value: '16 GB', min: '4 GB', recommended: '8 GB' });
    // Assert
    expect(r).toMatchObject({ icon: '✓', label: 'Memory (RAM)', value: '16 GB', target: 'minimum 4 GB · recommended 8 GB', advice: null });
  });

  it('gives a plain-language "what to do" for warn/fail', () => {
    // Act
    const upload = checkRow({ id: 'upload', status: 'fail', value: '3 Mbps', min: '5 Mbps' });
    const advice = { obs: checkRow({ id: 'obs', status: 'fail', value: 'not found' }).advice, ports: checkRow({ id: 'ports', status: 'warn', value: '1935 busy' }).advice, cpu: checkRow({ id: 'cpu', status: 'warn' }).advice };
    const ramWarning = checkRow({ id: 'ram', status: 'warn' });
    // Assert
    expect(upload).toMatchObject({ icon: '✗', target: 'minimum 5 Mbps', advice: expect.stringMatching(/P2P/) });
    expect(advice.obs).toContain('from obsproject.com');
    expect(advice.ports).toMatch(/Close it/);
    expect(advice.cpu).toMatch(/Close other programs/);
    expect(ramWarning.icon).toBe('⚠');
  });

  it('skipped and unknown checks degrade gracefully', () => {
    // Act
    const skipped = checkRow({ id: 'disk', status: 'skipped', value: '?', min: '2 GB' });
    const unknown = checkRow({ id: 'gpu', status: 'warn', value: 'old' });
    const yes = checkRow({ id: 'obs', status: 'ok', value: true });
    // Assert
    expect(skipped).toMatchObject({ icon: '–', value: 'Not checked', target: null, advice: null });
    expect(unknown.label).toBe('gpu');
    expect(unknown.advice).toMatch(/may still work/);
    expect(yes.value).toBe('✓');
  });

  it('orders rows like the installer', () => {
    // Arrange
    const c = { ...base, results: [{ id: 'obs', status: 'ok' as const }, { id: 'os', status: 'ok' as const }, { id: 'x', status: 'ok' as const }] };
    // Act
    const ids = checkRows(c).map((r) => r.id);
    // Assert
    expect(ids).toEqual(['os', 'obs', 'x']);
  });

  it('translates labels and targets (pt-BR)', () => {
    // Arrange
    setLang('pt-BR');
    // Act
    const r = checkRow({ id: 'ram', status: 'warn', min: '4 GB', recommended: '8 GB' });
    // Assert
    expect(r).toMatchObject({ label: 'Memória (RAM)', target: 'mínimo 4 GB · recomendado 8 GB' });
  });

  it('every check id has a label and advice text', () => {
    // Act
    const missing = CHECK_IDS.flatMap((id) => [`onb.sys.id.${id}`, `onb.sys.fix.${id}`]).filter((k) => !isMessageKey(k));
    // Assert
    expect(missing).toEqual([]);
  });

  it('shows the "below minimum" banner only when needed', () => {
    // Act
    const banners = [belowMinimum(base), belowMinimum({ ...base, belowMinimum: ['upload'] }), belowMinimum({ ...base, results: [{ id: 'ram', status: 'fail' }] }), belowMinimum({ ...base, results: [{ id: 'ram', status: 'warn' }] })];
    // Assert
    expect(banners).toEqual([false, true, true, false]);
  });

  it('falls back (null) when the server has no system check', async () => {
    // Act
    const loaded = [
      await loadSystemCheck(async () => base),
      await loadSystemCheck(async () => {
        throw new Error('404');
      }),
      await loadSystemCheck(async () => ({ error: 'x' })),
    ];
    // Assert
    expect(loaded).toEqual([base, null, null]);
  });
});

describe('check values', () => {
  it('are translated by check id (pt-BR); numbers and unknown values are shown as written', () => {
    // Arrange
    setLang('pt-BR');
    // Act
    const values = [
      checkRow({ id: 'ports', status: 'ok', value: 'free' }).value,
      checkRow({ id: 'ports', status: 'warn', value: 'in use: 8080 1935' }).value,
      checkRow({ id: 'obs', status: 'ok', value: 'installed' }).value,
      checkRow({ id: 'obs', status: 'warn', value: 'not found' }).value,
      checkRow({ id: 'github', status: 'ok', value: 'reachable' }).value,
      checkRow({ id: 'github', status: 'warn', value: 'unreachable (not needed)' }).value,
      checkRow({ id: 'release', status: 'ok', value: 'reachable (latest v0.2.1)' }).value,
      checkRow({ id: 'release', status: 'ok', value: 'v0.2.1 (desktop app)' }).value,
      checkRow({ id: 'upload', status: 'warn', value: 'speed test failed' }).value,
      checkRow({ id: 'ram', status: 'ok', value: '16 GB' }).value,
      translateValue('mystery', 'free'),
    ];
    // Assert
    expect(values).toEqual(['livres', 'em uso: 8080 1935', 'instalado', 'não encontrado', 'acessível', 'inacessível (não é necessário)', 'acessível (última v0.2.1)', 'v0.2.1 (app para computador)', 'o teste de velocidade falhou', '16 GB', 'free']);
  });

  it('are shown as written in English', () => {
    // Act
    const values = [checkRow({ id: 'github', status: 'ok', value: 'reachable' }).value, checkRow({ id: 'ports', status: 'ok', value: 'free' }).value];
    // Assert
    expect(values).toEqual(['reachable', 'free']);
  });
});
