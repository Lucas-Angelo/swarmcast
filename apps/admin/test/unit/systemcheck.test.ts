import { afterEach, describe, expect, it } from 'vitest';
import { isMessageKey, setLang } from '@swarmcast/shared/i18n';
import { belowMinimum, CHECK_IDS, checkRow, checkRows, loadSystemCheck, type SystemCheck } from '../../src/onboarding/systemcheck.js';

const base: SystemCheck = {
  version: 1,
  at: '2026-10-25T18:00:00Z',
  os: 'Windows 11',
  arch: 'x64',
  results: [],
  belowMinimum: [],
};

afterEach(() => setLang('en'));

describe('installer system check rows', () => {
  it('shows ✓ with value and targets, no advice, for passing checks', () => {
    const r = checkRow({ id: 'ram', status: 'ok', value: '16 GB', min: '4 GB', recommended: '8 GB' });
    expect(r).toMatchObject({ icon: '✓', label: 'Memory (RAM)', value: '16 GB', target: 'minimum 4 GB · recommended 8 GB', advice: null });
  });

  it('gives a plain-language "what to do" for warn/fail', () => {
    const up = checkRow({ id: 'upload', status: 'fail', value: '3 Mbps', min: '5 Mbps' });
    expect(up.icon).toBe('✗');
    expect(up.target).toBe('minimum 5 Mbps');
    expect(up.advice).toMatch(/P2P/);
    expect(checkRow({ id: 'obs', status: 'fail', value: 'not found' }).advice).toMatch(/obsproject\.com/);
    expect(checkRow({ id: 'ports', status: 'warn', value: '1935 busy' }).advice).toMatch(/Close it/);
    expect(checkRow({ id: 'cpu', status: 'warn' }).advice).toMatch(/Close other programs/);
    expect(checkRow({ id: 'ram', status: 'warn' }).icon).toBe('⚠');
  });

  it('skipped and unknown checks degrade gracefully', () => {
    expect(checkRow({ id: 'disk', status: 'skipped', value: '?', min: '2 GB' })).toMatchObject({ icon: '–', value: 'Not checked', target: null, advice: null });
    const unknown = checkRow({ id: 'gpu', status: 'warn', value: 'old' });
    expect(unknown.label).toBe('gpu');
    expect(unknown.advice).toMatch(/may still work/);
    expect(checkRow({ id: 'obs', status: 'ok', value: true }).value).toBe('✓');
  });

  it('orders rows like the installer and translates labels (pt-BR)', () => {
    const c = { ...base, results: [{ id: 'obs', status: 'ok' as const }, { id: 'os', status: 'ok' as const }, { id: 'x', status: 'ok' as const }] };
    expect(checkRows(c).map((r) => r.id)).toEqual(['os', 'obs', 'x']);
    setLang('pt-BR');
    expect(checkRow({ id: 'ram', status: 'warn', min: '4 GB', recommended: '8 GB' })).toMatchObject({ label: 'Memória (RAM)', target: 'mínimo 4 GB · recomendado 8 GB' });
  });

  it('every check id has a label and advice text', () => {
    for (const id of CHECK_IDS) {
      expect(isMessageKey(`onb.sys.id.${id}`)).toBe(true);
      expect(isMessageKey(`onb.sys.fix.${id}`)).toBe(true);
    }
  });

  it('shows the "below minimum" banner only when needed', () => {
    expect(belowMinimum(base)).toBe(false);
    expect(belowMinimum({ ...base, belowMinimum: ['upload'] })).toBe(true);
    expect(belowMinimum({ ...base, results: [{ id: 'ram', status: 'fail' }] })).toBe(true);
    expect(belowMinimum({ ...base, results: [{ id: 'ram', status: 'warn' }] })).toBe(false);
  });

  it('falls back (null) when the server has no system check', async () => {
    expect(await loadSystemCheck(async () => base)).toEqual(base);
    expect(
      await loadSystemCheck(async () => {
        throw new Error('404');
      }),
    ).toBeNull();
    expect(await loadSystemCheck(async () => ({ error: 'x' }))).toBeNull();
  });
});
