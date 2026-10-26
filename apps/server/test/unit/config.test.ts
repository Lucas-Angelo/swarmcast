import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUICK_TUNNEL_MAX_VIEWERS } from '@swarmcast/shared';
import { CONFIG_VERSION, defaultConfig, loadConfig, migrateConfig, persistableConfig, saveConfig } from '../../src/core/config.js';
import { defaultDataDir } from '../../src/core/paths.js';
import { generateSecrets, loadOrCreateSecrets, randomToken } from '../../src/core/secrets.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-cfg-'));

describe('config', () => {
  it('has safe defaults', () => {
    const c = defaultConfig();
    expect(c.ports).toEqual({ rtmp: 1935, public: 8080, admin: 8081, mediamtxHls: 8888 });
    expect(c.tunnel.provider).toBe('cloudflare-quick');
    expect(c.uploadLimitMbps).toBe(100);
    expect(c.autoStopMinutes).toBe(10);
    expect(c.stunServers).toEqual(['stun:stun.cloudflare.com:3478']);
  });

  it('creates the file on first load and round-trips', () => {
    const f = path.join(tmp(), 'config.json');
    const c = loadConfig(f);
    expect(fs.existsSync(f)).toBe(true);
    c.uploadLimitMbps = 42;
    saveConfig(f, c);
    expect(loadConfig(f).uploadLimitMbps).toBe(42);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('never persists run-only values (fallback ports, --no-tunnel)', () => {
    const onDisk = defaultConfig();
    const runtime = { ...defaultConfig(), ports: { ...onDisk.ports, admin: 8082 }, tunnel: { provider: 'none' as const }, onboardingDone: true };
    const saved = persistableConfig(runtime, onDisk, { noTunnel: true });
    expect(saved.ports.admin).toBe(8081);
    expect(saved.tunnel.provider).toBe('cloudflare-quick');
    expect(saved.onboardingDone).toBe(true);
    // A tunnel setting chosen in the config file itself is still saved as is.
    const external = { ...defaultConfig(), tunnel: { provider: 'none' as const } };
    expect(persistableConfig(external, external).tunnel.provider).toBe('none');
  });

  it('turns the browser check on by default', () => {
    expect(defaultConfig().security.requireBrowserCheck).toBe(true);
    expect(defaultConfig().configVersion).toBe(CONFIG_VERSION);
  });

  it('migrates a v0.1.0 file once: its saved "browser check off" (the old default) becomes on', () => {
    const f = path.join(tmp(), 'config.json');
    // What v0.1.0 wrote: no version, every default spelled out (requireBrowserCheck: false).
    const old = { ...defaultConfig(), security: { ...defaultConfig().security, requireBrowserCheck: false, autoNewLink: true } } as Record<string, unknown>;
    delete old.configVersion;
    fs.writeFileSync(f, JSON.stringify(old));
    const c = loadConfig(f);
    expect(c.security.requireBrowserCheck).toBe(true);
    // Other choices are kept.
    expect(c.security.autoNewLink).toBe(true);
    expect(c.configVersion).toBe(CONFIG_VERSION);
    // Written back once.
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toMatchObject({ configVersion: CONFIG_VERSION, security: { requireBrowserCheck: true } });

    // The streamer turns it off after the migration: it stays off on every later load.
    saveConfig(f, { ...c, security: { ...c.security, requireBrowserCheck: false } });
    expect(loadConfig(f).security.requireBrowserCheck).toBe(false);
    expect(loadConfig(f).security.requireBrowserCheck).toBe(false);
  });

  it('migration: pure function cases', () => {
    expect(migrateConfig({ security: { requireBrowserCheck: false } })).toEqual({ config: { configVersion: 3, security: { requireBrowserCheck: true } }, changed: true });
    // Old file without the switch: only the version is added (the new default applies).
    expect(migrateConfig({ uploadLimitMbps: 5 })).toEqual({ config: { uploadLimitMbps: 5, configVersion: 3 }, changed: true });
    expect(migrateConfig({ configVersion: 1, security: { requireBrowserCheck: true } }).config).toMatchObject({ security: { requireBrowserCheck: true } });
    // Version 2 (or newer) files are the streamer's choice.
    expect(migrateConfig({ configVersion: 2, security: { requireBrowserCheck: false } })).toEqual({
      config: { configVersion: 3, security: { requireBrowserCheck: false } },
      changed: true,
    });
    expect(migrateConfig({ configVersion: 3, security: { requireBrowserCheck: false } }).changed).toBe(false);
    expect(migrateConfig({ configVersion: 4, security: { requireBrowserCheck: false } }).changed).toBe(false);
    // Unknown shapes pass through untouched (the schema reports them).
    for (const x of [null, 5, 'x', [1]]) expect(migrateConfig(x)).toEqual({ config: x, changed: false });
    const input = { security: { requireBrowserCheck: false } };
    migrateConfig(input);
    expect(input).toEqual({ security: { requireBrowserCheck: false } });
  });

  it('defaults maxViewers to what a quick tunnel holds, and migrates the old default 500 once', () => {
    expect(defaultConfig().maxViewers).toBe(QUICK_TUNNEL_MAX_VIEWERS);
    // 500 saved before version 3 was the old default: it becomes 120.
    expect(migrateConfig({ maxViewers: 500 }).config).toMatchObject({ maxViewers: QUICK_TUNNEL_MAX_VIEWERS, configVersion: 3 });
    expect(migrateConfig({ configVersion: 2, maxViewers: 500 }).config).toMatchObject({ maxViewers: QUICK_TUNNEL_MAX_VIEWERS });
    // Any other number was the streamer's choice.
    expect(migrateConfig({ configVersion: 2, maxViewers: 300 }).config).toMatchObject({ maxViewers: 300 });
    // A 500 chosen after the migration stays.
    expect(migrateConfig({ configVersion: 3, maxViewers: 500 })).toEqual({ config: { configVersion: 3, maxViewers: 500 }, changed: false });
    const f = path.join(tmp(), 'config.json');
    const old = { ...defaultConfig(), configVersion: 2, maxViewers: 500 };
    fs.writeFileSync(f, JSON.stringify(old));
    expect(loadConfig(f).maxViewers).toBe(QUICK_TUNNEL_MAX_VIEWERS);
    saveConfig(f, { ...loadConfig(f), maxViewers: 500 });
    expect(loadConfig(f).maxViewers).toBe(500);
  });

  it('rejects invalid values with a clear error', () => {
    const f = path.join(tmp(), 'config.json');
    fs.writeFileSync(f, JSON.stringify({ uploadLimitMbps: -5 }));
    expect(() => loadConfig(f)).toThrow(/Invalid config/);
  });

  it('uses per-user data directories', () => {
    expect(defaultDataDir('darwin', {})).toMatch(/Library[\\/]Application Support[\\/]SwarmCast$/);
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/x' })).toBe(path.join('/x', 'swarmcast'));
    expect(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toContain('SwarmCast');
    expect(defaultDataDir('linux', { SWARMCAST_DATA_DIR: '/tmp/a' })).toBe(path.resolve('/tmp/a'));
  });
});

describe('secrets', () => {
  it('generates a stream key and Ed25519 key once, stored privately', () => {
    const f = path.join(tmp(), 'secrets.json');
    const a = loadOrCreateSecrets(f);
    const b = loadOrCreateSecrets(f);
    expect(a.streamKey).toBe(b.streamKey);
    expect(a.streamKey).toMatch(/^sc_[A-Za-z0-9]{24}$/);
    expect(a.manifestPrivateKeyPem).toContain('PRIVATE KEY');
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('adds a browser check key to secrets.json from v0.1.0 and keeps everything else', () => {
    const f = path.join(tmp(), 'secrets.json');
    const { browserCheckKey: _, ...old } = generateSecrets();
    fs.writeFileSync(f, JSON.stringify(old));
    const a = loadOrCreateSecrets(f);
    expect(a.browserCheckKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.streamKey).toBe(old.streamKey);
    expect(a.manifestPrivateKeyPem).toBe(old.manifestPrivateKeyPem);
    // Stable from then on (a browser stays remembered across restarts).
    expect(loadOrCreateSecrets(f).browserCheckKey).toBe(a.browserCheckKey);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['secrets.json']);
  });

  it('random tokens use an unambiguous alphabet', () => {
    const t = randomToken(500);
    expect(t).toHaveLength(500);
    expect(t).not.toMatch(/[0O1lI]/);
    expect(generateSecrets().streamKey).not.toBe(generateSecrets().streamKey);
  });
});
