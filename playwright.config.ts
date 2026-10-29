import { defineConfig, devices } from '@playwright/test';

// Keep in sync with apps/server/test/e2e/server.ts (SWARMCAST_E2E_PORT_OFFSET moves all ports).
const PUBLIC = 38080 + Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0);
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'apps/server/test/e2e',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  // One worker, one e2e server: the media tests are CPU-sensitive (the runner also encodes the
  // stream). Tests are independent (the gate in fixtures.ts resets the server before each), so
  // a retry re-runs one test, not its file. Every test is tagged @media (live video, P2P, the
  // ladder: p2p, quality, adaptive-delay, attack) or @ui (the rest), so CI can run the two
  // groups on separate runners: `--grep @media` / `--grep @ui`.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // CI keeps the evidence of every run (_e2e.yml uploads playwright-report/ and test-results/ unless
  // cancelled, flaky-green runs included): the HTML report, results.json for flake statistics,
  // and annotations on the PR. test-results/ also holds e2e-server.log and fake-obs.log.
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : 'list',
  reportSlowTests: { max: 10, threshold: 60_000 },
  use: {
    baseURL: `http://127.0.0.1:${PUBLIC}`,
    // CI: a trace for every retried (failed or flaky) test, and no tracing cost on first attempts.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
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
