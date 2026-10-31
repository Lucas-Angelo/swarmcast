// The panel's "Get beta versions" switch (Desktop app card) against a real server started like
// the desktop shell starts it (`--desktop`), with this test playing the shell on stdio: the
// switch saves config.json's updates.channel and sends `update-channel` to the shell, and a
// reload reads it back from the server. A stable app has it off; a beta app has the Beta badge
// and the switch on by itself until turned off, and stays a beta (badge) until a stable
// version is higher (no downgrade). Each server has its own temporary data folder, HOME and
// ports, removed after the test; the shared e2e server is not involved. The desktop app shows
// the panel in Chromium (WebView2) and WebKit.
//
// The server sends `update-channel` right after `ready` (desktop.ts), as a line of its own: it
// may arrive a moment after `ready`, so the test polls for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { allocPortMap } from '../../../../scripts/test/lib/ports.mjs';
import { spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { decodeDesktopMessage, type DesktopOutMessage } from '../../src/desktop/protocol.js';
import { ROOT, serverArgs } from '../integration/helpers.js';
import { loginPanel } from './fixtures.js';

type Desktop = { adminUrl: string; dataDir: string; messages: DesktopOutMessage[] };

/** Starts SwarmCast as the desktop shell does, the app reporting `version`; stopped and its folders removed after the test. */
const test = base.extend<{ startDesktop: (version: string) => Promise<Desktop> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function uses from its first argument
  startDesktop: async ({}, use) => {
    const started: Array<{ server: Tracked; dirs: string[] }> = [];
    await use(async (version) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-desktop-'));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-home-'));
      const ports = await allocPortMap(['rtmp', 'public', 'admin', 'mediamtxHls']);
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ports, tunnel: { provider: 'none' }, speedTest: { enabled: false, intervalMinutes: 15 }, onboardingDone: true }));
      const messages: DesktopOutMessage[] = [];
      const server = spawnTracked(process.execPath, serverArgs(['--desktop', '--no-tunnel', '--no-autostart', '--data-dir', dataDir]), {
        name: 'SwarmCast --desktop (e2e)',
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: '',
          SWARMCAST_NO_OPEN: '1',
          SWARMCAST_NO_FFMPEG_INSTALL: '1',
          SWARMCAST_NO_NOTIFY: '1',
          SWARMCAST_LOG_LEVEL: 'warn',
          SWARMCAST_DESKTOP_VERSION: version,
        },
      });
      started.push({ server, dirs: [dataDir, home] });
      server.on('line', (line, stream) => {
        const msg = stream === 'stdout' ? decodeDesktopMessage(line) : null;
        if (msg) messages.push(msg);
      });
      await until(() => messages.some((m) => m.type === 'ready'), { timeoutMs: 60_000, what: 'the desktop server is ready', on: [[server, 'line']], abortOn: [server] });
      const ready = messages.find((m) => m.type === 'ready') as Extract<DesktopOutMessage, { type: 'ready' }>;
      return { adminUrl: ready.adminUrl, dataDir, messages };
    });
    for (const { server, dirs } of started) {
      await server.stop();
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  },
});

test.skip(({ browserName }) => browserName === 'firefox', 'the desktop app shows the panel in Chromium (WebView2) and WebKit');

const TEXT = {
  en: { label: 'Get beta versions', on: 'You get beta versions', feedback: 'Tell us what you find' },
  'pt-BR': { label: 'Receber versões beta', on: 'Você recebe versões beta', feedback: 'Conte o que você encontrou' },
} as const;

const channelsSent = (d: Desktop) => d.messages.filter((m) => m.type === 'update-channel').map((m) => (m as { channel: string | null }).channel);
const savedChannel = (d: Desktop) => (JSON.parse(fs.readFileSync(path.join(d.dataDir, 'config.json'), 'utf8')) as { updates?: { channel?: string } }).updates?.channel;

/** The desktop server's panel (logged in through its login URL), in `lang`, with the Desktop app card shown. */
async function openPanel(page: Page, d: Desktop, lang: 'en' | 'pt-BR'): Promise<void> {
  await loginPanel(page, d.adminUrl);
  await page.goto(new URL(`/?lang=${lang}`, d.adminUrl).toString());
  await expect(page.getByTestId('desktop-card')).toBeVisible();
}

for (const lang of ['en', 'pt-BR'] as const) {
  test(`stable app (${lang}): "Get beta versions" is off; on and off again reach config.json and the shell`, { tag: '@ui' }, async ({ page, startDesktop }) => {
    // Arrange
    const d = await startDesktop('0.2.2');
    await expect.poll(() => channelsSent(d)).toEqual([null]);
    await openPanel(page, d, lang);
    const toggle = page.getByTestId('beta-updates');

    // Assert
    await expect(page.getByTestId('desktop-card').getByText(TEXT[lang].label)).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('beta-badge')).toHaveCount(0);
    await expect(page.getByTestId('beta-note')).toHaveCount(0);

    // Act
    await toggle.check();

    // Assert
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('beta-note')).toContainText(TEXT[lang].on);
    await expect(page.getByTestId('beta-note').getByRole('link', { name: TEXT[lang].feedback })).toHaveAttribute('href', /discussions\/categories\/beta-feedback$/);
    await expect.poll(() => channelsSent(d)).toEqual([null, 'beta']);
    expect(savedChannel(d)).toBe('beta');

    // Act
    await page.reload();

    // Assert
    await expect(page.getByTestId('beta-updates')).toBeChecked();

    // Act
    await page.getByTestId('beta-updates').uncheck();

    // Assert
    await expect(page.getByTestId('beta-updates')).not.toBeChecked();
    await expect(page.getByTestId('beta-note')).toHaveCount(0);
    await expect.poll(() => channelsSent(d)).toEqual([null, 'beta', 'stable']);
    expect(savedChannel(d)).toBe('stable');
  });
}

test('beta app (pt-BR): the Beta badge, and "Get beta versions" on by itself until turned off', { tag: '@ui' }, async ({ page, startDesktop }) => {
  // Arrange
  const d = await startDesktop('0.3.0-beta.1');

  // Act
  await openPanel(page, d, 'pt-BR');

  // Assert
  await expect(page.getByTestId('desktop-version')).toContainText('0.3.0-beta.1');
  await expect(page.getByTestId('beta-badge')).toHaveText('Beta');
  await expect(page.getByTestId('beta-updates')).toBeChecked();
  expect(savedChannel(d)).toBeUndefined();

  // Act
  await page.getByTestId('beta-updates').uncheck();

  // Assert
  await expect.poll(() => channelsSent(d)).toEqual([null, 'stable']);
  expect(savedChannel(d)).toBe('stable');

  // Act
  await page.reload();

  // Assert
  await expect(page.getByTestId('beta-updates')).not.toBeChecked();
  await expect(page.getByTestId('beta-badge')).toBeVisible();
});
