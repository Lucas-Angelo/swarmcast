#!/usr/bin/env node
// Write the desktop updater manifest (latest.json) from the artifacts made by desktop.mjs.
//
// Usage: node scripts/build/updater-manifest.mjs --version 0.2.0 \
//          --base-url https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0 \
//          [--notes-file notes.md | --notes "text"] [--pub-date 2026-10-26T12:00:00Z] \
//          [--out release/desktop/latest.json] [--require-all] release/desktop/*
//
// Every `<artifact>.sig` next to its artifact becomes a platform entry
// (url = <base-url>/<artifact>, signature = contents of the .sig). The Tauri updater looks
// for `{os}-{arch}-{installer}` first, then `{os}-{arch}`:
//
//   SwarmCast_<v>_x64-setup.exe          windows-x86_64, windows-x86_64-nsis
//   SwarmCast_<v>_aarch64.app.tar.gz     darwin-aarch64, darwin-aarch64-app
//   SwarmCast_<v>_x64.app.tar.gz         darwin-x86_64,  darwin-x86_64-app
//   SwarmCast_<v>_amd64.AppImage         linux-x86_64,   linux-x86_64-appimage
//   SwarmCast_<v>_aarch64.AppImage       linux-aarch64,  linux-aarch64-appimage
//   SwarmCast_<v>_amd64.deb              linux-x86_64-deb
//   SwarmCast_<v>_arm64.deb              linux-aarch64-deb
//
// A .deb install must find its own `-deb` entry: without it the updater would download the
// AppImage and refuse it.
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const VALUE_FLAGS = new Set(['--version', '--base-url', '--notes-file', '--notes', '--pub-date', '--out']);
const inputs = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.has(all[i - 1]));

const version = arg('version');
const baseUrl = arg('base-url');
if (!version || !baseUrl || inputs.length === 0) {
  console.error('usage: updater-manifest.mjs --version <v> --base-url <url> [--notes-file f | --notes text] [--out file] <dir|file>...');
  process.exit(2);
}
const notesFile = arg('notes-file');
const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : (arg('notes', '') ?? '');
const pubDate = arg('pub-date', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
const out = arg('out', 'release/desktop/latest.json');

/** [file name pattern, platform keys] — the first key is the generic `{os}-{arch}` one. */
const RULES = [
  [/_x64-setup\.exe$/, ['windows-x86_64', 'windows-x86_64-nsis']],
  [/_aarch64\.app\.tar\.gz$/, ['darwin-aarch64', 'darwin-aarch64-app']],
  [/_x64\.app\.tar\.gz$/, ['darwin-x86_64', 'darwin-x86_64-app']],
  [/_amd64\.AppImage$/, ['linux-x86_64', 'linux-x86_64-appimage']],
  [/_aarch64\.AppImage$/, ['linux-aarch64', 'linux-aarch64-appimage']],
  [/_amd64\.deb$/, ['linux-x86_64-deb']],
  [/_arm64\.deb$/, ['linux-aarch64-deb']],
];
const REQUIRED = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64'];

function sigFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith('.sig') ? [p] : [];
  return fs.readdirSync(p).flatMap((n) => {
    const child = path.join(p, n);
    // Do not descend into .app bundles.
    return fs.statSync(child).isDirectory() && !n.endsWith('.app') ? sigFiles(child) : child.endsWith('.sig') ? [child] : [];
  });
}

const platforms = {};
for (const sig of inputs.flatMap(sigFiles)) {
  const artifact = sig.slice(0, -'.sig'.length);
  const name = path.basename(artifact);
  if (!name.includes(`_${version}_`)) {
    console.warn(`⚠ skipping ${name}: not version ${version}`);
    continue;
  }
  if (!fs.existsSync(artifact)) throw new Error(`${name}.sig has no ${name} next to it`);
  const rule = RULES.find(([re]) => re.test(name));
  if (!rule) {
    console.warn(`⚠ skipping ${name}: unknown artifact type`);
    continue;
  }
  const entry = { signature: fs.readFileSync(sig, 'utf8').trim(), url: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}` };
  for (const key of rule[1]) {
    if (platforms[key]) throw new Error(`two artifacts for ${key}: ${platforms[key].url} and ${entry.url}`);
    platforms[key] = entry;
  }
}

const missing = REQUIRED.filter((k) => !platforms[k]);
if (missing.length) {
  const msg = `missing platforms: ${missing.join(', ')}`;
  if (process.argv.includes('--require-all')) throw new Error(msg);
  console.warn(`⚠ ${msg}`);
}
if (Object.keys(platforms).length === 0) throw new Error('no signed artifacts found');

const manifest = { version, notes, pub_date: pubDate, platforms: Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b))) };
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ ${out} (${Object.keys(platforms).join(', ')})`);
