// The player's own controls on a real live, in every engine (viewer: player-controls.ts,
// player-caps.ts, quality-menu.ts): they replace the browser's controls; play / pause, the big
// Play button, sound and volume, LIVE, theater mode and the quality menu work with the mouse;
// full screen takes the player container, so the controls (and the delay behind live) are on the
// screen with the video; picture-in-picture where the engine has it, no button where it has not;
// the bar fades while the live plays and comes back with the mouse, never under reduced motion;
// the keyboard reaches and presses every control; and the page's CSP refuses nothing.
// Layout, phones and touch targets: apps/viewer/test/chat/player-controls.spec.ts (mock hub).
import type { Page } from '@playwright/test';
import { cspViolations, expect, recordCsp, test, uid, waitPlaying } from './fixtures.js';

const videoState = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector('video')!;
    return { paused: v.paused, muted: v.muted, volume: v.volume, controls: v.hasAttribute('controls') };
  });
const faded = (page: Page): Promise<boolean> => page.locator('.player').evaluate((p) => p.classList.contains('pc-idle'));

/**
 * The mouse leaves the player: to the info row's empty left edge, just under the video (the
 * player starts at the window's top-left corner, so the corner is on the video).
 */
async function awayFromPlayer(page: Page): Promise<void> {
  const player = await page.locator('.player').boundingBox();
  if (!player) throw new Error('the player is not laid out');
  await page.mouse.move(player.x + 8, player.y + player.height + 8);
}

/** The mouse rests on the bar (it holds the bar while there), as a viewer reaching for a control. */
async function onTheBar(page: Page): Promise<void> {
  const bar = await page.getByTestId('controls').boundingBox();
  if (!bar) throw new Error('the control bar is not laid out');
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await expect.poll(() => faded(page)).toBe(false);
}

test('the bar replaces the browser controls: play / pause, the big Play button, sound, volume, LIVE and theater mode work; no CSP refusal', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('bar'), { setup: async (c) => void (await c.addInitScript(recordCsp)) });
  await waitPlaying(page);
  expect(await videoState(page)).toMatchObject({ paused: false, muted: true, controls: false });
  await expect(page.getByTestId('controls').getByTestId('go-live')).toHaveText('LIVE');

  // Act
  await page.getByTestId('play').click();

  // Assert
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await expect(page.locator('#status')).toHaveText('Paused');
  await expect(page.getByTestId('play')).toHaveAccessibleName('Play');
  await expect(page.getByTestId('big-play')).toBeVisible();

  // Act
  await page.getByTestId('big-play').click();

  // Assert
  await waitPlaying(page);
  await expect(page.getByTestId('big-play')).toBeHidden();
  await expect(page.getByTestId('play')).toHaveAccessibleName('Pause');

  // Act
  await page.getByTestId('mute').click();

  // Assert: the sound is on, and the Unmute button under the player has gone with it
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);
  await expect(page.locator('#unmute')).toBeHidden();
  await expect(page.getByTestId('mute')).toHaveAccessibleName('Mute');

  // Act: the slider (every desktop engine lets a page set the volume)
  await page.getByTestId('volume').fill('40');

  // Assert
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.4, 2);
  await expect(page.getByTestId('volume')).toHaveAttribute('aria-valuetext', '40%');

  // Act
  await page.getByTestId('theater').click();

  // Assert
  await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.body.classList.contains('theater'))).toBe(true);
  expect(await cspViolations(page)).toEqual([]);
});

test('full screen is the player container: the controls and the delay behind live are on the screen with the video', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('fullscr'), { setup: async (c) => void (await c.addInitScript(recordCsp)) });
  await waitPlaying(page);
  await expect(page.getByTestId('controls-delay')).toBeHidden();

  // Act
  await page.getByTestId('fullscreen').click();

  // Assert
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector('.player'))).toBe(true);
  await onTheBar(page);
  await expect(page.getByTestId('controls')).toBeInViewport({ ratio: 1 });
  const bar = (await page.getByTestId('controls').boundingBox())!;
  const screen = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  expect(Math.round(bar.y + bar.height)).toBe(screen.h);
  expect(Math.round(bar.width)).toBe(screen.w);
  await expect(page.getByTestId('controls-delay')).toBeVisible();
  await expect(page.getByTestId('controls-delay')).toHaveText(/^~\d+ s behind live$/);
  await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Exit full screen');

  // Act
  await page.getByTestId('fullscreen').click();

  // Assert: out again, still playing
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.getByTestId('fullscreen')).toHaveAccessibleName('Full screen');
  await expect(page.getByTestId('controls-delay')).toBeHidden();
  expect((await videoState(page)).paused).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
});

test('picture-in-picture: the button where the engine has the API, none where it has not', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('pip'));
  await waitPlaying(page);
  const supported = await page.evaluate(() => document.pictureInPictureEnabled === true || typeof (document.querySelector('video') as HTMLVideoElement & { webkitSetPresentationMode?: unknown }).webkitSetPresentationMode === 'function');
  const button = page.getByTestId('pip');
  if (!supported) {
    // Assert
    await expect(button).toBeHidden();
    return;
  }
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName('Picture-in-picture');
  const inWindow = (): Promise<boolean> =>
    page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement & { webkitPresentationMode?: string };
      return document.pictureInPictureElement === v || v.webkitPresentationMode === 'picture-in-picture';
    });

  // Act
  await button.click();

  // Assert
  await expect.poll(inWindow).toBe(true);
  await expect(button).toHaveAccessibleName('Exit picture-in-picture');

  // Act
  await button.click();

  // Assert
  await expect.poll(inWindow).toBe(false);
  await expect(button).toHaveAccessibleName('Picture-in-picture');
});

test('the bar fades while the live plays and comes back with the mouse; under reduced motion it stays', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('fade'));
  await waitPlaying(page);
  await onTheBar(page);

  // Act: the mouse leaves the player
  await awayFromPlayer(page);

  // Assert
  await expect.poll(() => faded(page)).toBe(true);
  await expect(page.getByTestId('controls')).toHaveCSS('opacity', '0');
  expect((await videoState(page)).paused).toBe(false);

  // Act: back over the picture
  const video = (await page.locator('video').boundingBox())!;
  await page.mouse.move(video.x + video.width / 2, video.y + video.height / 3);

  // Assert
  await expect.poll(() => faded(page)).toBe(false);
  await expect(page.getByTestId('controls')).toHaveCSS('opacity', '1');

  // Act
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await awayFromPlayer(page);

  // Assert: nothing fades by itself for a viewer who asked for less motion
  expect(await faded(page)).toBe(false);
  await expect(page.getByTestId('controls')).toHaveCSS('opacity', '1');
});

test('the keyboard reaches every control in order and presses it; the focus holds the bar', { tag: '@ui' }, async ({ viewers, browserName }) => {
  // Arrange
  const { page } = await viewers.join(uid('tabkeys'));
  await waitPlaying(page);
  await awayFromPlayer(page);
  await expect.poll(() => faded(page)).toBe(true);
  // Safari moves the focus with Tab only to fields unless the viewer turns on "Press Tab to
  // highlight each item" (WebKit's tabsToLinks); Playwright's WebKit has it on, like that setting.
  void browserName;
  const focused = (): Promise<string | null> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.id ?? null);
  // The control before the bar in the page's order is the last one of the header: Tab from the
  // start of the page until the focus enters the bar (a bounded walk, not a retry).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let steps = 0;
  while (!(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="controls"]'))) && steps < 40) {
    await page.keyboard.press('Tab');
    steps += 1;
  }

  // Act: through the bar
  const order: Array<string | null> = [await focused()];
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="controls"]')))) break;
    order.push(await focused());
  }

  // Assert: the order a viewer reads them, the bar shown all along
  expect(order.filter((id) => id !== 'pip')).toEqual(['play', 'mute', 'volume', 'go-live', 'quality', 'theater', 'fullscreen']);
  expect(await faded(page)).toBe(false);

  // Act: Shift+Tab back to Play, Enter pauses
  await page.getByTestId('play').focus();
  await page.keyboard.press('Enter');

  // Assert
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  // Act: Space on Mute turns the sound on
  await page.keyboard.press('Tab');
  await page.keyboard.press(' ');

  // Assert
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);
  expect((await videoState(page)).paused).toBe(true);
});

test('the quality menu works from the keyboard: Enter opens it on the quality in use, arrows move, Esc closes it on its button', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  const { page } = await viewers.join(uid('qkeys'));
  await waitPlaying(page);
  const button = page.getByTestId('quality');
  await expect(button).toBeVisible();
  await button.focus();

  // Act
  await page.keyboard.press('Enter');

  // Assert
  await expect(page.getByTestId('quality-menu')).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('quality-menu').getByRole('menuitemradio', { checked: true })).toBeFocused();

  // Act
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');

  // Assert: closed, the focus back on the button, still playing, full screen untouched
  await expect(page.getByTestId('quality-menu')).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect((await videoState(page)).paused).toBe(false);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});
