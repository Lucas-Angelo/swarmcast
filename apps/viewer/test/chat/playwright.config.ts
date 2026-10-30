import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The viewer chat UI against a mock hub (mock-hub.ts): the built watch page (npm run build -w
// @swarmcast/viewer) is served by page.route from apps/viewer/dist and /control is a
// routeWebSocket, so no server, stream or network is needed. Run:
//   npx playwright test -c apps/viewer/test/chat/playwright.config.ts
// The same flows against the real server: apps/server/test/e2e/chat.spec.ts.
const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report', 'chat-ui') }]] : 'list',
  outputDir: path.join(root, 'test-results', 'chat-ui'),
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grepInvert: /@mobile/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grepInvert: /@mobile/ },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] }, grep: /@mobile|screenshots/ },
  ],
});
