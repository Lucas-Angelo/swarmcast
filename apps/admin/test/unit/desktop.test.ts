import { describe, expect, it } from 'vitest';
import type { DesktopInfo } from '@swarmcast/shared';
import { isMessageKey } from '@swarmcast/shared/i18n';
import { checkView, DESKTOP_API, getDesktop, isDesktopInfo, loadDesktop, setDesktop, updateBanner } from '../../src/desktop.js';
import { converterInstall } from '../../src/onboarding/logic.js';

const info = (over: Partial<DesktopInfo> = {}): DesktopInfo => ({
  desktop: true,
  version: '0.2.0',
  serverVersion: '0.2.0',
  autostart: { supported: true, enabled: false },
  update: null,
  updateChecking: false,
  systemCheck: 'idle',
  ...over,
});

describe('desktop app state', () => {
  it('only a real desktop answer shows the section (script mode, older servers and errors hide it)', async () => {
    expect(isDesktopInfo(info())).toBe(true);
    expect(isDesktopInfo({ desktop: false })).toBe(false);
    expect(isDesktopInfo(null)).toBe(false);
    expect(await loadDesktop(async (p, m) => (expect([p, m]).toEqual([DESKTOP_API, 'GET']), info()))).toEqual(info());
    expect(await loadDesktop(async () => ({ desktop: false }))).toBeNull();
    expect(await loadDesktop(async () => Promise.reject(new Error('404')))).toBeNull();
    setDesktop(info({ version: '9' }));
    expect(getDesktop()?.version).toBe('9');
    setDesktop(null);
  });

  it('update banner: available (with the live warning), downloading %, installing, failed install', () => {
    expect(updateBanner(null, 'off')).toBeNull();
    expect(updateBanner({ status: 'none' }, 'off')).toBeNull();
    expect(updateBanner({ status: 'available', version: '0.3.0', current: '0.2.0', notes: '  Fixes \n' }, 'live')).toEqual({ kind: 'available', version: '0.3.0', current: '0.2.0', notes: 'Fixes', liveOn: true });
    expect(updateBanner({ status: 'available', version: '0.3.0', notes: ' ' }, 'off')).toMatchObject({ liveOn: false, notes: undefined });
    expect(updateBanner({ status: 'available' }, 'off')).toBeNull();
    expect(updateBanner({ status: 'downloading', version: '0.3.0', progress: 0.424 }, 'off')).toEqual({ kind: 'downloading', version: '0.3.0', percent: 42 });
    expect(updateBanner({ status: 'downloading' }, 'off')).toMatchObject({ percent: null });
    expect(updateBanner({ status: 'installing', version: '0.3.0' }, 'off')).toEqual({ kind: 'installing', version: '0.3.0' });
    expect(updateBanner({ status: 'error', version: '0.3.0', error: 'bad signature' }, 'waiting-obs')).toEqual({ kind: 'error', version: '0.3.0', error: 'bad signature', liveOn: true });
    // A failed check (offline) only shows in the card.
    expect(updateBanner({ status: 'error', error: 'offline' }, 'off')).toBeNull();
  });

  it('"Check for updates" status line', () => {
    expect(checkView(info({ updateChecking: true, update: { status: 'none' } }))).toBe('checking');
    expect(checkView(info({ update: { status: 'none' } }))).toBe('upToDate');
    expect(checkView(info({ update: { status: 'available', version: '1' } }))).toBe('available');
    expect(checkView(info({ update: { status: 'downloading' } }))).toBe('busy');
    expect(checkView(info({ update: { status: 'error', error: 'x' } }))).toBe('error');
    expect(checkView(info())).toBe('unknown');
  });

  it('video converter install state for the tutorial', () => {
    expect(converterInstall(null)).toBeNull();
    expect(converterInstall({ install: null })).toBeNull();
    expect(converterInstall({ install: { phase: 'done' } })).toBeNull();
    expect(converterInstall({ install: { phase: 'downloading', receivedBytes: 1 } })).toBe('installing');
    expect(converterInstall({ install: { phase: 'verifying' } })).toBe('installing');
    expect(converterInstall({ install: { phase: 'retrying', attempt: 2, attempts: 4 } })).toBe('retrying');
    expect(converterInstall({ install: { phase: 'error', message: 'x' } })).toBe('failed');
  });

  it('every desktop text exists in the dictionaries', () => {
    for (const k of ['desktop.title', 'desktop.autostart', 'desktop.autostart.tip', 'desktop.update.available', 'desktop.update.now', 'desktop.update.liveWarn', 'onb.sys.checking', 'quality.install.retry', 'quality.install.retrying']) {
      expect(isMessageKey(k), k).toBe(true);
    }
  });
});
