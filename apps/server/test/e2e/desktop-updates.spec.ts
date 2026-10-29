import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { allocPortMap } from '../../../../scripts/test/lib/ports.mjs';
import { spawnTracked, stopTracked } from '../../../../scripts/test/lib/proc.mjs';
import { decodeDesktopMessage, type DesktopOutMessage } from '../../src/desktop/protocol.js';
import { ROOT, serverArgs } from '../integration/helpers.js';

// The panel's "Get beta versions" switch (Desktop app card) against a real server started like
// the desktop shell starts it (`--desktop`), with this test playing the shell on stdio: the
// switch saves config.json's updates.channel and sends `update-channel` to the shell. Its own
// temporary data folder, HOME and ports; the shared e2e server is not involved.

type Desktop = { adminUrl: string; dataDir: string; messages: DesktopOutMessage[] };

async function startDesktop(version: string): Promise<Desktop> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-desktop-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-home-'));
  const ports = await allocPortMap(['rtmp', 'public', 'admin', 'mediamtxHls']);
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ ports, tunnel: { provider: 'none' }, speedTest: { enabled: false, intervalMinutes: 15 }, onboardingDone: true }),
  );
  const messages: DesktopOutMessage[] = [];
  const t = spawnTracked(process.execPath, serverArgs(['--desktop', '--no-tunnel', '--no-autostart', '--data-dir', dataDir]), {
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
  t.on('line', (line: string, stream: string) => {
    const msg = stream === 'stdout' ? decodeDesktopMessage(line) : null;
    if (msg) messages.push(msg);
  });
  await expect.poll(() => messages.find((m) => m.type === 'ready'), { timeout: 60_000, message: 'the server is ready' }).toBeTruthy();
  const ready = messages.find((m) => m.type === 'ready') as Extract<DesktopOutMessage, { type: 'ready' }>;
  return { adminUrl: ready.adminUrl, dataDir, messages };
}

const channelsSent = (d: Desktop) => d.messages.filter((m) => m.type === 'update-channel').map((m) => (m as { channel: string | null }).channel);
const savedChannel = (d: Desktop) => (JSON.parse(fs.readFileSync(path.join(d.dataDir, 'config.json'), 'utf8')) as { updates?: { channel?: string } }).updates?.channel;

async function openPanel(page: Page, d: Desktop, lang: 'en' | 'pt-BR'): Promise<void> {
  // The login page sets the cookie and moves on to / by itself (meta refresh): wait for that
  // navigation before starting another one.
  await page.goto(d.adminUrl);
  await expect(page).toHaveURL(new URL('/', d.adminUrl).toString());
  await page.goto(new URL(`/?lang=${lang}`, d.adminUrl).toString());
  await expect(page.getByTestId('desktop-card')).toBeVisible();
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName === 'firefox', 'the desktop app shows the panel in Chromium (WebView2) and WebKit');
});
test.afterEach(async () => {
  await stopTracked();
});

const TEXT = {
  en: { label: 'Get beta versions', on: 'You get beta versions', feedback: 'Tell us what you find' },
  'pt-BR': { label: 'Receber versões beta', on: 'Você recebe versões beta', feedback: 'Conte o que você encontrou' },
} as const;

for (const lang of ['en', 'pt-BR'] as const) {
  test(`stable app (${lang}): "Get beta versions" is off; on and off again reach config.json and the shell`, { tag: '@ui' }, async ({ page }) => {
    const d = await startDesktop('0.2.2');
    expect(channelsSent(d)).toEqual([null]);
    await openPanel(page, d, lang);
    const toggle = page.getByTestId('beta-updates');
    await expect(page.getByTestId('desktop-card').getByText(TEXT[lang].label)).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('beta-badge')).toHaveCount(0);
    await expect(page.getByTestId('beta-note')).toHaveCount(0);

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('beta-note')).toContainText(TEXT[lang].on);
    await expect(page.getByTestId('beta-note').getByRole('link', { name: TEXT[lang].feedback })).toHaveAttribute('href', /discussions\/categories\/beta-feedback$/);
    await expect.poll(() => channelsSent(d)).toEqual([null, 'beta']);
    expect(savedChannel(d)).toBe('beta');

    // Kept across a reload (read back from the server).
    await page.reload();
    await expect(page.getByTestId('beta-updates')).toBeChecked();

    await page.getByTestId('beta-updates').uncheck();
    await expect(page.getByTestId('beta-updates')).not.toBeChecked();
    await expect(page.getByTestId('beta-note')).toHaveCount(0);
    await expect.poll(() => channelsSent(d)).toEqual([null, 'beta', 'stable']);
    expect(savedChannel(d)).toBe('stable');
  });
}

test('beta app (pt-BR): the Beta badge, and "Get beta versions" on by itself until turned off', { tag: '@ui' }, async ({ page }) => {
  const d = await startDesktop('0.3.0-beta.1');
  await openPanel(page, d, 'pt-BR');
  await expect(page.getByTestId('desktop-version')).toContainText('0.3.0-beta.1');
  await expect(page.getByTestId('beta-badge')).toHaveText('Beta');
  await expect(page.getByTestId('beta-updates')).toBeChecked();
  expect(savedChannel(d)).toBeUndefined();

  await page.getByTestId('beta-updates').uncheck();
  await expect.poll(() => channelsSent(d)).toEqual([null, 'stable']);
  expect(savedChannel(d)).toBe('stable');
  await page.reload();
  await expect(page.getByTestId('beta-updates')).not.toBeChecked();
  // Still a beta until a stable version is higher (no downgrade): the badge stays.
  await expect(page.getByTestId('beta-badge')).toBeVisible();
});
