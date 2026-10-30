import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import type { Platform } from './phone.js';

// The live viewer in real mobile browsers (docs/TESTING.md "Real devices"): Chrome on an Android
// emulator and Mobile Safari on an iOS Simulator, against the e2e server (SwarmCast from source,
// a temp data folder, a fake OBS: apps/server/test/e2e/server.ts). Set up the phones first with
// scripts/test/devices/setup.sh install android|ios. Run from the repository root, after
// `npm run build` and `npm run fetch-bins`:
//   npx playwright test -c apps/server/test/devices/playwright.config.ts --project=android-chrome
//   npx playwright test -c apps/server/test/devices/playwright.config.ts --project=ios-safari
// Platform-only tests carry @android or @ios. The second chat viewer is a desktop Google Chrome
// (PW_CHROMIUM_CHANNEL='' for Playwright's Chromium).
const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
// Keep in sync with apps/server/test/e2e/server.ts (SWARMCAST_E2E_PORT_OFFSET moves all ports).
const PUBLIC = 38080 + Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0);
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';
const desktopViewer = { ...devices['Desktop Chrome'], ...(chromiumChannel ? { channel: chromiumChannel } : {}) };
// As the e2e config: the runner, its workers and the server it starts all use UTC.
process.env.TZ = 'UTC';

export default defineConfig<{ platform: Platform }>({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // A join, live playback for several checks, a background trip of ten seconds of live.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // One phone per platform, one test at a time on it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report', 'devices') }], ['json', { outputFile: path.join(root, 'test-results', 'devices.json') }]]
    : 'list',
  outputDir: path.join(root, 'test-results', 'devices'),
  use: {
    baseURL: `http://127.0.0.1:${PUBLIC}`,
    // The desktop viewer, as in the e2e config. The phones keep their own settings (English).
    trace: { mode: 'retain-on-failure', screenshots: false },
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  },
  webServer: {
    command: 'node --import tsx apps/server/test/e2e/server.ts',
    cwd: root,
    url: `http://127.0.0.1:${PUBLIC}/healthz`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { SWARMCAST_NO_OPEN: '1' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [
    { name: 'android-chrome', use: { ...desktopViewer, platform: 'android' }, grepInvert: /@ios/ },
    { name: 'ios-safari', use: { ...desktopViewer, platform: 'ios' }, grepInvert: /@android/ },
  ],
});
