#!/usr/bin/env node
// The tools the Tauri bundler needs to make an AppImage, put where it looks for them before it
// downloads anything, from the pins in versions.json (`appimageTool` entries), SHA-256 checked.
//
// Usage: node scripts/build/appimage-tools.mjs [--target linux-x64] [--dir <tools dir>]
//        (desktop.mjs runs it by itself before `tauri build` with the appimage bundle)
//
// What tauri-bundler 2.10.4 (the one @tauri-apps/cli 2.12.4 is built with) does in
// src/bundle/linux/appimage/linuxdeploy.rs, `bundle_project` and `prepare_tools`:
//   - its tools folder is `dirs::cache_dir()/tauri`: $XDG_CACHE_HOME/tauri, or ~/.cache/tauri
//     (`<cargo target dir>/.tauri` only with bundle.useLocalToolsDir, which tauri.conf.json does
//     not set);
//   - `AppRun-<arch>` and `linuxdeploy-07333c6-<arch>.AppImage` (<arch>: x86_64, aarch64): when the
//     file does not exist it downloads it from github.com/tauri-apps/binary-releases, one plain GET
//     with no retry (http_utils.rs `download`), and the build fails on any error (a 504 failed
//     pipeline run 42000871599); a file that exists is used as it is;
//   - `linuxdeploy-plugin-gtk.sh`, `linuxdeploy-plugin-gstreamer.sh`: embedded in the bundler and
//     written from there, never downloaded;
//   - `linuxdeploy-plugin-appimage.AppImage`: when it does not exist, downloaded from the
//     `continuous` release of linuxdeploy-plugin-appimage (rebuilt every month); a failed download
//     is only logged, and linuxdeploy then uses the plugin built into it;
//   - then it zeroes bytes 8-10 (the AppImage magic) of its linuxdeploy copy with dd.
// And appimagetool, run by that plugin, downloads the AppImage runtime (the first part of every
// AppImage) from AppImage/type2-runtime's `continuous` release, again one try, unless the plugin
// gets LDAI_RUNTIME_FILE (it passes `--runtime-file`).
//
// So this script writes AppRun and linuxdeploy (mode 0755) and the pinned runtime, and returns
// LDAI_RUNTIME_FILE for the build. For the appimage plugin it writes an empty file that is not
// executable: the bundler sees one and does not download, linuxdeploy skips files that are not
// executable when it looks for plugins and uses its built-in one, whose appimagetool and mksquashfs
// are byte for byte those of the `continuous` plugin the bundler fetched before (checked on
// 2026-11-05). Every download goes through fetch-binaries.mjs (tries with back-off, resume, mirrors,
// SHA-256) and SC_DOWNLOAD_CACHE, the cache CI's setup action restores.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetUrls, downloadFirst, hostTarget } from './fetch-binaries.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const versions = JSON.parse(fs.readFileSync(path.join(here, 'versions.json'), 'utf8'));

/** The name the bundler gives the appimage plugin in its tools folder. */
export const APPIMAGE_PLUGIN = 'linuxdeploy-plugin-appimage.AppImage';
/** Where an AppImage keeps its magic bytes ("AI" 0x02), which the bundler zeroes in linuxdeploy. */
const MAGIC_AT = 8;
const MAGIC = Buffer.from([0x41, 0x49, 0x02]);

/** The pinned AppImage tools (versions.json entries with `appimageTool`), by name. */
export function appImageTools(pins = versions) {
  return Object.fromEntries(Object.entries(pins).filter(([, spec]) => spec.appimageTool));
}

/**
 * The bundler's tools folder: `dirs::cache_dir()` (an absolute $XDG_CACHE_HOME, else
 * $HOME/.cache) + `tauri`, as in tauri-bundler's linuxdeploy.rs `bundle_project`.
 */
export function tauriToolsDir(env = process.env, home = os.homedir()) {
  const xdg = env.XDG_CACHE_HOME;
  const cache = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || home, '.cache');
  return path.join(cache, 'tauri');
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Whether `bytes` are the pinned file: exactly, or with only the AppImage magic zeroed (what the
 * bundler's dd leaves of linuxdeploy after a build), so a copy it already used is not fetched again.
 */
export function matchesPin(bytes, pin) {
  if (sha256(bytes) === pin) return true;
  if (bytes.length < MAGIC_AT + MAGIC.length || bytes.subarray(MAGIC_AT, MAGIC_AT + MAGIC.length).some((b) => b !== 0)) return false;
  const restored = Buffer.from(bytes);
  MAGIC.copy(restored, MAGIC_AT);
  return sha256(restored) === pin;
}

/**
 * Whether an AppImage starts with `runtime`. appimagetool writes the runtime first and then fills
 * some of its sections that the runtime file leaves zeroed (the MD5 digest, update information,
 * signature), so a byte may differ only where the runtime file has a 0.
 */
export function startsWithRuntime(appImage, runtime) {
  if (appImage.length <= runtime.length) return false;
  for (let i = 0; i < runtime.length; i++) if (appImage[i] !== runtime[i] && runtime[i] !== 0) return false;
  return true;
}

/** Writes `bytes` to `dest` with `mode` through a `.part` file, so a killed job leaves no half file. */
function writeFile(dest, bytes, mode) {
  fs.writeFileSync(`${dest}.part`, bytes);
  fs.chmodSync(`${dest}.part`, mode);
  fs.renameSync(`${dest}.part`, dest);
}

/** The pinned bytes of one asset: from the download cache when it has them, else downloaded (and cached). */
async function pinnedBytes(spec, a, { cacheDir, download }) {
  const cached = cacheDir && path.join(cacheDir, `${a.sha256}-${a.asset}`);
  if (cached && fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    if (sha256(bytes) === a.sha256) return { bytes, from: 'the download cache' };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-appimage-tool-'));
  try {
    const file = path.join(work, a.asset);
    const url = await download(assetUrls(spec, a), file, a.sha256);
    const bytes = fs.readFileSync(file);
    if (cached) {
      fs.mkdirSync(cacheDir, { recursive: true });
      writeFile(cached, bytes, 0o644);
    }
    return { bytes, from: url };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Puts the pinned AppImage tools for `target` (linux-x64, linux-arm64) into `toolsDir` and returns
 * the environment the build needs (LDAI_RUNTIME_FILE). A file already there is kept when it is the
 * pin. `cacheDir` is SC_DOWNLOAD_CACHE; `download` (fetch-binaries.mjs downloadFirst) is for tests.
 */
export async function prepareAppImageTools(target, { toolsDir = tauriToolsDir(), cacheDir = process.env.SC_DOWNLOAD_CACHE, download = downloadFirst, pins = versions, log = console.log } = {}) {
  fs.mkdirSync(toolsDir, { recursive: true });
  const env = {};
  for (const [tool, spec] of Object.entries(appImageTools(pins))) {
    const a = spec.assets[target];
    if (!a) throw new Error(`No ${tool} for ${target} (the AppImage is built on Linux x64 and arm64)`);
    const dest = path.join(toolsDir, a.binary);
    // A file handed over in an environment variable (the runtime) is only read; the others run.
    const mode = spec.env ? 0o644 : 0o755;
    if (spec.env) env[spec.env] = dest;
    if (fs.existsSync(dest) && matchesPin(fs.readFileSync(dest), a.sha256)) {
      fs.chmodSync(dest, mode);
      log(`✓ ${tool} ${spec.version}: ${a.binary} already in ${toolsDir}`);
      continue;
    }
    const { bytes, from } = await pinnedBytes(spec, a, { cacheDir: cacheDir && path.resolve(cacheDir), download });
    writeFile(dest, bytes, mode);
    log(`✓ ${tool} ${spec.version}: ${a.binary} from ${from} (${a.sha256.slice(0, 12)}…)`);
  }
  // Empty and not executable: the bundler does not download the plugin, linuxdeploy does not use
  // this file and takes its built-in plugin (see the header).
  const plugin = path.join(toolsDir, APPIMAGE_PLUGIN);
  const st = fs.existsSync(plugin) ? fs.lstatSync(plugin) : null;
  if (!st || !st.isFile() || st.size !== 0 || (st.mode & 0o111) !== 0) {
    fs.rmSync(plugin, { force: true });
    writeFile(plugin, Buffer.alloc(0), 0o644);
  }
  log(`✓ ${APPIMAGE_PLUGIN}: linuxdeploy's built-in plugin (an empty, non-executable placeholder in ${toolsDir})`);
  return env;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = arg('dir');
  prepareAppImageTools(arg('target', hostTarget()), dir ? { toolsDir: path.resolve(dir) } : {})
    .then((env) => console.log(`LDAI_RUNTIME_FILE=${env.LDAI_RUNTIME_FILE}`))
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    });
}
