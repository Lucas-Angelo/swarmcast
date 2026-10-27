import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERIFIED_COOKIE } from '@swarmcast/shared';
import { createApp, type App } from '../../src/app.js';
import { CONFIG_VERSION, defaultConfig } from '../../src/core/config.js';
import { generateSecrets } from '../../src/core/secrets.js';
import { Jar, joinAs, tmpDir } from './helpers.js';

const PORTS = { rtmp: 29850, public: 28580, admin: 28581, mediamtxHls: 29888 };
const BASE = `http://127.0.0.1:${PORTS.public}`;

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(dataDir: string): Promise<App> {
  app = await createApp({ dataDir, noTunnel: true, noReaper: true, logToStdout: false, configOverrides: { ports: PORTS, speedTest: { enabled: false, intervalMinutes: 15 } } });
  await app.live.start();
  return app;
}

async function challengeRequired(jar: Jar, link: string): Promise<boolean> {
  expect((await jar.fetch(link)).status).toBe(303);
  return ((await (await jar.fetch('/api/join/challenge')).json()) as { required: boolean }).required;
}

describe('browser check with the real app: v0.1.0 upgrade and restarts', () => {
  it('turns the check on for a v0.1.0 data folder and remembers a browser across an app restart', async () => {
    const dir = tmpDir();
    // A data folder written by v0.1.0: the old default saved explicitly, no browser check key.
    const old = { ...defaultConfig(), ports: PORTS, security: { ...defaultConfig().security, requireBrowserCheck: false } } as Record<string, unknown>;
    delete old.configVersion;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(old));
    const { browserCheckKey: _, ...oldSecrets } = generateSecrets();
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(oldSecrets));

    let a = await boot(dir);
    expect(a.live.snapshot().security.settings.requireBrowserCheck).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toMatchObject({ configVersion: CONFIG_VERSION, security: { requireBrowserCheck: true } });
    const key = (JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as { browserCheckKey: string; streamKey: string });
    expect(key.browserCheckKey).toMatch(/^[0-9a-f]{64}$/);
    expect(key.streamKey).toBe(oldSecrets.streamKey);

    const browser = new Jar(BASE);
    expect(await challengeRequired(browser, a.live.snapshot().liveLink!)).toBe(true);
    await joinAs(BASE, a.live.snapshot().liveLink!, 'Ana', browser);
    expect(browser.has(VERIFIED_COOKIE)).toBe(true);

    // "Another day": the app restarts, a new live has a new link.
    await a.close();
    app = null;
    a = await boot(dir);
    expect(await challengeRequired(browser, a.live.snapshot().liveLink!)).toBe(false);
    expect(await challengeRequired(new Jar(BASE), a.live.snapshot().liveLink!)).toBe(true);

    // The streamer turns it off: that choice survives the next restart.
    a.live.updateSecurity({ ...a.live.securitySettings(), requireBrowserCheck: false });
    await a.close();
    app = null;
    a = await boot(dir);
    expect(a.live.snapshot().security.settings.requireBrowserCheck).toBe(false);
    expect(await challengeRequired(new Jar(BASE), a.live.snapshot().liveLink!)).toBe(false);
  });
});
