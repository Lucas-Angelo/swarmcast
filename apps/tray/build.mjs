#!/usr/bin/env node
// Builds the tray helper with the Go toolchain.
//
//   node apps/tray/build.mjs [--target <target>] [--vendor]
//
// <target> is one of windows-x64 | macos-arm64 | macos-x64 | linux-x64 | linux-arm64
// (default: the host). The binary goes to apps/tray/bin/<target>/swarmcast-tray[.exe];
// --vendor also copies it to vendor/<target>/, the binDir SwarmCast uses in dev mode.
//
// macOS needs cgo (Cocoa), so macOS targets build only on a Mac (both architectures work
// from either Mac with the Xcode Command Line Tools). Windows and Linux are pure Go
// (fyne.io/systray talks DBus directly on Linux) and cross-compile from anywhere.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  'windows-x64': { goos: 'windows', goarch: 'amd64', cgo: false },
  'macos-arm64': { goos: 'darwin', goarch: 'arm64', cgo: true },
  'macos-x64': { goos: 'darwin', goarch: 'amd64', cgo: true },
  'linux-x64': { goos: 'linux', goarch: 'amd64', cgo: false },
  'linux-arm64': { goos: 'linux', goarch: 'arm64', cgo: false },
};

/** Same tag format as platformTag() in apps/server/src/core/paths.ts. */
function hostTarget() {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return `${os}-${process.arch}`;
}

function fail(message) {
  console.error(`build.mjs: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const target = targetIdx >= 0 ? argv[targetIdx + 1] : hostTarget();
const vendor = argv.includes('--vendor');
const spec = TARGETS[target];
if (!spec) fail(`unknown target "${target}". Use one of: ${Object.keys(TARGETS).join(', ')}`);
if (spec.cgo && process.platform !== 'darwin') fail(`${target} needs cgo and the macOS SDK: build it on a Mac.`);

const trayDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(trayDir, '..', '..');
const name = spec.goos === 'windows' ? 'swarmcast-tray.exe' : 'swarmcast-tray';
const out = path.join(trayDir, 'bin', target, name);

const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' });
if (goVersion.error || goVersion.status !== 0) fail('Go is not installed or not on PATH (https://go.dev/dl/).');
console.log(`${goVersion.stdout.trim()} → ${target}`);

const ldflags = ['-s', '-w'];
// GUI subsystem: no console window flashes up when SwarmCast starts the helper.
if (spec.goos === 'windows') ldflags.unshift('-H=windowsgui');

const env = {
  ...process.env,
  GOOS: spec.goos,
  GOARCH: spec.goarch,
  CGO_ENABLED: spec.cgo ? '1' : '0',
};
// Keep the binary runnable on macOS releases older than the build machine (current Go
// toolchains themselves target macOS 13+). Passed through the CGO_* flags, which are part
// of Go's build cache key (MACOSX_DEPLOYMENT_TARGET is not).
if (spec.goos === 'darwin') {
  const min = `-mmacosx-version-min=${process.env.MACOSX_DEPLOYMENT_TARGET ?? '13.0'}`;
  env.CGO_CFLAGS = `${process.env.CGO_CFLAGS ?? '-O2 -g'} ${min}`;
  env.CGO_LDFLAGS = `${process.env.CGO_LDFLAGS ?? '-O2 -g'} ${min}`;
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const build = spawnSync('go', ['build', '-trimpath', '-ldflags', ldflags.join(' '), '-o', out, '.'], {
  cwd: trayDir,
  env,
  stdio: 'inherit',
});
if (build.error) fail(build.error.message);
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(`wrote ${path.relative(repoRoot, out)}`);

if (vendor) {
  const dest = path.join(repoRoot, 'vendor', target, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(out, dest);
  if (spec.goos !== 'windows') fs.chmodSync(dest, 0o755);
  console.log(`copied to ${path.relative(repoRoot, dest)}`);
}
