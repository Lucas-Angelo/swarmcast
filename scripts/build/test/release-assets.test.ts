// What a GitHub release carries besides the installers themselves (release.yml): latest.json,
// the desktop updater's manifest (updater-manifest.mjs), and SHA256SUMS.txt (checksums.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { writeChecksums, SUMS_FILE } from '../checksums.mjs';
import { buildManifest, REQUIRED } from '../updater-manifest.mjs';
import { it } from './fixtures.js';

const V = '0.5.1';
const BASE = 'https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.5.1';
/** Every installer and updater artifact desktop.mjs makes for version `v`. */
const artifacts = (v: string) => [
  `SwarmCast_${v}_x64-setup.exe`,
  `SwarmCast_${v}_aarch64.app.tar.gz`,
  `SwarmCast_${v}_x64.app.tar.gz`,
  `SwarmCast_${v}_amd64.AppImage`,
  `SwarmCast_${v}_aarch64.AppImage`,
  `SwarmCast_${v}_amd64.deb`,
  `SwarmCast_${v}_arm64.deb`,
];

/** Writes `names` into `dir`, each with its .sig (unless `unsigned`), and returns `dir`. */
function signed(dir: string, names: string[], o: { unsigned?: string[] } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), `bytes of ${n}`);
    if (!o.unsigned?.includes(n)) fs.writeFileSync(path.join(dir, `${n}.sig`), `signature of ${n}\n`);
  }
  return dir;
}

const quiet = { warn: () => {} };

describe('buildManifest (latest.json)', () => {
  it('maps every signed artifact to its updater platforms, with its URL in the release and its signature', ({ tmp }) => {
    // Arrange
    const dir = signed(path.join(tmp, 'desktop'), artifacts(V));
    // Act
    const m = buildManifest({ version: V, baseUrl: `${BASE}/`, notes: 'notes', pubDate: '2026-11-02T00:00:00Z', inputs: [dir], requireAll: true, ...quiet });
    // Assert
    expect(Object.keys(m.platforms)).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-aarch64',
      'linux-aarch64-appimage',
      'linux-aarch64-deb',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-nsis',
    ]);
    expect(m.platforms['windows-x86_64']).toEqual({ signature: `signature of SwarmCast_${V}_x64-setup.exe`, url: `${BASE}/SwarmCast_${V}_x64-setup.exe` });
    expect(m.platforms['linux-x86_64-deb']!.url).toBe(`${BASE}/SwarmCast_${V}_amd64.deb`);
    expect(m.platforms['linux-x86_64']).toBe(m.platforms['linux-x86_64-appimage']);
    expect({ version: m.version, notes: m.notes, pub_date: m.pub_date }).toEqual({ version: V, notes: 'notes', pub_date: '2026-11-02T00:00:00Z' });
  });

  it('a release missing a platform fails with --require-all, and only warns without it', ({ tmp }) => {
    // Arrange
    const dir = signed(path.join(tmp, 'desktop'), artifacts(V).filter((n) => !n.includes('x64.app')));
    const warned: string[] = [];
    // Act
    const strict = () => buildManifest({ version: V, baseUrl: BASE, inputs: [dir], requireAll: true, ...quiet });
    const lenient = buildManifest({ version: V, baseUrl: BASE, inputs: [dir], warn: (w: string) => warned.push(w) });
    // Assert
    expect(strict).toThrow('missing platforms: darwin-x86_64');
    expect(lenient.platforms['darwin-x86_64']).toBeUndefined();
    expect(warned).toEqual(['missing platforms: darwin-x86_64']);
    expect(REQUIRED).toContain('darwin-x86_64');
  });

  it('skips another version and unknown files (in any order the folder lists them), ignores what is unsigned, and never enters an .app bundle', ({ tmp }) => {
    // Arrange
    const dir = signed(path.join(tmp, 'desktop'), [...artifacts(V), `SwarmCast_0.5.0_x64-setup.exe`, `SwarmCast_${V}_x64.msi`, `SwarmCast_${V}_unsigned.dmg`], { unsigned: [`SwarmCast_${V}_unsigned.dmg`] });
    signed(path.join(dir, 'SwarmCast.app', 'Contents'), [`SwarmCast_${V}_arm64.deb`]);
    const warned: string[] = [];
    // Act
    const m = buildManifest({ version: V, baseUrl: BASE, inputs: [dir], warn: (w: string) => warned.push(w) });
    // Assert
    expect(warned.sort()).toEqual([`skipping SwarmCast_0.5.0_x64-setup.exe: not version ${V}`, `skipping SwarmCast_${V}_x64.msi: unknown artifact type`]);
    expect(m.platforms['linux-aarch64-deb']!.url).toBe(`${BASE}/SwarmCast_${V}_arm64.deb`);
  });

  it('refuses a signature without its artifact, two artifacts for one platform, and nothing signed at all', ({ tmp }) => {
    // Arrange
    const orphan = path.join(tmp, 'orphan');
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, `SwarmCast_${V}_amd64.AppImage.sig`), 'sig');
    const twice = signed(path.join(tmp, 'twice'), [`SwarmCast_${V}_amd64.AppImage`]);
    signed(path.join(twice, 'again'), [`SwarmCast_${V}_amd64.AppImage`]);
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    // Act
    const build = (dir: string) => () => buildManifest({ version: V, baseUrl: BASE, inputs: [dir], ...quiet });
    // Assert
    expect(build(orphan)).toThrow(`SwarmCast_${V}_amd64.AppImage.sig has no SwarmCast_${V}_amd64.AppImage next to it`);
    expect(build(twice)).toThrow('two artifacts for linux-x86_64');
    expect(build(empty)).toThrow('no signed artifacts found');
  });
});

describe('writeChecksums (SHA256SUMS.txt)', () => {
  it('lists every file of the folder in sha256sum format, sorted, without itself or subfolders', async ({ tmp }) => {
    // Arrange
    fs.writeFileSync(path.join(tmp, 'latest.json'), '{}\n');
    fs.writeFileSync(path.join(tmp, 'SwarmCast_0.5.1_x64-setup.exe'), 'exe');
    fs.writeFileSync(path.join(tmp, SUMS_FILE), 'stale');
    fs.mkdirSync(path.join(tmp, 'SwarmCast.app'));
    const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
    // Act
    const out = await writeChecksums(tmp);
    // Assert
    expect(out).toBe(`${sha('exe')}  SwarmCast_0.5.1_x64-setup.exe\n${sha('{}\n')}  latest.json\n`);
    expect(fs.readFileSync(path.join(tmp, SUMS_FILE), 'utf8')).toBe(out);
  });

  it('refuses a folder with nothing to list', async ({ tmp }) => {
    // Act
    const write = writeChecksums(tmp);
    // Assert
    await expect(write).rejects.toThrow('no files to checksum');
  });
});
