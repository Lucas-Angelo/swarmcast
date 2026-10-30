// Shared fixtures of the site's e2e specs: a visitor on a given system and language (the `visit`
// fixture, its browser contexts closed when the test ends, pass or fail), the stats.json the site
// reads, and the waits for the page's own work (fonts, the stats read) instead of network idle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';

export { expect };

/** Screenshots for review (test-results/screens), not checks. */
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/screens');

export const RELEASES = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest';

export const UA = {
  windows: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Win32' },
  macos: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'MacIntel' },
  linux: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Linux x86_64' },
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
} as const;

/** The usage summary the stats workflow publishes (scripts/stats), as the site reads it. */
export const STATS = {
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

export interface Visitor {
  /** The system the browser says it runs on (user agent and navigator.platform). Default windows. */
  os?: keyof typeof UA;
  /** The browser language. Default en-US. */
  locale?: string;
  /** Serve STATS as stats.json (else a 404, like a site deployed before the first stats run). */
  stats?: boolean;
  viewport?: BrowserContextOptions['viewport'];
  /** A phone: touch and the mobile viewport behaviour. */
  isMobile?: boolean;
  colorScheme?: BrowserContextOptions['colorScheme'];
}

/** `visit(visitor)`: a fresh browser context and page for that visitor; every one is closed when the test ends. */
export const test = base.extend<{ visit: (v?: Visitor) => Promise<{ context: BrowserContext; page: Page }> }>({
  visit: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (v = {}) => {
      const ua = UA[v.os ?? 'windows'];
      const context = await browser.newContext({
        userAgent: ua.userAgent,
        locale: v.locale ?? 'en-US',
        timezoneId: 'UTC',
        viewport: v.viewport ?? { width: 1280, height: 900 },
        isMobile: v.isMobile ?? false,
        hasTouch: v.isMobile ?? false,
        ...(v.colorScheme ? { colorScheme: v.colorScheme } : {}),
      });
      contexts.push(context);
      await context.addInitScript((platform) => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform });
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
      }, ua.platform);
      await context.route('**/swarmcast/stats.json', (route) =>
        v.stats ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(STATS) }) : route.fulfill({ status: 404, body: 'Not found' }),
      );
      return { context, page: await context.newPage() };
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});

/** Waits until a component that reads stats.json (download button, download page, usage numbers) is done with it. */
export async function statsRead(component: Locator): Promise<void> {
  await expect(component).toHaveAttribute('aria-busy', 'false');
}

/** Waits until the page's web fonts are loaded (text widths are final). */
export async function fontsLoaded(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Waits until the page is done with its own work after load: every component that reads
 * stats.json has read it (they are aria-busy until then; their scripts run before the load event
 * page.goto waits for) and the web fonts are in. The layout is final then.
 */
export async function pageSettled(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await fontsLoaded(page);
}

/** The page does not scroll sideways. */
export async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page must not scroll sideways').toBeLessThanOrEqual(client);
}

/** Saves a screenshot for review as test-results/screens/<name>.png. */
export async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage, animations: 'disabled', caret: 'hide' });
}
