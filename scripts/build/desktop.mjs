#!/usr/bin/env node
// Build the desktop app (apps/desktop, Tauri) for one target from a staged release package:
//
//   release/staging/<target>/ (made by package.mjs --no-archive)
//     swarmcast[.exe]            → sidecar  src-tauri/staged/binaries/swarmcast-server-<rust triple>[.exe]
//     bin/mediamtx, cloudflared  → resource bin/   (not the Go tray helper: the shell draws the tray)
//     web/viewer, web/admin      → resource web/
//     LICENSE                    → resource
//   + THIRD_PARTY_LICENSES.txt   → resource, made here: the package's list plus the Rust crates
//                                  compiled into the app (licenses.mjs, crate-licenses.mjs)
//
// then runs `tauri build` with the bundles of that OS and the updater artifacts (*.sig), and
// copies the results to release/desktop/<target>/.
//
// Usage: node scripts/build/desktop.mjs [--target macos-arm64] [--version 0.2.0] [--package]
//          [--bundles app,dmg] [--sidecar mock] [--insecure-updates [--updater-pubkey <file.pub>]]
//          [--debug] [--runner cargo-xwin]
//
//   --package           run package.mjs first (needs `npm run build`)
//   --sidecar mock      bundle apps/desktop/test/mock-server.mjs instead of the real server (tests)
//   --insecure-updates  allow http:// update URLs (local update tests only; never for releases)
//   --updater-pubkey    with --insecure-updates: trust this public key (`tauri signer generate`'s
//                       .pub file) instead of the release key, for update tests with a throwaway key
//   --runner <cmd>      passed to `tauri build` (e.g. cargo-xwin to build windows-x64 from Linux)
//
// Updater signing: TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD (CI secrets),
// or locally ~/.tauri/swarmcast-updater.key + ~/.tauri/swarmcast-updater.password. Without a
// key the app is built without updater artifacts (with a warning).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostTarget } from './fetch-binaries.mjs';
import { writeThirdPartyLicenses } from './licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const desktopDir = path.join(root, 'apps', 'desktop');
const tauriDir = path.join(desktopDir, 'src-tauri');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** Tauri / Rust names per release target. */
const TARGETS = {
  'windows-x64': { triple: 'x86_64-pc-windows-msvc', bundles: ['nsis'], pkg: 'node24-win-x64' },
  'macos-arm64': { triple: 'aarch64-apple-darwin', bundles: ['app', 'dmg'], pkg: 'node24-macos-arm64' },
  'macos-x64': { triple: 'x86_64-apple-darwin', bundles: ['app', 'dmg'], pkg: 'node24-macos-x64' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', bundles: ['deb', 'appimage'], pkg: 'node24-linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', bundles: ['deb', 'appimage'], pkg: 'node24-linux-arm64' },
};

const target = arg('target', hostTarget());
const spec = TARGETS[target];
if (!spec) throw new Error(`Unknown target ${target}. Use one of: ${Object.keys(TARGETS).join(', ')}`);
const version = arg('version', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
const bundles = arg('bundles', spec.bundles.join(',')).split(',');
const isWin = target.startsWith('windows');
const isMac = target.startsWith('macos');
const exe = (n) => (isWin ? `${n}.exe` : n);
const rel = (p) => path.relative(root, p);

// 1. The staged release package.
const staging = path.join(root, 'release', 'staging', target);
if (flag('package')) {
  execFileSync(process.execPath, [path.join(here, 'package.mjs'), '--target', target, '--version', version, '--no-archive'], { stdio: 'inherit' });
}
for (const f of [exe('swarmcast'), `bin/${exe('mediamtx')}`, `bin/${exe('cloudflared')}`, 'web/admin/index.html', 'web/viewer/watch.html', 'LICENSE']) {
  if (!fs.existsSync(path.join(staging, f))) {
    throw new Error(`${rel(staging)}/${f} is missing. Run: npm run build && node scripts/build/package.mjs --target ${target} --version ${version} --no-archive (or pass --package)`);
  }
}
const stagedVersion = fs.existsSync(path.join(staging, 'VERSION')) ? fs.readFileSync(path.join(staging, 'VERSION'), 'utf8').trim() : '?';
if (stagedVersion !== version) console.warn(`⚠ ${rel(staging)} is version ${stagedVersion}, building the app as ${version}`);

// 2. Sidecar and resources where tauri.conf (via the overlay below) expects them.
const stageDir = path.join(tauriDir, 'staged');
fs.rmSync(stageDir, { recursive: true, force: true });
const binDir = path.join(stageDir, 'binaries');
const resDir = path.join(stageDir, 'resources');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(resDir, 'bin'), { recursive: true });
const sidecar = path.join(binDir, `swarmcast-server-${spec.triple}${isWin ? '.exe' : ''}`);

if (arg('sidecar', 'server') === 'mock') {
  // A real executable (not a script) so it is signed and updated like the server.
  const bundle = path.join(stageDir, 'mock-server.cjs');
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/esbuild/bin/esbuild'), path.join(desktopDir, 'test/mock-server.mjs'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`, '--log-level=warning'],
    { stdio: 'inherit' },
  );
  execFileSync(process.execPath, [path.join(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js'), bundle, '--targets', spec.pkg, '--output', sidecar], { stdio: 'inherit', cwd: root });
  fs.rmSync(bundle);
  console.log('⚠ using the MOCK server as sidecar (test build)');
} else {
  fs.copyFileSync(path.join(staging, exe('swarmcast')), sidecar);
}
if (!isWin) fs.chmodSync(sidecar, 0o755);
for (const tool of ['mediamtx', 'cloudflared']) {
  const dest = path.join(resDir, 'bin', exe(tool));
  fs.copyFileSync(path.join(staging, 'bin', exe(tool)), dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
}
fs.cpSync(path.join(staging, 'web'), path.join(resDir, 'web'), { recursive: true });
fs.copyFileSync(path.join(staging, 'LICENSE'), path.join(resDir, 'LICENSE'));
// THIRD_PARTY_LICENSES.txt for the app: the package's list (npm, MediaMTX, cloudflared, fonts)
// plus the Rust crates compiled into the app for this target. Fails the build when a crate has no
// licence or one outside the allowlist (scripts/build/crate-licenses.mjs).
const npmCount = writeThirdPartyLicenses(path.join(resDir, 'THIRD_PARTY_LICENSES.txt'), { desktop: { target, triple: spec.triple } });
console.log(`✓ THIRD_PARTY_LICENSES.txt (${npmCount} npm packages + Rust crates for ${spec.triple})`);

// macOS: the bundler signs the app and the sidecar, but not files in Resources. MediaMTX and
// cloudflared must carry a valid signature of their own (cloudflared ships one); sign ad hoc
// whatever has none.
if (isMac && process.platform === 'darwin') {
  for (const tool of ['mediamtx', 'cloudflared']) {
    const file = path.join(resDir, 'bin', tool);
    if (spawnSync('codesign', ['--verify', '--strict', file], { stdio: 'ignore' }).status !== 0) {
      execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
      console.log(`✓ signed ${tool} (ad hoc)`);
    }
  }
}

// 3. Updater signing key.
const env = { ...process.env };
let updaterArtifacts = true;
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = path.join(os.homedir(), '.tauri', 'swarmcast-updater.key');
  const pwFile = path.join(os.homedir(), '.tauri', 'swarmcast-updater.password');
  if (fs.existsSync(keyFile)) {
    env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyFile, 'utf8').trim();
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.existsSync(pwFile) ? fs.readFileSync(pwFile, 'utf8').trim() : '';
  } else {
    updaterArtifacts = false;
    console.warn('⚠ no updater signing key (TAURI_SIGNING_PRIVATE_KEY or ~/.tauri/swarmcast-updater.key): building without updater artifacts');
  }
}

// Linux CI runners have no FUSE: let the AppImage tools (linuxdeploy) run extracted.
// NO_STRIP: linuxdeploy must not strip what it deploys (belt and braces, see LINUX_SIDECAR).
const isLinux = target.startsWith('linux');
if (isLinux) {
  env.APPIMAGE_EXTRACT_AND_RUN ??= '1';
  env.NO_STRIP ??= 'true';
}

// Linux: the sidecar is not an `externalBin`. The server is a pkg executable (Node + a payload
// appended after the ELF data), and linuxdeploy (the AppImage bundler) runs patchelf on every
// dynamically linked ELF in usr/bin and usr/lib (recursively): the rewritten ELF moves the
// payload and the server dies at start with "SyntaxError" in pkg/prelude/bootstrap.js.
// So each package gets its own copy, outside of linuxdeploy's reach in the AppImage:
//   .deb       /usr/bin/swarmcast-server                (same place as an externalBin)
//   .AppImage  usr/libexec/SwarmCast/swarmcast-server   (linuxdeploy never looks there)
// sidecar.rs (Layout::new) finds either one.
const LINUX_SIDECAR = { deb: '/usr/bin/swarmcast-server', appimage: '/usr/libexec/SwarmCast/swarmcast-server' };

// 4. tauri build with a config overlay (keeps tauri.conf.json free of build-time paths, so
// `cargo build` / `cargo test` work without a staged package).
const overlay = {
  version,
  bundle: {
    ...(isLinux
      ? {
          linux: {
            deb: { files: { [LINUX_SIDECAR.deb]: sidecar } },
            appimage: { files: { [LINUX_SIDECAR.appimage]: sidecar } },
          },
        }
      : { externalBin: ['staged/binaries/swarmcast-server'] }),
    resources: {
      'staged/resources/bin/': 'bin/',
      'staged/resources/web/': 'web/',
      'staged/resources/LICENSE': 'LICENSE',
      'staged/resources/THIRD_PARTY_LICENSES.txt': 'THIRD_PARTY_LICENSES.txt',
    },
    createUpdaterArtifacts: updaterArtifacts,
  },
};
const insecure = flag('insecure-updates');
if (insecure) {
  overlay.plugins = { updater: { dangerousInsecureTransportProtocol: true } };
  console.warn('⚠ --insecure-updates: this build accepts http:// update URLs (local tests only, never publish it)');
}
if (arg('updater-pubkey')) {
  if (!insecure) throw new Error('--updater-pubkey is for test builds only: use it with --insecure-updates');
  overlay.plugins.updater.pubkey = fs.readFileSync(arg('updater-pubkey'), 'utf8').trim();
  console.warn(`⚠ --updater-pubkey: this build trusts ${arg('updater-pubkey')}, not the release key`);
}
const overlayFile = path.join(stageDir, 'tauri.build.json');
fs.writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

const tauriArgs = ['build', '--target', spec.triple, '--bundles', bundles.join(','), '--config', overlayFile, '--ci'];
if (insecure) tauriArgs.push('--features', 'insecure-updates');
if (flag('debug')) tauriArgs.push('--debug');
if (arg('runner')) tauriArgs.push('--runner', arg('runner'));
const res = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...tauriArgs], { stdio: 'inherit', cwd: desktopDir, env });
if (res.status !== 0) process.exit(res.status ?? 1);

// 5. Collect the results with names that carry version and architecture.
const bundleDir = path.join(tauriDir, 'target', spec.triple, flag('debug') ? 'debug' : 'release', 'bundle');
const outDir = path.join(root, 'release', 'desktop', target);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const macArch = target === 'macos-arm64' ? 'aarch64' : 'x64';
const collected = [];
function collect(sub, match, rename = (n) => n) {
  const dir = path.join(bundleDir, sub);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!match(name)) continue;
    const dest = path.join(outDir, rename(name));
    fs.cpSync(path.join(dir, name), dest, { recursive: true });
    collected.push(dest);
  }
}
collect('nsis', (n) => n.includes(`_${version}_`) && (n.endsWith('-setup.exe') || n.endsWith('-setup.exe.sig')));
collect('dmg', (n) => n.includes(`_${version}_`) && n.endsWith('.dmg'));
collect('macos', (n) => n === 'SwarmCast.app.tar.gz' || n === 'SwarmCast.app.tar.gz.sig', (n) => n.replace('SwarmCast.app', `SwarmCast_${version}_${macArch}.app`));
collect('macos', (n) => n === 'SwarmCast.app');
collect('deb', (n) => n.includes(`_${version}_`) && (n.endsWith('.deb') || n.endsWith('.deb.sig')));
collect('appimage', (n) => n.includes(`_${version}_`) && (n.endsWith('.AppImage') || n.endsWith('.AppImage.sig')));
for (const f of collected) console.log(`✓ ${rel(f)}`);
if (updaterArtifacts && !collected.some((f) => f.endsWith('.sig'))) console.warn('⚠ no updater signature (*.sig) was produced');
