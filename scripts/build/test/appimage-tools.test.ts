// The AppImage tools put where the Tauri bundler looks for them (appimage-tools.mjs): its tools
// folder, the pin checks (also of a linuxdeploy copy the bundler has patched), the files and modes
// it leaves, the download cache, the runtime check of a built AppImage, and that the pins still
// match the bundler of the @tauri-apps/cli in package-lock.json. Downloads go to a local server
// on 127.0.0.1 (port 0) through fetch-binaries.mjs, with no back-off between tries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { beforeEach, describe, expect, onTestFinished, vi } from 'vitest';
import { APPIMAGE_PLUGIN, appImageTools, matchesPin, prepareAppImageTools, startsWithRuntime, tauriToolsDir } from '../appimage-tools.mjs';
import { downloadFirst } from '../fetch-binaries.mjs';
import versions from '../versions.json' with { type: 'json' };
import lock from '../../../package-lock.json' with { type: 'json' };
import tauriConf from '../../../apps/desktop/src-tauri/tauri.conf.json' with { type: 'json' };
import { it } from './fixtures.js';

type Asset = { asset: string; sha256: string; binary: string; mirrors?: string[] };
type Spec = { version: string; url: string; env?: string; appimageTool?: boolean; tauriCli?: string; assets: Record<string, Asset> };

const isWindows = process.platform === 'win32';
const sha256 = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex');
/** An AppImage-like file: an ELF start with the AppImage magic ("AI" 0x02) at byte 8. */
function appImageBytes(seed: string): Buffer {
  const b = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), crypto.createHash('sha512').update(seed).digest()]);
  return b;
}
const APPRUN = Buffer.from('#!/bin/sh\necho AppRun\n');
const LINUXDEPLOY = appImageBytes('linuxdeploy');
const RUNTIME = Buffer.concat([appImageBytes('runtime'), Buffer.alloc(32)]);
const FILES: Record<string, Buffer> = { 'AppRun-x86_64': APPRUN, 'linuxdeploy-x86_64.AppImage': LINUXDEPLOY, 'runtime-x86_64': RUNTIME };

/** Pins shaped like versions.json's AppImage tools, for files served from `base`. */
function pinsFor(base: string): Record<string, Spec> {
  const asset = (name: string, binary: string): Asset => ({ asset: name, sha256: sha256(FILES[name]!), binary });
  return {
    mediamtx: { version: 'v1', url: `${base}/{asset}`, assets: {} },
    'tauri-apprun': { version: 'apprun-old', appimageTool: true, url: `${base}/{asset}`, assets: { 'linux-x64': asset('AppRun-x86_64', 'AppRun-x86_64') } },
    linuxdeploy: { version: 'linuxdeploy-07333c6', appimageTool: true, url: `${base}/{asset}`, assets: { 'linux-x64': asset('linuxdeploy-x86_64.AppImage', 'linuxdeploy-07333c6-x86_64.AppImage') } },
    'appimage-runtime': { version: 'continuous', appimageTool: true, env: 'LDAI_RUNTIME_FILE', url: `${base}/{asset}`, assets: { 'linux-x64': asset('runtime-x86_64', 'runtime-x86_64') } },
  };
}

/** A local server for FILES; `fail` answers the first n requests with that status (a 504 from github.com). */
async function serve(o: { failFirst?: number; status?: number } = {}): Promise<{ base: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    requests.push(name);
    if (requests.length <= (o.failFirst ?? 0)) {
      res.writeHead(o.status ?? 504).end();
      return;
    }
    const body = FILES[name];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** fetch-binaries.mjs's downloadFirst without the back-off between tries. */
const download = (urls: string[], dest: string, sha: string): Promise<string> => downloadFirst(urls, dest, sha, { waitMs: () => 0 });
const quiet = { log: () => {}, download };
const mode = (f: string): number => fs.statSync(f).mode & 0o777;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('tauriToolsDir', () => {
  it("is $XDG_CACHE_HOME/tauri, as the bundler's dirs::cache_dir()", () => {
    // Arrange
    const xdg = path.resolve('/cache-home');

    // Act
    const dir = tauriToolsDir({ XDG_CACHE_HOME: xdg, HOME: path.resolve('/home/u') });

    // Assert
    expect(dir).toBe(path.join(xdg, 'tauri'));
  });

  it('is ~/.cache/tauri without XDG_CACHE_HOME, or with a relative one (dirs ignores it)', () => {
    // Arrange
    const home = path.resolve('/home/u');

    // Act
    const unset = tauriToolsDir({ HOME: home });
    const relative = tauriToolsDir({ XDG_CACHE_HOME: 'cache', HOME: home });

    // Assert
    expect(unset).toBe(path.join(home, '.cache', 'tauri'));
    expect(relative).toBe(path.join(home, '.cache', 'tauri'));
  });

  it('is not moved into the cargo target folder: tauri.conf.json does not set bundle.useLocalToolsDir', () => {
    // Act
    const bundle = tauriConf.bundle as Record<string, unknown>;

    // Assert
    expect(bundle.useLocalToolsDir ?? false).toBe(false);
  });
});

describe('matchesPin', () => {
  it('accepts the pinned bytes, and a copy whose AppImage magic the bundler zeroed', () => {
    // Arrange
    const patched = Buffer.from(LINUXDEPLOY);
    patched.fill(0, 8, 11);

    // Act
    const exact = matchesPin(LINUXDEPLOY, sha256(LINUXDEPLOY));
    const afterDd = matchesPin(patched, sha256(LINUXDEPLOY));

    // Assert
    expect(exact).toBe(true);
    expect(afterDd).toBe(true);
  });

  it('refuses any other change, zeroed magic or not', () => {
    // Arrange
    const other = Buffer.from(LINUXDEPLOY);
    other[20] = (other[20]! + 1) % 256;
    const otherPatched = Buffer.from(other);
    otherPatched.fill(0, 8, 11);

    // Act
    const changed = matchesPin(other, sha256(LINUXDEPLOY));
    const changedAfterDd = matchesPin(otherPatched, sha256(LINUXDEPLOY));
    const tooShort = matchesPin(Buffer.alloc(4), sha256(LINUXDEPLOY));

    // Assert
    expect([changed, changedAfterDd, tooShort]).toEqual([false, false, false]);
  });
});

describe('startsWithRuntime', () => {
  it("is true when only the runtime's zeroed sections were filled in, then the file system follows", () => {
    // Arrange
    const appImage = Buffer.concat([RUNTIME, Buffer.from('hsqs')]);
    appImage.fill(0xab, RUNTIME.length - 16, RUNTIME.length);

    // Act
    const ok = startsWithRuntime(appImage, RUNTIME);

    // Assert
    expect(ok).toBe(true);
  });

  it('is false for another runtime, or a file no longer than the runtime', () => {
    // Arrange
    const other = Buffer.concat([RUNTIME, Buffer.from('hsqs')]);
    other[12] = (other[12]! + 1) % 256;

    // Act
    const different = startsWithRuntime(other, RUNTIME);
    const short = startsWithRuntime(RUNTIME, RUNTIME);

    // Assert
    expect([different, short]).toEqual([false, false]);
  });
});

describe('prepareAppImageTools', () => {
  it('writes the files under the names the bundler looks for, runnable, and the runtime for LDAI_RUNTIME_FILE', async ({ tmp }) => {
    // Arrange
    const { base } = await serve();
    const toolsDir = path.join(tmp, 'tauri');

    // Act
    const env = await prepareAppImageTools('linux-x64', { ...quiet, toolsDir, cacheDir: undefined, pins: pinsFor(base) });

    // Assert
    expect(fs.readdirSync(toolsDir).sort()).toEqual(['AppRun-x86_64', APPIMAGE_PLUGIN, 'linuxdeploy-07333c6-x86_64.AppImage', 'runtime-x86_64'].sort());
    expect(fs.readFileSync(path.join(toolsDir, 'AppRun-x86_64'))).toEqual(APPRUN);
    expect(fs.readFileSync(path.join(toolsDir, 'linuxdeploy-07333c6-x86_64.AppImage'))).toEqual(LINUXDEPLOY);
    expect(env).toEqual({ LDAI_RUNTIME_FILE: path.join(toolsDir, 'runtime-x86_64') });
    expect(fs.readFileSync(env.LDAI_RUNTIME_FILE!)).toEqual(RUNTIME);
    expect(fs.statSync(path.join(toolsDir, APPIMAGE_PLUGIN)).size).toBe(0);
    if (!isWindows) {
      expect(mode(path.join(toolsDir, 'AppRun-x86_64'))).toBe(0o755);
      expect(mode(path.join(toolsDir, 'linuxdeploy-07333c6-x86_64.AppImage'))).toBe(0o755);
      expect(mode(env.LDAI_RUNTIME_FILE!)).toBe(0o644);
      expect(mode(path.join(toolsDir, APPIMAGE_PLUGIN)) & 0o111).toBe(0);
    }
  });

  it('rides out a 504 from the publisher (the failure the bundler had no retry for)', async ({ tmp }) => {
    // Arrange
    const { base, requests } = await serve({ failFirst: 2, status: 504 });

    // Act
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir: path.join(tmp, 'tauri'), cacheDir: undefined, pins: pinsFor(base) });

    // Assert
    expect(requests).toEqual(['AppRun-x86_64', 'AppRun-x86_64', 'AppRun-x86_64', 'linuxdeploy-x86_64.AppImage', 'runtime-x86_64']);
  });

  it('downloads nothing the next time, also after the bundler zeroed the magic of its linuxdeploy', async ({ tmp }) => {
    // Arrange
    const { base, requests } = await serve();
    const toolsDir = path.join(tmp, 'tauri');
    const pins = pinsFor(base);
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir, cacheDir: undefined, pins });
    const linuxdeploy = path.join(toolsDir, 'linuxdeploy-07333c6-x86_64.AppImage');
    const patched = fs.readFileSync(linuxdeploy);
    patched.fill(0, 8, 11);
    fs.writeFileSync(linuxdeploy, patched);
    requests.length = 0;

    // Act
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir, cacheDir: undefined, pins });

    // Assert
    expect(requests).toEqual([]);
    expect(fs.readFileSync(linuxdeploy)).toEqual(patched);
  });

  it('replaces a file that is not the pin, and a real appimage plugin with the placeholder', async ({ tmp }) => {
    // Arrange
    const { base, requests } = await serve();
    const toolsDir = path.join(tmp, 'tauri');
    fs.mkdirSync(toolsDir);
    fs.writeFileSync(path.join(toolsDir, 'AppRun-x86_64'), 'an older AppRun');
    fs.writeFileSync(path.join(toolsDir, APPIMAGE_PLUGIN), appImageBytes('a continuous plugin'), { mode: 0o755 });

    // Act
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir, cacheDir: undefined, pins: pinsFor(base) });

    // Assert
    expect(requests).toContain('AppRun-x86_64');
    expect(fs.readFileSync(path.join(toolsDir, 'AppRun-x86_64'))).toEqual(APPRUN);
    expect(fs.statSync(path.join(toolsDir, APPIMAGE_PLUGIN)).size).toBe(0);
    if (!isWindows) expect(mode(path.join(toolsDir, APPIMAGE_PLUGIN)) & 0o111).toBe(0);
  });

  it('fills the download cache and uses it in a fresh tools folder (a new runner)', async ({ tmp }) => {
    // Arrange
    const { base, requests } = await serve();
    const cacheDir = path.join(tmp, 'cache');
    const pins = pinsFor(base);
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir: path.join(tmp, 'first'), cacheDir, pins });
    requests.length = 0;

    // Act
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir: path.join(tmp, 'second'), cacheDir, pins });

    // Assert
    expect(requests).toEqual([]);
    expect(fs.readdirSync(cacheDir).sort()).toEqual(Object.keys(FILES).map((n) => `${sha256(FILES[n]!)}-${n}`).sort());
    expect(fs.readFileSync(path.join(tmp, 'second', 'linuxdeploy-07333c6-x86_64.AppImage'))).toEqual(LINUXDEPLOY);
  });

  it('ignores a cache entry with the wrong bytes and downloads the pin', async ({ tmp }) => {
    // Arrange
    const { base, requests } = await serve();
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, `${sha256(APPRUN)}-AppRun-x86_64`), 'not AppRun');

    // Act
    await prepareAppImageTools('linux-x64', { ...quiet, toolsDir: path.join(tmp, 'tauri'), cacheDir, pins: pinsFor(base) });

    // Assert
    expect(requests).toContain('AppRun-x86_64');
    expect(fs.readFileSync(path.join(tmp, 'tauri', 'AppRun-x86_64'))).toEqual(APPRUN);
    expect(fs.readFileSync(path.join(cacheDir, `${sha256(APPRUN)}-AppRun-x86_64`))).toEqual(APPRUN);
  });

  it('fails on a file whose SHA-256 is not the pin, and leaves no tool behind', async ({ tmp }) => {
    // Arrange
    const { base } = await serve();
    const pins = pinsFor(base);
    pins['tauri-apprun']!.assets['linux-x64']!.sha256 = sha256(Buffer.from('another AppRun'));
    const toolsDir = path.join(tmp, 'tauri');

    // Act
    const run = prepareAppImageTools('linux-x64', { ...quiet, toolsDir, cacheDir: undefined, pins });

    // Assert
    await expect(run).rejects.toThrow(/Checksum mismatch .*AppRun-x86_64/);
    expect(fs.readdirSync(toolsDir)).toEqual([]);
  });

  it('refuses a target without AppImage tools', async ({ tmp }) => {
    // Act
    const run = prepareAppImageTools('macos-arm64', { ...quiet, toolsDir: path.join(tmp, 'tauri'), cacheDir: undefined, pins: pinsFor('http://127.0.0.1:9') });

    // Assert
    await expect(run).rejects.toThrow(/No tauri-apprun for macos-arm64/);
  });
});

describe('versions.json AppImage tools', () => {
  const tools = appImageTools(versions as unknown as Record<string, Spec>) as Record<string, Spec>;
  const ARCH = { 'linux-x64': 'x86_64', 'linux-arm64': 'aarch64' } as const;

  it('were read from the bundler of the @tauri-apps/cli in package-lock.json (re-read it when that changes)', () => {
    // Arrange
    const cli = (lock.packages as Record<string, { version?: string }>)['node_modules/@tauri-apps/cli']?.version;

    // Act
    const readFrom = Object.values(tools).map((t) => t.tauriCli);

    // Assert
    expect(readFrom).toEqual(Object.values(tools).map(() => cli));
  });

  it("carry the bundler's file names for both Linux architectures, pinned by SHA-256", () => {
    // Act
    const names = Object.fromEntries(Object.entries(tools).map(([tool, t]) => [tool, Object.fromEntries(Object.entries(t.assets).map(([target, a]) => [target, a.binary]))]));

    // Assert
    expect(names).toEqual({
      'tauri-apprun': { 'linux-x64': `AppRun-${ARCH['linux-x64']}`, 'linux-arm64': `AppRun-${ARCH['linux-arm64']}` },
      linuxdeploy: { 'linux-x64': 'linuxdeploy-07333c6-x86_64.AppImage', 'linux-arm64': 'linuxdeploy-07333c6-aarch64.AppImage' },
      'appimage-runtime': { 'linux-x64': 'runtime-x86_64', 'linux-arm64': 'runtime-aarch64' },
    });
    for (const t of Object.values(tools)) for (const a of Object.values(t.assets)) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("download from the bundler's own URLs, and the rolling runtime has a mirror", () => {
    // Act
    const urls = Object.fromEntries(Object.entries(tools).map(([tool, t]) => [tool, t.url.replace('{version}', t.version).replace('{asset}', t.assets['linux-arm64']!.asset)]));
    const runtimeMirrors = Object.values(tools['appimage-runtime']!.assets).map((a) => a.mirrors?.length ?? 0);

    // Assert
    expect(urls).toEqual({
      'tauri-apprun': 'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64',
      linuxdeploy: 'https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-aarch64.AppImage',
      'appimage-runtime': 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-aarch64',
    });
    expect(runtimeMirrors).toEqual([1, 1]);
  });
});
