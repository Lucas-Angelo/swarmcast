import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addSnapshot,
  buildSummary,
  classifyAsset,
  countDownloads,
  latestDownloads,
  roundAbout,
  takeSnapshot,
  weeklyChecks,
} from '../stats.mjs';
import { main } from '../update.mjs';

const DAY = 86_400_000;
const at = (day: number, hour = 6) => new Date(Date.UTC(2026, 10, 1) + day * DAY + hour * 3_600_000);

function asset(name: string, download_count: number) {
  return { name, download_count, size: 1000, browser_download_url: `https://github.com/o/r/releases/download/x/${name}` };
}

function release(tag: string, assets: ReturnType<typeof asset>[], extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, published_at: '2026-11-01T00:00:00Z', assets, ...extra };
}

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
    expect(classifyAsset(name)).toMatchObject({ kind, target });
  });

  it('counts the script-mode zips and packages but not updater files, scripts or checksums', () => {
    expect(classifyAsset('SwarmCast-v0.1.0-windows-x64-installer.zip')).toEqual({ kind: 'installer', os: 'windows' });
    expect(classifyAsset('SwarmCast-v0.1.0-linux-arm64.tar.gz')).toEqual({ kind: 'package', os: 'linux' });
    expect(classifyAsset('SwarmCast-v0.1.0-macos-x64.tar.gz')).toEqual({ kind: 'package', os: 'macos' });
    for (const n of ['SwarmCast_0.2.0_x64-setup.exe.sig', 'SwarmCast.app.tar.gz', 'SwarmCast_aarch64.app.tar.gz.sig']) {
      expect(classifyAsset(n).kind).toBe('updater');
    }
    expect(classifyAsset('latest.json').kind).toBe('updater-manifest');
    for (const n of ['start-windows.ps1', 'SHA256SUMS.txt', 'binaries.json', 'uninstall-linux.sh']) {
      expect(classifyAsset(n).kind).toBe('other');
    }
  });

  it('does not count the CI mirrors of the ci-deps pre-release (CI downloads them on every run)', () => {
    for (const n of ['ffmpeg-9.0.2-macos-arm64.zip', 'ffmpeg-9.0.2-macos-x64.zip', 'ffmpeg-9.0.2.tar.xz', 'versions-macos-arm64.txt']) {
      expect(classifyAsset(n).kind).toBe('other');
    }
  });
});

describe('roundAbout', () => {
  it('never rounds up', () => {
    expect([0, -3, Number.NaN, 1, 19, 23, 99, 101, 999, 1234, 98_765].map(roundAbout)).toEqual([0, 0, 0, 1, 19, 20, 95, 100, 990, 1200, 98_000]);
  });
});

describe('countDownloads', () => {
  it('sums installers across releases and skips drafts', () => {
    const releases = [
      release('v0.2.0', [asset('SwarmCast_0.2.0_x64-setup.exe', 40), asset('SwarmCast_0.2.0_aarch64.dmg', 7), asset('latest.json', 999), asset('SwarmCast_0.2.0_x64-setup.exe.sig', 50)]),
      release('v0.1.0', [asset('SwarmCast-v0.1.0-linux-x64-installer.zip', 3), asset('SwarmCast-v0.1.0-linux-x64.tar.gz', 2), asset('start-linux.sh', 100)]),
      release('v0.3.0', [asset('SwarmCast_0.3.0_x64-setup.exe', 1000)], { draft: true }),
    ];
    expect(countDownloads(releases)).toEqual({ total: 52, byKind: { installer: 50, package: 2 }, byOs: { windows: 40, macos: 7, linux: 5 } });
  });
});

describe('snapshots and the weekly estimate', () => {
  const snap = (day: number, updater: Record<string, number>, hour = 6) => ({ at: at(day, hour).toISOString(), downloads: 0, updater });

  it('takes the latest.json counter of every tag', () => {
    const s = takeSnapshot([release('v0.2.0', [asset('latest.json', 12)]), release('v0.1.0', [asset('x.dmg', 3)])], at(0));
    expect(s).toEqual({ at: at(0).toISOString(), downloads: 3, updater: { 'v0.2.0': 12 } });
  });

  it('keeps one snapshot per UTC day and drops very old ones', () => {
    let h = addSnapshot(null, snap(0, { a: 1 }));
    h = addSnapshot(h, snap(1, { a: 5 }, 3));
    h = addSnapshot(h, snap(1, { a: 9 }, 20));
    expect(h.snapshots.map((s) => s.updater.a)).toEqual([1, 9]);
    h = addSnapshot(h, snap(500, { a: 10 }));
    expect(h.snapshots.map((s) => s.updater.a)).toEqual([10]);
  });

  it('needs about a day of history', () => {
    expect(weeklyChecks([])).toBeNull();
    expect(weeklyChecks([snap(0, { a: 10 })])).toBeNull();
    expect(weeklyChecks([snap(0, { a: 10 }), snap(0, { a: 12 }, 12)])).toBeNull();
  });

  it('uses the growth over the last 7 days', () => {
    const snaps = Array.from({ length: 10 }, (_, d) => snap(d, { 'v0.2.0': d * 30 }));
    expect(weeklyChecks(snaps)).toEqual({ checks: 210, days: 7, partial: false });
  });

  it('extrapolates a short history to 7 days and flags it', () => {
    expect(weeklyChecks([snap(0, { a: 0 }), snap(2, { a: 60 })])).toEqual({ checks: 210, days: 2, partial: true });
  });

  it('sums per release tag, so a new release (new latest.json starting at 0) is not lost', () => {
    const snaps = [snap(0, { 'v0.1.0': 500 }), snap(4, { 'v0.1.0': 560 }), snap(7, { 'v0.1.0': 580, 'v0.2.0': 40 })];
    // v0.1.0: +80, v0.2.0: new, +40
    expect(weeklyChecks(snaps)).toEqual({ checks: 120, days: 7, partial: false });
  });

  it('averages over a longer gap when daily runs were missed', () => {
    expect(weeklyChecks([snap(0, { a: 0 }), snap(14, { a: 140 })])).toEqual({ checks: 70, days: 14, partial: false });
  });

  it('treats a counter that went down (asset replaced) as starting again', () => {
    expect(weeklyChecks([snap(0, { a: 100 }), snap(7, { a: 30 })])?.checks).toBe(30);
  });
});

describe('buildSummary', () => {
  it('has no app estimate without latest.json data and no installers without a desktop release', () => {
    const releases = [release('v0.1.0', [asset('SwarmCast-v0.1.0-windows-x64-installer.zip', 4)])];
    const history = addSnapshot(null, takeSnapshot(releases, at(0)));
    const s = buildSummary({ releases, latest: releases[0], history, now: at(0), repo: 'o/r' });
    expect(s.downloads).toMatchObject({ total: 4, about: 4 });
    expect(s.apps).toBeNull();
    expect(s.latest).toMatchObject({ tag: 'v0.1.0', version: '0.1.0', assets: {} });
  });

  it('estimates apps from update checks and lists the desktop installers', () => {
    const mk = (n: number) => [release('v0.2.0', [asset('latest.json', n), asset('SwarmCast_0.2.0_x64-setup.exe', 80), asset('SwarmCast_0.2.0_aarch64.dmg', 10)])];
    let history = addSnapshot(null, takeSnapshot(mk(100), at(0)));
    history = addSnapshot(history, takeSnapshot(mk(400), at(7)));
    const s = buildSummary({ releases: mk(400), latest: mk(400)[0], history, now: at(7), repo: 'o/r' });
    expect(s.apps).toEqual({ week: 100, checks: 300, days: 7, partial: false, checksPerApp: 3 });
    expect(s.downloads.about).toBe(90);
    expect(Object.keys(s.latest?.assets ?? {}).sort()).toEqual(['macos-arm64', 'windows-x64']);
    expect(latestDownloads(null)).toBeNull();
  });
});

describe('update.mjs (offline input)', () => {
  it('writes the history and the summary, and grows the history day by day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-stats-'));
    const rel = path.join(dir, 'releases.json');
    const latest = path.join(dir, 'latest.json');
    const args = (now: Date) => ['--repo', 'o/r', '--history', path.join(dir, 'h.json'), '--summary', path.join(dir, 's.json'), '--releases', rel, '--latest', latest, '--now', now.toISOString()];
    const write = (n: number) => {
      const r = release('v0.2.0', [asset('latest.json', n), asset('SwarmCast_0.2.0_amd64.deb', 5)]);
      fs.writeFileSync(rel, JSON.stringify([r]));
      fs.writeFileSync(latest, JSON.stringify(r));
    };
    write(10);
    await main(args(at(0)));
    write(31);
    const s = await main(args(at(1)));
    expect(s.apps).toMatchObject({ checks: 147, partial: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'h.json'), 'utf8')).snapshots).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).latest.assets['linux-deb-x64'].name).toBe('SwarmCast_0.2.0_amd64.deb');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects bad arguments', async () => {
    await expect(main(['--repo', 'o/r'])).rejects.toThrow(/Usage/);
    await expect(main(['--repo', 'bad repo', '--history', 'h', '--summary', 's'])).rejects.toThrow(/Bad --repo/);
  });
});
