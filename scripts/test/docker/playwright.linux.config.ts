// Playwright config for Linux containers (used by e2e.sh). Same as the main config, except:
// - the chromium project uses Playwright's bundled Chromium (no `channel`): Google Chrome is
//   not available for Linux arm64,
// - paths are absolute so this file can live outside the repo root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const webServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;

export default defineConfig({
  ...base,
  testDir: path.join(root, 'apps/server/test/e2e'),
  outputDir: path.join(root, 'test-results/pw'),
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report') }]],
  webServer: { ...webServer!, cwd: root },
  projects: (base.projects ?? []).map((p) => {
    if (p.name !== 'chromium') return p;
    const { channel: _channel, ...use } = p.use ?? {};
    return { ...p, use };
  }),
});
