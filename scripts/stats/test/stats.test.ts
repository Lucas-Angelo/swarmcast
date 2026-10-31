// The usage numbers of the website (stats.mjs, update.mjs): which release assets count as downloads,
// the daily snapshots of the updater's latest.json counters and the weekly app estimate drawn from
// them. Days are UTC days (snapshots carry ISO timestamps), so the result does not depend on the
// machine's time zone. CI mirrors (the ci-deps pre-release) are downloaded on every CI run: they
// never count.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { it } from '../../build/test/fixtures.js';
import { addSnapshot, buildSummary, classifyAsset, countDownloads, latestDownloads, roundAbout, takeSnapshot, weeklyChecks } from '../stats.mjs';
import { main } from '../update.mjs';

const DAY = 86_400_000;
/** `hour` o'clock UTC, `day` days after 1 November 2026. */
const at = (day: number, hour = 6) => new Date(Date.UTC(2026, 10, 1) + day * DAY + hour * 3_600_000);

function asset(name: string, download_count: number) {
  return { name, download_count, size: 1000, browser_download_url: `https://github.com/o/r/releases/download/x/${name}` };
}

function release(tag: string, assets: ReturnType<typeof asset>[], extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, published_at: '2026-11-01T00:00:00Z', assets, ...extra };
}

/** A snapshot of the updater counters per tag, taken at `hour` UTC on `day`. */
const snap = (day: number, updater: Record<string, number>, hour = 6) => ({ at: at(day, hour).toISOString(), downloads: 0, updater });

describe('classifyAsset', () => {
  it.each([
    ['SwarmCast_0.2.0_x64-setup.exe', 'installer', 'windows-x64'],
    ['SwarmCast_0.2.0_aarch64.dmg', 'installer', 'macos-arm64'],
    ['SwarmCast_0.2.0_x64.dmg', 'installer', 'macos-x64'],
    ['swarmcast_0.2.0_amd64.deb', 'installer', 'linux-deb-x64'],
    ['swarmcast_0.2.0_arm64.deb', 'installer', 'linux-deb-arm64'],
    ['SwarmCast_0.2.0_amd64.AppImage', 'installer', 'linux-appimage-x64'],
    ['SwarmCast_0.2.0_aarch64.AppImage', 'installer', 'linux-appimage-arm64'],
  ])('%s is a desktop installer for %s', (name, kind, target) => {
    // Act
    const c = classifyAsset(name);

    // Assert
    expect(c).toMatchObject({ kind, target });
  });

  it.each([
    ['SwarmCast-v0.1.0-windows-x64-installer.zip', { kind: 'installer', os: 'windows' }],
    ['SwarmCast-v0.1.0-linux-arm64.tar.gz', { kind: 'package', os: 'linux' }],
    ['SwarmCast-v0.1.0-macos-x64.tar.gz', { kind: 'package', os: 'macos' }],
  ])('counts the script-mode zip or package %s', (name, expected) => {
    // Act
    const c = classifyAsset(name);

    // Assert
    expect(c).toEqual(expected);
  });

  it.each([
    ['SwarmCast_0.2.0_x64-setup.exe.sig', 'updater'],
    ['SwarmCast.app.tar.gz', 'updater'],
    ['SwarmCast_aarch64.app.tar.gz.sig', 'updater'],
    ['latest.json', 'updater-manifest'],
    ['start-windows.ps1', 'other'],
    ['SHA256SUMS.txt', 'other'],
    ['binaries.json', 'other'],
    ['uninstall-linux.sh', 'other'],
  ])('does not count %s as a download (%s)', (name, kind) => {
    // Act
    const c = classifyAsset(name);

    // Assert
    expect(c.kind).toBe(kind);
  });

  it.each(['ffmpeg-9.0.2-macos-arm64.zip', 'ffmpeg-9.0.2-macos-x64.zip', 'ffmpeg-9.0.2.tar.xz', 'versions-macos-arm64.txt'])('does not count the CI mirror %s', (name) => {
    // Act
    const c = classifyAsset(name);

    // Assert
    expect(c.kind).toBe('other');
  });
});

describe('roundAbout', () => {
  it('never rounds up', () => {
    // Act
    const rounded = [0, -3, Number.NaN, 1, 19, 23, 99, 101, 999, 1234, 98_765].map(roundAbout);

    // Assert
    expect(rounded).toEqual([0, 0, 0, 1, 19, 20, 95, 100, 990, 1200, 98_000]);
  });
});

describe('countDownloads', () => {
  it('sums installers across releases and skips drafts', () => {
    // Arrange
    const releases = [
      release('v0.2.0', [asset('SwarmCast_0.2.0_x64-setup.exe', 40), asset('SwarmCast_0.2.0_aarch64.dmg', 7), asset('latest.json', 999), asset('SwarmCast_0.2.0_x64-setup.exe.sig', 50)]),
      release('v0.1.0', [asset('SwarmCast-v0.1.0-linux-x64-installer.zip', 3), asset('SwarmCast-v0.1.0-linux-x64.tar.gz', 2), asset('start-linux.sh', 100)]),
      release('v0.3.0', [asset('SwarmCast_0.3.0_x64-setup.exe', 1000)], { draft: true }),
    ];

    // Act
    const counted = countDownloads(releases);

    // Assert
    expect(counted).toEqual({ total: 52, byKind: { installer: 50, package: 2 }, byOs: { windows: 40, macos: 7, linux: 5 } });
  });
});

describe('snapshots and the weekly estimate', () => {
  it('takes the latest.json counter of every tag', () => {
    // Arrange
    const releases = [release('v0.2.0', [asset('latest.json', 12)]), release('v0.1.0', [asset('x.dmg', 3)])];

    // Act
    const s = takeSnapshot(releases, at(0));

    // Assert
    expect(s).toEqual({ at: at(0).toISOString(), downloads: 3, updater: { 'v0.2.0': 12 } });
  });

  it('keeps one snapshot per UTC day, the latest of the day', () => {
    // Arrange
    let history = addSnapshot(null, snap(0, { a: 1 }));
    history = addSnapshot(history, snap(1, { a: 5 }, 3));

    // Act
    history = addSnapshot(history, snap(1, { a: 9 }, 20));

    // Assert
    expect(history.snapshots.map((s) => s.updater.a)).toEqual([1, 9]);
  });

  it('drops very old snapshots', () => {
    // Arrange
    const history = addSnapshot(addSnapshot(null, snap(0, { a: 1 })), snap(1, { a: 9 }));

    // Act
    const later = addSnapshot(history, snap(500, { a: 10 }));

    // Assert
    expect(later.snapshots.map((s) => s.updater.a)).toEqual([10]);
  });

  it.each([
    ['no snapshot', []],
    ['one snapshot', [snap(0, { a: 10 })]],
    ['two snapshots on the same day', [snap(0, { a: 10 }), snap(0, { a: 12 }, 12)]],
  ])('needs about a day of history: none from %s', (_case, snaps) => {
    // Act
    const weekly = weeklyChecks(snaps);

    // Assert
    expect(weekly).toBeNull();
  });

  it('uses the growth over the last 7 days', () => {
    // Arrange
    const snaps = Array.from({ length: 10 }, (_, d) => snap(d, { 'v0.2.0': d * 30 }));

    // Act
    const weekly = weeklyChecks(snaps);

    // Assert
    expect(weekly).toEqual({ checks: 210, days: 7, partial: false });
  });

  it('extrapolates a short history to 7 days and flags it', () => {
    // Act
    const weekly = weeklyChecks([snap(0, { a: 0 }), snap(2, { a: 60 })]);

    // Assert
    expect(weekly).toEqual({ checks: 210, days: 2, partial: true });
  });

  it('sums per release tag, so a new release (a new latest.json starting at 0) is not lost', () => {
    // Arrange
    const snaps = [snap(0, { 'v0.1.0': 500 }), snap(4, { 'v0.1.0': 560 }), snap(7, { 'v0.1.0': 580, 'v0.2.0': 40 })];

    // Act
    const weekly = weeklyChecks(snaps);

    // Assert
    expect(weekly).toEqual({ checks: 120, days: 7, partial: false });
  });

  it('averages over a longer gap when daily runs were missed', () => {
    // Act
    const weekly = weeklyChecks([snap(0, { a: 0 }), snap(14, { a: 140 })]);

    // Assert
    expect(weekly).toEqual({ checks: 70, days: 14, partial: false });
  });

  it('treats a counter that went down (asset replaced) as starting again', () => {
    // Act
    const weekly = weeklyChecks([snap(0, { a: 100 }), snap(7, { a: 30 })]);

    // Assert
    expect(weekly?.checks).toBe(30);
  });
});

describe('buildSummary', () => {
  it('has no app estimate without latest.json data and no installers without a desktop release', () => {
    // Arrange
    const releases = [release('v0.1.0', [asset('SwarmCast-v0.1.0-windows-x64-installer.zip', 4)])];
    const history = addSnapshot(null, takeSnapshot(releases, at(0)));

    // Act
    const s = buildSummary({ releases, latest: releases[0], history, now: at(0), repo: 'o/r' });

    // Assert
    expect(s.downloads).toMatchObject({ total: 4, about: 4 });
    expect(s.apps).toBeNull();
    expect(s.latest).toMatchObject({ tag: 'v0.1.0', version: '0.1.0', assets: {} });
  });

  it('estimates apps from update checks and lists the desktop installers', () => {
    // Arrange
    const mk = (n: number) => [release('v0.2.0', [asset('latest.json', n), asset('SwarmCast_0.2.0_x64-setup.exe', 80), asset('SwarmCast_0.2.0_aarch64.dmg', 10)])];
    const history = addSnapshot(addSnapshot(null, takeSnapshot(mk(100), at(0))), takeSnapshot(mk(400), at(7)));

    // Act
    const s = buildSummary({ releases: mk(400), latest: mk(400)[0], history, now: at(7), repo: 'o/r' });

    // Assert
    expect(s.apps).toEqual({ week: 100, checks: 300, days: 7, partial: false, checksPerApp: 3 });
    expect(s.downloads.about).toBe(90);
    expect(Object.keys(s.latest?.assets ?? {}).sort()).toEqual(['macos-arm64', 'windows-x64']);
  });

  it('latestDownloads of no release is null', () => {
    // Act
    const latest = latestDownloads(null);

    // Assert
    expect(latest).toBeNull();
  });
});

describe('update.mjs (offline input)', () => {
  /** update.mjs's arguments for a run at `now`, reading and writing the files in `dir`. */
  const args = (dir: string, now: Date) =>
    ['--repo', 'o/r', '--history', path.join(dir, 'h.json'), '--summary', path.join(dir, 's.json'), '--releases', path.join(dir, 'releases.json'), '--latest', path.join(dir, 'latest.json'), '--now', now.toISOString()];
  /** The GitHub API answers update.mjs reads (offline): one release whose latest.json was fetched `checks` times. */
  const writeApi = (dir: string, checks: number) => {
    const r = release('v0.2.0', [asset('latest.json', checks), asset('SwarmCast_0.2.0_amd64.deb', 5)]);
    fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify([r]));
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(r));
  };

  it('writes the history and the summary, and grows the history day by day', async ({ tmp }) => {
    // Arrange
    writeApi(tmp, 10);
    await main(args(tmp, at(0)));
    writeApi(tmp, 31);

    // Act
    const s = await main(args(tmp, at(1)));

    // Assert
    expect(s.apps).toMatchObject({ checks: 147, partial: true });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'h.json'), 'utf8')).snapshots).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 's.json'), 'utf8')).latest.assets['linux-deb-x64'].name).toBe('SwarmCast_0.2.0_amd64.deb');
  });

  it.each([
    ['without --history and --summary', ['--repo', 'o/r'], /Usage/],
    ['with a bad --repo', ['--repo', 'bad repo', '--history', 'h', '--summary', 's'], /Bad --repo/],
  ])('rejects arguments %s', async (_case, argv, error) => {
    // Act
    const run = main(argv);

    // Assert
    await expect(run).rejects.toThrow(error);
  });
});
