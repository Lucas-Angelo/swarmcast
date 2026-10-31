import { defineConfig, devices } from '@playwright/test';
import { assertFixedPorts, FIXED_PORTS } from '../scripts/test/lib/ports.mjs';

// Tests the BUILT site (`npm run build` first), served like GitHub Pages by test/serve.mjs.
// SITE_E2E_PORT moves the port (default FIXED_PORTS.site, 13210: clear of SwarmCast's own ports and
// of every ephemeral range, scripts/test/lib/ports.mjs).
const PORT = Number(process.env.SITE_E2E_PORT ?? FIXED_PORTS.site.http);
assertFixedPorts('site', { http: PORT }, `SITE_E2E_PORT=${PORT}`);
// Google Chrome (installed on GitHub's runner images and most desktops), as the root config does:
// no browser download. PW_CHROMIUM_CHANNEL='' uses Playwright's own Chromium instead
// (`npx playwright install chromium` first).
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // Never retried, CI included: a test that fails once is a bug to fix, not a flake to rerun.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // The same browser language and time zone on every machine: a browser in Portuguese is sent
    // to the pt-BR pages on its first visit, so the system's language must not decide the test.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `node test/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/swarmcast/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(chromiumChannel ? { channel: chromiumChannel } : {}) } }],
});
