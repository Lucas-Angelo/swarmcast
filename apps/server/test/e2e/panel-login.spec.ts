import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';

// Panel login through /auth/<token> (the cookie is SameSite=Strict). Chromium and WebKit
// (WebKit is the desktop app's webview on macOS).

function adminLoginUrl(): string {
  const env = JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string };
  return env.adminLoginUrl;
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName === 'firefox', 'checked on Chromium and WebKit');
});

test('script mode: opening the login URL shows the panel, logged in', { tag: '@ui' }, async ({ page }) => {
  const login = adminLoginUrl();
  await page.goto(login);
  await expect(page).toHaveURL(new URL('/', login).toString());
  await expect(page.getByTestId('status')).toBeVisible();
});

test('desktop app: a login started on another site (the splash) still lands logged in', { tag: '@ui' }, async ({ page }) => {
  const login = adminLoginUrl();
  // A page on another site, like the desktop splash (tauri://localhost), that opens the panel.
  await page.route('http://splash.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><a id="open" href="${login}">Open</a>` }),
  );
  for (let i = 0; i < 3; i++) {
    await page.context().clearCookies();
    await page.goto('http://splash.test/');
    await page.click('#open');
    await expect(page).toHaveURL(new URL('/', login).toString());
    await expect(page.getByTestId('status')).toBeVisible();
    await expect(page.getByText(/not authorized|Open the panel from the SwarmCast/i)).toHaveCount(0);
  }
  // And from a script on that site (like the shell's navigate()).
  await page.context().clearCookies();
  await page.goto('http://splash.test/');
  await page.evaluate((u) => location.assign(u), login);
  await expect(page).toHaveURL(new URL('/', login).toString());
  await expect(page.getByTestId('status')).toBeVisible();
});
