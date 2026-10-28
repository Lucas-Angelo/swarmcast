#!/usr/bin/env node
// Download MediaMTX and cloudflared for one platform and verify them against the
// SHA-256 values pinned in versions.json (copied from the upstream release checksums).
//
// Usage: node scripts/build/fetch-binaries.mjs [--target macos-arm64] [--out vendor/macos-arm64] [--with-ffmpeg]
//        node scripts/build/fetch-binaries.mjs --only ffmpeg-test --out <dir>   (one tool only)
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
const TRIES = 6;
const STALL_MS = Number(process.env.SC_DOWNLOAD_STALL_MS ?? 30_000);
const why = (err) => [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(': ');

/** One try: the body is streamed to `dest`, and the try is aborted when no bytes arrive for STALL_MS. */
async function fetchOnce(url, dest) {
  const ac = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000} s`)), STALL_MS);
  };
  arm();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.final = [403, 404, 410].includes(res.status);
      throw err;
    }
    const chunks = [];
    for await (const chunk of res.body) {
      chunks.push(chunk);
      arm();
    }
    fs.writeFileSync(dest, Buffer.concat(chunks));
  } catch (err) {
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}

export async function download(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchOnce(url, dest);
      return;
    } catch (err) {
      if (err.final || attempt === TRIES) throw new Error(`${why(err)} (${url}, try ${attempt} of ${TRIES})`);
      const wait = 2 ** attempt;
      console.warn(`  try ${attempt} of ${TRIES} failed (${why(err)}); again in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
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

export async function fetchBinaries(target, outDir, { withOptional = false, only } = {}) {
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
    } else if (spec.testOnly) {
      // ffmpeg-test (the GPL build CI's test feeds use) is fetched only by name (--only).
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
      const url = a.url ?? spec.url.replace('{version}', spec.version).replace('{asset}', a.asset);
      console.log(`↓ ${url}`);
      await download(url, archive);
      const actual = sha256(archive);
      if (actual !== a.sha256) {
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error(`Checksum mismatch for ${a.asset}: expected ${a.sha256}, got ${actual}`);
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
      execFileSync(tarBin(), ['-xf', archive, '-C', ex]);
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
  fetchBinaries(target, out, { only: arg('only') }).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
