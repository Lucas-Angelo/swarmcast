// Panel login through /auth/<token> (the cookie is SameSite=Strict), on Chromium and WebKit
// (WebKit is the desktop app's webview on macOS): from a script, and from another site the way
// the desktop splash (tauri://localhost) opens the panel, by a link or by its shell's
// navigate() (a script on that site), each time with no cookie left from the last.
import { expect, loginPanel, serverEnv, test } from './fixtures.js';

test.skip(({ browserName }) => browserName === 'firefox', 'checked on Chromium and WebKit');

const SPLASH = 'http://splash.test/';

test('script mode: opening the login URL shows the panel, logged in', { tag: '@ui' }, async ({ page }) => {
  // Act
  await loginPanel(page);

  // Assert
  await expect(page.getByTestId('status')).toBeVisible();
});

test('desktop app: a login started on another site (the splash) still lands logged in', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const login = serverEnv().adminLoginUrl;
  const panel = new URL('/', login).toString();
  await page.route(`${SPLASH}**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><a id="open" href="${login}">Open</a>` }));

  for (let i = 0; i < 3; i++) {
    // Arrange
    await page.context().clearCookies();
    await page.goto(SPLASH);

    // Act
    await page.click('#open');

    // Assert
    await expect(page).toHaveURL(panel);
    await expect(page.getByTestId('status')).toBeVisible();
    await expect(page.getByText(/not authorized|Open the panel from the SwarmCast/i)).toHaveCount(0);
  }

  // Arrange
  await page.context().clearCookies();
  await page.goto(SPLASH);

  // Act
  await page.evaluate((u) => location.assign(u), login);

  // Assert
  await expect(page).toHaveURL(panel);
  await expect(page.getByTestId('status')).toBeVisible();
});
