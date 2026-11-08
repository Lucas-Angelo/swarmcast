// pkg's base Node.js binary for one target, put where pkg looks for it before package.mjs runs
// pkg, so pkg never downloads it nor builds Node.js from source.
//
// pkg (@yao-pkg/pkg-fetch) downloads `node-<version>-<platform>-<arch>` from its GitHub release with
// one try (lib-es5/index.js `download`), and when that fails it compiles Node.js from source:
// about an hour, and on the runners it fails anyway (PR #141: github.com answered 504, then
// `make: *** [Makefile:143: node] Error 2` after 7 minutes, with g++ 11 "too old"). Here the binary
// comes from SC_DOWNLOAD_CACHE when it is there (CI's setup action restores it), else from that
// release through fetch-binaries.mjs's download (6 tries with back-off, resume, a stall limit), and
// is checked against the SHA-256 pkg-fetch itself expects (its expected-shas.json). A failure stops
// the build with the reason. Then pkg-fetch is asked (a dry run) whether it would use that file,
// so a change in its layout fails here instead of downloading or compiling.
//
// In SC_DOWNLOAD_CACHE the binary is `pkg-<sha256>-node-<version>-<platform>-<arch>`: outside the
// `<sha256>-<asset>` names fetch-binaries.mjs prunes against versions.json; this file prunes its
// own (`pkg-*` that pkg-fetch no longer expects).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { downloadFirst } from './fetch-binaries.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The pkg-fetch that @yao-pkg/pkg runs (resolved from pkg's own folder, so the same copy):
 * its version, node version choice, expected hashes and `need`.
 */
export function loadPkgFetch() {
  const fromPkg = createRequire(path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'package.json'));
  const dir = path.dirname(fromPkg.resolve('@yao-pkg/pkg-fetch/package.json'));
  const req = createRequire(path.join(dir, 'package.json'));
  const fetchLib = req('./lib-es5/index.js');
  return {
    version: req('./package.json').version,
    getNodeVersion: fetchLib.getNodeVersion,
    expected: req('./lib-es5/expected.js').EXPECTED_HASHES,
    need: fetchLib.need,
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Where pkg-fetch looks for the base binary of `pkgTarget` (`node24-linux-x64`, as package.mjs
 * passes `--targets`) and where it would download it from: lib-es5/places.js (`<cache>/v<major>.<minor
 * of pkg-fetch>/fetched-<node version>-<platform>-<arch>`, cache = PKG_CACHE_PATH or ~/.pkg-cache).
 */
export function pkgBasePlace(pkgTarget, { fetcher, pkgCache }) {
  const m = /^(node\d+)-(win|macos|linux)-(x64|arm64)$/.exec(pkgTarget);
  if (!m) throw new Error(`unexpected pkg target ${pkgTarget}`);
  const [, nodeRange, platform, arch] = m;
  const nodeVersion = fetcher.getNodeVersion(nodeRange);
  const [major, minor] = fetcher.version.split('.');
  const tag = `v${major}.${minor}`;
  const name = `node-${nodeVersion}-${platform}-${arch}`;
  const sha = fetcher.expected[name];
  if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`pkg-fetch ${fetcher.version} has no SHA-256 for ${name}`);
  return {
    nodeRange,
    platform,
    arch,
    name,
    sha256: sha,
    url: `https://github.com/yao-pkg/pkg-fetch/releases/download/${tag}/${name}`,
    file: path.join(pkgCache, tag, `fetched-${nodeVersion}-${platform}-${arch}`),
  };
}

/** Drops the `pkg-*` files of the download cache that pkg-fetch no longer expects. */
function pruneCache(cacheDir, expected) {
  const keep = new Set(Object.values(expected));
  for (const f of fs.readdirSync(cacheDir)) {
    const m = /^pkg-([0-9a-f]{64})-/.exec(f);
    if (m && !keep.has(m[1])) fs.rmSync(path.join(cacheDir, f), { force: true });
  }
}

/**
 * Makes sure pkg finds the base binary of `pkgTarget` in its cache (see the top of this file).
 * Returns where it came from: `pkg cache`, `download cache` or the URL it was downloaded from.
 * `cacheDir` defaults to SC_DOWNLOAD_CACHE; null means no download cache. `fetcher`
 * (loadPkgFetch), `download` (downloadFirst) and `log` are for tests.
 */
export async function ensurePkgBase(
  pkgTarget,
  { cacheDir = process.env.SC_DOWNLOAD_CACHE, pkgCache = process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache'), fetcher = loadPkgFetch(), download = downloadFirst, log = console.log } = {},
) {
  const place = pkgBasePlace(pkgTarget, { fetcher, pkgCache });
  const cached = cacheDir ? path.join(cacheDir, `pkg-${place.sha256}-${place.name}`) : null;
  let source;
  if (fs.existsSync(place.file) && sha256(place.file) === place.sha256) {
    source = 'pkg cache';
  } else {
    fs.mkdirSync(path.dirname(place.file), { recursive: true });
    if (cached && fs.existsSync(cached) && sha256(cached) === place.sha256) {
      source = 'download cache';
    } else {
      if (cached) fs.mkdirSync(cacheDir, { recursive: true });
      try {
        await download([place.url], cached ?? place.file, place.sha256);
      } catch (err) {
        throw new Error(`pkg's Node.js base binary ${place.name} could not be downloaded (pkg would compile Node.js from source instead, which takes about an hour): ${err.message}`, { cause: err });
      }
      source = place.url;
    }
    if (cached) {
      // Copy, then rename: a build stopped halfway never leaves a partial file where pkg looks.
      fs.copyFileSync(cached, `${place.file}.part`);
      fs.renameSync(`${place.file}.part`, place.file);
    }
    if (process.platform !== 'win32') fs.chmodSync(place.file, 0o755);
  }
  if (cacheDir && fs.existsSync(cacheDir)) pruneCache(cacheDir, fetcher.expected);
  const verdict = await fetcher.need({ dryRun: true, nodeRange: place.nodeRange, platform: place.platform, arch: place.arch });
  if (verdict !== 'exists') {
    throw new Error(`pkg-fetch ${fetcher.version} would not use ${place.file} (dry run: "${verdict}"): has its cache layout changed? See scripts/build/pkg-base.mjs`);
  }
  log(`✓ pkg base binary ${place.name} from ${source.startsWith('http') ? source : `the ${source}`} (${place.sha256.slice(0, 12)}…)`);
  return source;
}
