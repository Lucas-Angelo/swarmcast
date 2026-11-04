// The panel's setting forms keep what the streamer changes from their first render on. Each form
// holds its own copy of the saved settings and takes the saved ones again when they change; that
// copy has to be taken in the commit, before any click can reach the form, never in a useEffect,
// which Preact runs only after the next frame (or a 35 ms timer) and which then put the saved
// value back over a click made in the meantime. The forms are never saved here: nothing on the
// shared e2e server changes.
import { clickOnFirstRender, expect, openPanel, test } from './fixtures.js';

test('Protection: a switch clicked the moment the card appears stays as clicked', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const clicked = await clickOnFirstRender(page, 'sec-blockKnownBadIps');

  // Act
  await openPanel(page);
  const { before, after } = await clicked();

  // Assert
  expect(after).toBe(!before);
  await expect(page.getByTestId('sec-blockKnownBadIps')).toBeChecked({ checked: !before });
});

test('Network settings: a box clicked the moment the form appears stays as clicked', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const clicked = await clickOnFirstRender(page, 'show-viewer-count');

  // Act
  await openPanel(page);
  const { before, after } = await clicked();

  // Assert
  expect(after).toBe(!before);
  await expect(page.getByTestId('show-viewer-count')).toBeChecked({ checked: !before });
});

test('Chat settings: a box clicked the moment the form appears stays as clicked', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const clicked = await clickOnFirstRender(page, 'chat-viewer-colors');

  // Act
  await openPanel(page);
  const { before, after } = await clicked();

  // Assert
  expect(after).toBe(!before);
  await expect(page.getByTestId('chat-viewer-colors')).toBeChecked({ checked: !before });
  await expect(page.getByTestId('chat-save')).toBeEnabled();
});

test('Chat settings: a number typed fast keeps every digit', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await openPanel(page);
  const field = page.getByTestId('chat-new-wait');
  await expect(field).toBeVisible();

  // Act: type "123" one key at a time, each key on what the box shows, with Preact's render
  // (a microtask) after every key but no frame in between, as fast typing on a busy page can.
  const shown = await field.evaluate(async (el: HTMLInputElement) => {
    const key = async (next: string): Promise<void> => {
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    await key('');
    for (const digit of '123') await key(el.value + digit);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    return el.value;
  });

  // Assert
  expect(shown).toBe('123');
  await expect(field).toHaveValue('123');
  await expect(page.getByTestId('chat-save')).toBeEnabled();
});
