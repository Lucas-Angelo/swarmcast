// Playwright globalSetup for the chat UI specs: start every engine of the config once and lay out
// emoji and the scripts the specs use, before any test's clock runs. The first start of a browser
// on a fresh CI runner is slow far beyond the page under test (Windows scans the new binary and
// builds its font caches: Firefox there took over 30 s to load the first page, and the next tests
// 17-19 s instead of under one). Each test's own browser is then warm except for its per-process
// font fallback, which openWatch handles (watch-page.ts). Engines that are not installed are skipped.
import { chromium, firefox, webkit, type BrowserType, type FullConfig } from '@playwright/test';
import { WARM_TEXTS } from './watch-page.js';

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

export default async function warmBrowsers(config: FullConfig): Promise<void> {
  const seen = new Set<string>();
  for (const project of config.projects) {
    const name = project.use.browserName ?? project.use.defaultBrowserType ?? 'chromium';
    const channel = project.use.channel;
    const key = `${name}:${channel ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t0 = Date.now();
    let browser;
    try {
      browser = await TYPES[name]!.launch(channel ? { channel } : {});
    } catch (err) {
      // Not installed on this runner (its project is not run here either). Said, not swallowed: an
      // engine that is installed but cannot start fails its tests, and this line tells why.
      console.log(`not warmed ${key.replace(/:$/, '')}: ${String((err as Error).message).split('\n')[0]}`);
      continue;
    }
    try {
      const page = await browser.newPage();
      await page.evaluate(async (list) => {
        for (const t of list) {
          const p = document.createElement('p');
          p.textContent = t;
          document.body.append(p);
        }
        document.body.getBoundingClientRect();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, WARM_TEXTS);
    } finally {
      await browser.close();
    }
    console.log(`warmed ${key.replace(/:$/, '')} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
