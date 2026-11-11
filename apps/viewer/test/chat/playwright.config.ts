import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { browserTempOnWorkDisk } from '../../../../scripts/test/lib/browser-temp.mjs';
import { firefoxEnv, firefoxPrefs } from '../../../../scripts/test/lib/firefox.mjs';

// The viewer chat UI against a mock hub (mock-hub.ts): the built watch page (npm run build -w
// @swarmcast/viewer) is served by page.route from apps/viewer/dist and /control is a
// routeWebSocket, so no server, stream or network is needed. Run:
//   npx playwright test -c apps/viewer/test/chat/playwright.config.ts
// The same flows against the real server: apps/server/test/e2e/chat.spec.ts.
const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
// On a Windows CI runner every browser profile goes on the runner's local disk, not on C:, where
// Defender's signature update can stall a new Firefox for a minute (scripts/test/lib/browser-temp.mjs).
// Before anything launches: globalSetup's browsers, the workers and theirs.
browserTempOnWorkDisk();

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Two workers on CI, whatever the runner. Playwright's default is half the CPUs: two on the
  // 4-CPU Ubuntu and Windows runners, but one on the 3-CPU macOS ones, where the same 326 tests then
  // took 4.9-10.1 minutes (p50 7.3 in the e2e chat job, whose 10-minute step limit one run
  // outlasted), against 3.1-5.3 on Ubuntu and 2.4-3.2 on the macOS hosts with more CPUs, which got
  // two (pipeline runs of 2026-11-07 to 11-11). Every test has its own page, context and mock hub,
  // and the warm-ups (globalSetup, then each worker's browser in fixtures.ts) are made for several
  // workers. Locally, the default.
  workers: process.env.CI ? 2 : undefined,
  // Never retried, CI included: a test that fails once is a bug to fix, not a flake to rerun.
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report', 'chat-ui') }], ['json', { outputFile: path.join(root, 'test-results', 'chat-ui.json') }]]
    : 'list',
  outputDir: path.join(root, 'test-results', 'chat-ui'),
  // Every engine started once before the tests (warm-browsers.ts): a fresh runner's first start is not the page.
  // Each worker's own browser is warmed too, before its first test (fixtures.ts).
  globalSetup: path.join(import.meta.dirname, 'warm-browsers.ts'),
  // The same browser language and time zone on every machine (the page's language comes from
  // ?lang=, but Intl formatting and the first-visit language follow the browser's).
  use: { trace: 'retain-on-failure', locale: 'en-US', timezoneId: 'UTC' },
  projects: [
    // CI (the `ui` group of _e2e.yml) has Google Chrome from the runner image, not Playwright's
    // Chromium, like the main suite's `chromium` project.
    // @bundle (a check of the built files, no browser) runs once, in the chromium project.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.CI ? { channel: 'chrome' } : {}) }, grepInvert: /@mobile/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { env: firefoxEnv(), firefoxUserPrefs: firefoxPrefs() } }, grepInvert: /@mobile|@bundle/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grepInvert: /@mobile|@bundle/ },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] }, grep: /@mobile|@render|screenshots/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], ...(process.env.CI ? { channel: 'chrome' } : {}) }, grep: /@mobile|@render/ },
    // Microsoft Edge where it is installed (rendering.yml on Windows sets CHAT_EDGE=1).
    ...(process.env.CHAT_EDGE ? [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' }, grepInvert: /@mobile|@bundle/ }] : []),
  ],
});
