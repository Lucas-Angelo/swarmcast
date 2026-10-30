import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Texts the desktop section and the tutorial show. */
const DESKTOP_KEYS = ['desktop.title', 'desktop.autostart', 'desktop.autostart.tip', 'desktop.update.available', 'desktop.update.now', 'desktop.update.liveWarn', 'onb.sys.checking', 'quality.install.retry', 'quality.install.retrying'];

// The store is module state the panel shares: every test leaves it empty.
afterEach(() => setDesktop(null));

describe('desktop app state', () => {
  it('only a real desktop answer counts (script mode, older servers and errors do not)', () => {
    // Act
    const answers = [isDesktopInfo(info()), isDesktopInfo({ desktop: false }), isDesktopInfo(null)];
    // Assert
    expect(answers).toEqual([true, false, false]);
  });

  it('loads the state with GET /api/desktop, and hides the section in script mode, on older servers and on errors', async () => {
    // Arrange
    const get = vi.fn(async () => info());
    // Act
    const loaded = await loadDesktop(get);
    const script = await loadDesktop(async () => ({ desktop: false }));
    const failed = await loadDesktop(async () => Promise.reject(new Error('404')));
    // Assert
    expect(get).toHaveBeenCalledWith(DESKTOP_API, 'GET');
    expect(loaded).toEqual(info());
    expect(script).toBeNull();
    expect(failed).toBeNull();
  });

  it('the store keeps the last state', () => {
    // Act
    setDesktop(info({ version: '9' }));
    // Assert
    expect(getDesktop()?.version).toBe('9');
  });

  it('update banner: available (with the live warning), downloading %, installing, failed install; a failed check (offline) only shows in the card', () => {
    // Act
    const banners = [
      updateBanner(null, 'off'),
      updateBanner({ status: 'none' }, 'off'),
      updateBanner({ status: 'available', version: '0.3.0', current: '0.2.0', notes: '  Fixes \n' }, 'live'),
      updateBanner({ status: 'available', version: '0.3.0', notes: ' ' }, 'off'),
      updateBanner({ status: 'available' }, 'off'),
      updateBanner({ status: 'downloading', version: '0.3.0', progress: 0.424 }, 'off'),
      updateBanner({ status: 'downloading' }, 'off'),
      updateBanner({ status: 'installing', version: '0.3.0' }, 'off'),
      updateBanner({ status: 'error', version: '0.3.0', error: 'bad signature' }, 'waiting-obs'),
      updateBanner({ status: 'error', error: 'offline' }, 'off'),
    ];
    // Assert
    expect(banners[0]).toBeNull();
    expect(banners[1]).toBeNull();
    expect(banners[2]).toEqual({ kind: 'available', version: '0.3.0', current: '0.2.0', notes: 'Fixes', liveOn: true });
    expect(banners[3]).toMatchObject({ liveOn: false, notes: undefined });
    expect(banners[4]).toBeNull();
    expect(banners[5]).toEqual({ kind: 'downloading', version: '0.3.0', percent: 42 });
    expect(banners[6]).toMatchObject({ percent: null });
    expect(banners[7]).toEqual({ kind: 'installing', version: '0.3.0' });
    expect(banners[8]).toEqual({ kind: 'error', version: '0.3.0', error: 'bad signature', liveOn: true });
    expect(banners[9]).toBeNull();
  });

  it('"Check for updates" status line', () => {
    // Act
    const views = [
      checkView(info({ updateChecking: true, update: { status: 'none' } })),
      checkView(info({ update: { status: 'none' } })),
      checkView(info({ update: { status: 'available', version: '1' } })),
      checkView(info({ update: { status: 'downloading' } })),
      checkView(info({ update: { status: 'error', error: 'x' } })),
      checkView(info()),
    ];
    // Assert
    expect(views).toEqual(['checking', 'upToDate', 'available', 'busy', 'error', 'unknown']);
  });

  it('video converter install state for the tutorial', () => {
    // Act
    const states = [
      converterInstall(null),
      converterInstall({ install: null }),
      converterInstall({ install: { phase: 'done' } }),
      converterInstall({ install: { phase: 'downloading', receivedBytes: 1 } }),
      converterInstall({ install: { phase: 'verifying' } }),
      converterInstall({ install: { phase: 'retrying', attempt: 2, attempts: 4 } }),
      converterInstall({ install: { phase: 'error', message: 'x' } }),
    ];
    // Assert
    expect(states).toEqual([null, null, null, 'installing', 'installing', 'retrying', 'failed']);
  });

  it('every desktop text exists in the dictionaries', () => {
    // Act
    const missing = DESKTOP_KEYS.filter((k) => !isMessageKey(k));
    // Assert
    expect(missing).toEqual([]);
  });
});
