// Theater mode, keyboard shortcuts and "stats for nerds" on the built watch page, in chromium,
// firefox and webkit (and phones for @mobile), against the mock hub: no stream plays here, so these
// are the layout, the keys and the panel's open / close; the player's side (play / pause, the
// panel's numbers from a real stream) is in apps/server/test/e2e/player-extras.spec.ts.
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts player-extras
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const box = async (page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not laid out`);
  return b;
};

/** The page in theater mode (the class the styles widen the player with). */
const inTheater = (page: Page): Promise<boolean> => page.evaluate(() => document.body.classList.contains('theater'));
const muted = (page: Page): Promise<boolean> => page.evaluate(() => document.querySelector('video')!.muted);

/** Gives the focus to the page itself (nothing in particular), as after a click on an empty spot. */
async function focusPage(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

/** Opens the Settings menu under the video (the shortcuts and stats links are in it). */
async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-menu')).toBeVisible();
}

test.describe('theater mode', () => {
  test('a laptop (1280×720): the player takes the whole height of the window, the chat stays beside it; remembered', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 720 });
    await openWatch(page, new MockHub('Bia'));
    const button = page.getByTestId('theater');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const before = await box(page, '.player');
    // Not in theater mode the info row is in view under the video.
    expect((await box(page, '[data-testid="info"]')).y + (await box(page, '[data-testid="info"]')).height).toBeLessThanOrEqual(720);

    // Act
    await button.click();

    // Assert
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => Math.round((await box(page, '.player')).height)).toBe(720);
    const player = await box(page, '.player');
    const chat = await box(page, '[data-testid="chat"]');
    // As wide as before (the chat keeps its column), from the top of the window to its bottom.
    expect(Math.round(player.width)).toBe(Math.round(before.width));
    expect(player.y).toBe(0);
    expect(chat.x).toBeGreaterThanOrEqual(player.x + player.width - 1);
    expect(Math.round(chat.height)).toBe(720);
    // The info row is a scroll away.
    expect((await box(page, '[data-testid="info"]')).y).toBeGreaterThanOrEqual(720 - 1);

    // Act
    await page.reload();

    // Assert
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'true');
    expect(await inTheater(page)).toBe(true);

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Math.round((await box(page, '.player')).height)).toBe(Math.round(before.height));
  });

  test('a wide screen (1800×1000): a taller player, the chat still beside it', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1800, height: 1000 });
    await openWatch(page, new MockHub('Bia'));
    const before = await box(page, '.player');

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect.poll(async () => Math.round((await box(page, '.player')).height)).toBe(1000);
    const player = await box(page, '.player');
    const chat = await box(page, '[data-testid="chat"]');
    expect(player.height).toBeGreaterThan(before.height + 100);
    expect(chat.x).toBeGreaterThanOrEqual(player.x + player.width - 1);
    expect(chat.x + chat.width).toBeLessThanOrEqual(1800);
    expect(Math.round(chat.height)).toBe(1000);
  });

  test('works with the chat hidden: the player takes the whole window', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 720 });
    await openWatch(page, new MockHub('Bia'));
    await page.getByTestId('chat-hide').click();
    await expect(page.getByTestId('chat')).toBeHidden();
    const before = await box(page, '.player');
    expect(Math.round(before.width)).toBe(1280);

    // Act
    await page.getByTestId('theater').click();

    // Assert
    await expect.poll(async () => Math.round((await box(page, '.player')).height)).toBe(720);
    const player = await box(page, '.player');
    expect(player.height).toBeGreaterThan(before.height);
    expect(Math.round(player.width)).toBe(1280);
    await expect(page.getByTestId('chat-show')).toBeAttached();
  });

  test('a narrow window (chat under the video) has no theater button', async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 900, height: 1000 });

    // Act
    await openWatch(page, new MockHub('Bia'));

    // Assert
    await expect(page.getByTestId('theater')).toBeHidden();
  });

  test('a phone has no theater button and its layout does not change @mobile', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));
    const before = await box(page, '.player');

    // Assert
    await expect(page.getByTestId('theater')).toBeHidden();

    // Act: a keyboard on a tablet or a phone still has T
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true })));

    // Assert
    expect(await inTheater(page)).toBe(true);
    expect(await box(page, '.player')).toEqual(before);
  });
});

test.describe('keyboard shortcuts', () => {
  test('T and M work from the page; typing "kmft" in the chat box only types', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await focusPage(page);
    expect(await muted(page)).toBe(true);

    // Act
    await page.keyboard.press('t');
    await page.keyboard.press('m');

    // Assert
    expect(await inTheater(page)).toBe(true);
    expect(await muted(page)).toBe(false);
    await expect(page.getByTestId('theater')).toHaveAttribute('aria-pressed', 'true');

    // Act
    const input = page.getByTestId('chat-input');
    await input.click();
    await page.keyboard.type('kmft ?s');

    // Assert: the text is in the box, nothing toggled, no panel, no list
    await expect(input).toHaveValue('kmft ?s');
    expect(await inTheater(page)).toBe(true);
    expect(await muted(page)).toBe(false);
    await expect(page.getByTestId('keys-help')).toBeHidden();
    await expect(page.getByTestId('stats')).toBeHidden();

    // Act: C from the page goes to the chat box without typing a "c"
    await input.fill('');
    await focusPage(page);
    await page.keyboard.press('c');

    // Assert
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
  });

  test('? opens the list; its switch turns the shortcuts off, remembered after a reload; Esc closes it', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));
    await focusPage(page);

    // Act
    await page.keyboard.press('?');

    // Assert
    const help = page.getByTestId('keys-help');
    await expect(help).toBeVisible();
    await expect(help.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(help.locator('dd')).toContainText(['Play or pause', 'Sound on or off', 'Full screen (Esc leaves it)', 'Theater mode (a bigger video)', 'Go live']);
    const toggle = help.getByLabel('Use keyboard shortcuts');
    await expect(toggle).toBeChecked();

    // Act
    await toggle.uncheck();
    await page.keyboard.press('Escape');

    // Assert
    await expect(help).toBeHidden();

    // Act
    await page.reload();
    await focusPage(page);
    await page.keyboard.press('t');
    await page.keyboard.press('m');
    await page.keyboard.press('?');

    // Assert: off, so nothing happened, not even the list
    expect(await inTheater(page)).toBe(false);
    expect(await muted(page)).toBe(true);
    await expect(help).toBeHidden();

    // Act: the link in the Settings menu is the way back
    await openSettings(page);
    await page.getByTestId('keys-open').click();

    // Assert
    await expect(help).toBeVisible();
    await expect(help.getByLabel('Use keyboard shortcuts')).not.toBeChecked();

    // Act
    await help.getByLabel('Use keyboard shortcuts').check();
    await help.getByRole('button', { name: 'Close' }).click();
    await focusPage(page);
    await page.keyboard.press('t');

    // Assert
    await expect(help).toBeHidden();
    expect(await inTheater(page)).toBe(true);
  });

  test('pt-BR: the list and the buttons in Portuguese', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'), { lang: 'pt-BR' });

    // Act
    await page.getByTestId('settings-open').click();
    await page.getByTestId('keys-open').click();

    // Assert
    const help = page.getByTestId('keys-help');
    await expect(help.getByRole('heading', { name: 'Atalhos de teclado' })).toBeVisible();
    await expect(help.locator('kbd').first()).toHaveText('Espaço');
    await expect(help.getByLabel('Usar atalhos de teclado')).toBeChecked();
    await expect(page.getByTestId('theater')).toHaveText('Modo cinema');
    await expect(page.getByTestId('stats-open')).toHaveText('Estatísticas para nerds');
    await expect(page.getByTestId('settings-open')).toHaveText('Configurações');
  });
});

test.describe('stats for nerds', () => {
  test('closed by default and not loaded; opens from its link, S toggles it, Esc closes it and the focus goes back', async ({ page }) => {
    // Arrange
    const statsChunks: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/stats-overlay-[\w-]+\.(js|css)$/.test(r.url())) statsChunks.push(r.url());
    });
    await openWatch(page, new MockHub('Bia'));
    const link = page.getByTestId('stats-open');
    const panel = page.getByTestId('stats');

    // Assert
    await expect(panel).toBeHidden();
    await expect(link).toHaveAttribute('aria-expanded', 'false');
    expect(statsChunks).toEqual([]);

    // Act
    await openSettings(page);
    await link.click();

    // Assert
    await expect(panel).toBeVisible();
    await expect(link).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('heading', { name: 'Stats for nerds' })).toBeVisible();
    await expect(panel.locator('dt')).toHaveText(['Resolution', 'Quality', 'Internet speed (estimate)', 'Video loaded ahead', 'Behind live', 'Playback', 'Dropped frames', 'P2P', 'Received from other viewers', 'Sent to other viewers', 'Received from the streamer', 'Connection', 'Player']);
    await expect(panel.locator('[data-stat="p2p"] dd')).toHaveText('Off');
    await expect(page.getByRole('button', { name: 'Close stats for nerds' })).toBeFocused();
    expect(statsChunks.some((u) => u.endsWith('.js'))).toBe(true);
    // It sits over the top of the video, in view, and leaves the bottom of the video (the
    // controls) free.
    await expect(panel).toBeInViewport();
    const player = await box(page, '.player');
    const over = await box(page, '[data-testid="stats"]');
    expect(over.y).toBeGreaterThanOrEqual(player.y);
    expect(over.y + over.height).toBeLessThan(player.y + player.height - 40);

    // Act
    await page.keyboard.press('Escape');

    // Assert: the Settings menu closed when the panel opened; the focus goes back to its button
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('settings-menu')).toBeHidden();
    await expect(page.getByTestId('settings-open')).toBeFocused();
    await expect(link).toHaveAttribute('aria-expanded', 'false');

    // Act
    await focusPage(page);
    await page.keyboard.press('s');

    // Assert
    await expect(panel).toBeVisible();

    // Act
    await page.getByRole('button', { name: 'Close stats for nerds' }).click();

    // Assert
    await expect(panel).toBeHidden();
  });

  test('on a phone it fits over the video and closes @mobile', async ({ page }) => {
    // Arrange
    await openWatch(page, new MockHub('Bia'));

    // Act
    await openSettings(page);
    await page.getByTestId('stats-open').click();

    // Assert
    const panel = page.getByTestId('stats');
    await expect(panel).toBeVisible();
    const player = await box(page, '.player');
    const over = await box(page, '[data-testid="stats"]');
    expect(over.x).toBeGreaterThanOrEqual(player.x);
    expect(over.x + over.width).toBeLessThanOrEqual(player.x + player.width);
    expect(over.y + over.height).toBeLessThanOrEqual(player.y + player.height);

    // Act
    await page.getByRole('button', { name: 'Close stats for nerds' }).click();

    // Assert
    await expect(panel).toBeHidden();
  });
});
