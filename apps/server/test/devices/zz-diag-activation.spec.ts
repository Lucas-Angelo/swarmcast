// DIAGNOSTIC (soak branch only, never merged): does a focus() of the join page's nickname field
// raise the on-screen keyboard by itself, with and without a Playwright page.evaluate before it?
// page.evaluate runs with userGesture: true; phone.evaluate (AndroidPhone) goes through
// Runtime.evaluate without one. Blink's Element::Focus raises the keyboard only when the frame
// has sticky user activation; the join page's autofocus takes the same path.
import { liveLink } from '../e2e/fixtures.js';
import type { AndroidPhone } from './android.js';
import { expect, test } from './fixtures.js';
import { joinPageReady, still, type Phone } from './phone.js';

/** How long the diagnostic watches the input method service after the focus (a measured window). */
const OBSERVE_MS = 10_000;

async function snapshot(phone: Phone): Promise<string> {
  const page = await phone.evaluate(() => ({ hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive, focus: document.activeElement?.id ?? null, vvHeight: Math.round(window.visualViewport!.height), innerHeight }));
  return `${JSON.stringify(page)} ime: ${await phone.keyboardState()}`;
}

for (const gesture of [false, true]) {
  test(`diag: focus() on the join page after ${gesture ? 'one Playwright page.evaluate' : 'gesture-free reads only'}`, { tag: '@android' }, async ({ phone }) => {
    // Arrange
    await phone.open(await liveLink());
    await expect.poll(() => phone.url()).toMatch(/\/join$/);
    await joinPageReady(phone);
    await still(phone);
    const before = await snapshot(phone);
    if (gesture) await (phone as AndroidPhone).current.evaluate(() => 1);
    const afterRead = await snapshot(phone);
    // Act
    await phone.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.getElementById('nickname')!.focus();
    });
    const started = Date.now();
    let shownAfterMs: number | null = null;
    while (Date.now() - started < OBSERVE_MS) {
      if ((await phone.keyboardState()).includes('mInputShown=true')) {
        shownAfterMs = Date.now() - started;
        break;
      }
    }
    const after = await snapshot(phone);
    console.log(`[diag-activation] gesture=${gesture} keyboard shown after focus(): ${shownAfterMs === null ? `no (watched ${OBSERVE_MS} ms)` : `${shownAfterMs} ms`}\n  before: ${before}\n  after the read: ${afterRead}\n  after focus(): ${after}`);
    // Assert
    expect(shownAfterMs !== null, `keyboard raised by focus() (gesture=${gesture})`).toBe(gesture);
  });
}
