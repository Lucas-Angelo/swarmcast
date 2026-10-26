import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/screens');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });

const UA = {
  windows: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Win32' },
  macos: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'MacIntel' },
  linux: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Linux x86_64' },
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
} as const;

const STATS = {
  version: 1,
  generatedAt: '2026-11-08T06:00:00.000Z',
  repo: 'Lucas-Angelo/swarmcast',
  downloads: { total: 1234, about: 1230, byKind: { installer: 1000, package: 234 }, byOs: { windows: 900, macos: 200, linux: 134 } },
  apps: { week: 40, checks: 123, days: 7, partial: false, checksPerApp: 3 },
  latest: {
    tag: 'v0.2.0',
    version: '0.2.0',
    url: 'https://github.com/Lucas-Angelo/swarmcast/releases/tag/v0.2.0',
    publishedAt: '2026-11-01T00:00:00Z',
    assets: {
      'windows-x64': { name: 'SwarmCast_0.2.0_x64-setup.exe', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_x64-setup.exe', size: 1 },
      'macos-arm64': { name: 'SwarmCast_0.2.0_aarch64.dmg', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_aarch64.dmg', size: 1 },
      'macos-x64': { name: 'SwarmCast_0.2.0_x64.dmg', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_x64.dmg', size: 1 },
      'linux-deb-x64': { name: 'swarmcast_0.2.0_amd64.deb', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/swarmcast_0.2.0_amd64.deb', size: 1 },
      'linux-appimage-x64': { name: 'SwarmCast_0.2.0_amd64.AppImage', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_amd64.AppImage', size: 1 },
    },
  },
};

const RELEASES = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest';

/** A page that looks like `os` and has `locale` as its browser language. stats: serve STATS or 404. */
async function open(browser: Browser, opts: { os?: keyof typeof UA; locale?: string; stats?: boolean; viewport?: BrowserContextOptions['viewport']; isMobile?: boolean } = {}) {
  const ua = UA[opts.os ?? 'windows'];
  const context = await browser.newContext({
    userAgent: ua.userAgent,
    locale: opts.locale ?? 'en-US',
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    isMobile: opts.isMobile ?? false,
    hasTouch: opts.isMobile ?? false,
  });
  await context.addInitScript((platform) => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  }, ua.platform);
  await context.route('**/swarmcast/stats.json', (route) =>
    opts.stats ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(STATS) }) : route.fulfill({ status: 404, body: 'Not found' }),
  );
  const page = await context.newPage();
  return { context, page };
}

async function noHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page must not scroll sideways').toBeLessThanOrEqual(client);
}

test.describe('landing pages', () => {
  test('English landing: tagline, diagram, download, no external requests', async ({ browser }) => {
    const { context, page } = await open(browser);
    const external: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url());
    });
    await page.goto('/swarmcast/');
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'SwarmCast' })).toBeVisible();
    await expect(page.getByText('Stream a members-only live straight from your computer')).toBeVisible();
    await expect(page.getByTestId('how-it-works').locator('li')).toHaveCount(4);
    await expect(page.getByTestId('download-main')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Free, private and safe' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(external, 'no third-party requests (trackers, fonts…)').toEqual([]);
    expect(await context.cookies()).toEqual([]);
    await noHorizontalScroll(page);
    await shot(page, 'landing-en-desktop');
    await context.close();
  });

  test('Portuguese landing', async ({ browser }) => {
    const { context, page } = await open(browser, { locale: 'pt-BR' });
    await page.goto('/swarmcast/pt-br/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByText('Faça uma live só para membros direto do seu computador')).toBeVisible();
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Windows/);
    await expect(page.getByRole('heading', { name: 'Grátis, privado e seguro' })).toBeVisible();
    await expect(page.getByTestId('how-it-works')).toContainText('Navegadores dos membros');
    await shot(page, 'landing-pt-BR-desktop');
    await context.close();
  });

  test('dark and light mode', async ({ browser }) => {
    const { context, page } = await open(browser);
    await page.goto('/swarmcast/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        localStorage.setItem('starlight-theme', t);
        document.documentElement.dataset.theme = t;
      }, theme);
      await shot(page, `landing-en-${theme}`, false);
    }
    await context.close();
  });
});

test.describe('language', () => {
  test('a Portuguese browser goes to pt-BR on the first visit, and the switcher wins after that', async ({ browser }) => {
    const { context, page } = await open(browser, { locale: 'pt-BR' });
    await page.goto('/swarmcast/install/windows/');
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/install\/windows\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Instalar no Windows');

    // The language menu (desktop header) back to English.
    await page.locator('header starlight-lang-select select').first().selectOption({ label: 'English' });
    await expect(page).toHaveURL(/\/swarmcast\/install\/windows\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Install on Windows');

    // A later visit typed in the address bar stays in English.
    await page.goto('/swarmcast/');
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await context.close();
  });

  test('an English browser is not redirected', async ({ browser }) => {
    const { context, page } = await open(browser, { locale: 'en-GB' });
    await page.goto('/swarmcast/');
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await page.goto('/swarmcast/pt-br/');
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/$/);
    await context.close();
  });
});

test.describe('download button', () => {
  test('Windows without stats: releases page, other systems listed', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'windows' });
    await page.goto('/swarmcast/');
    const main = page.getByTestId('download-main');
    await expect(main).toHaveText(/Download for Windows/);
    await expect(main).toHaveAttribute('href', RELEASES);
    const other = page.getByTestId('download-other');
    await expect(other.getByRole('link', { name: 'macOS' })).toBeVisible();
    await expect(other.getByRole('link', { name: 'Linux' })).toBeVisible();
    await expect(other.getByRole('link', { name: 'Windows' })).toHaveCount(0);
    await expect(page.getByTestId('download-meta').getByRole('link', { name: 'How to install' })).toHaveAttribute('href', '/swarmcast/install/windows/');
    await context.close();
  });

  test('Windows with stats: direct link to the setup .exe', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'windows', stats: true });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', STATS.latest.assets['windows-x64'].url);
    await expect(page.getByTestId('download-meta')).toContainText('Version 0.2.0');
    await shot(page, 'download-windows-stats', false);
    await context.close();
  });

  test('macOS: Apple chip first, Intel as the alternative', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'macos', stats: true });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-main')).toHaveText(/Download for Mac \(Apple chip\)/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /aarch64\.dmg$/);
    await expect(page.getByTestId('download-alt-macos-x64')).toHaveAttribute('href', /_x64\.dmg$/);
    await context.close();
  });

  test('Linux: .deb first, AppImage as the alternative (pt-BR)', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'linux', stats: true, locale: 'pt-BR' });
    await page.goto('/swarmcast/pt-br/');
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Linux \(\.deb\)/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /amd64\.deb$/);
    await expect(page.getByTestId('download-alt-linux-appimage')).toHaveText('AppImage (qualquer distribuição)');
    await expect(page.getByTestId('download-meta').getByRole('link')).toHaveAttribute('href', '/swarmcast/pt-br/install/linux/');
    await context.close();
  });

  test('phone: explains that SwarmCast runs on the computer', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'iphone', viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-mobile')).toBeVisible();
    await expect(page.getByTestId('download-main')).toBeHidden();
    await expect(page.getByTestId('download-other').getByRole('link', { name: 'Windows' })).toBeVisible();
    await context.close();
  });
});

test.describe('usage numbers', () => {
  test('hidden without data', async ({ browser }) => {
    const { context, page } = await open(browser, { stats: false });
    await page.goto('/swarmcast/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('usage-stats')).toBeHidden();
    await context.close();
  });

  test('shown with data, with honest wording, in both languages', async ({ browser }) => {
    const { context, page } = await open(browser, { stats: true });
    await page.goto('/swarmcast/');
    const block = page.getByTestId('usage-stats');
    await expect(block).toBeVisible();
    await expect(page.getByTestId('stats-downloads')).toHaveText('about 1,230 downloads');
    await expect(page.getByTestId('stats-apps')).toHaveText('about 40 SwarmCast apps opened this week');
    await expect(block.getByRole('link')).toHaveAttribute('href', '/swarmcast/about/privacy/');
    await block.scrollIntoViewIfNeeded();
    await shot(page, 'stats-en', false);
    await page.goto('/swarmcast/pt-br/');
    await expect(page.getByTestId('stats-downloads')).toHaveText('cerca de 1.230 downloads');
    await expect(page.getByTestId('stats-apps')).toHaveText('cerca de 40 SwarmCast abertos nesta semana');
    await context.close();
  });
});

test.describe('phones', () => {
  for (const [name, url] of [
    ['landing-en-mobile', '/swarmcast/'],
    ['landing-pt-BR-mobile', '/swarmcast/pt-br/'],
    ['obs-en-mobile', '/swarmcast/start/obs/'],
    ['troubleshooting-pt-BR-mobile', '/swarmcast/pt-br/help/troubleshooting/'],
  ] as const) {
    test(`${url} fits a 360 px screen and keeps the language link visible`, async ({ browser }) => {
      const { context, page } = await open(browser, { os: 'iphone', viewport: { width: 360, height: 780 }, isMobile: true, locale: url.includes('pt-br') ? 'pt-BR' : 'en-US', stats: true });
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await noHorizontalScroll(page);
      const toggle = page.getByTestId('lang-mobile');
      await expect(toggle).toBeVisible();
      await shot(page, name);
      await context.close();
    });
  }

  test('the phone language link switches the page', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'iphone', viewport: { width: 360, height: 780 }, isMobile: true });
    await page.goto('/swarmcast/live/p2p/');
    await page.getByTestId('lang-mobile').click();
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/live\/p2p\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ajudar a transmissão (P2P)');
    await context.close();
  });
});

test('every page has alt text on its images', async ({ browser }) => {
  const { context, page } = await open(browser);
  for (const url of ['/swarmcast/start/obs/', '/swarmcast/pt-br/start/obs/', '/swarmcast/viewers/', '/swarmcast/pt-br/viewers/', '/swarmcast/live/go-live/', '/swarmcast/pt-br/live/go-live/']) {
    await page.goto(url);
    const missing = await page.locator('main img:not([alt]), main img[alt=""]').count();
    expect(missing, `${url} images without alt`).toBe(0);
  }
  await context.close();
});
