#!/usr/bin/env node
// Download MediaMTX and cloudflared for one platform and verify them against the
// SHA-256 values pinned in versions.json (copied from the upstream release checksums).
// Run as a script (`npm run fetch-bins`) it also fetches the test tools (`testTool` in
// versions.json: Pebble, the ACME test's CA), which packaging (package.mjs) never takes.
//
// Usage: node scripts/build/fetch-binaries.mjs [--target macos-arm64] [--out vendor/macos-arm64] [--with-ffmpeg]
//        node scripts/build/fetch-binaries.mjs --only ffmpeg-test --out <dir>   (one tool only)
//
// An asset with "mirrors" (versions.json) is downloaded from them first and from its publisher
// only when they fail: from GitHub's runners the macOS ffmpeg host is very slow, so CI uses a
// byte-identical copy in this repo's `ci-deps` pre-release (docs/RELEASING.md). When every
// source failed, the GitHub release files among them are tried once more through GitHub's REST
// API (githubApiUrl). The pinned SHA-256 is checked whatever the source.
//
// SC_DOWNLOAD_CACHE=<dir> keeps the verified archives there (named by SHA-256) and uses them
// instead of downloading again; CI's setup action caches that folder. Entries no longer pinned
// in versions.json are deleted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// On Windows, Git for Windows puts GNU tar first in PATH; it reads "C:\..." as a remote host.
// The OS ships bsdtar (which also handles .zip) in System32.
function tarBin() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const versions = JSON.parse(fs.readFileSync(path.join(here, 'versions.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export function hostTarget() {
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return `${osName}-${process.arch}`;
}

// 6 tries, 2 + 4 + 8 + 16 + 32 s apart: a network blip of up to about 2 minutes (with fetch's own
// 10 s connect timeout per try) is ridden out. Three tries 2-6 s apart were not enough: one
// release run died of `UND_ERR_CONNECT_TIMEOUT github.com` after about 40 s. A missing file
// (HTTP 403/404/410) fails at once. A try that stops receiving bytes for STALL_MS is aborted
// and retried: one macOS CI job sat 44 min on a body that never finished, until the job timed out.
// A retry resumes where the stalled try stopped (HTTP Range) when the server allows it: a
// pre-release job failed 6 tries of the 28 MB macOS ffmpeg, each restarting from byte 0. A try
// that brought new bytes starts the count of 6 over: only 6 tries in a row without progress fail
// (from GitHub's macOS runners the same host trickles 10-30 kB/s with stalls; on PR #19 it sent
// 17.7 of 28 MB in 6 tries). SC_DOWNLOAD_MAX_MIN (default 20) caps the whole download.
const TRIES = 6;
const MAX_MS = Number(process.env.SC_DOWNLOAD_MAX_MIN ?? 20) * 60_000;
const STALL_MS = Number(process.env.SC_DOWNLOAD_STALL_MS ?? 30_000);
const why = (err) => [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(': ');

/**
 * One try, appending to `got` (the bytes kept from earlier tries, in memory). With bytes already
 * there it asks for the rest (`Range: bytes=<n>-`): a 206 that starts at n is appended, a 200
 * (the server ignores ranges) starts over, a 416 means the earlier try already had the whole file
 * when its Content-Range says so, else it starts over. The try is aborted when no bytes arrive for
 * `stallMs`; what arrived until then stays in `got` for the next try. Nothing is written here.
 * `headers` go with every request.
 */
async function fetchInto(url, got, stallMs, fetchImpl, headers) {
  const ac = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs);
  };
  const restart = () => {
    got.chunks = [];
    got.bytes = 0;
  };
  arm();
  try {
    const from = got.bytes;
    const res = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { ...headers, ...(from > 0 ? { range: `bytes=${from}-` } : {}) } });
    if (from > 0 && res.status === 416) {
      await res.body?.cancel();
      const total = /^bytes \*\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
      if (Number(total) === from) return;
      restart();
      throw new Error(`HTTP 416 for bytes ${from}- (starting over)`);
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.final = [403, 404, 410].includes(res.status);
      throw err;
    }
    if (res.status === 206) {
      const start = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1];
      if (Number(start) !== from) {
        await res.body?.cancel();
        restart();
        throw new Error(`HTTP 206 from byte ${start ?? '?'} instead of ${from} (starting over)`);
      }
      got.resumedAt.push(from);
    } else if (from > 0) {
      // 200: the whole file again.
      restart();
    }
    for await (const chunk of res.body) {
      got.chunks.push(chunk);
      got.bytes += chunk.length;
      arm();
    }
  } catch (err) {
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download `url` to `dest` when its SHA-256 is `sha256`. A try that stalls or breaks is resumed
 * where it stopped (see fetchInto). The bytes are checked in memory and only bytes that match
 * reach the disk (written to `dest.part`, then renamed). A mismatch is final: the pin or the
 * upstream file is wrong (or, after a resume, the server sent a different file), and downloading
 * again would not change that. `headers` go with every request. `waitMs`, `stallMs`, `maxMs` and
 * `fetch` (the network) are for tests. Returns the number of tries it took.
 */
export async function download(url, dest, sha256, { headers = {}, waitMs = (attempt) => 2 ** attempt * 1000, stallMs = STALL_MS, maxMs = MAX_MS, fetch: fetchImpl = fetch } = {}) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error(`no pinned SHA-256 for ${url}`);
  const got = { chunks: [], bytes: 0, resumedAt: [] };
  const deadline = Date.now() + maxMs;
  // `failed`: tries in a row that brought no new bytes (they fail it at TRIES and set the back-off).
  for (let attempt = 1, failed = 0; ; attempt++) {
    const before = got.bytes;
    try {
      await fetchInto(url, got, stallMs, fetchImpl, headers);
    } catch (err) {
      failed = got.bytes > before ? 0 : failed + 1;
      const where = `${url}, try ${attempt}, ${failed} of ${TRIES} in a row without progress`;
      if (err.final || failed === TRIES) throw new Error(`${why(err)} (${where})`, { cause: err });
      if (Date.now() >= deadline) throw new Error(`${why(err)} (${where}; gave up after ${maxMs / 60_000} min, ${got.bytes} bytes received; SC_DOWNLOAD_MAX_MIN)`, { cause: err });
      const wait = waitMs(Math.max(1, failed));
      const kept = got.bytes ? `, ${got.bytes} bytes kept` : '';
      console.warn(`  try ${attempt} failed (${why(err)}${kept}; ${failed} of ${TRIES} in a row without progress); again in ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const bytes = Buffer.concat(got.chunks);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      const resumed = got.resumedAt.length ? ` (after resuming at byte ${got.resumedAt.join(', ')}: the parts may come from different files)` : '';
      const err = new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}${resumed}`);
      err.checksum = true;
      throw err;
    }
    // Only reached when sha256(bytes) equals the pin from versions.json: these are exactly the
    // bytes reviewed when the pin was set, not data chosen by the server.
    fs.writeFileSync(`${dest}.part`, bytes);
    fs.renameSync(`${dest}.part`, dest);
    return attempt;
  }
}

const GITHUB_RELEASE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/;

/**
 * The URL of a `github.com/<owner>/<repo>/releases/download/<tag>/<name>` file on GitHub's REST
 * API (`/repos/<owner>/<repo>/releases/assets/<id>`, which redirects to the same bytes on
 * release-assets.githubusercontent.com when asked for `application/octet-stream`). On 2026-11-08
 * github.com's release downloads answered 504 for most of an hour while that endpoint served the
 * same files (PR #141; .github/workflows/README.md, "Release downloads"). One lookup of the
 * release by tag, without a token: GitHub allows 60 such requests an hour per address, and a
 * refusal only fails this last source.
 */
export async function githubApiUrl(url, { fetch: fetchImpl = fetch, apiBase = 'https://api.github.com' } = {}) {
  const [, owner, repo, tag, name] = GITHUB_RELEASE.exec(url) ?? [];
  if (!owner) throw new Error(`not a GitHub release download: ${url}`);
  const res = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/releases/tags/${tag}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the GitHub API for release ${decodeURIComponent(tag)} of ${owner}/${repo}`);
  const asset = (await res.json()).assets?.find((a) => a.name === decodeURIComponent(name));
  if (!asset) throw new Error(`release ${decodeURIComponent(tag)} of ${owner}/${repo} has no ${decodeURIComponent(name)} (GitHub API)`);
  return `${apiBase}/repos/${owner}/${repo}/releases/assets/${asset.id}`;
}

/**
 * `download` from the first of `urls` that works: our mirror first (`mirrors` in versions.json,
 * the `ci-deps` pre-release of this repo), the publisher's own URL last, then the GitHub release
 * files among them once more through GitHub's API (githubApiUrl). Each source gets the whole
 * `download` treatment (resume, retries, time cap). A source that fails (missing file, stalls,
 * too slow) passes the turn to the next one; a checksum mismatch stops at once: a mirror serving
 * other bytes than the pin is a problem to look at, not to route around. The pinned SHA-256 is
 * the only thing trusted, whichever source the bytes came from. A source that worked only after
 * failed tries, or through the API, logs it as an `infra recovery:` (docs/TESTING.md, counted by
 * the soak). `apiBase` and `fetch` are for tests.
 */
export async function downloadFirst(urls, dest, sha256, opts = {}) {
  const errors = [];
  const sources = [...urls.map((url) => ({ url })), ...urls.filter((url) => GITHUB_RELEASE.test(url)).map((url) => ({ url, api: true }))];
  for (const [i, { url, api }] of sources.entries()) {
    try {
      let from = url;
      if (api) {
        console.log(`↓ ${url} through the GitHub API`);
        from = await githubApiUrl(url, opts);
      } else {
        console.log(`↓ ${url}`);
      }
      const tries = await download(from, dest, sha256, api ? { ...opts, headers: { accept: 'application/octet-stream' } } : opts);
      if (api) console.warn(`  infra recovery: ${url} downloaded through the GitHub API (${from}), try ${tries}`);
      else if (tries > 1) console.warn(`  infra recovery: ${url} downloaded on try ${tries} (the ${tries - 1} before it failed)`);
      return from;
    } catch (err) {
      if (err.checksum || i === sources.length - 1) {
        if (errors.length === 0) throw err;
        throw new Error([...errors, err.message].join('; then '), { cause: err });
      }
      errors.push(err.message);
      console.warn(`  ${err.message}; trying the next source`);
    }
  }
  throw new Error('no download URL');
}

/** Where an asset can be downloaded from, in order: its mirrors, then the publisher. */
export function assetUrls(spec, a) {
  const original = a.url ?? spec.url.replace('{version}', spec.version).replace('{asset}', a.asset);
  return [...(a.mirrors ?? []), original];
}

/** The pinned archives, by SHA-256: what SC_DOWNLOAD_CACHE may keep. */
function pinnedHashes() {
  return new Set(Object.values(versions).flatMap((spec) => Object.values(spec.assets ?? {}).map((a) => a.sha256)));
}

/** Drops cache entries that versions.json no longer pins (the cache would grow forever). */
function pruneCache(dir) {
  const keep = pinnedHashes();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^([0-9a-f]{64})-/.exec(f);
    if (m && !keep.has(m[1])) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

export async function fetchBinaries(target, outDir, { withOptional = false, withTestTools = false, only } = {}) {
  if (only && !versions[only]) throw new Error(`Unknown tool ${only} (versions.json has ${Object.keys(versions).join(', ')})`);
  fs.mkdirSync(outDir, { recursive: true });
  const cacheDir = process.env.SC_DOWNLOAD_CACHE ? path.resolve(process.env.SC_DOWNLOAD_CACHE) : null;
  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    pruneCache(cacheDir);
  }
  for (const [tool, spec] of Object.entries(versions)) {
    if (only) {
      if (tool !== only) continue;
    } else if (spec.testTool) {
      // Pebble (the integration tests' ACME CA) comes with `npm run fetch-bins`, never with a package.
      if (!withTestTools) continue;
    } else if (spec.testOnly || spec.appimageTool) {
      // ffmpeg-test (the GPL build CI's test feeds use) and cargo-llvm-cov (CI's Rust coverage)
      // are fetched only by name (--only); the AppImage build tools only by appimage-tools.mjs.
      continue;
    } else if (spec.bundle === false && !(withOptional || process.argv.includes(`--with-${tool}`))) {
      // ffmpeg (quality ladder) is installed by the streamer from the panel, not shipped,
      // unless a packager explicitly opts in (and then ships its license + source).
      continue;
    }
    const a = spec.assets[target];
    if (!a) throw new Error(`No ${tool} build for ${target}`);
    const finalPath = path.join(outDir, path.basename(a.binary));
    const stamp = path.join(outDir, `${tool}.version`);
    if (fs.existsSync(finalPath) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${spec.version} ${a.sha256}`) {
      console.log(`✓ ${tool} ${spec.version} already present`);
      continue;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `sc-${tool}-`));
    const cached = cacheDir && path.join(cacheDir, `${a.sha256}-${a.asset}`);
    let archive = path.join(work, a.asset);
    if (cached && fs.existsSync(cached) && sha256(cached) === a.sha256) {
      console.log(`✓ ${tool} ${spec.version}: ${a.asset} from the download cache`);
      archive = cached;
    } else {
      try {
        await downloadFirst(assetUrls(spec, a), archive, a.sha256);
      } catch (err) {
        fs.rmSync(work, { recursive: true, force: true });
        throw err;
      }
      if (cached) {
        // Copy, then rename: a job killed halfway never leaves a partial entry.
        fs.copyFileSync(archive, `${cached}.part`);
        fs.renameSync(`${cached}.part`, cached);
      }
    }
    let binary;
    if (/\.(zip|tar\.gz|tgz|tar\.xz)$/.test(a.asset)) {
      const ex = path.join(work, 'x');
      fs.mkdirSync(ex);
      // GNU tar (Linux) reads no .zip: the Windows assets, when the Windows package is built on
      // Linux (CI's build job), go through unzip, which the Ubuntu images have.
      if (a.asset.endsWith('.zip') && process.platform === 'linux') execFileSync('unzip', ['-q', archive, '-d', ex]);
      else execFileSync(tarBin(), ['-xf', archive, '-C', ex]);
      binary = findFile(ex, path.basename(a.binary));
      if (!binary) throw new Error(`${a.binary} not found inside ${a.asset}`);
    } else {
      binary = archive;
    }
    if (a.binarySha256 && sha256(binary) !== a.binarySha256) {
      throw new Error(`Checksum mismatch for ${a.binary} inside ${a.asset}`);
    }
    fs.copyFileSync(binary, finalPath);
    if (process.platform !== 'win32') fs.chmodSync(finalPath, 0o755);
    fs.writeFileSync(stamp, `${spec.version} ${a.sha256}`);
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`✓ ${tool} ${spec.version} verified (${a.sha256.slice(0, 12)}…)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = arg('target', hostTarget());
  const out = path.resolve(arg('out', path.join(root, 'vendor', target)));
  fetchBinaries(target, out, { only: arg('only'), withTestTools: true }).catch((err) => {
    console.error(`✗ ${err.message}`);
    // The cause on the run's summary page, not only "exit code 1" (CI stops the job here: no test
    // runs without its binaries, .github/workflows/README.md, "Release downloads").
    // A workflow command's message escapes %, CR and LF (URLs in the message carry %-escapes).
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=fetch-binaries::${err.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
  });
}
