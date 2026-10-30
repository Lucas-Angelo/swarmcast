import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUICK_TUNNEL_MAX_VIEWERS } from '@swarmcast/shared';
import { CONFIG_VERSION, defaultConfig, loadConfig, migrateConfig, persistableConfig, saveConfig } from '../../src/core/config.js';
import { defaultDataDir } from '../../src/core/paths.js';
import { generateSecrets, loadOrCreateSecrets, randomToken } from '../../src/core/secrets.js';
import { tempDir } from './helpers.js';

// config.json and secrets.json: defaults, migrations of files older versions wrote, private
// file modes, and the per-user data folder.
//
// Migration history: version 2 turned the browser check on (v0.1.0 saved its old default, off,
// in every file), version 3 lowered the default maxViewers from 500 to what a quick tunnel holds,
// version 4 added the chat.

/** A config.json path in a fresh folder. */
const configFile = (): string => path.join(tempDir('sc-cfg-'), 'config.json');

describe('config', () => {
  it('has safe defaults', () => {
    // Act
    const c = defaultConfig();
    // Assert
    expect(c.ports).toEqual({ rtmp: 1935, public: 8080, admin: 8081, mediamtxHls: 8888 });
    expect(c.tunnel.provider).toBe('cloudflare-quick');
    expect(c.uploadLimitMbps).toBe(100);
    expect(c.autoStopMinutes).toBe(10);
    expect(c.stunServers).toEqual(['stun:stun.cloudflare.com:3478']);
  });

  it('creates the file on first load and round-trips, private (0600)', () => {
    // Arrange
    const f = configFile();
    // Act
    const c = loadConfig(f);
    c.uploadLimitMbps = 42;
    saveConfig(f, c);
    // Assert
    expect(fs.existsSync(f)).toBe(true);
    expect(loadConfig(f).uploadLimitMbps).toBe(42);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('never persists run-only values (fallback ports, --no-tunnel)', () => {
    // Arrange
    const onDisk = defaultConfig();
    const runtime = { ...defaultConfig(), ports: { ...onDisk.ports, admin: 8082 }, tunnel: { provider: 'none' as const }, onboardingDone: true };
    // Act
    const saved = persistableConfig(runtime, onDisk, { noTunnel: true });
    // Assert
    expect(saved.ports.admin).toBe(8081);
    expect(saved.tunnel.provider).toBe('cloudflare-quick');
    expect(saved.onboardingDone).toBe(true);
  });

  it('a tunnel setting chosen in the config file itself is saved as is', () => {
    // Arrange
    const external = { ...defaultConfig(), tunnel: { provider: 'none' as const } };
    // Act
    const saved = persistableConfig(external, external);
    // Assert
    expect(saved.tunnel.provider).toBe('none');
  });

  it('turns the browser check on by default, at the current version', () => {
    // Act
    const c = defaultConfig();
    // Assert
    expect(c.security.requireBrowserCheck).toBe(true);
    expect(c.configVersion).toBe(CONFIG_VERSION);
  });

  it('migrates a v0.1.0 file once: its saved "browser check off" (the old default) becomes on, other choices stay', () => {
    // Arrange
    const f = configFile();
    const old = { ...defaultConfig(), security: { ...defaultConfig().security, requireBrowserCheck: false, autoNewLink: true } } as Record<string, unknown>;
    delete old.configVersion;
    fs.writeFileSync(f, JSON.stringify(old));
    // Act
    const c = loadConfig(f);
    // Assert
    expect(c.security.requireBrowserCheck).toBe(true);
    expect(c.security.autoNewLink).toBe(true);
    expect(c.configVersion).toBe(CONFIG_VERSION);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toMatchObject({ configVersion: CONFIG_VERSION, security: { requireBrowserCheck: true } });
  });

  it('after the migration, the streamer turning the check off stays off on every later load', () => {
    // Arrange
    const f = configFile();
    const old = { ...defaultConfig(), security: { ...defaultConfig().security, requireBrowserCheck: false } } as Record<string, unknown>;
    delete old.configVersion;
    fs.writeFileSync(f, JSON.stringify(old));
    const migrated = loadConfig(f);
    // Act
    saveConfig(f, { ...migrated, security: { ...migrated.security, requireBrowserCheck: false } });
    // Assert
    expect(loadConfig(f).security.requireBrowserCheck).toBe(false);
    expect(loadConfig(f).security.requireBrowserCheck).toBe(false);
  });

  it.each([
    ['a file without a version and the old "off"', { security: { requireBrowserCheck: false } }, { config: { configVersion: 4, security: { requireBrowserCheck: true } }, changed: true }],
    ['a file without the switch: only the version is added', { uploadLimitMbps: 5 }, { config: { uploadLimitMbps: 5, configVersion: 4 }, changed: true }],
    ['a version 2 file (its "off" is the streamer\'s choice)', { configVersion: 2, security: { requireBrowserCheck: false } }, { config: { configVersion: 4, security: { requireBrowserCheck: false } }, changed: true }],
    ['a version 3 file', { configVersion: 3, security: { requireBrowserCheck: false } }, { config: { configVersion: 4, security: { requireBrowserCheck: false } }, changed: true }],
  ])('migration: %s', (_what, input, result) => {
    // Act
    const m = migrateConfig(input);
    // Assert
    expect(m).toEqual(result);
  });

  it('migration: version 1 with the check on keeps it on', () => {
    // Act
    const m = migrateConfig({ configVersion: 1, security: { requireBrowserCheck: true } });
    // Assert
    expect(m.config).toMatchObject({ security: { requireBrowserCheck: true } });
  });

  it.each([4, 5])('migration: a version %i file is left alone', (configVersion) => {
    // Act
    const m = migrateConfig({ configVersion, security: { requireBrowserCheck: false } });
    // Assert
    expect(m.changed).toBe(false);
  });

  it.each([null, 5, 'x', [1]])('migration: the unknown shape %j passes through untouched (the schema reports it)', (x) => {
    // Act
    const m = migrateConfig(x);
    // Assert
    expect(m).toEqual({ config: x, changed: false });
  });

  it('migration does not change its input', () => {
    // Arrange
    const input = { security: { requireBrowserCheck: false } };
    // Act
    migrateConfig(input);
    // Assert
    expect(input).toEqual({ security: { requireBrowserCheck: false } });
  });

  it('version 4 adds the chat with its defaults (on, GIFs off, slow mode 2 s), written back', () => {
    // Arrange
    const f = configFile();
    const v3 = { ...defaultConfig(), configVersion: 3 } as Record<string, unknown>;
    delete v3.chat;
    fs.writeFileSync(f, JSON.stringify(v3));
    // Act
    const c = loadConfig(f);
    // Assert
    expect(c.configVersion).toBe(4);
    expect(c.chat).toMatchObject({ enabled: true, slowModeS: 2, maxGraphemes: 200, content: { text: true, emotes: true, gifs: false }, gif: { key: '' } });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toMatchObject({ configVersion: 4, chat: { enabled: true } });
  });

  it('saved chat choices are kept', () => {
    // Arrange
    const f = configFile();
    const c = loadConfig(f);
    // Act
    saveConfig(f, { ...c, chat: { ...c.chat, enabled: false, slowModeS: 10 } });
    // Assert
    expect(loadConfig(f).chat).toMatchObject({ enabled: false, slowModeS: 10 });
  });

  it('defaults maxViewers to what a quick tunnel holds', () => {
    // Act
    const c = defaultConfig();
    // Assert
    expect(c.maxViewers).toBe(QUICK_TUNNEL_MAX_VIEWERS);
  });

  it.each([
    ['without a version', { maxViewers: 500 }, { maxViewers: QUICK_TUNNEL_MAX_VIEWERS, configVersion: 4 }],
    ['at version 2', { configVersion: 2, maxViewers: 500 }, { maxViewers: QUICK_TUNNEL_MAX_VIEWERS }],
  ])('migrates the old default 500 saved %s', (_what, input, config) => {
    // Act
    const m = migrateConfig(input);
    // Assert
    expect(m.config).toMatchObject(config);
  });

  it('any other number was the streamer\'s choice, and so is a 500 chosen after the migration', () => {
    // Act
    const other = migrateConfig({ configVersion: 2, maxViewers: 300 });
    const chosen = migrateConfig({ configVersion: 3, maxViewers: 500 });
    // Assert
    expect(other.config).toMatchObject({ maxViewers: 300 });
    expect(chosen).toEqual({ config: { configVersion: 4, maxViewers: 500 }, changed: true });
  });

  it('a file with the old 500 loads as the new default; a 500 saved after that stays', () => {
    // Arrange
    const f = configFile();
    fs.writeFileSync(f, JSON.stringify({ ...defaultConfig(), configVersion: 2, maxViewers: 500 }));
    // Act
    const migrated = loadConfig(f).maxViewers;
    saveConfig(f, { ...loadConfig(f), maxViewers: 500 });
    // Assert
    expect(migrated).toBe(QUICK_TUNNEL_MAX_VIEWERS);
    expect(loadConfig(f).maxViewers).toBe(500);
  });

  it('rejects invalid values with a clear error', () => {
    // Arrange
    const f = configFile();
    fs.writeFileSync(f, JSON.stringify({ uploadLimitMbps: -5 }));
    // Act
    const load = () => loadConfig(f);
    // Assert
    expect(load).toThrow(/Invalid config/);
  });

  it('per-user data directory on macOS: Application Support', () => {
    // Act
    const dir = defaultDataDir('darwin', {});
    // Assert
    expect(dir).toMatch(/Library[\\/]Application Support[\\/]SwarmCast$/);
  });

  it('per-user data directory on Linux: XDG_DATA_HOME', () => {
    // Act
    const dir = defaultDataDir('linux', { XDG_DATA_HOME: '/x' });
    // Assert
    expect(dir).toBe(path.join('/x', 'swarmcast'));
  });

  it('per-user data directory on Windows: LOCALAPPDATA', () => {
    // Act
    const dir = defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' });
    // Assert
    expect(dir).toContain('SwarmCast');
  });

  it('SWARMCAST_DATA_DIR wins over the per-user directory', () => {
    // Act
    const dir = defaultDataDir('linux', { SWARMCAST_DATA_DIR: '/tmp/a' });
    // Assert
    expect(dir).toBe(path.resolve('/tmp/a'));
  });
});

describe('secrets', () => {
  it('generates a stream key and Ed25519 key once, stored privately', () => {
    // Arrange
    const f = path.join(tempDir('sc-cfg-'), 'secrets.json');
    // Act
    const a = loadOrCreateSecrets(f);
    const b = loadOrCreateSecrets(f);
    // Assert
    expect(a.streamKey).toBe(b.streamKey);
    expect(a.streamKey).toMatch(/^sc_[A-Za-z0-9]{24}$/);
    expect(a.manifestPrivateKeyPem).toContain('PRIVATE KEY');
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('adds a browser check key to secrets.json from v0.1.0, keeps everything else, and keeps it from then on', () => {
    // Arrange
    const f = path.join(tempDir('sc-cfg-'), 'secrets.json');
    const { browserCheckKey: _, ...old } = generateSecrets();
    fs.writeFileSync(f, JSON.stringify(old));
    // Act
    const a = loadOrCreateSecrets(f);
    // Assert
    expect(a.browserCheckKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.streamKey).toBe(old.streamKey);
    expect(a.manifestPrivateKeyPem).toBe(old.manifestPrivateKeyPem);
    expect(loadOrCreateSecrets(f).browserCheckKey).toBe(a.browserCheckKey);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['secrets.json']);
  });

  it('random tokens use an unambiguous alphabet', () => {
    // Act
    const t = randomToken(500);
    // Assert
    expect(t).toHaveLength(500);
    expect(t).not.toMatch(/[0O1lI]/);
  });

  it('every stream key is new', () => {
    // Act
    const keys = [generateSecrets().streamKey, generateSecrets().streamKey];
    // Assert
    expect(keys[0]).not.toBe(keys[1]);
  });
});
