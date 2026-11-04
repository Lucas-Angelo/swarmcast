// .github/scripts/npm-network-error.mjs: which failed `npm ci` logs the setup action runs once
// more (a network error, npm's own or prebuild-install's in an install script) and which fail the
// step (anything else).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { networkError } from '../../../.github/scripts/npm-network-error.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../../.github/scripts/npm-network-error.mjs');

/** The end of the failed `npm ci` of pipeline run 41664754395 (macos-15-intel), shortened. */
const RUN_41664754395 = [
  'npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.',
  'npm error code 2',
  'npm error path /Users/runner/work/swarmcast/swarmcast/node_modules/node-datachannel',
  'npm error command failed',
  'npm error command sh -c prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)',
  'npm error added 800 packages, and audited 801 packages in 3m',
  'npm error > node-datachannel@0.32.3 _prebuild',
  'npm error > prebuild -r napi --backend cmake-js',
  'npm error (node:3274) [DEP0176] DeprecationWarning: fs.R_OK is deprecated, use fs.constants.R_OK instead',
  'npm error prebuild-install warn install Request timed out',
  'npm error npm warn config production Use `--omit=dev` instead.',
  'npm error prebuild info begin Prebuild version 13.0.1',
  'npm error prebuild WARN This package does not support N-API version undefined ',
  'npm error prebuild ERR! build TypeError: expected first argument to be an array',
  'npm error A complete log of this run can be found in: /Users/runner/.npm/_logs/2026-11-03T16_01_14_393Z-debug-0.log',
].join('\n');

/** A failed install script whose prebuild-install download got `message`, then a failed build. */
const prebuildLog = (message: string) =>
  ['npm error code 1', 'npm error command failed', `npm error prebuild-install warn install ${message}`, 'npm error gyp ERR! build error'].join('\n');

describe('networkError', () => {
  it("finds prebuild-install's timed-out download in the log of run 41664754395", () => {
    // Act
    const line = networkError(RUN_41664754395);

    // Assert
    expect(line).toBe('npm error prebuild-install warn install Request timed out');
  });

  it.each([
    'connect ETIMEDOUT 140.82.112.4:443',
    'getaddrinfo ENOTFOUND github.com',
    'getaddrinfo EAI_AGAIN github.com',
    'read ECONNRESET',
    'connect ECONNREFUSED 140.82.112.4:443',
    'connect ENETUNREACH 2606:50c0:8000::153:443',
    'connect EHOSTUNREACH 140.82.112.4:443',
    'write EPIPE',
    'socket hang up',
    'Client network socket disconnected before secure TLS connection was established',
  ])("takes prebuild-install's %s as a network error", (message) => {
    // Act
    const line = networkError(prebuildLog(message));

    // Assert
    expect(line).toBe(`npm error prebuild-install warn install ${message}`);
  });

  it.each([
    'No prebuilt binaries found (target=8 runtime=napi arch=x64 libc= platform=darwin)',
    'Missing .node file in archive',
    'prebuilt binaries enforced with --force!',
    'EACCES: permission denied, open /Users/runner/.npm/_prebuilds/0f9c75-x.tar.gz',
  ])("does not take prebuild-install's %s as one", (message) => {
    // Act
    const line = networkError(prebuildLog(message));

    // Assert
    expect(line).toBeNull();
  });

  it.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'])(
    "takes npm's code %s as a network error",
    (code) => {
      // Arrange
      const log = ['npm warn tarball tarball data for x@1.0.0 seems to be corrupted. Trying again.', `npm error code ${code}`, 'npm error errno ' + code].join('\n');

      // Act
      const line = networkError(log);

      // Assert
      expect(line).toBe(`npm error code ${code}`);
    },
  );

  it("takes npm's network explanation as one", () => {
    // Arrange
    const log = ['npm error code ERR_SSL_WRONG_VERSION_NUMBER', 'npm error network request to https://registry.npmjs.org/vite failed, reason: socket hang up'].join('\n');

    // Act
    const line = networkError(log);

    // Assert
    expect(line).toBe('npm error network request to https://registry.npmjs.org/vite failed, reason: socket hang up');
  });

  it.each([
    ['a dependency conflict', 'npm error code ERESOLVE\nnpm error ERESOLVE could not resolve'],
    ['a lockfile out of sync', 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.'],
    ['a failed install script', 'npm error code 1\nnpm error command failed\nnpm error gyp ERR! stack Error: `make` failed with exit code: 2'],
    ['a code that only starts with a network one', 'npm error code ETIMEDOUTX'],
    ['a network word inside a line', 'npm error the network tab of the panel'],
    ["prebuild-install's request line", 'npm error prebuild-install http request GET https://github.com/murat-dogan/node-datachannel/releases/download/v0.32.3/x.tar.gz'],
    ['an empty log', ''],
  ])('does not take %s as one', (_name, log) => {
    // Act
    const line = networkError(log);

    // Assert
    expect(line).toBeNull();
  });

  it('ignores colour codes and Windows line ends', () => {
    // Arrange
    const log = '\x1b[31mnpm error\x1b[39m code 1\r\n\x1b[31mnpm error\x1b[39m prebuild-install warn install Request timed out\r\n';

    // Act
    const line = networkError(log);

    // Assert
    expect(line).toBe('npm error prebuild-install warn install Request timed out');
  });
});

describe('npm-network-error.mjs (command line)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-network-error-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('exits 0 and prints the line for a network error', () => {
    // Arrange
    const log = path.join(dir, 'npm-ci.log');
    fs.writeFileSync(log, RUN_41664754395);

    // Act
    const result = run(log);

    // Assert
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('npm error prebuild-install warn install Request timed out');
  });

  it('exits 1 for any other failure', () => {
    // Arrange
    const log = path.join(dir, 'npm-ci.log');
    fs.writeFileSync(log, 'npm error code ERESOLVE\n');

    // Act
    const result = run(log);

    // Assert
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('exits 2 when the log cannot be read', () => {
    // Act
    const missing = run(path.join(dir, 'missing.log'));
    const none = run();

    // Assert
    expect(missing.status).toBe(2);
    expect(none.status).toBe(2);
  });
});
