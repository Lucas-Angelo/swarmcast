// SemVer precedence and the release rules built on it (semver.mjs, version.mjs): what the app
// updater, release.yml's verify step and the .deb Version field rely on. In the SemVer spec
// example, `beta11` is one alphanumeric identifier compared as text: why RELEASE_VERSION wants the
// dot (beta.11). A hotfix on an older line published after 0.3.0 must not take GitHub's "Latest"
// (the download button) back to it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compare, debianVersion, isLatestStable, isPrerelease, parse, releaseChannel } from '../semver.mjs';
import { allowedTagBranches, classify } from '../version.mjs';

const VERSION_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'version.mjs');

/** The release line in the order the app updater sorts it. */
const RELEASE_LINE = ['0.2.2', '0.3.0-beta.1', '0.3.0-beta.2', '0.3.0-beta.11', '0.3.0-rc.1', '0.3.0-rc.2', '0.3.0', '0.3.1', '1.0.0-beta.1', '1.0.0'];
/** The precedence example of SemVer 2.0.0 §11, lowest first. */
const SPEC_EXAMPLE = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
const PUBLISHED = ['v0.1.0', 'v0.2.0', 'v0.2.1', 'v0.3.0'];

/** `version.mjs --on-branch <version> <branches…>`: the verify step's dry run. */
const onBranch = (version: string, ...branches: string[]) => spawnSync(process.execPath, [VERSION_CLI, '--on-branch', version, ...branches], { encoding: 'utf8' });

describe('compare (SemVer 2.0.0 precedence)', () => {
  it('orders the release line the way the app updater does, every pair both ways', () => {
    // Arrange
    const pairs = RELEASE_LINE.flatMap((a, i) => RELEASE_LINE.map((b, j) => ({ a, b, order: Math.sign(i - j) })));

    // Act
    const results = pairs.map(({ a, b }) => `${a} vs ${b}: ${compare(a, b)}`);

    // Assert
    expect(results).toEqual(pairs.map(({ a, b, order }) => `${a} vs ${b}: ${order}`));
  });

  it('follows the SemVer spec example (§11)', () => {
    // Arrange
    const steps = SPEC_EXAMPLE.slice(1).map((v, i) => [SPEC_EXAMPLE[i]!, v] as const);

    // Act
    const results = steps.map(([a, b]) => `${a} vs ${b}: ${compare(a, b)}`);

    // Assert
    expect(results).toEqual(steps.map(([a, b]) => `${a} vs ${b}: -1`));
  });

  it('ignores build metadata and a leading v', () => {
    // Act
    const order = compare('v0.3.0', '0.3.0+build.5');

    // Assert
    expect(order).toBe(0);
  });

  it('compares an identifier without the dot (beta11) as text: beta11 sorts before beta2', () => {
    // Act
    const order = compare('0.3.0-beta11', '0.3.0-beta2');

    // Assert
    expect(order).toBe(-1);
  });

  it.each(['0.3', '0.3.0.1', '01.2.3', '0.3.0-', '0.3.0-beta..1', '0.3.0-01', 'latest', ''])('parse rejects %j', (bad) => {
    // Act
    const parsed = parse(bad);

    // Assert
    expect(parsed).toBeNull();
  });

  it('compare throws on a version that is not SemVer', () => {
    // Act
    const order = () => compare('0.3', '0.3.0');

    // Assert
    expect(order).toThrow(/not a SemVer/);
  });

  it.each([
    ['0.3.0-beta.1', true],
    ['v0.3.0', false],
  ])('isPrerelease(%j) is %s', (version, expected) => {
    // Act
    const pre = isPrerelease(version);

    // Assert
    expect(pre).toBe(expected);
  });
});

describe('releaseChannel (release.yml verify)', () => {
  it.each([
    ['0.3.0', 'stable'],
    ['0.3.0-beta.1', 'beta'],
    ['0.3.0-beta.12', 'beta'],
    ['1.0.0-rc.2', 'beta'],
  ])('accepts %s as %s', (version, channel) => {
    // Act
    const got = releaseChannel(version);

    // Assert
    expect(got).toBe(channel);
  });

  it.each(['0.3.0-alpha.1', '0.3.0-beta', '0.3.0-beta1', '0.3.0-beta.0', '0.3.0-beta.01', '0.3.0-rc.1.1', '0.3.0-beta.1+b5', '0.3.0+b5', 'v0.3.0', '0.3.0-test.1', '0.3.0-BETA.1', '0.3.0-preview.1'])(
    'rejects %s',
    (bad) => {
      // Act
      const channel = () => releaseChannel(bad);

      // Assert
      expect(channel).toThrow(/not a release version/);
    },
  );
});

describe('isLatestStable (GitHub "Latest")', () => {
  it.each([
    ['0.3.1', PUBLISHED, true],
    ['0.3.0', PUBLISHED, true],
    ['0.2.2', PUBLISHED, false],
    ['0.4.0-beta.1', PUBLISHED, false],
    ['0.1.0', [], true],
    ['0.3.1', ['v0.4.0-beta.1', 'nightly'], true],
  ])('%s with %j published: %s', (version, tags, latest) => {
    // Act
    const got = isLatestStable(version, tags);

    // Assert
    expect(got).toBe(latest);
  });

  it.each([
    [['0.3.0-beta.1', 'v0.2.2'], { channel: 'beta', prerelease: true, is_latest: false }],
    [['0.3.0', 'v0.2.2', ''], { channel: 'stable', prerelease: false, is_latest: true }],
    [['0.2.3', 'v0.3.0'], { channel: 'stable', prerelease: false, is_latest: false }],
  ])('classify(%j) prints what the workflow needs', (args, expected) => {
    // Act
    const out = classify(args);

    // Assert
    expect(out).toEqual(expected);
  });

  it('classify refuses a version that is not a release version', () => {
    // Act
    const out = () => classify(['0.3.0-alpha.1']);

    // Assert
    expect(out).toThrow(/not a release version/);
  });
});

describe('allowedTagBranches (release.yml: the tag commit must be on one of them)', () => {
  it.each([
    ['0.3.0', ['origin/main', 'origin/release/0.3']],
    ['0.3.2', ['origin/main', 'origin/release/0.3']],
    ['0.3.0-beta.1', ['origin/main', 'origin/release/0.3', 'origin/release/0.3.0']],
    ['1.0.0-rc.2', ['origin/main', 'origin/release/1.0', 'origin/release/1.0.0']],
  ])('%s: main, release/X.Y and (a pre-release only) release/X.Y.Z of exactly its X.Y.Z', (version, branches) => {
    // Act
    const allowed = allowedTagBranches(version);

    // Assert
    expect(allowed).toEqual(branches);
  });

  it('refuses a version that is not a release version', () => {
    // Act
    const allowed = () => allowedTagBranches('0.3.0-alpha.1');

    // Assert
    expect(allowed).toThrow(/not a release version/);
  });

  it.each([
    ['0.3.0-beta.1', ['origin/release/0.3.0']],
    ['0.3.0', ['origin/release/0.3']],
  ])('CLI: %s on %j passes', (version, branches) => {
    // Act
    const run = onBranch(version, ...branches);

    // Assert
    expect(run.status).toBe(0);
  });

  it('CLI: names every allowed branch the commit is on', () => {
    // Act
    const run = onBranch('0.3.0-beta.1', 'origin/main', 'origin/release/0.3.0');

    // Assert
    expect(run.stdout).toContain('origin/main, origin/release/0.3.0');
  });

  it.each([
    ['another X.Y.Z', '0.3.1-beta.1', ['origin/release/0.3.0']],
    ['a stable tag on a release PR branch', '0.3.0', ['origin/release/0.3.0']],
    ['no branch at all', '0.3.0-beta.1', []],
    ['a lookalike branch', '0.3.0-beta.1', ['origin/release/0x3x0']],
    ['a feature branch', '0.3.0-beta.1', ['origin/wp/feature']],
  ])('CLI: fails with ::error:: for %s', (_case, version, branches) => {
    // Act
    const run = onBranch(version, ...branches);

    // Assert
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('::error::');
  });
});

describe('debianVersion (.deb Version field)', () => {
  it.each([
    ['0.3.0-beta.1', '0.3.0~beta.1'],
    ['0.3.0-rc.2', '0.3.0~rc.2'],
    ['0.0.0-test.1', '0.0.0~test.1'],
    ['0.0.0-x-y.1', '0.0.0~x.y.1'],
    ['0.3.0', '0.3.0'],
  ])('%s -> %s (the pre-release hyphen becomes ~, which dpkg sorts before the stable version)', (version, deb) => {
    // Act
    const got = debianVersion(version);

    // Assert
    expect(got).toBe(deb);
  });

  it('refuses a version that is not SemVer', () => {
    // Act
    const got = () => debianVersion('0.3');

    // Assert
    expect(got).toThrow(/not a SemVer/);
  });
});
