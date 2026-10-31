// The built site as visitors see it: landing pages, theme, language redirect and switcher, the
// download button and page per system (with and without stats.json), the usage numbers, phone
// widths, the illustrated guides and keyboard focus. Each test is a visitor of its own (fixtures.ts);
// it waits for the page's own work (the stats read, the fonts), never for the network to go idle.
import { expect, fontsLoaded, noHorizontalScroll, pageSettled, RELEASES, shot, STATS, statsRead, test } from './fixtures.js';

/** The illustrated usage guides: [page, minimum screenshots, an English alt text, its Portuguese twin]. The alt texts name the app's buttons in the page language, like the screenshots. */
const GUIDES: Array<[string, number, RegExp, RegExp]> = [
  ['start/quick-start', 1, /The SwarmCast panel during a live/, /O painel do SwarmCast durante uma live/],
  ['install/windows', 1, /Run SwarmCast/, /Boas-vindas ao SwarmCast/],
  ['install/macos', 1, /Open Anyway/, /Abrir Mesmo Assim/],
  ['start/first-run', 10, /Starting SwarmCast/, /Abrindo o SwarmCast/],
  ['live/go-live', 6, /Start Streaming/, /Iniciar transmissão/],
  ['live/kick-and-new-link', 5, /Remove from P2P/, /Tirar do P2P/],
  ['live/quality', 1, /Quality for viewers/, /Qualidade para quem assiste/],
  ['live/p2p', 2, /Help the stream \(P2P\)/, /Ajudar a transmissão \(P2P\)/],
  ['live/protection', 1, /Protection card/, /cartão Proteção/],
  ['app/autostart', 2, /Start with the computer/, /Iniciar com o computador/],
  ['app/updates', 2, /Check for updates/, /Procurar atualizações/],
  ['help/troubleshooting', 1, /Export logs/, /Exportar logs/],
  ['viewers', 4, /nickname/, /apelido/],
];
/** A phone screen. */
const PHONE = { os: 'iphone', viewport: { width: 360, height: 780 }, isMobile: true } as const;
const localeOf = (url: string) => (url.includes('pt-br') ? 'pt-BR' : 'en-US');

test.describe('landing pages', () => {
  test('English landing: headline, screenshot, steps, download, the logo', async ({ visit }) => {
    // Arrange
    const { page } = await visit();

    // Act
    await page.goto('/swarmcast/');

    // Assert
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
    await expect(page.locator('img.sc-logo-mark:visible').first()).toBeVisible();
  });

  test('English landing: no third-party request or cookie, the self-hosted font in use, no sideways scroll', async ({ visit }) => {
    // Arrange
    const { context, page } = await visit();
    const external: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url());
    });

    // Act
    await page.goto('/swarmcast/');
    await pageSettled(page);

    // Assert
    expect(external, 'no third-party requests (trackers, fonts…)').toEqual([]);
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
    await noHorizontalScroll(page);
    await shot(page, 'landing-en-desktop');
  });

  test('Portuguese landing', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ locale: 'pt-BR' });

    // Act
    await page.goto('/swarmcast/pt-br/');

    // Assert
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lives só para membros, direto do seu PC.');
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Windows/);
    await expect(page.getByRole('heading', { name: 'Tudo o que uma live privada precisa' })).toBeVisible();
    await expect(page.getByTestId('how-it-works')).toContainText('Navegadores dos membros');
    await expect(page.getByRole('img', { name: /O painel do SwarmCast durante uma live/ })).toBeVisible();
    await shot(page, 'landing-pt-BR-desktop');
  });

  test('the FAQ opens and links to the guide', async ({ visit }) => {
    // Arrange
    const { page } = await visit();
    await page.goto('/swarmcast/');
    const faq = page.getByTestId('faq');

    // Act
    await faq.getByText('Is it really free?').click();

    // Assert
    await expect(faq.getByText('Yes. SwarmCast is a free, open-source')).toBeVisible();
    await expect(page.getByRole('link', { name: 'More answers in the guide' })).toHaveAttribute('href', '/swarmcast/help/troubleshooting/#frequent-questions');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`follows the system's ${scheme} mode`, async ({ visit }) => {
      // Arrange
      const { page } = await visit({ colorScheme: scheme });

      // Act
      await page.goto('/swarmcast/');

      // Assert
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await shot(page, `landing-en-${scheme}`, false);
    });
  }

  test("the footer's theme menu wins over the system, and the guide pages use the same choice", async ({ visit }) => {
    // Arrange
    const { page } = await visit({ colorScheme: 'light' });
    await page.goto('/swarmcast/');

    // Act
    await page.locator('[data-theme-select]').selectOption('dark');

    // Assert
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Act
    await page.goto('/swarmcast/start/obs/');

    // Assert
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('language', () => {
  test('a Portuguese browser goes to pt-BR on the first visit, and the switcher wins after that', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ locale: 'pt-BR' });

    // Act
    await page.goto('/swarmcast/install/windows/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/install\/windows\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Instalar no Windows');

    // Act
    await page.locator('header starlight-lang-select select').first().selectOption({ label: 'English' });

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/install\/windows\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Install on Windows');

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/$/);
  });

  test('a Portuguese browser lands on the Portuguese home page; the switch in the top bar goes back to English for good', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ locale: 'pt-BR' });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/$/);

    // Act
    await page.getByTestId('lang-switch').click();

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // Act
    await page.goto('/swarmcast/download/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/download\/$/);
  });

  test('an English browser is not redirected, on either language', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ locale: 'en-GB' });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/$/);

    // Act
    await page.goto('/swarmcast/pt-br/');

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/$/);
  });
});

test.describe('download button', () => {
  test('Windows without stats: releases page, other platforms and how to install', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'windows' });

    // Act
    await page.goto('/swarmcast/');
    await statsRead(page.getByTestId('download'));

    // Assert
    const main = page.getByTestId('download-main');
    await expect(main).toHaveText(/Download for Windows/);
    await expect(main).toHaveAttribute('href', RELEASES);
    await expect(page.getByTestId('download-meta')).toHaveText('Windows 10 and 11, 64-bit');
    await expect(page.getByTestId('download-other-link')).toHaveAttribute('href', '/swarmcast/download/');
    await expect(page.getByTestId('download-howto')).toHaveAttribute('href', '/swarmcast/install/windows/');
  });

  test('Windows with stats: direct link to the setup .exe, version and size', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'windows', stats: true });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', STATS.latest.assets['windows-x64'].url);
    await expect(page.getByTestId('download-meta')).toHaveText('Version 0.2.0 · 9.1 MB · Windows 10 and 11, 64-bit');
    await shot(page, 'download-windows-stats', false);
  });

  test('macOS: Apple chip first, Intel as the alternative', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'macos', stats: true });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page.getByTestId('download-main')).toHaveText(/Download for Mac/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /aarch64\.dmg$/);
    await expect(page.getByTestId('download-meta')).toContainText('Apple chip (M1 or newer)');
    await expect(page.getByTestId('download-alt-macos-x64')).toHaveAttribute('href', /_x64\.dmg$/);
    await expect(page.getByTestId('download-alt-macos-x64')).toHaveText('Intel Mac');
  });

  test('Linux: .deb first, AppImage as the alternative (pt-BR)', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'linux', stats: true, locale: 'pt-BR' });

    // Act
    await page.goto('/swarmcast/pt-br/');

    // Assert
    await expect(page.getByTestId('download-main')).toHaveText(/Baixar para Linux/);
    await expect(page.getByTestId('download-main')).toHaveAttribute('href', /amd64\.deb$/);
    await expect(page.getByTestId('download-alt-linux-appimage')).toHaveText('AppImage');
    await expect(page.getByTestId('download-alt-linux-appimage')).toHaveAttribute('href', /\.AppImage$/);
    await expect(page.getByTestId('download-howto')).toHaveAttribute('href', '/swarmcast/pt-br/install/linux/');
  });

  test('phone: explains that SwarmCast runs on the computer, with Copy link', async ({ visit }) => {
    // Arrange
    const { context, page } = await visit({ ...PHONE, viewport: { width: 390, height: 844 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Act
    await page.goto('/swarmcast/');

    // Assert
    const mobile = page.getByTestId('download-mobile');
    await expect(mobile).toBeVisible();
    await expect(mobile).toBeInViewport();
    await expect(page.getByTestId('download-main')).toBeHidden();
    await expect(page.getByTestId('download-other-link')).toBeVisible();

    // Act
    await page.getByTestId('download-copy').click();

    // Assert
    await expect(page.getByTestId('download-copy')).toHaveText(/Link copied/);
  });

  test('desktop: the download button is visible without scrolling', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ viewport: { width: 1280, height: 720 } });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    await expect(page.getByTestId('download-main')).toBeInViewport();
  });
});

test.describe('download page', () => {
  test('one card per system; the visitor’s system is marked and links straight to the files', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'macos', stats: true });

    // Act
    await page.goto('/swarmcast/download/');

    // Assert
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
  });

  test('without stats every button opens the GitHub release; anchors from the guide work (pt-BR)', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ os: 'windows', locale: 'pt-BR' });

    // Act
    await page.goto('/swarmcast/pt-br/download/#linux');
    await statsRead(page.getByTestId('download-page'));

    // Assert
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Baixar o SwarmCast');
    await expect(page.locator('#linux')).toBeInViewport();
    for (const key of ['windows', 'macos-arm64', 'macos-x64', 'linux-deb', 'linux-appimage']) {
      await expect(page.getByTestId(`file-${key}`)).toHaveAttribute('href', RELEASES);
    }
    await expect(page.getByTestId('os-windows')).toContainText('Executar assim mesmo');
    await expect(page.locator('#windows')).toHaveCount(1);
    await expect(page.locator('#macos')).toHaveCount(1);
  });

  test('the guide links to the download page and back', async ({ visit }) => {
    // Arrange
    const { page } = await visit();
    await page.goto('/swarmcast/install/macos/');

    // Act
    await page.getByRole('link', { name: 'download page' }).first().click();

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/download\/#macos$/);

    // Act
    await page.getByTestId('os-macos').getByRole('link', { name: /Step-by-step guide/ }).click();

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/install\/macos\/$/);
    await expect(page.getByTestId('header-download')).toHaveAttribute('href', '/swarmcast/download/');
  });
});

test.describe('usage numbers', () => {
  test('hidden without data', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ stats: false });

    // Act
    await page.goto('/swarmcast/');
    await statsRead(page.getByTestId('usage-stats'));

    // Assert
    await expect(page.getByTestId('usage-stats')).toBeHidden();
  });

  test('shown with data, with honest wording, in both languages', async ({ visit }) => {
    // Arrange
    const { page } = await visit({ stats: true });

    // Act
    await page.goto('/swarmcast/');

    // Assert
    const block = page.getByTestId('usage-stats');
    await expect(block).toBeVisible();
    await expect(page.getByTestId('stats-downloads')).toHaveText(/downloads\s*1,230/);
    await expect(page.getByTestId('stats-apps')).toHaveText(/apps opened this week\s*40/);
    await expect(block).toContainText('Approximate');
    await expect(block.getByRole('link')).toHaveAttribute('href', '/swarmcast/about/privacy/#how-the-numbers-on-the-home-page-are-counted');
    await block.scrollIntoViewIfNeeded();
    await shot(page, 'stats-en', false);

    // Act
    await page.goto('/swarmcast/pt-br/');

    // Assert
    await expect(page.getByTestId('stats-downloads')).toHaveText(/downloads\s*1\.230/);
    await expect(page.getByTestId('stats-apps')).toHaveText(/apps abertos nesta semana\s*40/);
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
    test(`${url} fits a 360 px screen and keeps the language link visible`, async ({ visit }) => {
      // Arrange
      const { page } = await visit({ ...PHONE, locale: localeOf(url), stats: true });

      // Act
      await page.goto(url);
      await pageSettled(page);

      // Assert
      await noHorizontalScroll(page);
      await expect(page.getByTestId(toggle)).toBeVisible();
      await shot(page, name);
    });
  }

  test('the phone language link switches the page', async ({ visit }) => {
    // Arrange
    const { page } = await visit(PHONE);
    await page.goto('/swarmcast/live/p2p/');

    // Act
    await page.getByTestId('lang-mobile').click();

    // Assert
    await expect(page).toHaveURL(/\/swarmcast\/pt-br\/live\/p2p\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ajudar a transmissão (P2P)');
  });
});

test('the guide has an overview page; the logo goes home and Guide comes back', async ({ visit }) => {
  // Arrange
  const { page } = await visit();

  // Act
  await page.goto('/swarmcast/guide/');

  // Assert
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The SwarmCast guide');

  // Act
  await page.getByRole('link', { name: 'SwarmCast home' }).first().click();

  // Assert
  await expect(page).toHaveURL(/\/swarmcast\/$/);

  // Act
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Guide' }).click();

  // Assert
  await expect(page).toHaveURL(/\/swarmcast\/guide\/$/);
});

for (const [url, lang, same, other, only] of [
  ['/swarmcast/start/obs/', 'en', 'A. Same scene everywhere', 'B. A different scene for SwarmCast', 'Only SwarmCast'],
  ['/swarmcast/pt-br/start/obs/', 'pt-br', 'A. A mesma cena em todo lugar', 'B. Outra cena para o SwarmCast', 'Só no SwarmCast'],
] as const) {
  test(`the OBS guide (${lang}) offers both methods, linked from the chooser at the top, with every screenshot loaded in the page language`, async ({ visit }) => {
    // Arrange
    const { page } = await visit();

    // Act
    await page.goto(url);

    // Assert
    const main = page.locator('main');
    for (const name of [same, other, only]) {
      await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name, exact: true }).first()).toBeVisible();
    }
    const imgs = main.locator('img');
    expect(await imgs.count()).toBeGreaterThanOrEqual(15);
    for (const img of await imgs.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect(img).toHaveJSProperty('complete', true);
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    }
    await expect(imgs.first()).toHaveAttribute('alt', lang === 'en' ? /Docks menu/ : /menu Painéis/);
  });
}

for (const url of ['/swarmcast/', '/swarmcast/pt-br/', '/swarmcast/download/', '/swarmcast/start/obs/', '/swarmcast/pt-br/start/obs/', '/swarmcast/viewers/', '/swarmcast/pt-br/viewers/', '/swarmcast/live/go-live/', '/swarmcast/pt-br/live/go-live/']) {
  test(`${url} has alt text on its images`, async ({ visit }) => {
    // Arrange
    const { page } = await visit();

    // Act
    await page.goto(url);

    // Assert
    await expect(page.locator('main img:not([alt]), main img[alt=""]')).toHaveCount(0);
  });
}

test.describe('illustrated guides', () => {
  for (const [slug, min, en, pt] of GUIDES) {
    for (const [lang, url, alt] of [
      ['en', `/swarmcast/${slug}/`, en],
      ['pt-BR', `/swarmcast/pt-br/${slug}/`, pt],
    ] as const) {
      test(`${url}: screenshots in the page language load, with alt text`, async ({ visit }) => {
        // Arrange
        const { page } = await visit({ locale: lang === 'en' ? 'en-US' : 'pt-BR' });

        // Act
        await page.goto(url);

        // Assert
        const imgs = page.locator('main .sl-markdown-content img');
        expect(await imgs.count()).toBeGreaterThanOrEqual(min);
        for (const img of await imgs.all()) {
          await img.scrollIntoViewIfNeeded();
          await expect(img).toHaveJSProperty('complete', true);
          expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
          expect((await img.getAttribute('alt'))?.length ?? 0, 'alt text').toBeGreaterThan(10);
        }
        expect(await imgs.evaluateAll((l) => l.map((i) => (i as HTMLImageElement).alt).join('\n'))).toMatch(alt);
      });
    }
  }

  for (const url of ['/swarmcast/start/first-run/', '/swarmcast/pt-br/live/go-live/', '/swarmcast/pt-br/live/kick-and-new-link/', '/swarmcast/viewers/', '/swarmcast/pt-br/install/macos/', '/swarmcast/install/windows/']) {
    test(`${url} fits a 360 px screen with its screenshots`, async ({ visit }) => {
      // Arrange
      const { page } = await visit({ ...PHONE, locale: localeOf(url) });
      await page.goto(url);

      // Act
      for (const img of await page.locator('main img').all()) await img.scrollIntoViewIfNeeded();
      await fontsLoaded(page);

      // Assert
      await noHorizontalScroll(page);
      const tooWide = await page.locator('main img').evaluateAll((l) => l.filter((i) => i.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
      expect(tooWide, 'screenshots wider than the screen').toBe(0);
    });
  }
});

test('keyboard users see where they are', async ({ visit }) => {
  // Arrange
  const { page } = await visit();
  await page.goto('/swarmcast/');

  // Act
  await page.keyboard.press('Tab');

  // Assert
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeInViewport();

  // Act
  await page.keyboard.press('Tab');

  // Assert
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe('none');
});
