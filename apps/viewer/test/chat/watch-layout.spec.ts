// The watch page's layout (style.css "Watch page"): the video as large as the window allows, the
// chat as a column fixed on the right and as tall as the window, the info row under the video in
// view, the Settings menu (settings-menu.ts) reachable from the keyboard, and the phone's order
// (video, info, chat filling the rest of the screen). The built page against the mock hub: no
// stream, so the player is its black box, which is what the layout sizes.
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts watch-layout
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, selector: string): Promise<Box> => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not laid out`);
  return b;
};
/** The info row's height the player leaves room for on a computer (style.css --info-h). */
const INFO_H = 88;
const picture = (c: string) => `/brand/${c.repeat(64)}.webp`;
/** A streamer's page with a picture, a banner and an About, so the page is taller than the window. */
const BRANDING = {
  rev: 1,
  name: 'Ana Plays',
  about: 'Cozy games and chat.\nNew lives every weekday at 8 pm.',
  tags: ['Cozy games'],
  links: [{ label: 'Instagram', href: 'https://instagram.com/ana' }],
  theme: { preset: 'forest', corners: 'round' },
  avatar: { s256: picture('a'), s128: picture('b') },
  banner: { s1280: picture('e'), s640: picture('f'), alt: '' },
  showCredit: true,
};

for (const { width, height, chatW } of [
  { width: 1280, height: 720, chatW: 340 },
  { width: 1600, height: 900, chatW: 360 },
  { width: 1920, height: 1080, chatW: 360 },
]) {
  test(`${width}×${height}: the chat is a full-height column on the right and the video takes the rest of the width`, async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width, height });

    // Act
    await openWatch(page, new MockHub('Bia'));

    // Assert: the chat, flush with the top, the bottom and the right of the window
    const chat = await box(page, '[data-testid="chat"]');
    expect(Math.round(chat.width)).toBe(chatW);
    expect(Math.round(chat.x + chat.width)).toBe(width);
    expect(chat.y).toBe(0);
    expect(Math.round(chat.height)).toBe(height);
    // The video: from the left edge to the chat, 16:9 unless that would push the info row out of view
    const player = await box(page, '.player');
    expect(player.x).toBe(0);
    expect(player.y).toBe(0);
    expect(Math.round(player.width)).toBe(width - chatW);
    expect(Math.round(player.height)).toBe(Math.round(Math.min(((width - chatW) * 9) / 16, height - INFO_H)));
    // The info row right under it, in view
    const info = await box(page, '[data-testid="info"]');
    expect(Math.abs(info.y - (player.y + player.height))).toBeLessThan(1);
    expect(info.y + info.height).toBeLessThanOrEqual(height);
    expect(info.x + info.width).toBeLessThanOrEqual(chat.x + 1);
    // No sideways scrolling
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('the chat column stays in place while the page scrolls', async ({ page }) => {
  // Arrange
  await page.setViewportSize({ width: 1280, height: 600 });
  await openWatch(page, new MockHub('Bia'), { brand: BRANDING });
  await expect(page.getByTestId('brand-about')).toBeVisible();
  const before = await box(page, '[data-testid="chat"]');

  // Act
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);

  // Assert
  expect(await box(page, '[data-testid="chat"]')).toEqual(before);
});

test('with the chat hidden the video takes the whole width; "Show chat" brings the column back', async ({ page }) => {
  // Arrange
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWatch(page, new MockHub('Bia'));

  // Act
  await page.getByTestId('chat-hide').click();

  // Assert
  await expect(page.getByTestId('chat')).toBeHidden();
  expect(Math.round((await box(page, '.player')).width)).toBe(1280);

  // Act
  await page.getByTestId('chat-show').click();

  // Assert
  await expect(page.getByTestId('chat')).toBeVisible();
  expect(Math.round((await box(page, '.player')).width)).toBe(1280 - 340);
});

test('the Settings menu: opened and closed from the keyboard, Tab goes into it, Esc gives the focus back', async ({ page, browserName }) => {
  // Arrange
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWatch(page, new MockHub('Bia'));
  const button = page.getByTestId('settings-open');
  const menu = page.getByTestId('settings-menu');
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAccessibleName('Settings');
  await button.focus();

  // Act
  await page.keyboard.press('Enter');

  // Assert: open, over the video (it opens upwards), with every setting in it
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(menu.getByText('Help the stream (P2P)')).toBeVisible();
  await expect(menu.getByTestId('keys-open')).toBeVisible();
  await expect(menu.getByTestId('stats-open')).toBeVisible();
  await expect(menu.locator('#nick')).toHaveText('Bia');
  expect((await box(page, '[data-testid="settings-menu"]')).y + 10).toBeLessThan((await box(page, '[data-testid="info"]')).y);

  // Act (Safari moves through buttons with Option+Tab)
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');

  // Assert
  expect(await page.evaluate(() => document.getElementById('settings-menu')!.contains(document.activeElement))).toBe(true);

  // Act
  await page.keyboard.press('Escape');

  // Assert
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // Act: Space opens it, a press outside closes it
  await page.keyboard.press(' ');
  await expect(menu).toBeVisible();
  await page.mouse.click(300, 650);

  // Assert
  await expect(menu).toBeHidden();
});

test('the shortcuts list opened from the menu keeps it open and gives the focus back to its link', async ({ page }) => {
  // Arrange
  await openWatch(page, new MockHub('Bia'));
  await page.getByTestId('settings-open').click();
  await page.getByTestId('keys-open').focus();

  // Act
  await page.keyboard.press('Enter');
  const help = page.getByTestId('keys-help');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');

  // Assert
  await expect(help).toBeHidden();
  await expect(page.getByTestId('settings-menu')).toBeVisible();
  await expect(page.getByTestId('keys-open')).toBeFocused();
});

test('pt-BR in a narrow computer window: the info row wraps, nothing is cut or scrolls sideways', async ({ page }) => {
  // Arrange
  await page.setViewportSize({ width: 1100, height: 700 });

  // Act
  await openWatch(page, new MockHub('Bia'), { lang: 'pt-BR' });

  // Assert
  await expect(page.getByTestId('settings-open')).toHaveText('Configurações');
  const info = await box(page, '[data-testid="info"]');
  const settings = await box(page, '[data-testid="settings-open"]');
  expect(settings.x + settings.width).toBeLessThanOrEqual(info.x + info.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);
});

test('a phone: the video, the info row, then the chat down to the bottom of the screen @mobile', async ({ page }) => {
  // Arrange: the streamer's name and picture, and the buttons a live shows (Unmute after the muted
  // autoplay, Share when the streamer allows it; no stream or server behind the mock to show them),
  // so the info row takes the lines it takes on a real phone.
  await openWatch(page, new MockHub('Bia'), { brand: BRANDING, lang: 'pt-BR' });
  await expect(page.locator('#brand-head .sc-brand-name')).toBeVisible();

  // Act
  await page.evaluate(() => {
    for (const id of ['unmute', 'share']) document.getElementById(id)!.hidden = false;
  });
  await expect(page.locator('#share')).toBeVisible();

  // Assert
  const view = page.viewportSize()!;
  const player = await box(page, '.player');
  const info = await box(page, '[data-testid="info"]');
  const chat = await box(page, '[data-testid="chat"]');
  expect(player.y).toBe(0);
  expect(Math.round(player.width)).toBe(view.width);
  expect(info.y).toBeGreaterThanOrEqual(player.y + player.height - 1);
  expect(chat.y).toBeGreaterThanOrEqual(info.y + info.height - 1);
  expect(Math.round(chat.width)).toBe(view.width);
  // The chat ends at the bottom of the screen, its message box in sight without scrolling
  // (however many lines the info row takes).
  expect(Math.abs(chat.y + chat.height - view.height)).toBeLessThan(1);
  await expect(page.getByTestId('chat-input')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('theater')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view.width);
});

test('a phone: the Settings menu is a sheet inside the screen; the P2P switch is in it @mobile', async ({ page }) => {
  // Arrange
  await openWatch(page, new MockHub('Bia'), { lang: 'pt-BR' });
  const button = page.getByTestId('settings-open');
  await expect(button).toHaveAccessibleName('Configurações');

  // Act
  await button.click();

  // Assert
  const menu = page.getByTestId('settings-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await expect(menu.locator('#p2p')).toBeAttached();
  await expect(menu.getByText('Ajudar a transmissão (P2P)')).toBeVisible();

  // Act: its own × (the sheet can cover the button that opened it)
  await page.getByRole('button', { name: 'Fechar as configurações' }).click();

  // Assert
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
});
