// @vitest-environment happy-dom
// The join page's branding start (branding/loader.ts startJoinBranding): the page shows
// (body.brand-known) once the branding is in or failed, or after JOIN_BRAND_WAIT_MS, and branding
// that comes after that may not change the layout. startBrand is a fake whose refresh the test
// settles; time is Vitest's fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOIN_BRAND_WAIT_MS, startJoinBranding, type StartBrand } from '../../src/branding/loader.js';

/**
 * A fake startBrand: its refresh waits for `apply()` (the branding answer) or `fail()`, and
 * `layoutOpen()` says whether startBrand's canChangeLayout allowed the layout when it was applied.
 */
function fakeBranding() {
  let settle: () => void = () => {};
  let reject: (err: Error) => void = () => {};
  let canChangeLayout: () => boolean = () => true;
  const refreshing = new Promise<void>((resolve, rej) => {
    settle = resolve;
    reject = rej;
  });
  let appliedWithLayout: boolean | null = null;
  const startBrand = ((_page: string, o: { canChangeLayout?: () => boolean }) => {
    canChangeLayout = o.canChangeLayout ?? (() => true);
    return { refresh: () => refreshing.then(() => void (appliedWithLayout = canChangeLayout())) };
  }) as unknown as StartBrand;
  return { startBrand, apply: () => settle(), fail: () => reject(new Error('offline')), layoutOpen: () => appliedWithLayout };
}

const shown = (): boolean => document.body.classList.contains('brand-known');

describe('startJoinBranding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.className = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not show the page while its branding is on the way', async () => {
    // Arrange
    const b = fakeBranding();

    // Act
    void startJoinBranding({ loadStartBrand: async () => b.startBrand });
    await vi.advanceTimersByTimeAsync(JOIN_BRAND_WAIT_MS - 1);

    // Assert
    expect(shown()).toBe(false);
  });

  it('shows the page once the branding is in, which could still change the layout', async () => {
    // Arrange
    const b = fakeBranding();
    const showing = startJoinBranding({ loadStartBrand: async () => b.startBrand });

    // Act
    b.apply();
    await showing;

    // Assert
    expect(shown()).toBe(true);
    expect(b.layoutOpen()).toBe(true);
  });

  it(`shows the stock page after ${JOIN_BRAND_WAIT_MS} ms; branding later than that may not change the layout`, async () => {
    // Arrange
    const b = fakeBranding();
    void startJoinBranding({ loadStartBrand: async () => b.startBrand });

    // Act
    await vi.advanceTimersByTimeAsync(JOIN_BRAND_WAIT_MS);
    b.apply();
    await vi.waitFor(() => expect(b.layoutOpen()).not.toBeNull());

    // Assert
    expect(shown()).toBe(true);
    expect(b.layoutOpen()).toBe(false);
  });

  it('shows the page at once when the branding chunk does not load, and says why', async () => {
    // Arrange
    const debug = vi.fn();

    // Act
    await startJoinBranding({ loadStartBrand: () => Promise.reject(new Error('chunk offline')), debug });

    // Assert
    expect(shown()).toBe(true);
    expect(debug).toHaveBeenCalledWith('branding: Error: chunk offline');
  });

  it('shows the page at once when the branding answer fails', async () => {
    // Arrange
    const b = fakeBranding();
    const showing = startJoinBranding({ loadStartBrand: async () => b.startBrand, debug: () => {} });

    // Act
    b.fail();
    await showing;

    // Assert
    expect(shown()).toBe(true);
  });
});
