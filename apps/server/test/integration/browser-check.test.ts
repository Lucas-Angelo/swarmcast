import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERIFIED_COOKIE } from '@swarmcast/shared';
import { createApp, type App } from '../../src/app.js';
import { CONFIG_VERSION, defaultConfig } from '../../src/core/config.js';
import { generateSecrets } from '../../src/core/secrets.js';
import { allocAppPorts, Jar, joinAs, tmpDir, type Ports } from './helpers.js';

// The browser check with the real app: a data folder written by v0.1.0 gets the check turned on,
// and a browser that passed it is remembered across app restarts ("another day": a new live,
// a new link). The ports stay the same across the restarts, as at home: the browser keeps its
// cookies for the same address.

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Closes the running app (if any) and starts the live of a new one on `dir`, like a restart. */
async function boot(dir: string, ports: Ports): Promise<App> {
  await app?.close();
  app = null;
  app = await createApp({ dataDir: dir, noTunnel: true, noReaper: true, logToStdout: false, configOverrides: { ports, speedTest: { enabled: false, intervalMinutes: 15 } } });
  await app.live.start();
  return app;
}

/**
 * A data folder as v0.1.0 wrote it: its default (browser check off) saved explicitly, no config
 * version, no browser check key in secrets.json. No blocklist to fetch (see testConfig()).
 */
function writeV010DataFolder(dir: string, ports: Ports): { streamKey: string } {
  const config = { ...defaultConfig(), ports, security: { ...defaultConfig().security, requireBrowserCheck: false, blocklists: [] } } as Record<string, unknown>;
  delete config.configVersion;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const { browserCheckKey: _, ...secrets } = generateSecrets();
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets));
  return secrets;
}

/** Opens the live link like a browser: the redirect's status, and whether the join page must solve the check. */
async function openLink(jar: Jar, link: string): Promise<{ status: number; checkRequired: boolean }> {
  const status = (await jar.fetch(link)).status;
  const { required } = (await (await jar.fetch('/api/join/challenge')).json()) as { required: boolean };
  return { status, checkRequired: required };
}

const linkOf = (a: App): string => a.live.snapshot().liveLink!;

describe('browser check with the real app: v0.1.0 upgrade and restarts', () => {
  it('turns the check on for a v0.1.0 data folder and remembers a browser across an app restart', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const base = `http://127.0.0.1:${ports.public}`;
    const dir = tmpDir();
    const old = writeV010DataFolder(dir, ports);
    const browser = new Jar(base);
    // Act
    const upgraded = await boot(dir, ports);
    const firstVisit = await openLink(browser, linkOf(upgraded));
    await joinAs(base, linkOf(upgraded), 'Ana', browser);
    // Assert
    expect(upgraded.live.snapshot().security.settings.requireBrowserCheck).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toMatchObject({ configVersion: CONFIG_VERSION, security: { requireBrowserCheck: true } });
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as { browserCheckKey: string; streamKey: string };
    expect(secrets.browserCheckKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.streamKey).toBe(old.streamKey);
    expect(firstVisit).toEqual({ status: 303, checkRequired: true });
    expect(browser.has(VERIFIED_COOKIE)).toBe(true);
    // Act
    const nextDay = await boot(dir, ports);
    const sameBrowser = await openLink(browser, linkOf(nextDay));
    const newBrowser = await openLink(new Jar(base), linkOf(nextDay));
    // Assert
    expect(sameBrowser).toEqual({ status: 303, checkRequired: false });
    expect(newBrowser).toEqual({ status: 303, checkRequired: true });
    // Act
    nextDay.live.updateSecurity({ ...nextDay.live.securitySettings(), requireBrowserCheck: false });
    const afterTurnedOff = await boot(dir, ports);
    const anyBrowser = await openLink(new Jar(base), linkOf(afterTurnedOff));
    // Assert
    expect(afterTurnedOff.live.snapshot().security.settings.requireBrowserCheck).toBe(false);
    expect(anyBrowser).toEqual({ status: 303, checkRequired: false });
  });
});
