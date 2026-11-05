// The install scripts `npm ci` runs, in both lockfiles. An install script that downloads from
// outside the npm registry is outside npm's cache and retries: node-datachannel's fetched its
// native binary from GitHub, timed out on macos-15-intel and then failed to build from source
// (pipeline run 41664754395), so it is replaced by a stand-in (apps/server/shims/node-datachannel)
// and a new package with an install script has to be looked at before it lands
// (.github/actions/setup, "npm ci").
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

type LockPackage = { hasInstallScript?: boolean; optional?: boolean; link?: boolean; resolved?: string };
const packages = (lockfile: string) =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, lockfile), 'utf8')) as { packages: Record<string, LockPackage> }).packages;
const nameOf = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** Every package with an install script, and why it may run in CI. */
const ALLOWED: Record<string, string> = {
  // postinstall checks the binary of the @esbuild/<os>-<cpu> package npm installed (the registry,
  // through npm's cache); only when that package is missing does it fetch it, from the registry too.
  esbuild: 'checks its platform package',
  // Optional (a failed install script does not fail `npm ci`), macOS only, prebuilt in its tarball.
  fsevents: 'optional',
  // Optional dependencies of ws, prebuilt in their tarballs (node-gyp-build).
  bufferutil: 'optional',
  'utf-8-validate': 'optional',
};

describe('install scripts', () => {
  it.each(['package-lock.json', 'site/package-lock.json'])('in %s are only the allowed ones', (lockfile) => {
    // Arrange
    const withScripts = Object.entries(packages(lockfile)).filter(([key, p]) => key.includes('node_modules/') && p.hasInstallScript);

    // Act
    const unknown = withScripts.map(([key]) => nameOf(key)).filter((name) => !(name in ALLOWED));
    const optionalNotOptional = withScripts.filter(([key, p]) => ALLOWED[nameOf(key)] === 'optional' && !p.optional).map(([key]) => key);

    // Assert
    expect(unknown).toEqual([]);
    expect(optionalNotOptional).toEqual([]);
  });

  it('do not include node-datachannel: every copy of it is the stand-in', () => {
    // Arrange
    const lock = packages('package-lock.json');

    // Act
    const copies = Object.entries(lock).filter(([key]) => nameOf(key) === 'node-datachannel');
    const stand = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/server/shims/node-datachannel/package.json'), 'utf8')) as { scripts?: unknown };

    // Assert
    expect(copies).toEqual([['node_modules/node-datachannel', { resolved: 'apps/server/shims/node-datachannel', link: true }]]);
    expect(stand.scripts).toBeUndefined();
  });
});

describe('the node-datachannel stand-in', () => {
  it('is never loaded by the tracker the server runs, and stops the client that would need it', async () => {
    // Act
    const server = await import('bittorrent-tracker/server');
    const client = import('bittorrent-tracker');

    // Assert
    expect(typeof server.default).toBe('function');
    await expect(client).rejects.toThrow(/node-datachannel is not installed/);
  });
});
