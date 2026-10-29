import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { debianVersion } from '../../releases/semver.mjs';
import { setDebVersion, withVersion } from '../deb-version.mjs';

const hasDpkg = spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' }).status === 0;

describe('withVersion', () => {
  it('replaces only the Version field', () => {
    const control = 'Package: swarm-cast\nVersion: 0.3.0-beta.1\nArchitecture: amd64\nDepends: libwebkit2gtk-4.1-0\n';
    expect(withVersion(control, '0.3.0~beta.1')).toBe('Package: swarm-cast\nVersion: 0.3.0~beta.1\nArchitecture: amd64\nDepends: libwebkit2gtk-4.1-0\n');
    expect(() => withVersion('Package: x\n', '1.0.0')).toThrow(/no Version field/);
    expect(() => withVersion(control, '0.3.0-beta.1\nDepends: evil')).toThrow(/not a Debian upstream version/);
  });
});

// Linux CI (and any machine with dpkg): a real .deb, rewritten and compared by dpkg itself.
describe.skipIf(!hasDpkg)('setDebVersion (dpkg-deb)', () => {
  it('rewrites the Version so dpkg sorts the beta before the stable version, keeping the files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-deb-test-'));
    try {
      const root = path.join(tmp, 'pkg');
      fs.mkdirSync(path.join(root, 'DEBIAN'), { recursive: true });
      fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'DEBIAN', 'control'), 'Package: sc-test\nVersion: 0.3.0-beta.1\nArchitecture: all\nMaintainer: t <t@example.com>\nDescription: test\n');
      fs.writeFileSync(path.join(root, 'usr', 'bin', 'sc-test'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
      const deb = path.join(tmp, 'SwarmCast_0.3.0-beta.1_amd64.deb');
      execFileSync('dpkg-deb', ['--root-owner-group', '--build', root, deb], { stdio: 'ignore' });
      const dpkgLt = (a: string, b: string) => spawnSync('dpkg', ['--compare-versions', a, 'lt', b]).status === 0;
      expect(dpkgLt('0.3.0-beta.1', '0.3.0')).toBe(false); // the problem

      setDebVersion(deb, debianVersion('0.3.0-beta.1'));
      expect(execFileSync('dpkg-deb', ['--field', deb, 'Version'], { encoding: 'utf8' }).trim()).toBe('0.3.0~beta.1');
      expect(dpkgLt('0.3.0~beta.1', '0.3.0')).toBe(true);
      expect(dpkgLt('0.2.2', '0.3.0~beta.1')).toBe(true);
      const listing = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' });
      expect(listing).toMatch(/-rwxr-xr-x root\/root .* \.\/usr\/bin\/sc-test/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
