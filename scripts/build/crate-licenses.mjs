#!/usr/bin/env node
// Licence texts of the Rust crates compiled into the desktop app (apps/desktop/src-tauri), for one
// target, from Cargo.lock via `cargo metadata` and the crates' own licence files in the cargo
// registry. Used by desktop.mjs (through licenses.mjs) so every desktop bundle ships them in
// THIRD_PARTY_LICENSES.txt, and fails the build when a crate has no licence or one outside
// ALLOWED_LICENSES.
//
// "Compiled into the app" = reachable from swarmcast-desktop through normal dependencies on the
// target (proc-macros included: their output is compiled in). Build-dependencies only run on the
// build machine (tauri-build, cc, …) and dev-dependencies only in tests, so they are left out.
//
// The output is deterministic: sorted, no absolute paths, no dates.
//
// Usage: node scripts/build/crate-licenses.mjs [--target aarch64-apple-darwin] [--out file] [--check]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripTags } from './strip-tags.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
export const DESKTOP_MANIFEST = path.join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
const CANONICAL_DIR = path.join(here, 'licenses');
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

/** Permissive (and weak, file-level copyleft MPL-2.0) licences SwarmCast accepts in the desktop app. */
export const ALLOWED_LICENSES = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'MPL-2.0',
  'CC0-1.0',
  '0BSD',
  'BSL-1.0',
]);
export const ALLOWED_EXCEPTIONS = new Set(['LLVM-exception']);
/** Which licence of an OR choice SwarmCast uses (lower index first; others after, alphabetically). */
const PREFERENCE = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'Zlib', '0BSD', 'MIT-0', 'BSL-1.0', 'Unicode-3.0', 'CC0-1.0', 'MPL-2.0'];
/** Canonical texts that carry no copyright line of their own: a "Copyright (c) <authors>" line is added. */
const NEEDS_COPYRIGHT_LINE = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib']);

// ---------------------------------------------------------------------------------------------
// SPDX expressions

/**
 * Parse an SPDX licence expression (`MIT OR Apache-2.0`, `(MIT OR Apache-2.0) AND Unicode-3.0`,
 * `Apache-2.0 WITH LLVM-exception`), also Cargo's legacy `MIT/Apache-2.0` (= OR).
 * @returns {{ type: 'license', id: string, exception?: string } | { type: 'and' | 'or', args: any[] }}
 */
export function parseSpdx(expression) {
  const tokens = String(expression)
    .replace(/\//g, ' OR ')
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t, op) => typeof t === 'string' && t.toUpperCase() === op;
  const fail = (why) => {
    throw new Error(`invalid licence expression "${expression}": ${why}`);
  };
  function primary() {
    const t = tokens[i++];
    if (t === undefined) fail('unexpected end');
    if (t === '(') {
      const e = or();
      if (tokens[i++] !== ')') fail('missing )');
      return e;
    }
    if (t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) fail(`unexpected "${t}"`);
    if (isOp(peek(), 'WITH')) {
      i++;
      const ex = tokens[i++];
      if (!ex || ex === '(' || ex === ')') fail('missing exception after WITH');
      return { type: 'license', id: t, exception: ex };
    }
    return { type: 'license', id: t };
  }
  function and() {
    const args = [primary()];
    while (isOp(peek(), 'AND')) {
      i++;
      args.push(primary());
    }
    return args.length === 1 ? args[0] : { type: 'and', args };
  }
  function or() {
    const args = [and()];
    while (isOp(peek(), 'OR')) {
      i++;
      args.push(and());
    }
    return args.length === 1 ? args[0] : { type: 'or', args };
  }
  if (tokens.length === 0) fail('empty');
  const ast = or();
  if (i !== tokens.length) fail(`unexpected "${tokens[i]}"`);
  return ast;
}

const rank = (id) => {
  const r = PREFERENCE.indexOf(id);
  return r === -1 ? PREFERENCE.length : r;
};
const leafName = (n) => (n.exception ? `${n.id} WITH ${n.exception}` : n.id);

/**
 * Is the expression acceptable, and under which licence(s) does SwarmCast use the crate?
 * OR: one acceptable branch is enough (the preferred one is chosen); AND: every part must be.
 * @returns {{ ok: boolean, chosen: string[], rejected: string[] }}
 */
export function evaluateLicense(expression, allowed = ALLOWED_LICENSES, exceptions = ALLOWED_EXCEPTIONS) {
  function walk(n) {
    if (n.type === 'license') {
      const ok = allowed.has(n.id) && (!n.exception || exceptions.has(n.exception));
      return ok ? { ok, chosen: [leafName(n)], rejected: [] } : { ok, chosen: [], rejected: [leafName(n)] };
    }
    const parts = n.args.map(walk);
    if (n.type === 'and') {
      return { ok: parts.every((p) => p.ok), chosen: parts.flatMap((p) => p.chosen), rejected: parts.flatMap((p) => p.rejected) };
    }
    const good = parts.filter((p) => p.ok);
    if (good.length === 0) return { ok: false, chosen: [], rejected: parts.flatMap((p) => p.rejected) };
    const score = (p) => Math.max(...p.chosen.map((c) => rank(c.split(' WITH ')[0])));
    good.sort((a, b) => score(a) - score(b) || a.chosen.length - b.chosen.length || a.chosen.join().localeCompare(b.chosen.join()));
    return { ok: true, chosen: good[0].chosen, rejected: [] };
  }
  return walk(parseSpdx(expression));
}

// ---------------------------------------------------------------------------------------------
// Dependency graph

/**
 * Packages compiled into the root package's binary for the platform `cargo metadata
 * --filter-platform` was run with: reachable through normal dependency edges only.
 */
export function shippedPackages(metadata) {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const rootId = metadata.resolve.root ?? metadata.workspace_members[0];
  const members = new Set(metadata.workspace_members);
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null || k.kind === undefined)) stack.push(dep.pkg);
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .sort(comparePackages);
}

function compareVersions(a, b) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
const comparePackages = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : compareVersions(a.version, b.version));

// ---------------------------------------------------------------------------------------------
// Licence texts

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)([-_.].*)?$/i;

/** Licence files at the top of a crate's package (and inside a LICENSES/ folder), sorted. */
export function readLicenseFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!LICENSE_FILE.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isFile()) out.push({ name: e.name, text: fs.readFileSync(full, 'utf8') });
    else if (e.isDirectory()) {
      for (const sub of fs.readdirSync(full).sort()) {
        if (fs.statSync(path.join(full, sub)).isFile()) out.push({ name: `${e.name}/${sub}`, text: fs.readFileSync(path.join(full, sub), 'utf8') });
      }
    }
  }
  return out;
}

const tidy = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const fingerprint = (text) => text.replace(/\s+/g, ' ').trim();

/** Standard text of an SPDX licence from scripts/build/licenses/, or null. */
export function canonicalText(id) {
  const file = path.join(CANONICAL_DIR, `${id}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Collect, check and attach the licence texts of the shipped crates.
 * Texts come from the crate's own files; if its package has none, from another shipped crate of
 * the same repository; else the standard text of the licence SwarmCast uses it under.
 * @param {any[]} packages  from shippedPackages()
 * @param {{ readFiles?: (pkg: any) => {name: string, text: string}[], canonical?: (id: string) => string | null }} io
 * @returns {{ crates: any[], problems: string[] }}
 */
export function collectCrates(packages, { readFiles = (p) => readLicenseFiles(path.dirname(p.manifest_path)), canonical = canonicalText } = {}) {
  const problems = [];
  const crates = packages.map((p) => {
    const c = {
      name: p.name,
      version: p.version,
      license: p.license ?? null,
      repository: p.repository ?? null,
      authors: (p.authors ?? []).map((a) => stripTags(a).replace(/\s+/g, ' ').trim()).filter(Boolean),
      cratesIo: p.source === CRATES_IO,
      files: readFiles(p).map((f) => ({ name: f.name, text: tidy(f.text) })).filter((f) => f.text),
      chosen: [],
      note: null,
    };
    if (!c.license) {
      problems.push(`${c.name} ${c.version}: no SPDX licence in Cargo.toml${p.license_file ? ` (only license-file = ${p.license_file})` : ''}`);
      return c;
    }
    let verdict;
    try {
      verdict = evaluateLicense(c.license);
    } catch (e) {
      problems.push(`${c.name} ${c.version}: ${e.message}`);
      return c;
    }
    if (!verdict.ok) problems.push(`${c.name} ${c.version}: "${c.license}" is not allowed (${verdict.rejected.join(', ')})`);
    c.chosen = verdict.chosen;
    return c;
  });
  const withOwnFiles = crates.filter((c) => c.files.length);
  for (const c of crates) {
    if (c.files.length || !c.license) continue;
    const sibling = c.repository && withOwnFiles.find((o) => o.repository && normRepo(o.repository) === normRepo(c.repository) && o.license === c.license);
    if (sibling) {
      c.files = sibling.files.map((f) => ({ ...f }));
      c.note = `This crate's package includes no licence file; the text below is the one of ${sibling.name} ${sibling.version}, from the same repository and under the same licence.`;
      continue;
    }
    const ids = c.chosen.map((x) => x.split(' WITH ')[0]);
    const holders = c.authors.length ? c.authors.join(', ') : `the ${c.name} authors`;
    const files = [];
    for (const id of ids) {
      const text = canonical(id);
      if (!text) {
        problems.push(`${c.name} ${c.version}: no licence file in the crate and no standard text for ${id} (add scripts/build/licenses/${id}.txt)`);
        continue;
      }
      files.push({ name: `${id} (standard text)`, text: tidy(NEEDS_COPYRIGHT_LINE.has(id) ? `Copyright (c) ${holders}\n\n${text}` : text) });
    }
    c.files = files;
    const withHolders = ids.some((id) => NEEDS_COPYRIGHT_LINE.has(id)) ? ', with its authors from Cargo.toml as copyright holders' : '';
    c.note = `This crate's package includes no licence file; below is the standard ${ids.join(' and ')} text, under which SwarmCast uses it${withHolders}.`;
  }
  return { crates, problems };
}

const normRepo = (u) => u.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();

/** The text block for THIRD_PARTY_LICENSES.txt. Identical texts are printed once and referred to after. */
export function renderCrateLicenses(crates, { triple }) {
  const lines = [
    `== Rust crates compiled into the SwarmCast desktop app (${triple}) ==`,
    '',
    `${crates.length} crates, as locked in apps/desktop/src-tauri/Cargo.lock: the dependencies compiled into`,
    'the app for this platform (build-time tools are not shipped and not listed). Each crate is listed with',
    'the licence expression it declares; where it offers a choice (OR), SwarmCast uses it under the licence',
    'shown after "used under". Sources: crates.io (https://crates.io/crates/<name>/<version>) and the',
    'repository shown. Generated by scripts/build/crate-licenses.mjs.',
    '',
  ];
  const width = Math.max(...crates.map((c) => `${c.name} ${c.version}`.length), 10);
  for (const c of crates) lines.push(`  ${`${c.name} ${c.version}`.padEnd(width)}  ${c.license}`);
  lines.push('');
  const printed = new Map();
  for (const c of crates) {
    lines.push(`-- ${c.name} ${c.version} --`);
    const usedUnder = c.chosen.join(' AND ');
    lines.push(`Licence: ${c.license}${usedUnder && usedUnder !== c.license ? ` (used under ${usedUnder})` : ''}`);
    const where = [c.cratesIo ? `https://crates.io/crates/${c.name}/${c.version}` : null, c.repository].filter(Boolean);
    if (where.length) lines.push(`Source: ${where.join(' , ')}`);
    if (c.note) lines.push(c.note);
    for (const f of c.files) {
      const key = fingerprint(f.text);
      const first = printed.get(key);
      if (first) {
        lines.push(`[${f.name}] Same text as ${first} above.`);
      } else {
        printed.set(key, `[${f.name}] of ${c.name} ${c.version}`);
        lines.push(`[${f.name}]`, f.text);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// cargo

export function cargoMetadata({ manifestPath = DESKTOP_MANIFEST, triple } = {}) {
  const args = ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath];
  if (triple) args.push('--filter-platform', triple);
  const out = execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
  return JSON.parse(out);
}

/**
 * The checked licence block for the desktop app on `triple`. Throws (listing every problem) when
 * a crate has no licence, an unparsable or disallowed one, or no text can be found.
 */
export function crateLicenses({ triple, manifestPath = DESKTOP_MANIFEST, metadata } = {}) {
  if (!triple) throw new Error('crateLicenses: a Rust target triple is required');
  const meta = metadata ?? cargoMetadata({ manifestPath, triple });
  const { crates, problems } = collectCrates(shippedPackages(meta));
  if (problems.length) {
    throw new Error(`Rust crate licence check failed for ${triple}:\n  - ${problems.join('\n  - ')}\nAllowed: ${[...ALLOWED_LICENSES].join(', ')} (exceptions: ${[...ALLOWED_EXCEPTIONS].join(', ')}).`);
  }
  return { text: renderCrateLicenses(crates, { triple }), crates };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const triple = arg('target', execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]);
  const { text, crates } = crateLicenses({ triple });
  const out = arg('out');
  if (out) fs.writeFileSync(out, `${text}\n`);
  else if (!process.argv.includes('--check')) process.stdout.write(`${text}\n`);
  const fallbacks = crates.filter((c) => c.note);
  console.error(`✓ ${crates.length} crates for ${triple}, all licences allowed${fallbacks.length ? `; ${fallbacks.length} without a licence file of their own: ${fallbacks.map((c) => c.name).join(', ')}` : ''}`);
}
