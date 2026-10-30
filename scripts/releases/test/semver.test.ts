import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compare, debianVersion, isLatestStable, isPrerelease, parse, releaseChannel } from '../semver.mjs';
import { allowedTagBranches, classify } from '../version.mjs';

const VERSION_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'version.mjs');

describe('compare (SemVer 2.0.0 precedence)', () => {
  it('orders the release line the way the app updater does', () => {
    const ordered = ['0.2.2', '0.3.0-beta.1', '0.3.0-beta.2', '0.3.0-beta.11', '0.3.0-rc.1', '0.3.0-rc.2', '0.3.0', '0.3.1', '1.0.0-beta.1', '1.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compare(ordered[i]!, ordered[j]!), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
  });

  it('follows the SemVer spec example (§11) and ignores build metadata and a leading v', () => {
    const spec = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 1; i < spec.length; i++) expect(compare(spec[i - 1]!, spec[i]!)).toBe(-1);
    expect(compare('v0.3.0', '0.3.0+build.5')).toBe(0);
    // beta11 is one alphanumeric identifier compared as text: why RELEASE_VERSION wants the dot.
    expect(compare('0.3.0-beta11', '0.3.0-beta2')).toBe(-1);
  });

  it('rejects what is not SemVer', () => {
    for (const bad of ['0.3', '0.3.0.1', '01.2.3', '0.3.0-', '0.3.0-beta..1', '0.3.0-01', 'latest', '']) expect(parse(bad), bad).toBeNull();
    expect(() => compare('0.3', '0.3.0')).toThrow(/not a SemVer/);
  });

  it('isPrerelease', () => {
    expect(isPrerelease('0.3.0-beta.1')).toBe(true);
    expect(isPrerelease('v0.3.0')).toBe(false);
  });
});

describe('releaseChannel (release.yml verify)', () => {
  it('accepts stable, beta.N and rc.N', () => {
    expect(releaseChannel('0.3.0')).toBe('stable');
    expect(releaseChannel('0.3.0-beta.1')).toBe('beta');
    expect(releaseChannel('0.3.0-beta.12')).toBe('beta');
    expect(releaseChannel('1.0.0-rc.2')).toBe('beta');
  });

  it('rejects every other pre-release identifier', () => {
    for (const bad of ['0.3.0-alpha.1', '0.3.0-beta', '0.3.0-beta1', '0.3.0-beta.0', '0.3.0-beta.01', '0.3.0-rc.1.1', '0.3.0-beta.1+b5', '0.3.0+b5', 'v0.3.0', '0.3.0-test.1', '0.3.0-BETA.1', '0.3.0-preview.1']) {
      expect(() => releaseChannel(bad), bad).toThrow(/not a release version/);
    }
  });
});

describe('isLatestStable (GitHub "Latest")', () => {
  it('only a stable version at least every published stable one', () => {
    const tags = ['v0.1.0', 'v0.2.0', 'v0.2.1', 'v0.3.0'];
    expect(isLatestStable('0.3.1', tags)).toBe(true);
    expect(isLatestStable('0.3.0', tags)).toBe(true);
    // A hotfix on the older line after 0.3.0 must not take the download button back.
    expect(isLatestStable('0.2.2', tags)).toBe(false);
    expect(isLatestStable('0.4.0-beta.1', tags)).toBe(false);
    expect(isLatestStable('0.1.0', [])).toBe(true);
    // Pre-release and junk tags in the list do not count.
    expect(isLatestStable('0.3.1', ['v0.4.0-beta.1', 'nightly'])).toBe(true);
  });

  it('classify prints what the workflow needs', () => {
    expect(classify(['0.3.0-beta.1', 'v0.2.2'])).toEqual({ channel: 'beta', prerelease: true, is_latest: false });
    expect(classify(['0.3.0', 'v0.2.2', ''])).toEqual({ channel: 'stable', prerelease: false, is_latest: true });
    expect(classify(['0.2.3', 'v0.3.0'])).toEqual({ channel: 'stable', prerelease: false, is_latest: false });
    expect(() => classify(['0.3.0-alpha.1'])).toThrow(/not a release version/);
  });
});

describe('allowedTagBranches (release.yml: the tag commit must be on one of them)', () => {
  it('stable: main or release/X.Y; a pre-release also release/X.Y.Z of exactly its X.Y.Z', () => {
    expect(allowedTagBranches('0.3.0')).toEqual(['origin/main', 'origin/release/0.3']);
    expect(allowedTagBranches('0.3.2')).toEqual(['origin/main', 'origin/release/0.3']);
    expect(allowedTagBranches('0.3.0-beta.1')).toEqual(['origin/main', 'origin/release/0.3', 'origin/release/0.3.0']);
    expect(allowedTagBranches('1.0.0-rc.2')).toEqual(['origin/main', 'origin/release/1.0', 'origin/release/1.0.0']);
    expect(() => allowedTagBranches('0.3.0-alpha.1')).toThrow(/not a release version/);
  });

  it('CLI dry run of the verify step', () => {
    const cli = (...a: string[]) => spawnSync(process.execPath, [VERSION_CLI, '--on-branch', ...a], { encoding: 'utf8' });
    expect(cli('0.3.0-beta.1', 'origin/release/0.3.0').status).toBe(0);
    expect(cli('0.3.0-beta.1', 'origin/main', 'origin/release/0.3.0').stdout).toContain('origin/main, origin/release/0.3.0');
    // Not the same X.Y.Z, a stable tag on a release PR branch, nothing, a lookalike.
    for (const [v, ...b] of [['0.3.1-beta.1', 'origin/release/0.3.0'], ['0.3.0', 'origin/release/0.3.0'], ['0.3.0-beta.1'], ['0.3.0-beta.1', 'origin/release/0x3x0'], ['0.3.0-beta.1', 'origin/wp/feature']]) {
      const r = cli(v!, ...b);
      expect(r.status, `${v} on ${b.join(',')}`).toBe(1);
      expect(r.stderr).toContain('::error::');
    }
    expect(cli('0.3.0', 'origin/release/0.3').status).toBe(0);
  });
});

describe('debianVersion (.deb Version field)', () => {
  it('turns the pre-release hyphen into ~ so dpkg sorts it before the stable version', () => {
    expect(debianVersion('0.3.0-beta.1')).toBe('0.3.0~beta.1');
    expect(debianVersion('0.3.0-rc.2')).toBe('0.3.0~rc.2');
    expect(debianVersion('0.0.0-test.1')).toBe('0.0.0~test.1');
    expect(debianVersion('0.0.0-x-y.1')).toBe('0.0.0~x.y.1');
    expect(debianVersion('0.3.0')).toBe('0.3.0');
    expect(() => debianVersion('0.3')).toThrow(/not a SemVer/);
  });
});
