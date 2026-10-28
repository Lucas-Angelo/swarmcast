import { defineConfig, devices } from '@playwright/test';

// Tests the BUILT site (`npm run build` first), served like GitHub Pages by test/serve.mjs.
// SITE_E2E_PORT moves the port (default 43210; far from SwarmCast's own ports).
const PORT = Number(process.env.SITE_E2E_PORT ?? 43210);
// Google Chrome (installed on GitHub's runner images and most desktops), as the root config does:
// no browser download. PW_CHROMIUM_CHANNEL='' uses Playwright's own Chromium instead
// (`npx playwright install chromium` first).
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node test/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/swarmcast/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(chromiumChannel ? { channel: chromiumChannel } : {}) } }],
});
