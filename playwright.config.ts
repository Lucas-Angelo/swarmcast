import { defineConfig, devices } from '@playwright/test';

// Keep in sync with apps/server/test/e2e/server.ts (SWARMCAST_E2E_PORT_OFFSET moves all ports).
const PUBLIC = 38080 + Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0);
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'apps/server/test/e2e',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PUBLIC}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx apps/server/test/e2e/server.ts',
    url: `http://127.0.0.1:${PUBLIC}/healthz`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Let the test server stop MediaMTX itself (the reaper is the fallback).
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Google Chrome ships H.264/AAC decoders. PW_CHROMIUM_CHANNEL='' uses Playwright's own
        // Chromium instead.
        ...(chromiumChannel ? { channel: chromiumChannel } : {}),
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.autoplay.default': 0,
            'media.peerconnection.ice.obfuscate_host_addresses': false,
            'media.peerconnection.ice.loopback': true,
          },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
