#!/usr/bin/env node
// Assemble a release package for one target:
//   release/staging/<target>/
//     swarmcast[.exe]            (server bundle + embedded Node 24, via @yao-pkg/pkg)
//     bin/mediamtx[.exe]         (verified against versions.json)
//     bin/cloudflared[.exe]      (verified against versions.json)
//     bin/swarmcast-tray[.exe]   (optional, built by apps/tray/build.mjs)
//     web/viewer, web/admin      (Vite builds)
//     LICENSE, THIRD_PARTY_LICENSES.txt, VERSION
// Then archives it unless --no-archive is given (see archive.mjs).
//
// Usage: node scripts/build/package.mjs [--target macos-arm64] [--version 0.1.0] [--no-archive]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchBinaries, hostTarget } from './fetch-binaries.mjs';
import { writeThirdPartyLicenses } from './licenses.mjs';
import { archive } from './archive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const PKG_TARGETS = {
  'windows-x64': 'node24-win-x64',
  'macos-arm64': 'node24-macos-arm64',
  'macos-x64': 'node24-macos-x64',
  'linux-x64': 'node24-linux-x64',
  'linux-arm64': 'node24-linux-arm64',
};

const target = arg('target', hostTarget());
const version = arg('version', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
if (!PKG_TARGETS[target]) throw new Error(`Unknown target ${target}`);
const isWin = target.startsWith('windows');
const exe = (n) => (isWin ? `${n}.exe` : n);

const staging = path.join(root, 'release', 'staging', target);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });

// 1. Web apps and server bundle (with the release version baked in).
for (const [name, dir] of [
  ['viewer', 'apps/viewer/dist'],
  ['admin', 'apps/admin/dist'],
]) {
  if (!fs.existsSync(path.join(root, dir, name === 'admin' ? 'index.html' : 'watch.html'))) {
    throw new Error(`${dir} is missing. Run "npm run build" first.`);
  }
  fs.cpSync(path.join(root, dir), path.join(staging, 'web', name), { recursive: true });
}
execFileSync(process.execPath, [path.join(root, 'apps/server/build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SWARMCAST_VERSION: version },
});

// 2. Single executable. --no-bytecode keeps cross-builds possible (bytecode needs the target CPU).
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js'),
    path.join(root, 'apps/server/dist/swarmcast.cjs'),
    '--targets', PKG_TARGETS[target],
    '--output', path.join(staging, exe('swarmcast')),
    '--no-bytecode', '--public', '--public-packages', '*',
    '--compress', 'Brotli',
  ],
  { stdio: 'inherit', cwd: root },
);

// 3. Third-party binaries, verified against pinned SHA-256 values.
await fetchBinaries(target, path.join(staging, 'bin'));
for (const f of fs.readdirSync(path.join(staging, 'bin'))) {
  if (f.endsWith('.version')) fs.rmSync(path.join(staging, 'bin', f));
}

// 4. Tray helper (optional: panel-only without it).
const trayCandidates = [path.join(root, 'apps/tray/bin', target, exe('swarmcast-tray')), path.join(root, 'vendor', target, exe('swarmcast-tray'))];
const tray = trayCandidates.find((p) => fs.existsSync(p));
if (tray) {
  fs.copyFileSync(tray, path.join(staging, 'bin', exe('swarmcast-tray')));
  if (!isWin) fs.chmodSync(path.join(staging, 'bin', exe('swarmcast-tray')), 0o755);
} else {
  console.warn(`⚠ tray helper for ${target} not found (build it with: node apps/tray/build.mjs --target ${target}); the package will run without a tray icon`);
}

// 5. Licenses and version.
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
writeThirdPartyLicenses(path.join(staging, 'THIRD_PARTY_LICENSES.txt'));
fs.writeFileSync(path.join(staging, 'VERSION'), `${version}\n`);

// macOS: pkg ad-hoc signs the executable; make sure everything is executable.
if (!isWin) for (const f of [exe('swarmcast'), `bin/${exe('mediamtx')}`, `bin/${exe('cloudflared')}`]) fs.chmodSync(path.join(staging, f), 0o755);

console.log(`✓ staged ${path.relative(root, staging)} (v${version})`);
if (!process.argv.includes('--no-archive')) {
  const out = await archive(target, version);
  console.log(`✓ ${path.relative(root, out)}`);
}
