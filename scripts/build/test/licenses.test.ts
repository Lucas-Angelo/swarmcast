// THIRD_PARTY_LICENSES.txt (licenses.mjs): which npm packages it names. The list came from
// `npm ls --parseable`, which prints a path segment that looks like a UUID as ***; none of those
// paths existed, the error was swallowed and the file shipped without any npm package. It now
// comes from package-lock.json, and an empty list is an error.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { prodPackageDirs, shippedNpmPackages, thirdPartyLicenses } from '../licenses.mjs';
import { it } from './fixtures.js';

const ROOT = path.join(path.sep, 'repo');
/** A package-lock.json "packages" map with one entry of each kind. */
const LOCK = {
  packages: {
    '': { name: 'swarmcast', workspaces: ['apps/*'] },
    'apps/server': { name: '@swarmcast/server', version: '0.4.0' },
    'node_modules/@swarmcast/server': { resolved: 'apps/server', link: true },
    'node_modules/ip': { resolved: 'apps/server/shims/ip', link: true },
    'node_modules/fastify': { version: '5.0.0' },
    'node_modules/fastify/node_modules/semver': { version: '7.6.0' },
    'apps/viewer/node_modules/hls.js': { version: '1.7.3' },
    'node_modules/vitest': { version: '5.0.5', dev: true },
    'node_modules/bufferutil': { version: '4.0.8', optional: true },
  },
};
const installed = (...keys: string[]) => {
  const files = new Set(keys.map((k) => path.join(ROOT, k, 'package.json')));
  return (file: string) => files.has(file);
};

describe('prodPackageDirs', () => {
  it('takes the production packages of every workspace, nested copies included', () => {
    // Arrange
    const exists = installed('node_modules/fastify', 'node_modules/fastify/node_modules/semver', 'apps/viewer/node_modules/hls.js', 'node_modules/vitest', 'node_modules/bufferutil');

    // Act
    const dirs = prodPackageDirs(LOCK, ROOT, exists);

    // Assert
    expect(dirs).toEqual([
      path.join(ROOT, 'node_modules', 'fastify'),
      path.join(ROOT, 'node_modules', 'fastify', 'node_modules', 'semver'),
      path.join(ROOT, 'apps', 'viewer', 'node_modules', 'hls.js'),
      path.join(ROOT, 'node_modules', 'bufferutil'),
    ]);
  });

  it('leaves out dev-only packages, links to workspaces and local shims, and the workspaces themselves', () => {
    // Arrange
    const exists = () => true;

    // Act
    const dirs = prodPackageDirs(LOCK, ROOT, exists);

    // Assert
    const keys = dirs.map((d) => path.relative(ROOT, d).split(path.sep).join('/'));
    expect(keys).not.toContain('node_modules/vitest');
    expect(keys).not.toContain('node_modules/@swarmcast/server');
    expect(keys).not.toContain('node_modules/ip');
    expect(keys).not.toContain('apps/server');
    expect(keys).not.toContain('');
  });

  it('leaves out a package that is not installed here (an optional one for another system)', () => {
    // Arrange
    const exists = installed('node_modules/fastify');

    // Act
    const dirs = prodPackageDirs(LOCK, ROOT, exists);

    // Assert
    expect(dirs).toEqual([path.join(ROOT, 'node_modules', 'fastify')]);
  });
});

describe('shippedNpmPackages', () => {
  it('fails, instead of giving an empty list, when no production package is installed', ({ tmp }) => {
    // Arrange
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/vitest': { dev: true } } }));

    // Act
    const list = () => shippedNpmPackages(tmp);

    // Assert
    expect(list).toThrow(/no installed production npm package in .*package-lock\.json/);
  });
});

describe('thirdPartyLicenses (this repository)', () => {
  it('names the npm packages the apps run with, each with its licence, and none of the dev tools or own workspaces', () => {
    // Act
    const { text, npmPackages } = thirdPartyLicenses();

    // Assert
    expect(npmPackages).toBeGreaterThan(50);
    expect(text).toMatch(/^== hls\.js@[\d.]+ — Apache-2\.0 ==$/m);
    expect(text).toMatch(/^== fastify@[\d.]+ — MIT ==$/m);
    expect(text).not.toMatch(/^== (vitest|@playwright\/test|eslint)@/m);
    expect(text).not.toMatch(/^== @swarmcast\//m);
  });
});
