#!/usr/bin/env node
// Download MediaMTX and cloudflared for one platform and verify them against the
// SHA-256 values pinned in versions.json (copied from the upstream release checksums).
//
// Usage: node scripts/build/fetch-binaries.mjs [--target macos-arm64] [--out vendor/macos-arm64] [--with-ffmpeg]
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

async function download(url, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
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

export async function fetchBinaries(target, outDir, { withOptional = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [tool, spec] of Object.entries(versions)) {
    // ffmpeg (quality ladder) is installed by the streamer from the panel, not shipped,
    // unless a packager explicitly opts in (and then ships its license + source).
    if (spec.bundle === false && !(withOptional || process.argv.includes(`--with-${tool}`))) continue;
    const a = spec.assets[target];
    if (!a) throw new Error(`No ${tool} build for ${target}`);
    const finalPath = path.join(outDir, path.basename(a.binary));
    const stamp = path.join(outDir, `${tool}.version`);
    if (fs.existsSync(finalPath) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${spec.version} ${a.sha256}`) {
      console.log(`✓ ${tool} ${spec.version} already present`);
      continue;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `sc-${tool}-`));
    const archive = path.join(work, a.asset);
    const url = a.url ?? spec.url.replace('{version}', spec.version).replace('{asset}', a.asset);
    console.log(`↓ ${url}`);
    await download(url, archive);
    const actual = sha256(archive);
    if (actual !== a.sha256) {
      fs.rmSync(work, { recursive: true, force: true });
      throw new Error(`Checksum mismatch for ${a.asset}: expected ${a.sha256}, got ${actual}`);
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
  fetchBinaries(target, out).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
