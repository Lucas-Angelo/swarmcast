// PROOF (soak branch only, never merged): the keyboard already up when the viewer taps the
// nickname field, as in Devices run 42307812551. The field is focused again once the page is
// ready; on Android the join page already has a user activation then, so Chrome raises the
// keyboard by itself. tapToType must then pass (it waits for the keyboard to be up); the
// version on main waited for the visible height to shrink across the tap and could not.
import { liveLink } from '../e2e/fixtures.js';
import { expect, test } from './fixtures.js';
import { joinPageReady, tapToType } from './phone.js';

test('proof: tapToType with the keyboard already up before the tap', { tag: '@android' }, async ({ phone }) => {
  // Arrange
  await phone.open(await liveLink());
  await expect.poll(() => phone.url()).toMatch(/\/join$/);
  await joinPageReady(phone);
  await phone.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.getElementById('nickname')!.focus();
  });
  await expect.poll(async () => (await phone.keyboardState()).includes('mInputShown=true'), { message: 'the keyboard is up before the tap' }).toBe(true);
  await expect.poll(() => phone.evaluate(() => window.innerHeight - window.visualViewport!.height), { message: 'the keyboard covers the page before the tap' }).toBeGreaterThan(150);
  // Act
  await tapToType(phone, '#nickname');
  // Assert
  expect(await phone.evaluate(() => document.activeElement?.id)).toBe('nickname');
});
