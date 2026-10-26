import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, persistableConfig, saveConfig } from '../../src/core/config.js';
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

  it('random tokens use an unambiguous alphabet', () => {
    const t = randomToken(500);
    expect(t).toHaveLength(500);
    expect(t).not.toMatch(/[0O1lI]/);
    expect(generateSecrets().streamKey).not.toBe(generateSecrets().streamKey);
  });
});
