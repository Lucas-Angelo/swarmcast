// pkg's base Node.js binary (pkg-base.mjs): put where pkg looks for it, from the download cache or
// with fetch-binaries.mjs's tries, checked against pkg-fetch's own SHA-256, so pkg neither
// downloads it with its single try nor compiles Node.js from source (PR #141). pkg-fetch and the
// network are stand-ins, except in the last test, which reads the real pkg-fetch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, onTestFinished, vi } from 'vitest';
import { ensurePkgBase, loadPkgFetch, pkgBasePlace } from '../pkg-base.mjs';
import { it } from './fixtures.js';

const BYTES = Buffer.from('pkg base binary');
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const OLD_SHA = 'a'.repeat(64);
const NAME = 'node-v24.22.1-linux-x64';
const URL = `https://github.com/yao-pkg/pkg-fetch/releases/download/v3.6/${NAME}`;

/** pkg-fetch 3.6.7 as far as pkg-base uses it; its dry run looks at the file it would use, under `pkgCache`. */
function fakePkgFetch(pkgCache: string, { verdict }: { verdict?: string } = {}) {
  return {
    version: '3.6.7',
    getNodeVersion: (range: string) => (range === 'node24' ? 'v24.22.1' : 'v0'),
    expected: { [NAME]: SHA, 'node-v24.22.1-win-x64': 'b'.repeat(64) },
    need: vi.fn(async () => verdict ?? (fs.existsSync(path.join(pkgCache, 'v3.6', 'fetched-v24.22.1-linux-x64')) ? 'exists' : 'fetched')),
  };
}

/** downloadFirst: writes the pinned bytes to `dest`, or fails like six 504s would. */
function fakeDownload({ fail = false } = {}) {
  return vi.fn(async (_urls: string[], dest: string, _sha: string) => {
    if (fail) throw new Error(`HTTP 504 (${URL}, try 6, 6 of 6 in a row without progress)`);
    fs.writeFileSync(dest, BYTES);
  });
}

function dirs(tmp: string) {
  return { cacheDir: path.join(tmp, 'downloads'), pkgCache: path.join(tmp, 'pkg-cache') };
}
const placed = (pkgCache: string) => path.join(pkgCache, 'v3.6', 'fetched-v24.22.1-linux-x64');

describe('ensurePkgBase', () => {
  it('downloads the binary into the download cache and puts it where pkg looks, executable', async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    const download = fakeDownload();
    const fetcher = fakePkgFetch(pkgCache);

    // Act
    const source = await ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher, download, log: () => {} });

    // Assert
    expect(source).toBe(URL);
    expect(download).toHaveBeenCalledWith([URL], path.join(cacheDir, `pkg-${SHA}-${NAME}`), SHA);
    expect(fs.readFileSync(placed(pkgCache))).toEqual(BYTES);
    if (process.platform !== 'win32') expect(fs.statSync(placed(pkgCache)).mode & 0o111).toBe(0o111);
    expect(fetcher.need).toHaveBeenCalledWith({ dryRun: true, nodeRange: 'node24', platform: 'linux', arch: 'x64' });
  });

  it('takes it from the download cache without the network', async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, `pkg-${SHA}-${NAME}`), BYTES);
    const download = fakeDownload();

    // Act
    const source = await ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher: fakePkgFetch(pkgCache), download, log: () => {} });

    // Assert
    expect(source).toBe('download cache');
    expect(download).not.toHaveBeenCalled();
    expect(fs.readFileSync(placed(pkgCache))).toEqual(BYTES);
  });

  it('leaves a binary pkg already has alone', async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    fs.mkdirSync(path.dirname(placed(pkgCache)), { recursive: true });
    fs.writeFileSync(placed(pkgCache), BYTES);
    const download = fakeDownload();

    // Act
    const source = await ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher: fakePkgFetch(pkgCache), download, log: () => {} });

    // Assert
    expect(source).toBe('pkg cache');
    expect(download).not.toHaveBeenCalled();
  });

  it('never uses a file whose SHA-256 is not the one pkg-fetch expects: it downloads the binary again', async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, `pkg-${SHA}-${NAME}`), 'truncated');
    fs.mkdirSync(path.dirname(placed(pkgCache)), { recursive: true });
    fs.writeFileSync(placed(pkgCache), 'other bytes');
    const download = fakeDownload();

    // Act
    const source = await ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher: fakePkgFetch(pkgCache), download, log: () => {} });

    // Assert
    expect(source).toBe(URL);
    expect(fs.readFileSync(placed(pkgCache))).toEqual(BYTES);
  });

  it('without a download cache (a local build) it downloads straight to where pkg looks, also where SC_DOWNLOAD_CACHE is set', async ({ tmp }) => {
    // Arrange: CI's setup sets SC_DOWNLOAD_CACHE for the unit tests too (run 42472780332); null
    // means no cache, whatever the environment says.
    const { pkgCache } = dirs(tmp);
    const download = fakeDownload();
    vi.stubEnv('SC_DOWNLOAD_CACHE', path.join(tmp, 'the-job-download-cache'));
    onTestFinished(() => void vi.unstubAllEnvs());

    // Act
    await ensurePkgBase('node24-linux-x64', { cacheDir: null, pkgCache, fetcher: fakePkgFetch(pkgCache), download, log: () => {} });

    // Assert
    expect(download).toHaveBeenCalledWith([URL], placed(pkgCache), SHA);
    expect(fs.readFileSync(placed(pkgCache))).toEqual(BYTES);
    expect(fs.existsSync(path.join(tmp, 'the-job-download-cache'))).toBe(false);
  });

  it('stops the build with the reason when the download fails, instead of letting pkg compile Node.js', async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    const fetcher = fakePkgFetch(pkgCache);

    // Act
    const act = ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher, download: fakeDownload({ fail: true }), log: () => {} });

    // Assert
    await expect(act).rejects.toThrow(/node-v24\.22\.1-linux-x64 could not be downloaded \(pkg would compile Node\.js from source instead.*\): HTTP 504/);
    expect(fs.existsSync(placed(pkgCache))).toBe(false);
    expect(fetcher.need).not.toHaveBeenCalled();
  });

  it("drops the download cache's pkg binaries that pkg-fetch no longer expects, and nothing else", async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);
    fs.mkdirSync(cacheDir);
    const old = path.join(cacheDir, `pkg-${OLD_SHA}-node-v24.21.0-linux-x64`);
    const pinned = path.join(cacheDir, `${OLD_SHA}-mediamtx_v1.21.3_linux_amd64.tar.gz`);
    fs.writeFileSync(old, 'old');
    fs.writeFileSync(pinned, 'fetch-binaries.mjs prunes these against versions.json');

    // Act
    await ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher: fakePkgFetch(pkgCache), download: fakeDownload(), log: () => {} });

    // Assert
    expect(fs.readdirSync(cacheDir).sort()).toEqual([path.basename(pinned), `pkg-${SHA}-${NAME}`].sort());
  });

  it("fails when pkg-fetch's dry run says it would not use the file (its layout changed)", async ({ tmp }) => {
    // Arrange
    const { cacheDir, pkgCache } = dirs(tmp);

    // Act
    const act = ensurePkgBase('node24-linux-x64', { cacheDir, pkgCache, fetcher: fakePkgFetch(pkgCache, { verdict: 'fetched' }), download: fakeDownload(), log: () => {} });

    // Assert
    await expect(act).rejects.toThrow(/would not use .*fetched-v24\.22\.1-linux-x64 \(dry run: "fetched"\)/);
  });
});

describe('pkgBasePlace', () => {
  it('refuses a target it does not know and one pkg-fetch has no SHA-256 for', ({ tmp }) => {
    // Arrange
    const fetcher = fakePkgFetch(tmp);

    // Act
    const unknown = () => pkgBasePlace('node24-freebsd-x64', { fetcher, pkgCache: tmp });
    const noHash = () => pkgBasePlace('node24-macos-arm64', { fetcher, pkgCache: tmp });

    // Assert
    expect(unknown).toThrow(/unexpected pkg target node24-freebsd-x64/);
    expect(noHash).toThrow(/pkg-fetch 3\.6\.7 has no SHA-256 for node-v24\.22\.1-macos-arm64/);
  });

  it("knows every target package.mjs builds, from the pkg-fetch that pkg runs", ({ tmp }) => {
    // Arrange
    const fetcher = loadPkgFetch();
    const targets = ['node24-win-x64', 'node24-macos-arm64', 'node24-macos-x64', 'node24-linux-x64', 'node24-linux-arm64'];

    // Act
    const places = targets.map((t) => pkgBasePlace(t, { fetcher, pkgCache: tmp }));

    // Assert
    for (const p of places) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.url).toBe(`https://github.com/yao-pkg/pkg-fetch/releases/download/v${fetcher.version.split('.').slice(0, 2).join('.')}/${p.name}`);
      expect(path.dirname(path.dirname(p.file))).toBe(tmp);
    }
  });
});
