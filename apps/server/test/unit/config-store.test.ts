import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { ConfigStore } from '../../src/core/config-store.js';
import { tempDir } from './helpers.js';

// ConfigStore, the one writer of config.json: it saves the live config object the modules change
// in place, minus what the run chose for itself (fallback ports, the tunnel of --no-tunnel).

/** A config.json written with the defaults in a fresh folder, and its path. */
function freshConfigFile(): string {
  const file = path.join(tempDir('sc-cfg-store-'), 'config.json');
  loadConfig(file);
  return file;
}

describe('ConfigStore', () => {
  it('saves changes made in place on `current`, which stays the same object', () => {
    // Arrange
    const file = freshConfigFile();
    const config = loadConfig(file);
    const store = new ConfigStore(file, config);

    // Act
    config.uploadLimitMbps = 42;
    config.onboardingDone = true;
    store.save();

    // Assert
    expect(store.current).toBe(config);
    expect(loadConfig(file)).toMatchObject({ uploadLimitMbps: 42, onboardingDone: true });
  });

  it('keeps the ports of the file: a fallback port chosen at runtime is never written', () => {
    // Arrange
    const file = freshConfigFile();
    const config = loadConfig(file);
    const store = new ConfigStore(file, config);
    config.ports = { ...config.ports, admin: 8082, public: 8090 };

    // Act
    store.save();

    // Assert
    expect(loadConfig(file).ports).toEqual({ rtmp: 1935, public: 8080, admin: 8081, mediamtxHls: 8888 });
  });

  it('with --no-tunnel, keeps the tunnel of the file', () => {
    // Arrange
    const file = freshConfigFile();
    const config = loadConfig(file);
    config.tunnel = { provider: 'none' };
    const store = new ConfigStore(file, config, { noTunnel: true });

    // Act
    config.autoStopMinutes = 5;
    store.save();

    // Assert
    expect(loadConfig(file)).toMatchObject({ tunnel: { provider: 'cloudflare-quick' }, autoStopMinutes: 5 });
  });

  it('without --no-tunnel, saves a tunnel change like any other', () => {
    // Arrange
    const file = freshConfigFile();
    const config = loadConfig(file);
    const store = new ConfigStore(file, config);

    // Act
    config.tunnel = { provider: 'none' };
    store.save();

    // Assert
    expect(loadConfig(file).tunnel).toEqual({ provider: 'none' });
  });
});
