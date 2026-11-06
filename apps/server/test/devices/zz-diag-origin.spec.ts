// DIAGNOSTIC (soak branch only, never merged): when does the join page get a user activation on
// Android, with gesture-free reads only (AndroidPhone.evaluate is Runtime.evaluate without
// userGesture)? A: the link handed to Chrome as a VIEW intent (phone.open, as the suite does).
// B: the same tab then sent to /join by DevTools' Page.navigate (browser-initiated, no intent).
import { liveLink } from '../e2e/fixtures.js';
import type { AndroidPhone } from './android.js';
import { expect, test } from './fixtures.js';
import { joinPageReady, type Phone } from './phone.js';

/** How long the diagnostic samples the new document (a measured window). */
const SAMPLE_MS = 12_000;

async function sample(phone: Phone, label: string): Promise<void> {
  const started = Date.now();
  const seen: string[] = [];
  let last = '';
  while (Date.now() - started < SAMPLE_MS) {
    const s = await phone
      .evaluate(() => JSON.stringify({ path: location.pathname, rs: document.readyState, active: navigator.userActivation.hasBeenActive, transient: navigator.userActivation.isActive, focus: document.activeElement?.id ?? null, vis: document.visibilityState, hasFocus: document.hasFocus(), watch: (document.getElementById('join') as HTMLButtonElement | null)?.disabled === false }))
      .catch((e: Error) => `error ${e.message.slice(0, 80)}`);
    if (s !== last) seen.push(`+${Date.now() - started}ms ${s} ime: ${await phone.keyboardState()}`);
    last = s;
  }
  console.log(`[diag-origin] ${label}\n  ${seen.join('\n  ')}`);
}

test('diag: user activation of the join page, VIEW intent then Page.navigate', { tag: '@android' }, async ({ phone }) => {
  // Arrange
  const link = await liveLink();
  // Act
  await phone.open(link);
  await sample(phone, 'A: opened by a VIEW intent');
  await joinPageReady(phone);
  const page = (phone as AndroidPhone).current;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.navigate', { url: new URL('/join', link).toString() });
  await sample(phone, 'B: the same tab sent to /join by Page.navigate');
  // Assert
  expect(true).toBe(true);
});
