import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultDataDir, resolvePaths, runDataDir } from '../../src/core/paths.js';

/**
 * The data folder of a run that was not given one. A run from the source checkout (`npm run dev`,
 * `node --import tsx apps/server/src/main.ts`) must never read or change the real SwarmCast data of
 * the computer it runs on, so it uses `<repo>/.cache/dev-data`, which git ignores (the folder holds
 * the stream key and the signing keys). Packaged builds (start scripts, desktop app) keep the
 * per-user folder, and SWARMCAST_DATA_DIR wins for both.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CHECKOUT = path.resolve('/work/swarmcast');

/** The environment of this test process without a SWARMCAST_DATA_DIR the developer may have set. */
function envWithoutDataDir(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SWARMCAST_DATA_DIR;
  return env;
}

describe('data folder of a run without --data-dir', () => {
  it('a run from the source checkout uses .cache/dev-data inside the repository', () => {
    // Act
    const dir = runDataDir({}, false, CHECKOUT);

    // Assert
    expect(dir).toBe(path.join(CHECKOUT, '.cache', 'dev-data'));
  });

  it('a packaged run keeps the per-user data folder', () => {
    // Arrange
    const env = { LOCALAPPDATA: path.resolve('/users/a/local'), XDG_DATA_HOME: path.resolve('/users/a/share') };

    // Act
    const dir = runDataDir(env, true, CHECKOUT);

    // Assert
    expect(dir).toBe(defaultDataDir(process.platform, env));
    expect(dir.startsWith(CHECKOUT)).toBe(false);
  });

  it('SWARMCAST_DATA_DIR wins for source and packaged runs', () => {
    // Arrange
    const env = { SWARMCAST_DATA_DIR: path.join('some', 'data') };

    // Act
    const source = runDataDir(env, false, CHECKOUT);
    const packaged = runDataDir(env, true, CHECKOUT);

    // Assert
    expect(source).toBe(path.resolve('some', 'data'));
    expect(packaged).toBe(path.resolve('some', 'data'));
  });

  it('the app paths of a source run without a folder all point into this checkout', () => {
    // Act
    const paths = resolvePaths(undefined, envWithoutDataDir());

    // Assert
    expect(paths.dataDir).toBe(path.join(REPO, '.cache', 'dev-data'));
    expect(paths.secretsFile).toBe(path.join(REPO, '.cache', 'dev-data', 'secrets.json'));
  });

  it('git ignores the dev data folder', () => {
    // Arrange
    const gitignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split(/\r?\n/);

    // Act
    const ignored = gitignore.includes('.cache/');

    // Assert
    expect(ignored).toBe(true);
  });
});
