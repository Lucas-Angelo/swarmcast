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
      'windows-x64': { name: 'SwarmCast_0.2.0_x64-setup.exe', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_x64-setup.exe', size: 9123456 },
      'macos-arm64': { name: 'SwarmCast_0.2.0_aarch64.dmg', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_aarch64.dmg', size: 9123456 },
      'macos-x64': { name: 'SwarmCast_0.2.0_x64.dmg', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_x64.dmg', size: 9123456 },
      'linux-deb-x64': { name: 'swarmcast_0.2.0_amd64.deb', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/swarmcast_0.2.0_amd64.deb', size: 9123456 },
      'linux-appimage-x64': { name: 'SwarmCast_0.2.0_amd64.AppImage', url: 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/SwarmCast_0.2.0_amd64.AppImage', size: 9123456 },
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
  test('English landing: headline, screenshot, steps, download, no external requests', async ({ browser }) => {
    const { context, page } = await open(browser);
    const external: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url());
    });
    await page.goto('/swarmcast/');
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Members-only live streams, straight from your PC.');
    await expect(page.getByText('Keep streaming from OBS.')).toBeVisible();
    await expect(page.getByRole('img', { name: /The SwarmCast panel during a live/ })).toBeVisible();
    await expect(page.getByTestId('how-it-works').locator('li')).toHaveCount(4);
    await expect(page.getByTestId('download-main')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Everything a private live needs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open, and honest about it' })).toBeVisible();
    await expect(page.getByTestId('limits').locator('li')).toHaveCount(4);
    await expect(page.getByTestId('faq').locator('details')).toHaveCount(5);
    // The real brand symbol (light or dark variant, whichever the theme shows).
    await expect(page.locator('img.sc-logo-mark:visible').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(external, 'no third-party requests (trackers, fonts…)').toEqual([]);
    expect(await context.cookies()).toEqual([]);
    // The font is self-hosted and actually used.
    expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
    await noHorizontalScroll(page);
    await shot(page, 'landing-en-desktop');
    await context.close();
  });

  test('Portuguese landing', async ({ browser }) => {
    const { context, page } = await open(browser, { locale: 'pt-BR' });
    await page.goto('/swarmcast/pt-br/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lives só para membros, direto do seu PC.');
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Windows/);
    await expect(page.getByRole('heading', { name: 'Tudo o que uma live privada precisa' })).toBeVisible();
    await expect(page.getByTestId('how-it-works')).toContainText('Navegadores dos membros');
    await expect(page.getByRole('img', { name: /O painel do SwarmCast durante uma live/ })).toBeVisible();
    await shot(page, 'landing-pt-BR-desktop');
    await context.close();
  });

  test('the FAQ opens and links to the guide', async ({ browser }) => {
    const { context, page } = await open(browser);
    await page.goto('/swarmcast/');
    const faq = page.getByTestId('faq');
    await faq.getByText('Is it really free?').click();
    await expect(faq.getByText('Yes. SwarmCast is a free, open-source')).toBeVisible();
    await expect(page.getByRole('link', { name: 'More answers in the guide' })).toHaveAttribute('href', '/swarmcast/help/troubleshooting/#frequent-questions');
    await context.close();
  });

  test('dark and light mode follow the system and the saved choice', async ({ browser }) => {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto('/swarmcast/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, `landing-en-${scheme}`, false);
      await ctx.close();
    }
    // The footer's theme menu wins, and the guide pages use the same choice.
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto('/swarmcast/');
    await page.locator('[data-theme-select]').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto('/swarmcast/start/obs/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto('/swarmcast/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await ctx.close();
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

  test('a Portuguese browser lands on the Portuguese home page', async ({ browser }) => {
    const { context, page } = await open(browser, { locale: 'pt-BR' });
    await page.goto('/swarmcast/');
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/$/);
    // The switch in the top bar goes back to English and stays there.
    await page.getByTestId('lang-switch').click();
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto('/swarmcast/download/');
    await expect(page).toHaveURL(/\/swarmcast\/download\/$/);
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
  test('Windows without stats: releases page, other platforms and how to install', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'windows' });
    await page.goto('/swarmcast/');
    const main = page.getByTestId('download-main');
    await expect(main).toHaveText(/Download for Windows/);
    await expect(main).toHaveAttribute('href', RELEASES);
    await expect(page.getByTestId('download-meta')).toHaveText('Windows 10 and 11, 64-bit');
    await expect(page.getByTestId('download-other-link')).toHaveAttribute('href', '/swarmcast/download/');
    await expect(page.getByTestId('download-howto')).toHaveAttribute('href', '/swarmcast/install/windows/');
    await context.close();
  });

  test('Windows with stats: direct link to the setup .exe, version and size', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'windows', stats: true });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', STATS.latest.assets['windows-x64'].url);
    await expect(page.getByTestId('download-meta')).toHaveText('Version 0.2.0 · 9.1 MB · Windows 10 and 11, 64-bit');
    await shot(page, 'download-windows-stats', false);
    await context.close();
  });

  test('macOS: Apple chip first, Intel as the alternative', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'macos', stats: true });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-main')).toHaveText(/Download for Mac/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /aarch64\.dmg$/);
    await expect(page.getByTestId('download-meta')).toContainText('Apple chip (M1 or newer)');
    await expect(page.getByTestId('download-alt-macos-x64')).toHaveAttribute('href', /_x64\.dmg$/);
    await expect(page.getByTestId('download-alt-macos-x64')).toHaveText('Intel Mac');
    await context.close();
  });

  test('Linux: .deb first, AppImage as the alternative (pt-BR)', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'linux', stats: true, locale: 'pt-BR' });
    await page.goto('/swarmcast/pt-br/');
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Linux/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /amd64\.deb$/);
    await expect(page.getByTestId('download-alt-linux-appimage')).toHaveText('AppImage');
    await expect(page.getByTestId('download-alt-linux-appimage')).toHaveAttribute('href', /\.AppImage$/);
    await expect(page.getByTestId('download-howto')).toHaveAttribute('href', '/swarmcast/pt-br/install/linux/');
    await context.close();
  });

  test('phone: explains that SwarmCast runs on the computer, with Copy link', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'iphone', viewport: { width: 390, height: 844 }, isMobile: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/swarmcast/');
    const mobile = page.getByTestId('download-mobile');
    await expect(mobile).toBeVisible();
    await expect(mobile).toBeInViewport();
    await expect(page.getByTestId('download-main')).toBeHidden();
    await expect(page.getByTestId('download-other-link')).toBeVisible();
    await page.getByTestId('download-copy').click();
    await expect(page.getByTestId('download-copy')).toHaveText(/Link copied/);
    await context.close();
  });

  test('desktop: the download button is visible without scrolling', async ({ browser }) => {
    const { context, page } = await open(browser, { viewport: { width: 1280, height: 720 } });
    await page.goto('/swarmcast/');
    await expect(page.getByTestId('download-main')).toBeInViewport();
    await context.close();
  });
});

test.describe('download page', () => {
  test('one card per system; the visitor’s system is marked and links straight to the files', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'macos', stats: true });
    await page.goto('/swarmcast/download/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Download SwarmCast');
    for (const os of ['windows', 'macos', 'linux']) await expect(page.getByTestId(`os-${os}`)).toBeVisible();
    const mac = page.getByTestId('os-macos');
    await expect(mac.getByText('Your system')).toBeVisible();
    await expect(page.getByTestId('os-windows').getByText('Your system')).toBeHidden();
    await expect(page.getByTestId('file-macos-arm64')).toHaveAttribute('href', STATS.latest.assets['macos-arm64'].url);
    await expect(page.getByTestId('file-macos-arm64')).toHaveClass(/sc-btn-primary/);
    await expect(page.getByTestId('file-macos-x64')).toHaveAttribute('href', STATS.latest.assets['macos-x64'].url);
    await expect(page.getByTestId('file-windows')).toHaveAttribute('href', STATS.latest.assets['windows-x64'].url);
    await expect(mac).toContainText('SwarmCast_0.2.0_aarch64.dmg');
    await expect(mac).toContainText('Open Anyway');
    await expect(page.getByTestId('os-windows')).toContainText('Run anyway');
    await expect(page.getByText('Latest version: 0.2.0.')).toBeVisible();
    await expect(page.getByTestId('verify')).toContainText('SHA256SUMS.txt');
    await expect(page.getByRole('cell', { name: '50 Mbps or more' })).toBeVisible();
    await shot(page, 'download-page-macos');
    await context.close();
  });

  test('without stats every button opens the GitHub release; anchors from the guide work (pt-BR)', async ({ browser }) => {
    const { context, page } = await open(browser, { os: 'windows', locale: 'pt-BR' });
    await page.goto('/swarmcast/pt-br/download/#linux');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Baixar o SwarmCast');
    await expect(page.locator('#linux')).toBeInViewport();
    for (const key of ['windows', 'macos-arm64', 'macos-x64', 'linux-deb', 'linux-appimage']) {
      await expect(page.getByTestId(`file-${key}`)).toHaveAttribute('href', RELEASES);
    }
    await expect(page.getByTestId('os-windows')).toContainText('Executar assim mesmo');
    await expect(page.locator('#windows')).toHaveCount(1);
    await expect(page.locator('#macos')).toHaveCount(1);
    await context.close();
  });

  test('the guide links to the download page and back', async ({ browser }) => {
    const { context, page } = await open(browser);
    await page.goto('/swarmcast/install/macos/');
    await page.getByRole('link', { name: 'download page' }).first().click();
    await expect(page).toHaveURL(/\/swarmcast\/download\/#macos$/);
    await page.getByTestId('os-macos').getByRole('link', { name: /Step-by-step guide/ }).click();
    await expect(page).toHaveURL(/\/swarmcast\/install\/macos\/$/);
    await expect(page.getByTestId('header-download')).toHaveAttribute('href', '/swarmcast/download/');
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
    await expect(page.getByTestId('stats-downloads')).toHaveText(/downloads\s*1,230/);
    await expect(page.getByTestId('stats-apps')).toHaveText(/apps opened this week\s*40/);
    await expect(block).toContainText('Approximate');
    await expect(block.getByRole('link')).toHaveAttribute('href', '/swarmcast/about/privacy/#how-the-numbers-on-the-home-page-are-counted');
    await block.scrollIntoViewIfNeeded();
    await shot(page, 'stats-en', false);
    await page.goto('/swarmcast/pt-br/');
    await expect(page.getByTestId('stats-downloads')).toHaveText(/downloads\s*1\.230/);
    await expect(page.getByTestId('stats-apps')).toHaveText(/apps abertos nesta semana\s*40/);
    await context.close();
  });
});

test.describe('phones', () => {
  for (const [name, url, toggle] of [
    ['landing-en-mobile', '/swarmcast/', 'lang-switch'],
    ['landing-pt-BR-mobile', '/swarmcast/pt-br/', 'lang-switch'],
    ['download-pt-BR-mobile', '/swarmcast/pt-br/download/', 'lang-switch'],
    ['obs-en-mobile', '/swarmcast/start/obs/', 'lang-mobile'],
    ['obs-pt-BR-mobile', '/swarmcast/pt-br/start/obs/', 'lang-mobile'],
    ['troubleshooting-pt-BR-mobile', '/swarmcast/pt-br/help/troubleshooting/', 'lang-mobile'],
  ] as const) {
    test(`${url} fits a 360 px screen and keeps the language link visible`, async ({ browser }) => {
      const { context, page } = await open(browser, { os: 'iphone', viewport: { width: 360, height: 780 }, isMobile: true, locale: url.includes('pt-br') ? 'pt-BR' : 'en-US', stats: true });
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await noHorizontalScroll(page);
      await expect(page.getByTestId(toggle)).toBeVisible();
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

test('the guide has an overview page and the logo goes home', async ({ browser }) => {
  const { context, page } = await open(browser);
  await page.goto('/swarmcast/guide/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The SwarmCast guide');
  await page.getByRole('link', { name: 'SwarmCast home' }).first().click();
  await expect(page).toHaveURL(/\/swarmcast\/$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Guide' }).click();
  await expect(page).toHaveURL(/\/swarmcast\/guide\/$/);
  await context.close();
});

test('the OBS guide offers both methods, with screenshots in the page language', async ({ browser }) => {
  const { context, page } = await open(browser);
  for (const [url, lang, same, other, only] of [
    ['/swarmcast/start/obs/', 'en', 'A. Same scene everywhere', 'B. A different scene for SwarmCast', 'Only SwarmCast'],
    ['/swarmcast/pt-br/start/obs/', 'pt-br', 'A. A mesma cena em todo lugar', 'B. Outra cena para o SwarmCast', 'Só no SwarmCast'],
  ] as const) {
    await page.goto(url);
    const main = page.locator('main');
    // The chooser at the top links to each method.
    for (const name of [same, other, only]) {
      await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name, exact: true }).first()).toBeVisible();
    }
    // One screenshot per step, from the page's own language folder, all loaded.
    const imgs = main.locator('img');
    expect(await imgs.count()).toBeGreaterThanOrEqual(15);
    for (const img of await imgs.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect(img).toHaveJSProperty('complete', true);
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    }
    // The first picture is the Docks menu, named as OBS shows it in that language.
    await expect(imgs.first()).toHaveAttribute('alt', lang === 'en' ? /Docks menu/ : /menu Painéis/);
  }
  await context.close();
});

test('every page has alt text on its images', async ({ browser }) => {
  const { context, page } = await open(browser);
  for (const url of ['/swarmcast/', '/swarmcast/pt-br/', '/swarmcast/download/', '/swarmcast/start/obs/', '/swarmcast/pt-br/start/obs/', '/swarmcast/viewers/', '/swarmcast/pt-br/viewers/', '/swarmcast/live/go-live/', '/swarmcast/pt-br/live/go-live/']) {
    await page.goto(url);
    const missing = await page.locator('main img:not([alt]), main img[alt=""]').count();
    expect(missing, `${url} images without alt`).toBe(0);
  }
  await context.close();
});

test('keyboard users see where they are', async ({ browser }) => {
  const { context, page } = await open(browser);
  await page.goto('/swarmcast/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeInViewport();
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
  await context.close();
});
