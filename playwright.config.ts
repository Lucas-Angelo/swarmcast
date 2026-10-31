import { defineConfig, devices } from '@playwright/test';
import { firefoxEnv } from './scripts/test/lib/firefox.mjs';
import { e2ePorts } from './scripts/test/lib/ports.mjs';

// The e2e server's public port (scripts/test/lib/ports.mjs, moved by SWARMCAST_E2E_PORT_OFFSET).
const PUBLIC = e2ePorts().public;
const chromiumChannel = process.env.PW_CHROMIUM_CHANNEL ?? 'chrome';
// Dates the specs and the e2e server format (log file names, "muted until") do not depend on
// the machine's timezone: the runner, its workers and the server it starts all use UTC.
process.env.TZ = 'UTC';

export default defineConfig({
  testDir: 'apps/server/test/e2e',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  // One worker, one e2e server: the media tests are CPU-sensitive (the runner also encodes the
  // stream). Tests are independent (the gate in fixtures.ts resets the server before each, and
  // every fixture puts back what its test changed). Every test is tagged @media (live video,
  // P2P, the ladder: p2p, quality, adaptive-delay, attack) or @ui (the rest), so CI can run the
  // two groups on separate runners: `--grep @media` / `--grep @ui`.
  fullyParallel: false,
  workers: 1,
  // Never retried, in CI too: a test passes on its first run on every engine and runner, or its
  // cause is found and fixed. A retry would only hide it.
  retries: 0,
  // CI keeps the evidence of every run (_e2e.yml uploads playwright-report/ and test-results/ unless
  // cancelled): the HTML report, results.json for statistics, and annotations on the PR.
  // test-results/ also holds e2e-server.log and fake-obs.log.
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : 'list',
  reportSlowTests: { max: 10, threshold: 60_000 },
  use: {
    baseURL: `http://127.0.0.1:${PUBLIC}`,
    // The first run is the only run: its trace (actions, DOM snapshots, network, console) is
    // kept when it fails, with a screenshot of every page at the end. No screencast: the
    // pages play video, and encoding their frames would take the CPU the media tests measure.
    trace: { mode: 'retain-on-failure', screenshots: false },
    screenshot: 'only-on-failure',
    // The same browser everywhere, whatever the machine is set to: English, UTC, light theme,
    // animations allowed (a spec that needs another locale or scheme asks for it).
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
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
          // Its startup cache stays in memory: writing it can freeze the browser (firefox.mjs).
          env: firefoxEnv(),
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
