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
//          [--release-key <file>] [--debug] [--fast] [--runner cargo-xwin]
//
//   --package           run package.mjs first (needs `npm run build`)
//   --bundles           which bundles to make (default: all of the target's). macOS: the .dmg is
//                       made by its own `tauri bundle` step after the .app, retried when hdiutil
//                       reports "Resource busy", so a busy disk costs seconds, not a rebuild
//   --fast              throwaway test builds (the update test's A and B): no LTO, 16 codegen
//                       units (CARGO_PROFILE_RELEASE_* environment overrides, so `tauri bundle`
//                       still finds target/<triple>/release) and an uncompressed NSIS installer.
//                       Never for builds that ship
//   --sidecar mock      bundle apps/desktop/test/mock-server.mjs instead of the real server (tests)
//   --insecure-updates  allow http:// update URLs (local update tests only; never for releases)
//   --updater-pubkey    with --insecure-updates: trust this public key (`tauri signer generate`'s
//                       .pub file) instead of the release key, for update tests with a throwaway key
//   --runner <cmd>      passed to `tauri build` (e.g. cargo-xwin to build windows-x64 from Linux)
//   --release-key <file>  sign the updater artifacts with this private key file (the maintainer's
//                       ~/.tauri/swarmcast-updater.key); its password from
//                       TAURI_SIGNING_PRIVATE_KEY_PASSWORD or the .password file next to it
//
// Updater signing only when asked: TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
// (CI: the release secrets, or a throwaway key pair for test builds) or --release-key. Nothing
// reads ~/.tauri by itself, so a local test build can never be signed with the release key by
// accident. Without a key the app is built without updater artifacts (with a warning).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { debianVersion } from '../releases/semver.mjs';
import { setDebVersion } from './deb-version.mjs';
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

// 3. Updater signing key: given in the environment or with --release-key, never found by itself.
const env = { ...process.env };
let updaterArtifacts = true;
const releaseKey = arg('release-key');
if (releaseKey) {
  if (env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('give the updater key one way: TAURI_SIGNING_PRIVATE_KEY or --release-key, not both');
  const keyFile = path.resolve(releaseKey);
  if (!fs.existsSync(keyFile)) throw new Error(`--release-key: ${keyFile} does not exist`);
  const pwFile = keyFile.replace(/(\.key)?$/, '.password');
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.existsSync(pwFile) ? fs.readFileSync(pwFile, 'utf8').trim() : '';
  console.log(`✓ updater artifacts signed with ${keyFile}`);
} else if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  updaterArtifacts = false;
  console.warn('⚠ no updater signing key (TAURI_SIGNING_PRIVATE_KEY, or --release-key <file>): building without updater artifacts (*.sig)');
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
const fast = flag('fast');
if (fast) {
  // Test builds only: the release profile without LTO and with parallel codegen. Through the
  // environment, so the output stays in target/<triple>/release (where `tauri bundle` looks);
  // the dependencies compiled this way sit next to the release ones in target/ (and the cache).
  env.CARGO_PROFILE_RELEASE_LTO ??= 'false';
  env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS ??= '16';
  if (isWin) overlay.bundle.windows = { nsis: { compression: 'none' } };
  // Fixed text only: `env` also holds the updater signing key, so nothing from it is logged.
  console.warn(`⚠ --fast: test build (no LTO, parallel codegen${isWin ? ', NSIS uncompressed' : ''}), never publish it`);
}
const overlayFile = path.join(stageDir, 'tauri.build.json');
fs.writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

const tauriCli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const profileDir = flag('debug') ? 'debug' : 'release';
const bundleDir = path.join(tauriDir, 'target', spec.triple, profileDir, 'bundle');
// The macOS updater archive has no version in its name: drop the one of an earlier build, so a
// build without updater artifacts cannot pick it up.
fs.rmSync(path.join(bundleDir, 'macos'), { recursive: true, force: true });

// macOS: the .dmg gets its own step (below), after the .app.
const dmg = isMac && bundles.includes('dmg');
let buildBundles = dmg ? bundles.filter((b) => b !== 'dmg') : bundles;
if (dmg && !buildBundles.includes('app')) buildBundles = ['app', ...buildBundles];
const common = ['--target', spec.triple, '--ci', ...(insecure ? ['--features', 'insecure-updates'] : []), ...(flag('debug') ? ['--debug'] : [])];
const tauriArgs = ['build', '--bundles', buildBundles.join(','), '--config', overlayFile, ...common];
if (arg('runner')) tauriArgs.push('--runner', arg('runner'));
const res = spawnSync(process.execPath, [tauriCli, ...tauriArgs], { stdio: 'inherit', cwd: desktopDir, env });
if (res.status !== 0) process.exit(res.status ?? 1);

/** Runs a command with its output shown live and returned. */
function runTee(cmd, argv, o) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { ...o, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    p.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    p.on('error', (err) => resolve({ status: -1, out: `${out}${err.message}` }));
    p.on('close', (status) => resolve({ status, out }));
  });
}

/** Detaches disk images bundle_dmg.sh left attached (its read-write `rw.<pid>.*.dmg`). */
function detachLeftovers() {
  const info = spawnSync('hdiutil', ['info'], { encoding: 'utf8' }).stdout ?? '';
  for (const block of info.split(/^=+$/m)) {
    if (!/image-path\s*:.*\/bundle\/dmg\/rw\./.test(block)) continue;
    const dev = /^(\/dev\/disk\d+)\b/m.exec(block)?.[1];
    if (!dev) continue;
    console.log(`detaching a leftover disk image (${dev})`);
    spawnSync('hdiutil', ['detach', '-force', dev], { stdio: 'inherit' });
  }
  const dir = path.join(bundleDir, 'dmg');
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (n.startsWith('rw.')) fs.rmSync(path.join(dir, n), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits (up to 30 s) while XProtect scans: it keeps a freshly attached image busy. */
async function xprotectQuiet() {
  for (let i = 0; i < 30 && spawnSync('pgrep', ['-x', 'XProtect'], { stdio: 'ignore' }).status === 0; i++) await sleep(1000);
}

// The .dmg from the .app just built: `tauri bundle` reuses the compiled binary, so a retry costs
// seconds. hdiutil fails now and then on CI with "Resource busy" (create or detach), and the
// create-dmg script Tauri vendors does not retry those (tauri#14686). No updater artifacts
// here: the .app.tar.gz above is the one that ships. `app` again (seconds) because the .dmg step
// deletes an .app it had to make itself.
if (dmg) {
  const tries = 4;
  const backoff = [5, 10, 20];
  const dmgArgs = ['bundle', '--bundles', 'app,dmg', '--config', overlayFile, '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), ...common];
  for (let i = 1; ; i++) {
    detachLeftovers();
    spawnSync('sync');
    if (i > 1) await xprotectQuiet();
    const t0 = Date.now();
    const r = await runTee(process.execPath, [tauriCli, ...dmgArgs], { cwd: desktopDir, env });
    if (r.status === 0) {
      if (i > 1) console.log(`::notice title=hdiutil::the .dmg succeeded on try ${i} of ${tries}`);
      break;
    }
    const busy = /Resource busy/i.test(r.out);
    const why = busy ? 'hdiutil: Resource busy' : `exit ${r.status}`;
    if (i >= tries) {
      console.log(`::error title=hdiutil::the .dmg failed ${tries} times (${why})`);
      process.exit(r.status || 1);
    }
    const wait = backoff[i - 1];
    console.log(`::warning title=hdiutil::the .dmg failed after ${Math.round((Date.now() - t0) / 1000)} s (${why}, try ${i} of ${tries}); retrying in ${wait} s`);
    await sleep(wait * 1000);
  }
}

// 5. Collect the results with names that carry version and architecture.
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
// Linux, pre-release: the .deb's Version field gets `~` (0.3.0~beta.1), or dpkg would sort the
// beta above the stable 0.3.0 and apt would refuse that update as a downgrade (deb-version.mjs).
// The rewritten .deb is signed again for the updater, bound to the SemVer version as before.
const debVersion = debianVersion(version);
if (isLinux && debVersion !== version) {
  for (const deb of collected.filter((f) => f.endsWith('.deb'))) {
    setDebVersion(deb, debVersion);
    console.log(`✓ ${rel(deb)}: Debian version ${debVersion}`);
    if (!updaterArtifacts) continue;
    fs.rmSync(`${deb}.sig`, { force: true });
    // The key and its password stay in the environment (never on a command line).
    const signed = spawnSync(process.execPath, [tauriCli, 'signer', 'sign', '--app-version', version, deb], { stdio: ['ignore', 'ignore', 'inherit'], env });
    if (signed.status !== 0 || !fs.existsSync(`${deb}.sig`)) throw new Error(`could not sign ${rel(deb)} again after changing its Debian version`);
    const comment = Buffer.from(fs.readFileSync(`${deb}.sig`, 'utf8').trim(), 'base64').toString('utf8');
    if (!comment.includes(`\tfile:${path.basename(deb)}\t`) || !comment.includes(`\tversion:${version}`)) throw new Error(`the new signature of ${rel(deb)} is not bound to ${path.basename(deb)} ${version}`);
    console.log(`✓ ${rel(deb)}.sig (signed again)`);
  }
}
for (const f of collected) console.log(`✓ ${rel(f)}`);
if (updaterArtifacts && !collected.some((f) => f.endsWith('.sig'))) console.warn('⚠ no updater signature (*.sig) was produced');
const PRODUCES = { nsis: /-setup\.exe$/, dmg: /\.dmg$/, app: /SwarmCast\.app$/, deb: /\.deb$/, appimage: /\.AppImage$/ };
for (const b of bundles) {
  if (PRODUCES[b] && !collected.some((f) => PRODUCES[b].test(f))) throw new Error(`the ${b} bundle was not produced in ${rel(bundleDir)}`);
}

// 6. Linux: the server inside each package must start. linuxdeploy once broke it in the AppImage
// (patchelf moved pkg's payload: "SyntaxError" in pkg/prelude/bootstrap.js), and only the
// clean-machine test noticed, 10 minutes later. `--version` runs pkg's bootstrap and the server.
if (isLinux && arg('sidecar', 'server') !== 'mock') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sidecar-'));
  try {
    for (const f of collected) {
      let server;
      if (f.endsWith('.AppImage')) {
        // Extracting needs no FUSE.
        execFileSync(f, ['--appimage-extract', LINUX_SIDECAR.appimage.slice(1)], { cwd: tmp, stdio: 'ignore' });
        server = path.join(tmp, 'squashfs-root', LINUX_SIDECAR.appimage);
      } else if (f.endsWith('.deb')) {
        execFileSync('dpkg-deb', ['-x', f, path.join(tmp, 'deb')]);
        server = path.join(tmp, 'deb', LINUX_SIDECAR.deb);
      } else {
        continue;
      }
      const r = spawnSync(server, ['--version'], { encoding: 'utf8', input: '', timeout: 60_000 });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim();
      const expected = stagedVersion === '?' ? null : stagedVersion;
      if (r.status !== 0 || !/^\d+\.\d+\.\d+/.test(out) || (expected && out !== expected)) {
        throw new Error(`the server in ${path.basename(f)} does not start (${r.status ?? r.signal}): ${out.slice(0, 2000)}`);
      }
      console.log(`✓ the server in ${path.basename(f)} starts (--version: ${out})`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
