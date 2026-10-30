// The .deb Version field of a pre-release (deb-version.mjs). With dpkg installed (Linux CI and any
// machine that has it), a real .deb is built, rewritten and compared by dpkg itself.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { debianVersion } from '../../releases/semver.mjs';
import { setDebVersion, withVersion } from '../deb-version.mjs';
import { it } from './fixtures.js';

const hasDpkg = spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' }).status === 0;
const CONTROL = 'Package: swarm-cast\nVersion: 0.3.0-beta.1\nArchitecture: amd64\nDepends: libwebkit2gtk-4.1-0\n';

/** dpkg's own order: `a` sorts before `b`. */
const dpkgLt = (a: string, b: string): boolean => spawnSync('dpkg', ['--compare-versions', a, 'lt', b]).status === 0;

/** A minimal .deb of version 0.3.0-beta.1 (as Tauri names a beta) with one executable, built in `dir`. */
function buildBetaDeb(dir: string): string {
  const root = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(root, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DEBIAN', 'control'), 'Package: sc-test\nVersion: 0.3.0-beta.1\nArchitecture: all\nMaintainer: t <t@example.com>\nDescription: test\n');
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'sc-test'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const deb = path.join(dir, 'SwarmCast_0.3.0-beta.1_amd64.deb');
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', root, deb], { stdio: 'ignore' });
  return deb;
}

describe('withVersion', () => {
  it('replaces only the Version field', () => {
    // Act
    const out = withVersion(CONTROL, '0.3.0~beta.1');

    // Assert
    expect(out).toBe('Package: swarm-cast\nVersion: 0.3.0~beta.1\nArchitecture: amd64\nDepends: libwebkit2gtk-4.1-0\n');
  });

  it('refuses a control file without a Version field', () => {
    // Act
    const rewrite = () => withVersion('Package: x\n', '1.0.0');

    // Assert
    expect(rewrite).toThrow(/no Version field/);
  });

  it('refuses a version that would inject another field', () => {
    // Act
    const rewrite = () => withVersion(CONTROL, '0.3.0-beta.1\nDepends: evil');

    // Assert
    expect(rewrite).toThrow(/not a Debian upstream version/);
  });
});

describe.skipIf(!hasDpkg)('setDebVersion (dpkg-deb)', () => {
  it('dpkg sorts the version Tauri writes (0.3.0-beta.1) after the stable 0.3.0: the problem', () => {
    // Act
    const betaFirst = dpkgLt('0.3.0-beta.1', '0.3.0');

    // Assert
    expect(betaFirst).toBe(false);
  });

  it('rewrites the Version so dpkg sorts the beta before the stable version, keeping the files', ({ tmp }) => {
    // Arrange
    const deb = buildBetaDeb(tmp);

    // Act
    setDebVersion(deb, debianVersion('0.3.0-beta.1'));

    // Assert
    const version = execFileSync('dpkg-deb', ['--field', deb, 'Version'], { encoding: 'utf8' }).trim();
    expect(version).toBe('0.3.0~beta.1');
    expect(dpkgLt(version, '0.3.0')).toBe(true);
    expect(dpkgLt('0.2.2', version)).toBe(true);
    expect(execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' })).toMatch(/-rwxr-xr-x root\/root .* \.\/usr\/bin\/sc-test/);
  });
});
