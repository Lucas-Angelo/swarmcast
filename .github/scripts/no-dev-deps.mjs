#!/usr/bin/env node
// Release hygiene: fails when a development dependency, or test code, would ship.
//
//   node .github/scripts/no-dev-deps.mjs [--server] [--web] [--staging <dir>]... [--archive <file>]...
//                                        [--installers <dir>]...
//
//   --server      apps/server/dist/meta.json, esbuild's record of the server bundle: every input
//                 file, and every require() the bundle leaves to Node at run time (pkg copies
//                 what those find into the executable); meta.json must describe the bundle on disk
//   --web         apps/viewer and apps/admin: the modules and source assets of their Vite builds
//                 (built again in memory with each app's own config), and apps/<app>/dist must be
//                 byte for byte that build
//   --staging     a script-mode package (release/staging/<target>): no node_modules folder, the
//                 files in the server executable's pkg snapshot, and web/ the same as
//                 apps/*/dist when that is here (a job that only downloaded the package has none)
//   --archive     a release archive (.zip or .tar.gz of a staging folder): unpacked, then as --staging
//   --installers  the desktop installers in a folder (release/desktop/<target>): each one unpacked
//                 (.app, .app.tar.gz, .deb, .AppImage, NSIS -setup.exe), no node_modules folder,
//                 the server sidecar's snapshot as in --staging and the same file list as the
//                 staged server's, web/ the same as the staged one (--staging) or apps/*/dist
//
// Must not ship:
// - a development dependency: a package that package-lock.json marks "dev" (only the
//   devDependencies of the root or of a workspace need it), a package named in any workspace's
//   devDependencies (unless another one lists it as a dependency), any @types/* package, or a
//   package that is not in package-lock.json at all (not installed by `npm ci`);
// - test code: a first-party file in a test/ (tests/, __tests__/, __mocks__/) folder, or a
//   *.test.* / *.spec.* file.
// Exit 1 when something would ship that must not, 2 when a check could not run. The findings also
// go to the job summary ($GITHUB_STEP_SUMMARY). pipeline.yml's build jobs (_build.yml,
// _desktop.yml) and release.yml's signing jobs run it; it needs the checkout (package.json files,
// package-lock.json) and, for --web, `npm ci`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { annotate } from './annotate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const posix = (p) => p.split(path.sep).join('/');
const fromRoot = (p) => posix(path.relative(root, p));
/** The server bundle that package.mjs hands to pkg: the entry point of every server executable. */
const SERVER_BUNDLE = 'apps/server/dist/swarmcast.cjs';
const WEB_APPS = ['viewer', 'admin'];
const TEST_CODE = /(^|\/)(test|tests|__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const LIST_MAX = 40;

class CheckError extends Error {}

// ------------------------------------------------------------------ what must not ship

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The workspaces of the root package.json ("apps/*" style patterns), with their package.json. */
function workspaces() {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const out = [{ dir: '.', pkg: rootPkg }];
  for (const pattern of rootPkg.workspaces ?? []) {
    const parts = pattern.split('/');
    if (parts.length !== 2 || parts[1] !== '*') throw new CheckError(`workspace pattern "${pattern}" is not "<folder>/*"; teach no-dev-deps.mjs to read it`);
    const parent = path.join(root, parts[0]);
    for (const name of fs.readdirSync(parent).sort()) {
      const file = path.join(parent, name, 'package.json');
      if (fs.existsSync(file)) out.push({ dir: `${parts[0]}/${name}`, pkg: readJson(file) });
    }
  }
  return out;
}

/** The rules: which installed package (by its package-lock.json path) must not ship, and why. */
function devModel() {
  const lock = readJson(path.join(root, 'package-lock.json'));
  const devNames = new Map();
  const prodNames = new Set();
  for (const { dir, pkg } of workspaces()) {
    for (const name of Object.keys(pkg.devDependencies ?? {})) devNames.set(name, [...(devNames.get(name) ?? []), dir === '.' ? 'the root' : dir]);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(pkg[field] ?? {})) prodNames.add(name);
  }
  const packages = lock.packages ?? {};
  return {
    lock: packages,
    /** Why the package installed at `key` (e.g. node_modules/a/node_modules/b) must not ship; [] when it may. */
    reasons(key, name) {
      const reasons = [];
      const entry = packages[key];
      if (!entry) reasons.push('not in package-lock.json (not installed by npm ci)');
      else if (entry.dev) reasons.push('needed only by devDependencies (package-lock.json "dev": true)');
      if (name.startsWith('@types/')) reasons.push('type declarations (@types/*)');
      if (devNames.has(name) && !prodNames.has(name)) reasons.push(`a devDependency of ${devNames.get(name).join(', ')}`);
      return reasons;
    },
  };
}

/**
 * The installed package a repository path belongs to ({ key, name }, key as in package-lock.json),
 * null for a first-party file, or 'dir' for a node_modules (or @scope) folder itself.
 */
function packageOf(relPath) {
  const parts = relPath.split('/');
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const width = parts[i + 1]?.startsWith('@') ? 2 : 1;
  if (parts.length < i + 1 + width) return 'dir';
  return { key: parts.slice(0, i + 1 + width).join('/'), name: parts.slice(i + 1, i + 1 + width).join('/') };
}

// ------------------------------------------------------------------ one check's findings

/** One line of the report: what was checked, what it holds, and what must not ship from it. */
class Check {
  constructor(label) {
    this.label = label;
    this.files = 0;
    this.packages = new Set();
    this.notes = [];
    this.found = new Map();
    /** Why this item was not opened (a file the check reads through another one). */
    this.skipped = '';
  }
  /** A finding; findings with the same `group` (one package, one folder) make one line with a count. */
  bad(where, why, group = `${where}\n${why}`) {
    const f = this.found.get(group);
    if (f) f.count++;
    else this.found.set(group, { where, why, count: 1 });
  }
  get problems() {
    return [...this.found.values()].map((f) => `${f.where}: ${f.why}${f.count > 1 ? ` (${f.count} entries)` : ''}`);
  }
  /** A file that ships, as a repository path; `source` says where it was seen (input, module, a snapshot). */
  file(model, relPath, source) {
    this.files++;
    if (relPath.startsWith('../') || path.isAbsolute(relPath)) return this.bad(`${source} ${relPath}`, 'outside the repository');
    const pkg = packageOf(relPath);
    if (pkg === 'dir') return;
    if (pkg === null) {
      if (TEST_CODE.test(relPath)) this.bad(`${source} ${relPath}`, 'test code');
      return;
    }
    this.packages.add(pkg.key);
    const reasons = model.reasons(pkg.key, pkg.name);
    if (reasons.length) this.bad(`${source} ${pkg.key}`, `${pkg.name}: ${reasons.join('; ')}`, `${source}\n${pkg.key}`);
  }
}

// ------------------------------------------------------------------ the server bundle

function checkServer(model) {
  const metaFile = path.join(root, 'apps/server/dist/meta.json');
  const check = new Check('server bundle (apps/server/dist/meta.json)');
  if (!fs.existsSync(metaFile)) throw new CheckError(`${fromRoot(metaFile)} is missing: run npm run build (or package.mjs) first`);
  const meta = readJson(metaFile);
  const outputs = Object.entries(meta.outputs ?? {});
  const entry = outputs.map(([, o]) => o.entryPoint).find(Boolean);
  // esbuild writes paths relative to its working folder: apps/server when npm runs the
  // workspace's build script there, the repository when package.mjs runs build.mjs.
  const base = [path.join(root, 'apps/server'), root].find((b) => entry && fs.existsSync(path.resolve(b, entry)));
  if (!base) throw new CheckError(`${fromRoot(metaFile)}: cannot tell where esbuild ran (entry point ${entry ?? 'missing'})`);
  const [outName, out] = outputs.find(([name]) => fromRoot(path.resolve(base, name)) === SERVER_BUNDLE) ?? [];
  if (!out) throw new CheckError(`${fromRoot(metaFile)} has no output ${SERVER_BUNDLE}`);
  const bundle = path.resolve(base, outName);
  if (!fs.existsSync(bundle) || fs.statSync(bundle).size !== out.bytes) {
    throw new CheckError(`${fromRoot(metaFile)} does not describe ${SERVER_BUNDLE} on disk (${out.bytes} bytes there, ${fs.existsSync(bundle) ? fs.statSync(bundle).size : 'no file'} here): build again`);
  }
  for (const input of Object.keys(meta.inputs ?? {})) {
    // Namespaced inputs ("ns:path") come from plugins, which build.mjs has none of.
    if (/^[a-z][\w-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
      check.bad(input, 'an input from an esbuild plugin namespace; no-dev-deps.mjs cannot tell where it comes from');
      continue;
    }
    check.file(model, fromRoot(path.resolve(base, input)), 'input');
  }
  // The require() calls esbuild left in the bundle (externals, optional packages): Node resolves
  // them from apps/server/dist when the server runs, and pkg copies what they find into the
  // executable. One that finds nothing is never loaded (the bundle catches its absence).
  const builtins = new Set(builtinModules);
  const runtime = [];
  for (const imp of out.imports ?? []) {
    if (!imp.external || imp.path.startsWith('node:') || builtins.has(imp.path) || builtins.has(imp.path.split('/')[0])) continue;
    const name = imp.path.startsWith('@') ? imp.path.split('/').slice(0, 2).join('/') : imp.path.split('/')[0];
    if (runtime.includes(name)) continue;
    runtime.push(name);
    const lookup = [];
    for (let dir = path.dirname(bundle); ; dir = path.dirname(dir)) {
      lookup.push(fromRoot(path.join(dir, 'node_modules', name)));
      if (dir === root || dir === path.dirname(dir)) break;
    }
    const key = lookup.find((k) => model.lock[k] || fs.existsSync(path.join(root, k)));
    if (key) check.file(model, `${key}/package.json`, `require("${imp.path}")`);
    else check.notes.push(`require("${imp.path}") finds nothing (never loaded)`);
  }
  check.notes.unshift(`${Object.keys(meta.inputs ?? {}).length} inputs, ${runtime.length} run-time require${runtime.length === 1 ? '' : 's'} (${runtime.join(', ') || 'none'})`);
  return check;
}

// ------------------------------------------------------------------ the web apps

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every file under `dir`: posix path relative to it -> sha256 of its content. */
function treeHashes(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(posix(path.relative(dir, p)), sha256(fs.readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}

/** The differences between two file -> hash maps, as problem lines. */
function compareTrees(check, actual, expected, label) {
  const diff = [];
  for (const f of expected.keys()) if (!actual.has(f)) diff.push(`${f} is missing`);
  for (const [f, h] of actual) {
    if (!expected.has(f)) diff.push(`${f} is extra`);
    else if (expected.get(f) !== h) diff.push(`${f} differs`);
  }
  for (const d of diff.slice(0, LIST_MAX)) check.bad(label, d);
  if (diff.length > LIST_MAX) check.bad(label, `and ${diff.length - LIST_MAX} more differences`);
  return diff.length === 0;
}

async function checkWeb(model) {
  const { build } = await import('vite');
  const checks = [];
  for (const app of WEB_APPS) {
    const dir = path.join(root, 'apps', app);
    const check = new Check(`web: apps/${app} (Vite build)`);
    const result = await build({ root: dir, configFile: path.join(dir, 'vite.config.ts'), logLevel: 'error', build: { write: false } });
    const items = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? []);
    if (!items.length) throw new CheckError(`apps/${app}: the in-memory Vite build returned no output`);
    const built = new Map();
    let modules = 0;
    let virtual = 0;
    let assets = 0;
    for (const item of items) {
      built.set(item.fileName, sha256(item.type === 'chunk' ? item.code : item.source));
      if (item.type === 'chunk') {
        for (const id of item.moduleIds ?? Object.keys(item.modules ?? {})) {
          modules++;
          // Virtual modules (\0rolldown/runtime.js, \0vite/preload-helper.js, a plugin's own)
          // are made by the bundler or a plugin, not read from a file.
          const file = id.replace(/^\0/, '').replace(/[?#].*$/, '');
          if (!path.isAbsolute(file)) {
            virtual++;
            continue;
          }
          check.file(model, fromRoot(file), 'module');
        }
      } else {
        for (const original of item.originalFileNames ?? (item.originalFileName ? [item.originalFileName] : [])) {
          assets++;
          check.file(model, fromRoot(path.resolve(dir, original)), 'asset');
        }
      }
    }
    check.files = built.size;
    check.notes.push(`${modules} modules (${virtual} virtual), ${assets} source assets, ${built.size} files`);
    // What ships is apps/<app>/dist: it must be this very build (the module list above is then its list).
    const dist = path.join(dir, 'dist');
    if (!fs.existsSync(dist)) check.bad(`apps/${app}/dist`, 'missing: run npm run build first');
    else if (compareTrees(check, treeHashes(dist), built, `apps/${app}/dist`)) check.notes.push(`apps/${app}/dist is this build, byte for byte`);
    checks.push(check);
  }
  return checks;
}

// ------------------------------------------------------------------ pkg executables

/**
 * The files pkg put into an executable's snapshot, as repository paths, and its entry point.
 * pkg (packer.js, producer.js) ends the payload with a prelude whose last five values are JSON,
 * one per line: the snapshot's files, the entry point, the symlinks, the dictionary of path
 * segments (keys are written as segment tokens when the payload is compressed) and the
 * compression. Anything else is an executable this check does not know: it fails rather than
 * pass what it cannot read.
 */
export function snapshotOf(exe) {
  const buf = fs.readFileSync(exe);
  const marker = Buffer.from('\nreturn module.exports; })(),\n');
  const at = buf.lastIndexOf(marker);
  if (at < 0) throw new CheckError(`${exe}: no pkg prelude (not a pkg executable, or a pkg whose layout no-dev-deps.mjs does not know)`);
  const end = buf.indexOf('\n);\n})', at);
  if (end < 0) throw new CheckError(`${exe}: the pkg prelude does not end as expected`);
  const values = buf.subarray(at + marker.length, end).toString('utf8').split('\n,\n');
  if (values.length !== 5) throw new CheckError(`${exe}: the pkg prelude has ${values.length} values, not 5`);
  let vfs, entry, dict;
  try {
    [vfs, entry, , dict] = values.map((v) => JSON.parse(v));
  } catch (e) {
    throw new CheckError(`${exe}: cannot read the pkg prelude (${e.message})`);
  }
  const segments = new Map(Object.entries(dict ?? {}).map(([segment, token]) => [token, segment]));
  const decode = (key) => {
    if (!segments.size) return key.replaceAll('\\', '/');
    return key
      .split('/')
      .map((token) => {
        if (!segments.has(token)) throw new CheckError(`${exe}: snapshot path token "${token}" is not in pkg's dictionary`);
        return segments.get(token);
      })
      .join('/');
  };
  // pkg puts the files under /snapshot/ (C:/snapshot/ for Windows), from the deepest folder they
  // share: the checkout's own folder name may come first, or (with no node_modules file at all)
  // the snapshot may start inside the repository. The entry point, the server bundle, tells which.
  const entryPath = String(entry).replaceAll('\\', '/');
  const top = ['C:/snapshot/', '/snapshot/'].find((t) => entryPath.startsWith(t));
  const entryRel = top ? entryPath.slice(top.length) : '';
  let toRepo;
  let above = '';
  if (entryRel === SERVER_BUNDLE || entryRel.endsWith(`/${SERVER_BUNDLE}`)) {
    above = entryRel.slice(0, entryRel.length - SERVER_BUNDLE.length);
    toRepo = (p) => (p.startsWith(above) ? p.slice(above.length) : `../${p}`);
  } else if (entryRel && SERVER_BUNDLE.endsWith(`/${entryRel}`)) {
    const inside = SERVER_BUNDLE.slice(0, -entryRel.length);
    toRepo = (p) => inside + p;
  } else {
    throw new CheckError(`${exe}: runs ${entryPath}, not the server bundle ${SERVER_BUNDLE}`);
  }
  const files = [];
  for (const key of Object.keys(vfs)) {
    const p = decode(key);
    if (!p.startsWith(top)) {
      // The snapshot folder itself, or a folder above it: not a file.
      if (!top.startsWith(`${p}/`)) files.push(`../${p}`);
      continue;
    }
    const rel = p.slice(top.length);
    // A folder between the snapshot folder and the checkout (e.g. /snapshot/<checkout>).
    if (above && (above.startsWith(`${rel}/`) || `${rel}/` === above)) continue;
    files.push(toRepo(rel));
  }
  return { files: files.sort(), entry: entryPath };
}

function checkExecutable(model, check, exe, label) {
  const snap = snapshotOf(exe);
  for (const f of snap.files) check.file(model, f, `${label} snapshot`);
  check.notes.push(`${label}: ${snap.files.length} snapshot entries from ${new Set(snap.files.map((f) => packageOf(f)?.key).filter((k) => k && k !== 'dir')).size} packages besides the bundle`);
  return snap;
}

// ------------------------------------------------------------------ packages, archives, installers

/** Every file and folder under `dir`, as posix paths relative to it. */
function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(posix(path.relative(dir, p)));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

const hasSegment = (relPath, segment) => relPath.split('/').includes(segment);
/** The outermost node_modules folder of a path (findings about one folder make one line). */
const nodeModulesFolder = (relPath) => {
  const parts = relPath.split('/');
  return parts.slice(0, parts.indexOf('node_modules') + 1).join('/');
};

/** The folders under `dir` that hold the web apps (web/viewer/watch.html, web/admin/index.html). */
function webDirs(dir, entries) {
  return entries.filter((e) => e.endsWith('/web/viewer/watch.html') || e === 'web/viewer/watch.html').map((e) => path.join(dir, e.slice(0, -'/viewer/watch.html'.length)));
}

function checkWebCopy(check, webDir, reference, label) {
  for (const app of WEB_APPS) {
    const ref = reference?.(app);
    if (!ref) continue;
    const here = path.join(webDir, app);
    if (!fs.existsSync(here)) check.bad(label, `no web/${app}`);
    else if (compareTrees(check, treeHashes(here), treeHashes(ref), `${label}/${app}`)) check.notes.push(`${label}/${app} = ${fromRoot(ref)}`);
  }
}

/** Where the checked web apps are: apps/<app>/dist when this job has them. */
const distReference = (app) => {
  const d = path.join(root, 'apps', app, 'dist');
  return fs.existsSync(d) ? d : null;
};

function checkStaging(model, dir, label = `staging: ${fromRoot(dir)}`) {
  const check = new Check(label);
  if (!fs.existsSync(dir)) throw new CheckError(`${dir} does not exist`);
  const entries = listTree(dir);
  for (const e of entries) if (hasSegment(e, 'node_modules')) check.bad(nodeModulesFolder(e), 'a node_modules folder in the package', nodeModulesFolder(e));
  const exe = entries.find((e) => e === 'swarmcast' || e === 'swarmcast.exe');
  let snap = null;
  if (!exe) check.bad(label, 'no server executable (swarmcast or swarmcast.exe) at its top level');
  else snap = checkExecutable(model, check, path.join(dir, exe), exe);
  const web = path.join(dir, 'web');
  if (!fs.existsSync(path.join(web, 'viewer', 'watch.html'))) check.bad(label, 'no web/viewer/watch.html');
  else if (WEB_APPS.some((a) => distReference(a))) checkWebCopy(check, web, distReference, 'web');
  else check.notes.push('web/ not compared (no apps/*/dist in this job; the job that built this package compared it)');
  check.files = entries.length;
  return { check, snap, web: fs.existsSync(web) ? web : null };
}

const tmpDirs = [];
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sc-no-dev-deps-${prefix}-`));
  tmpDirs.push(d);
  return d;
};
// On Windows, Git for Windows puts GNU tar first in PATH, which reads "C:\..." as a remote host;
// the OS's bsdtar (which also reads .zip) is in System32.
const tarBin = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });

function checkArchive(model, file) {
  const dir = tmp('archive');
  if (/\.zip$/i.test(file)) {
    if (process.platform !== 'win32' && process.platform !== 'darwin') run('unzip', ['-q', file, '-d', dir]);
    else run(tarBin(), ['-xf', file, '-C', dir]);
  } else if (/\.tar\.gz$|\.tgz$/i.test(file)) run(tarBin(), ['-xzf', file, '-C', dir]);
  else throw new CheckError(`${file}: not a .zip or .tar.gz`);
  return checkStaging(model, dir, `archive: ${path.basename(file)}`).check;
}

/** The unpacked installer (a folder), or null when this check does not open that kind of file. */
function unpack(file) {
  const name = path.basename(file);
  if (name.endsWith('.app') && fs.statSync(file).isDirectory()) return file;
  if (name.endsWith('.app.tar.gz')) {
    const d = tmp('app');
    run(tarBin(), ['-xzf', file, '-C', d]);
    return d;
  }
  if (name.endsWith('.deb')) {
    const d = tmp('deb');
    run('dpkg-deb', ['-x', file, d]);
    return d;
  }
  if (name.endsWith('.AppImage')) {
    // Extracting needs no FUSE (the runners have none); the AppImage runs on its own architecture.
    const d = tmp('appimage');
    fs.chmodSync(file, 0o755);
    run(path.resolve(file), ['--appimage-extract'], { cwd: d });
    return path.join(d, 'squashfs-root');
  }
  if (name.endsWith('-setup.exe')) {
    // 7-Zip reads NSIS installers (preinstalled on GitHub's Windows images).
    const d = tmp('nsis');
    run('7z', ['x', '-y', `-o${d}`, file]);
    return d;
  }
  return null;
}

function checkInstallers(model, dir, staged) {
  const checks = [];
  if (!fs.existsSync(dir)) throw new CheckError(`${dir} does not exist`);
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    // The updater's signatures and manifest are not installers.
    if (name.endsWith('.sig') || name.endsWith('.json')) continue;
    const check = new Check(`installer: ${name}`);
    checks.push(check);
    if (name.endsWith('.dmg')) {
      // Attaching disk images on the runners is what fails with "Resource busy"; the .dmg is
      // made from the .app next to it by the same `tauri bundle` step, and that is checked.
      check.skipped = 'not opened: made from SwarmCast.app, which is checked';
      continue;
    }
    let tree;
    try {
      tree = unpack(file);
    } catch (e) {
      throw new CheckError(`${name}: cannot unpack it (${String(e.stderr || e.message).trim().slice(0, 300)})`);
    }
    if (!tree) {
      check.bad(name, 'an unknown kind of installer: teach no-dev-deps.mjs to open it');
      continue;
    }
    const entries = listTree(tree);
    check.files = entries.length;
    for (const e of entries) if (hasSegment(e, 'node_modules')) check.bad(nodeModulesFolder(e), 'a node_modules folder in the installer', nodeModulesFolder(e));
    const sidecars = entries.filter((e) => /^swarmcast-server(\.exe)?$/.test(e.split('/').pop()) && fs.statSync(path.join(tree, e)).isFile());
    if (!sidecars.length) check.bad(name, 'no server sidecar (swarmcast-server) found');
    for (const s of sidecars) {
      const snap = checkExecutable(model, check, path.join(tree, s), s);
      if (staged?.snap && snap.files.join('\n') !== staged.snap.files.join('\n')) check.bad(s, `its snapshot is not the staged server's (${snap.files.length} entries, staged ${staged.snap.files.length})`);
    }
    const webs = webDirs(tree, entries);
    if (!webs.length) check.bad(name, 'no web/viewer/watch.html found');
    const reference = staged?.web ? (app) => path.join(staged.web, app) : distReference;
    for (const w of webs) checkWebCopy(check, w, reference, posix(path.relative(tree, w)));
  }
  if (!checks.length) throw new CheckError(`${dir}: no installers in it`);
  return checks;
}

// ------------------------------------------------------------------ report

function report(checks) {
  const lines = ['## Release: no development dependencies, no test code', '', '| checked | files | npm packages | result |', '|---|---|---|---|'];
  for (const c of checks) lines.push(`| ${c.label} | ${c.files} | ${c.packages.size} | ${c.problems.length ? `❌ ${c.problems.length}` : c.skipped ? '➖ not opened' : '✅'} |`);
  const bad = checks.filter((c) => c.problems.length);
  for (const c of bad) {
    lines.push('', `### ❌ ${c.label}`, '');
    for (const p of c.problems.slice(0, LIST_MAX)) lines.push(`- ${p}`);
    if (c.problems.length > LIST_MAX) lines.push(`- … and ${c.problems.length - LIST_MAX} more`);
  }
  lines.push('', '<details><summary>Details</summary>', '');
  for (const c of checks) {
    lines.push(`- **${c.label}**: ${[c.skipped, ...c.notes].filter(Boolean).join('; ') || 'no notes'}`);
    if (c.packages.size) lines.push(`  - packages: ${[...new Set([...c.packages].map((k) => k.replace(/^(.*\/)?node_modules\//, '')))].sort().join(', ')}`);
  }
  lines.push('', '</details>', '');
  return lines.join('\n');
}

async function main(argv) {
  const want = { server: false, web: false, staging: [], archive: [], installers: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') want.server = true;
    else if (a === '--web') want.web = true;
    else if (['--staging', '--archive', '--installers'].includes(a) && argv[i + 1]) want[a.slice(2)].push(path.resolve(argv[++i]));
    else throw new CheckError(`unknown argument ${a} (see the top of .github/scripts/no-dev-deps.mjs)`);
  }
  if (!want.server && !want.web && !want.staging.length && !want.archive.length && !want.installers.length) throw new CheckError('nothing to check: pass --server, --web, --staging, --archive or --installers');
  const model = devModel();
  const checks = [];
  if (want.server) checks.push(checkServer(model));
  if (want.web) checks.push(...(await checkWeb(model)));
  const staged = [];
  for (const dir of want.staging) {
    const s = checkStaging(model, dir);
    checks.push(s.check);
    staged.push(s);
  }
  for (const file of want.archive) checks.push(checkArchive(model, file));
  for (const dir of want.installers) checks.push(...checkInstallers(model, dir, staged.length === 1 ? staged[0] : null));
  const text = report(checks);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  const problems = checks.reduce((n, c) => n + c.problems.length, 0);
  for (const c of checks) for (const p of c.problems.slice(0, 10)) annotate('error', `Must not ship (${c.label})`, p);
  return problems ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    annotate('error', 'no-dev-deps.mjs', e instanceof CheckError ? e.message : e.stack);
    code = 2;
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
  process.exit(code);
}
