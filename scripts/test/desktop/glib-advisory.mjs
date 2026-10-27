#!/usr/bin/env node
// Guard for GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429 (Dependabot alert on glib < 0.20 in
// apps/desktop/src-tauri/Cargo.lock): the `Iterator`/`DoubleEndedIterator` impls of
// `glib::VariantStrIter` are unsound. Nothing in the app reaches them: VariantStrIter is only
// made by `glib::Variant::array_iter_str()`, and no crate compiled into the app (ours included)
// calls either. glib itself cannot move to 0.20 within Tauri 2: Tauri 2.12 and its whole Linux
// stack (wry, tao, muda, tray-icon, webkit2gtk 2.0, libappindicator) require gtk 0.18, which
// requires glib 0.18 (see the comment in Cargo.toml).
//
// This check keeps that statement true: it lists every package of the Linux dependency graph
// (both architectures; glib is only compiled on Linux) and fails if any source file outside glib
// itself mentions the unsound API. Once glib >= 0.20 is locked, it only says so.
//
//   node scripts/test/desktop/glib-advisory.mjs        (needs cargo; downloads the crate sources)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = path.join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
const UNSOUND = /\bVariantStrIter\b|\barray_iter_str\b/;
const TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];

const packages = new Map();
for (const target of TARGETS) {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', target], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
  );
  const used = new Set(meta.resolve.nodes.map((n) => n.id));
  for (const p of meta.packages) if (used.has(p.id)) packages.set(p.id, p);
}

const glibs = [...packages.values()].filter((p) => p.name === 'glib');
const vulnerable = glibs.filter((p) => {
  const [major, minor] = p.version.split('.').map(Number);
  return major === 0 && minor < 20;
});
if (vulnerable.length === 0) {
  console.log(`glib ${glibs.map((p) => p.version).join(', ') || '(none)'}: not affected by GHSA-wrw7-89jp-8q8g; this guard can go`);
  process.exit(0);
}

function* rustFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'target' && e.name !== '.git') yield* rustFiles(p);
    } else if (e.name.endsWith('.rs')) {
      yield p;
    }
  }
}

const hits = [];
for (const p of packages.values()) {
  if (p.name === 'glib') continue;
  for (const f of rustFiles(path.dirname(p.manifest_path))) {
    if (UNSOUND.test(fs.readFileSync(f, 'utf8'))) hits.push(`${p.name} ${p.version}: ${path.relative(path.dirname(p.manifest_path), f)}`);
  }
}
const versions = vulnerable.map((p) => p.version).join(', ');
if (hits.length) {
  console.error(`::error title=glib advisory::glib ${versions} is affected by GHSA-wrw7-89jp-8q8g and these crates use glib::VariantStrIter:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`glib ${versions} (GHSA-wrw7-89jp-8q8g): none of the ${packages.size - vulnerable.length} other crates compiled for Linux uses VariantStrIter / array_iter_str`);
