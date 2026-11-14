#!/usr/bin/env node
// The Rust toolchain of apps/desktop/src-tauri/rust-toolchain.toml for the jobs that run cargo,
// with no download from static.rust-lang.org in a job whose runner image or saved copy has it
// (.github/actions/rust-toolchain; .github/workflows/README.md, "Rust toolchain").
//
//   node .github/scripts/rust-toolchain.mjs key        dir= and prefix= of the saved copy (an Actions cache)
//   node .github/scripts/rust-toolchain.mjs install [--components a,b] [--targets t,u]
//                                                      the toolchain, its default, offline when it can be
//   node .github/scripts/rust-toolchain.mjs pin <channel>
//                                                      rewrites rust-toolchain.sha256 for rust-toolchain.toml's
//                                                      channel (a developer's step after a channel change; downloads)
//
// The pin: apps/desktop/src-tauri/rust-toolchain.sha256 holds the SHA-256 of the release's channel
// manifest (channel-rust-<channel>.toml, as static.rust-lang.org publishes it, in its own `.sha256`
// format). The manifest lists every archive of the release with its SHA-256, so the pin fixes the
// whole toolchain. Not in rust-toolchain.toml itself: rust-cache hashes that file into every Rust
// cache key, and changing it would make all eight Rust entries cold at once.
//
// `install` takes, in order:
// 1. the runner image's toolchain, with no network at all: a toolchain of this host that rustup
//    installed from the pinned manifest (the first 20 hex digits of its SHA-256, which rustup
//    records in $RUSTUP_HOME/update-hashes/<toolchain>, match the pin) and that has every component
//    and target the job needs (rustup's $RUSTUP_HOME/toolchains/<toolchain>/lib/rustlib/components).
//    `<channel>-<host>` itself, or another name such as the image's `stable-<host>` (stable's
//    manifest is the very file of its version, byte for byte), linked as `<channel>-<host>`;
// 2. else the saved copy in $SC_RUST_TOOLCHAIN_DIR (restored by .github/actions/rust-toolchain/restore):
//    a mirror of static.rust-lang.org's dist/ folder holding the manifest and the archives the
//    jobs of this host used. The manifest must have the pinned SHA-256 and every archive the
//    manifest's SHA-256 (a file that does not is deleted, with a warning). Then rustup installs
//    from it (RUSTUP_DIST_SERVER=file://..., which also checks every archive against the manifest);
// 3. the cold path, only for what the saved copy lacks: the manifest and archives from
//    static.rust-lang.org, each try limited, at most TRIES tries, every file checked against the
//    pin or the manifest, into the mirror, and rustup installs from the mirror as in 2.
//    `SC_RUST_TOOLCHAIN_SAVE_KEY` then tells ./.github/actions/setup/save to save the mirror (main
//    only). When static.rust-lang.org does not answer, the step fails with a
//    `Rust toolchain (infrastructure)` error naming it and why the job needed it.
// rustup itself never downloads anything: it always installs from the local mirror.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CRATE_DIR = path.join(ROOT, 'apps/desktop/src-tauri');
const TOOLCHAIN_FILE = path.join(CRATE_DIR, 'rust-toolchain.toml');
const PIN_FILE = path.join(CRATE_DIR, 'rust-toolchain.sha256');
/** The one origin the cold path downloads from; the mirror keeps its paths below it. */
export const DIST_ORIGIN = 'https://static.rust-lang.org';
/** How the manifest's archive URLs start. */
export const DIST_ROOT = `${DIST_ORIGIN}/`;
/**
 * The only paths the cold path asks for and writes: a channel manifest in dist/, or an archive in
 * a dist/<date>/ folder. One file name, no other folder, no `..`.
 */
const DIST_PATH = /^dist\/(?:\d{4}-\d{2}-\d{2}\/)?[a-z0-9][a-z0-9_.+-]*\.(?:toml|tar\.xz|tar\.gz)$/;
/** The channels rust-toolchain.toml may name. */
const CHANNEL = /^(?:\d+\.\d+(?:\.\d+)?|stable|beta|nightly(?:-\d{4}-\d{2}-\d{2})?)$/;

/** `rel` when it is such a path, else an error: nothing else is ever fetched or written. */
export function distPath(rel) {
  if (typeof rel !== 'string' || !DIST_PATH.test(rel) || rel.includes('..')) throw new Error(`not a path of static.rust-lang.org's dist/ this script fetches: ${JSON.stringify(rel)}`);
  return rel;
}

/** The URL of a dist/ path: the fixed origin and the checked path, never a URL from a file. */
export const distUrl = (rel) => `${DIST_ORIGIN}/${distPath(rel)}`;

/** Where a dist/ path lands in the mirror at `root`: below it, whatever the path says. */
export function mirrorPath(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...distPath(rel).split('/'));
  if (!full.startsWith(base + path.sep)) throw new Error(`${rel} would land outside ${base}`);
  return full;
}
const isWin = process.platform === 'win32';

/** Part of the saved copy's key: a change in what the mirror holds starts a new family. */
export const KEY_VERSION = 'v1';
/** Tries per file on the cold path. */
export const TRIES = 3;
/** One try of one file is cut off after this (rustc's archive, the largest, is about 85 MB; a host's seven files took 9 s in all). */
export const TRY_MS = 90_000;
/** ...or after this long without a byte. */
export const IDLE_MS = 30_000;
/** Pause before try 2, then before try 3. */
export const PAUSES_MS = [5_000, 15_000];
/**
 * The cold path ends this long after it began: a try that could not end by then does not start.
 * With the saved copy's restore (2 x 90 s at most) and the install, under setup-rust's 8 minutes.
 */
export const COLD_PATH_MS = 240_000;

/** A failure of static.rust-lang.org or of the runner's network: the `(infrastructure)` error. */
export class InfraError extends Error {}

/** A time limit as the logs say it. */
const limit = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** SHA-256 of a file, read in pieces. */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** channel, profile, components and targets of a rust-toolchain.toml. */
export function readToolchain(toml) {
  const text = toml.replace(/\r\n/g, '\n');
  const str = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1];
  const list = (key) => {
    const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const channel = str('channel');
  if (!channel) throw new Error('rust-toolchain.toml: no channel');
  if (!CHANNEL.test(channel)) throw new Error(`rust-toolchain.toml: ${channel} is not a release, stable, beta or a dated nightly`);
  return { channel, profile: str('profile') ?? 'minimal', components: list('components'), targets: list('targets') };
}

/** The manifest's file name in dist/. */
export const manifestName = (channel) => `channel-rust-${channel}.toml`;

/**
 * The pinned SHA-256 of `channel`'s manifest, from rust-toolchain.sha256 (`<sha256>  channel-rust-<channel>.toml`).
 * Throws when the file pins another channel's manifest: rust-toolchain.toml changed without it.
 */
export function readPin(text, channel) {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/m.exec(text.replace(/\r\n/g, '\n'));
  if (!m) throw new Error('rust-toolchain.sha256: not "<sha256>  channel-rust-<channel>.toml"');
  if (m[2] !== manifestName(channel)) {
    throw new Error(`rust-toolchain.sha256 pins ${m[2]}, but rust-toolchain.toml's channel is ${channel}: run node .github/scripts/rust-toolchain.mjs pin ${channel}`);
  }
  return m[1];
}

const HOSTS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** The target triple rustup installs for this machine (its default host on the runners). */
export function hostTriple(platform = process.platform, arch = process.arch) {
  const host = HOSTS[`${platform}-${arch}`];
  if (!host) throw new Error(`no Rust host triple known for ${platform}-${arch}`);
  return host;
}

/** The saved copy's key prefix: one family per host and channel; the restore takes its newest entry. */
export const cachePrefix = (host, channel) => `rust-toolchain-${KEY_VERSION}-${host}-${channel}-`;

/**
 * The key of a new entry: the prefix, the run, and a hash of what the mirror holds, so the newest
 * entry is the one a later run made with the most files (the restore takes the newest).
 * @param {string} prefix
 * @param {string} runId
 * @param {Map<string, string>} files  path below the mirror -> SHA-256
 */
export function saveKey(prefix, runId, files) {
  const list = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([rel, sha]) => `${sha}  ${rel}\n`).join('');
  return `${prefix}${runId}-${sha256(list).slice(0, 16)}`;
}

function tomlValue(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"')) return /^"([^"]*)"/.exec(v)?.[1] ?? '';
  if (v.startsWith('[')) return [...v.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return v;
}
const unquote = (s) => s.replace(/^"(.*)"$/, '$1');

/**
 * The parts of a channel manifest (manifest-version 2) that say what to install: its date, each
 * package's entry per target ({ available, url, hash, xz_url, xz_hash }), the component renames
 * (clippy -> clippy-preview) and the profiles. Only that subset of TOML: tables, `key = "..."`,
 * booleans and one-line arrays of strings; arrays of tables are skipped.
 * @param {string} text
 */
export function parseManifest(text) {
  /** @type {Map<string, Record<string, any>>} */
  const pkgs = new Map();
  /** @type {Map<string, string>} */
  const renames = new Map();
  /** @type {Record<string, string[]>} */
  const profiles = {};
  let date = null;
  /** @type {{ kind: string, entry?: Record<string, any>, from?: string }} */
  let table = { kind: 'top' };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) {
      table = { kind: 'skip' };
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      let m;
      if ((m = /^pkg\.([^.]+)\.target\.(.+)$/.exec(name))) {
        const entry = { pkg: m[1], target: unquote(m[2]) };
        pkgs.set(`${entry.pkg}|${entry.target}`, entry);
        table = { kind: 'pkg', entry };
      } else if ((m = /^renames\.(.+)$/.exec(name))) table = { kind: 'rename', from: unquote(m[1]) };
      else if (name === 'profiles') table = { kind: 'profiles' };
      else table = { kind: 'skip' };
      continue;
    }
    const kv = /^("?[A-Za-z0-9_.*-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = tomlValue(kv[2]);
    if (table.kind === 'top' && key === 'date') date = value;
    else if (table.kind === 'pkg' && table.entry) table.entry[key] = value;
    else if (table.kind === 'rename' && key === 'to' && table.from) renames.set(table.from, String(value));
    else if (table.kind === 'profiles' && Array.isArray(value)) profiles[key] = value;
  }
  if (!date || !pkgs.size) throw new Error('not a Rust channel manifest (no date or no packages)');
  return { date, pkgs, renames, profiles };
}

/** rustup's names before the manifest is known (the image check): the renames every manifest has. */
const KNOWN_RENAMES = new Map([
  ['clippy', 'clippy-preview'],
  ['rustfmt', 'rustfmt-preview'],
  ['llvm-tools', 'llvm-tools-preview'],
  ['rust-analyzer', 'rust-analyzer-preview'],
  ['miri', 'miri-preview'],
]);
/** The minimal profile; rust-mingw exists only for the windows-gnu hosts. */
const KNOWN_MINIMAL = ['rustc', 'cargo', 'rust-std', 'rust-mingw'];

/**
 * The components a job needs, as rustup names them in a toolchain's lib/rustlib/components
 * (`<package>-<target>`, `<package>` for a target-independent one such as rust-src): the profile's
 * for the host, the extra components (rustup's user-facing names, renamed as the manifest says)
 * and rust-std for each extra target. With no manifest (the image check), the renames and the
 * minimal profile every manifest has.
 * @param {{ host: string, profile?: string, components?: string[], targets?: string[], manifest?: ReturnType<typeof parseManifest> | null }} o
 * @returns {{ pkg: string, target: string, name: string }[]}
 */
export function wanted({ host, profile = 'minimal', components = [], targets = [], manifest = null }) {
  const renames = manifest?.renames ?? KNOWN_RENAMES;
  const has = (pkg, target) => {
    if (!manifest) return pkg !== 'rust-mingw' || /-windows-gnu/.test(target);
    return manifest.pkgs.get(`${pkg}|${target}`)?.available === true;
  };
  /** @type {Map<string, { pkg: string, target: string, name: string }>} */
  const out = new Map();
  const add = (pkg, target) => {
    const name = target === '*' ? pkg : `${pkg}-${target}`;
    out.set(name, { pkg, target, name });
  };
  const list = manifest?.profiles?.[profile] ?? (profile === 'minimal' ? KNOWN_MINIMAL : null);
  if (!list) throw new Error(`rustup profile ${profile} is not in the manifest`);
  for (const pkg of list) if (has(pkg, host)) add(pkg, host);
  for (const c of components) {
    const pkg = renames.get(c) ?? c;
    if (manifest?.pkgs.get(`${pkg}|*`)?.available === true) add(pkg, '*');
    else if (has(pkg, host)) add(pkg, host);
    else throw new Error(`component ${c} is not available for ${host} in this release`);
  }
  for (const t of targets) {
    if (!has('rust-std', t)) throw new Error(`target ${t} is not available in this release`);
    add('rust-std', t);
  }
  return [...out.values()];
}

/**
 * The archive rustup downloads for each component (the .tar.xz, as rustup prefers it), with its
 * path below the mirror and its SHA-256 from the manifest. The manifest's URL must be a dist/
 * archive of static.rust-lang.org (distPath); the URL fetched is rebuilt from the fixed origin.
 * @param {ReturnType<typeof parseManifest>} manifest
 * @param {{ pkg: string, target: string, name: string }[]} list
 */
export function archives(manifest, list) {
  return list.map((w) => {
    const e = manifest.pkgs.get(`${w.pkg}|${w.target}`);
    const url = e?.xz_url ?? e?.url;
    const sha = e?.xz_url ? e.xz_hash : e?.hash;
    if (typeof url !== 'string' || !url.startsWith(DIST_ROOT) || !/^[0-9a-f]{64}$/.test(sha ?? '')) {
      throw new Error(`the manifest has no archive on ${DIST_ROOT} for ${w.name}`);
    }
    const rel = distPath(url.slice(DIST_ROOT.length));
    return { name: w.name, url: distUrl(rel), rel, sha };
  });
}

/** Every file below `dir`, as paths with `/`. */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

/**
 * Checks the mirror at `dir` against the pin, as apt-debs.sh checks a .deb set: the manifest must
 * have the pinned SHA-256, and every other file must be an archive of that manifest with its
 * SHA-256. What does not match is deleted and reported. Without a good manifest nothing else can
 * be judged: { manifest: null }, the archives left for the call after the manifest is fetched.
 * @returns {{ manifest: ReturnType<typeof parseManifest> | null, ok: Map<string, string>, removed: { rel: string, why: string }[] }}
 */
export function checkMirror(dir, channel, pin) {
  const removed = [];
  const ok = new Map();
  // A download's private folder that a killed job left behind (downloadWithTries).
  if (fs.existsSync(dir)) for (const d of fs.readdirSync(dir)) if (d.startsWith('.download-')) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  const manifestRel = `dist/${manifestName(channel)}`;
  const manifestFile = path.join(dir, manifestRel);
  if (!fs.existsSync(manifestFile)) return { manifest: null, ok, removed };
  const text = fs.readFileSync(manifestFile);
  const got = sha256(text);
  if (got !== pin) {
    fs.rmSync(manifestFile);
    removed.push({ rel: manifestRel, why: `SHA-256 ${got}, not the pinned ${pin}` });
    return { manifest: null, ok, removed };
  }
  const manifest = parseManifest(text.toString('utf8'));
  const known = new Map();
  for (const e of manifest.pkgs.values()) {
    if (typeof e.xz_url === 'string' && e.xz_url.startsWith(DIST_ROOT)) known.set(e.xz_url.slice(DIST_ROOT.length), e.xz_hash);
    if (typeof e.url === 'string' && e.url.startsWith(DIST_ROOT)) known.set(e.url.slice(DIST_ROOT.length), e.hash);
  }
  for (const rel of listFiles(dir)) {
    if (rel === manifestRel || rel === `${manifestRel}.sha256`) continue;
    const want = known.get(rel);
    const sha = sha256File(path.join(dir, rel));
    if (want && sha === want) {
      ok.set(rel, sha);
      continue;
    }
    fs.rmSync(path.join(dir, rel));
    removed.push({ rel, why: want ? `SHA-256 ${sha}, not the manifest's ${want}` : 'not an archive of this release' });
  }
  return { manifest, ok, removed };
}

/** The reason of a failed fetch() (Node puts the system error, ENOTFOUND and the like, in `cause`). */
function reason(err) {
  const cause = err?.cause;
  const detail = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(' ')})` : '';
  return `${err?.message ?? err}${detail}`;
}

/** A download that must not be tried again: the file is not there. */
class NotThere extends Error {}

/**
 * One try: `url` into `file`, a new file (created exclusively, mode 0600), cut off after `tryMs`
 * or `idleMs` without data. Resolves the SHA-256 of what arrived; rejects with the reason
 * (NotThere for a 404 or 410).
 */
export async function downloadOnce(url, file, { tryMs = TRY_MS, idleMs = IDLE_MS, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  let why = '';
  const cut = (w) => {
    why = w;
    ac.abort();
  };
  const total = setTimeout(() => cut(`cut off after ${limit(tryMs)}`), tryMs);
  let idle = setTimeout(() => cut(`no data for ${limit(idleMs)}`), idleMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (res.status === 404 || res.status === 410) throw new NotThere(`HTTP ${res.status}`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        clearTimeout(idle);
        idle = setTimeout(() => cut(`no data for ${limit(idleMs)}`), idleMs);
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: ac.signal });
    return hash.digest('hex');
  } catch (err) {
    if (err instanceof NotThere) throw err;
    throw new Error(why || reason(err), { cause: err });
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

/**
 * The dist/ path `rel` from static.rust-lang.org into the mirror at `root`, with tries: one more
 * after a try that failed, was cut off or brought another file than `sha` (a CDN that served a
 * damaged or partial body), at most `tries`, none that could not end by `deadline`. A 404 is
 * not tried again. Each try downloads into a private folder of its own in the mirror
 * (fs.mkdtemp), and only a file with the SHA-256 `sha` (the pin, or the pinned manifest's) is
 * moved to its place, mirrorPath(root, rel); the URL is the fixed origin and the checked path
 * (distUrl). Returns { tries }; throws an InfraError with the reason when every try failed. A
 * file that came only after failed tries logs an `infra recovery:` warning (docs/TESTING.md,
 * "Infra recoveries").
 */
export async function downloadWithTries({ root, rel, sha, tries = TRIES, tryMs = TRY_MS, idleMs = IDLE_MS, pauses = PAUSES_MS, deadline = Infinity, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, fetchImpl = fetch }) {
  const url = distUrl(rel);
  const file = mirrorPath(root, rel);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${rel}: no SHA-256 to check it against`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let first = '';
  for (let n = 1; ; n++) {
    if (n === 1 && now() >= deadline) throw new InfraError(`${url}: the cold path had no time left for it`);
    let why;
    const tmp = fs.mkdtempSync(path.join(path.resolve(root), '.download-'));
    try {
      const part = path.join(tmp, path.basename(file));
      const got = await downloadOnce(url, part, { tryMs, idleMs, fetchImpl });
      if (got === sha) {
        fs.renameSync(part, file);
        if (n > 1) log(`::warning title=Rust toolchain::infra recovery: ${url} downloaded on try ${n} of ${tries} (try 1: ${first})`);
        return { tries: n };
      }
      why = `it sent a file with SHA-256 ${got}, not ${sha}`;
    } catch (err) {
      if (err instanceof NotThere) throw new Error(`static.rust-lang.org has no ${url} (${err.message})`, { cause: err });
      why = err instanceof Error ? err.message : String(err);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    first ||= why;
    const pause = pauses[Math.min(n - 1, pauses.length - 1)] ?? 0;
    if (n >= tries || now() + pause + tryMs > deadline) {
      throw new InfraError(`${url}: ${n} ${n === 1 ? 'try' : 'tries'} failed, the last: ${why}${n > 1 && first !== why ? `; the first: ${first}` : ''}`);
    }
    log(`::warning title=Rust toolchain::${url}: try ${n} of ${tries} failed (${why}); trying again in ${Math.round(pause / 1000)} s`);
    await sleep(pause);
  }
}

/** What rustup recorded for a toolchain: the manifest hash it was installed from and its components. */
function toolchainRecord(rustupHome, name) {
  const dir = path.join(rustupHome, 'toolchains', name);
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const hash = (read(path.join(rustupHome, 'update-hashes', name)) ?? '').trim();
  const components = (read(path.join(dir, 'lib', 'rustlib', 'components')) ?? '').split(/\r?\n/).filter(Boolean);
  return { name, dir, hash, components };
}

/**
 * The installed toolchain this job can use as it is, with no network: `<channel>-<host>` itself
 * (`exact`), else another toolchain of the host, such as the runner image's `stable-<host>`, to
 * link as `<channel>-<host>` (`alias`), or none. Usable means: rustup installed it from the pinned
 * manifest (the hash prefix it keeps in update-hashes, at least 16 hex digits, starts the pin)
 * and its components include every one of `want`. `notes` says why each toolchain of the host
 * was not usable.
 * @param {{ rustupHome: string, channel: string, host: string, pin: string, want: { name: string }[] }} o
 */
export function usableInstalled({ rustupHome, channel, host, pin, want }) {
  const exactName = `${channel}-${host}`;
  const toolchains = path.join(rustupHome, 'toolchains');
  const names = fs.existsSync(toolchains) ? fs.readdirSync(toolchains).filter((n) => n.endsWith(`-${host}`)) : [];
  const notes = [];
  const fits = (rec) => {
    if (!/^[0-9a-f]{16,64}$/.test(rec.hash) || !pin.startsWith(rec.hash)) {
      notes.push(`${rec.name}: installed from another manifest (${rec.hash || 'no record'}, not ${pin.slice(0, 20)})`);
      return false;
    }
    const missing = want.filter((w) => !rec.components.includes(w.name)).map((w) => w.name);
    if (missing.length) {
      notes.push(`${rec.name}: installed from the pinned manifest, without ${missing.join(', ')}`);
      return false;
    }
    return true;
  };
  if (names.includes(exactName)) {
    const rec = toolchainRecord(rustupHome, exactName);
    return fits(rec) ? { use: 'exact', name: exactName, from: exactName, notes } : { use: null, name: exactName, from: null, notes };
  }
  const others = names.sort((a, b) => Number(b.startsWith('stable-')) - Number(a.startsWith('stable-')) || a.localeCompare(b));
  for (const n of others) {
    if (fits(toolchainRecord(rustupHome, n))) return { use: 'alias', name: exactName, from: n, notes };
  }
  return { use: null, name: exactName, from: null, notes };
}

/** Links `from` as `name` in rustup's toolchains (a junction on Windows), with its update hash. */
export function linkToolchain(rustupHome, from, name) {
  const target = path.join(rustupHome, 'toolchains', from);
  fs.symlinkSync(target, path.join(rustupHome, 'toolchains', name), isWin ? 'junction' : 'dir');
  fs.copyFileSync(path.join(rustupHome, 'update-hashes', from), path.join(rustupHome, 'update-hashes', name));
}

// ---- the CLI ----

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const rustupHomeDir = (env = process.env) => env.RUSTUP_HOME || path.join(os.homedir(), '.rustup');
/**
 * The mirror: $SC_RUST_TOOLCHAIN_DIR (the restore step sets it), else in the job's own
 * $RUNNER_TEMP, else (outside CI) a new private folder of the system's temporary folder.
 */
function mirrorDir(env = process.env) {
  if (env.SC_RUST_TOOLCHAIN_DIR) return path.resolve(env.SC_RUST_TOOLCHAIN_DIR);
  if (env.RUNNER_TEMP) return path.join(path.resolve(env.RUNNER_TEMP), 'rust-toolchain');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rust-toolchain-'));
}

function appendGithub(file, lines) {
  if (process.env[file]) fs.appendFileSync(process.env[file], lines.map((l) => `${l}\n`).join(''));
}

/** rustup with `env` added, in `cwd` (never one with a rust-toolchain.toml: rustup would act on it). */
function rustup(args, { env = {}, cwd, capture = false } = {}) {
  const r = spawnSync('rustup', args, { cwd, env: { ...process.env, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: isWin });
  if (r.error) throw new Error(`rustup ${args[0]}: ${r.error.message} (is rustup on PATH?)`);
  if (r.status !== 0) throw new Error(`rustup ${args.join(' ')} exited with ${r.status}${capture ? `: ${(r.stderr || '').trim()}` : ''}`);
  return r.stdout ?? '';
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? '' : (argv[i + 1] ?? '');
}
const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function config() {
  const toolchain = readToolchain(fs.readFileSync(TOOLCHAIN_FILE, 'utf8'));
  const pin = readPin(fs.readFileSync(PIN_FILE, 'utf8'), toolchain.channel);
  const host = hostTriple();
  return { ...toolchain, pin, host, prefix: cachePrefix(host, toolchain.channel) };
}

/** The saved copy's folder and key prefix (GITHUB_OUTPUT dir=, prefix=; GITHUB_ENV SC_RUST_TOOLCHAIN_DIR). */
function keyCommand() {
  const { prefix } = config();
  const dir = mirrorDir();
  const lines = [`dir=${dir}`, `prefix=${prefix}`];
  console.log(lines.join('\n'));
  appendGithub('GITHUB_OUTPUT', lines);
  appendGithub('GITHUB_ENV', [`SC_RUST_TOOLCHAIN_DIR=${dir}`]);
}

/**
 * The toolchain the job needs, from the image, else the saved copy, else static.rust-lang.org
 * for what the copy lacks; rustup installs from the local mirror only, and the toolchain becomes
 * the default. Outputs (GITHUB_OUTPUT): toolchain=, source= (image, saved, network), dist-server=.
 */
async function installCommand(argv) {
  const start = Date.now();
  const cfg = config();
  const { channel, host, pin, profile } = cfg;
  const extra = { components: csv(arg(argv, 'components')), targets: csv(arg(argv, 'targets')) };
  // rust-toolchain.toml's own components and targets too: rustup's proxies install whatever of
  // them is missing at the first cargo call in apps/desktop/src-tauri, from the network.
  const components = [...new Set([...cfg.components, ...extra.components])];
  const targets = [...new Set([...cfg.targets, ...extra.targets])].filter((t) => t !== host);
  const name = `${channel}-${host}`;
  const rustupHome = rustupHomeDir();
  const dir = mirrorDir();
  const distServer = pathToFileURL(dir).href;
  const restored = process.env.SC_RUST_TOOLCHAIN_RESTORED ?? '';
  // Every rustup call of this script: from the mirror only, never installing by itself, and on
  // the toolchain it names (no RUSTUP_TOOLCHAIN override).
  const offline = { RUSTUP_DIST_SERVER: distServer, RUSTUP_AUTO_INSTALL: '0' };
  delete process.env.RUSTUP_TOOLCHAIN;
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Rust toolchain: ${name}, profile ${profile}${components.length ? `, components ${components.join(', ')}` : ''}${targets.length ? `, targets ${targets.join(', ')}` : ''}; pinned manifest ${manifestName(channel)} ${pin}`);
  console.log(rustup(['--version'], { env: offline, cwd: dir, capture: true }).trim().split('\n')[0]);

  // 1. The runner image's (or an earlier step's) toolchain, with no network.
  let source;
  const knownWant = wanted({ host, profile, components, targets });
  const found = usableInstalled({ rustupHome, channel, host, pin, want: knownWant });
  for (const n of found.notes) console.log(`  ${n}`);
  if (found.use === 'exact') {
    source = 'image';
    console.log(`Rust toolchain: ${name} is installed already, from the pinned manifest, with every component: no download`);
  } else if (found.use === 'alias' && found.from) {
    linkToolchain(rustupHome, found.from, name);
    source = 'image';
    console.log(`Rust toolchain: the runner image's ${found.from} was installed from the pinned manifest (${channel}) with every component; linked as ${name}: no download`);
  }

  let saveKeyValue = '';
  if (!source) {
    // 2. The saved copy, checked; 3. static.rust-lang.org for what it lacks.
    let check = checkMirror(dir, channel, pin);
    for (const r of check.removed) console.log(`::warning title=Rust toolchain::the saved copy's ${r.rel} is not used: ${r.why}`);
    const fetched = [];
    const coldStart = Date.now();
    const deadline = coldStart + COLD_PATH_MS;
    const lacks = [];
    const why = () => {
      const image = found.notes.length ? `the runner image's toolchains do not fit (${found.notes.join('; ')})` : `the runner image has no ${host} toolchain`;
      const copy = restored ? `the saved copy ${restored} lacks ${lacks.join(', ')}` : 'no saved copy was restored (none saved on main yet for this channel and host, or the Actions cache did not answer)';
      return `${copy}, and ${image}`;
    };
    const get = async (rel, sha) => {
      await downloadWithTries({ root: dir, rel, sha, deadline });
      fetched.push(rel);
    };
    try {
      if (!check.manifest) {
        lacks.push(manifestName(channel));
        console.log(`Rust toolchain: fetching ${manifestName(channel)} from static.rust-lang.org (the cold path)`);
        await get(`dist/${manifestName(channel)}`, pin);
        check = checkMirror(dir, channel, pin);
        for (const r of check.removed) console.log(`::warning title=Rust toolchain::the saved copy's ${r.rel} is not used: ${r.why}`);
      }
      if (!check.manifest) throw new Error('the manifest does not check out after its download');
      const want = wanted({ host, profile, components, targets, manifest: check.manifest });
      const files = archives(check.manifest, want);
      const missing = files.filter((f) => !check.ok.has(f.rel));
      lacks.push(...missing.map((f) => f.name));
      for (const f of missing) {
        console.log(`Rust toolchain: fetching ${f.rel} from static.rust-lang.org (the cold path)`);
        await get(f.rel, f.sha);
        check.ok.set(f.rel, f.sha);
      }
      const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f.rel)).size, 0);
      if (fetched.length) {
        source = 'network';
        saveKeyValue = saveKey(cfg.prefix, process.env.GITHUB_RUN_ID || 'local', check.ok);
        console.log(`Rust toolchain: ${fetched.length} files from static.rust-lang.org in ${Math.round((Date.now() - coldStart) / 1000)} s, each checked against the pin or the manifest (${why()})`);
      } else {
        source = 'saved';
        console.log(`Rust toolchain: every archive from the saved copy ${restored || dir}: ${files.length} archives, ${mb(bytes)}, checked against the pinned manifest; no download`);
      }
    } catch (err) {
      if (err instanceof InfraError) {
        throw new InfraError(`static.rust-lang.org did not answer: ${err.message}. The job needed it because ${why()}. Nothing was skipped and nothing was tested without the toolchain: this is an outage of static.rust-lang.org or of the runner's network, not a failure of SwarmCast. Start a new run once it answers.`, { cause: err });
      }
      throw err;
    }
    // rustup reads the manifest's .sha256 first: the pin, in static.rust-lang.org's format, as a
    // new file of its own (a restored one is replaced).
    const sumFile = `${mirrorPath(dir, `dist/${manifestName(channel)}`)}.sha256`;
    fs.rmSync(sumFile, { force: true });
    fs.writeFileSync(sumFile, `${pin}  ${manifestName(channel)}\n`, { flag: 'wx', mode: 0o600 });
    const args = ['toolchain', 'install', name, '--profile', profile, '--no-self-update'];
    if (components.length) args.push('--component', components.join(','));
    if (targets.length) args.push('--target', targets.join(','));
    console.log(`Rust toolchain: rustup installs ${name} from ${distServer} (the local mirror)`);
    rustup(args, { env: offline, cwd: dir });
  }

  // Also the default: rust-cache computes its key with the default rustc, and the scripts run
  // cargo outside apps/desktop/src-tauri too.
  rustup(['default', name], { env: offline, cwd: dir });
  const rec = toolchainRecord(rustupHome, name);
  const after = wanted({ host, profile, components, targets }).filter((w) => !rec.components.includes(w.name));
  if (after.length) throw new Error(`${name} lacks ${after.map((w) => w.name).join(', ')} after the install`);
  // rust-toolchain.toml resolves to it, offline: what every cargo call in src-tauri does next.
  const vv = spawnSync('rustc', ['-vV'], { cwd: CRATE_DIR, env: { ...process.env, ...offline }, encoding: 'utf8', shell: isWin });
  const release = /^release: (.+)$/m.exec(vv.stdout ?? '')?.[1]?.trim();
  const rustcHost = /^host: (.+)$/m.exec(vv.stdout ?? '')?.[1]?.trim();
  if (vv.status !== 0 || rustcHost !== host || (/^\d+\.\d+\.\d+$/.test(channel) && release !== channel)) {
    throw new Error(`rustc -vV in apps/desktop/src-tauri did not give ${channel} for ${host} (release ${release}, host ${rustcHost}): ${(vv.stderr || '').trim()}`);
  }
  console.log(`Rust toolchain: ${name} (rustc ${release}) is the default and what rust-toolchain.toml resolves to, offline (${Math.round((Date.now() - start) / 1000)} s; source: ${source})`);
  appendGithub('GITHUB_OUTPUT', [`toolchain=${name}`, `source=${source}`, `dist-server=${distServer}`]);
  if (saveKeyValue) appendGithub('GITHUB_ENV', [`SC_RUST_TOOLCHAIN_SAVE_KEY=${saveKeyValue}`]);
}

/**
 * `pin <channel>`: the SHA-256 of that channel's manifest into rust-toolchain.sha256, after a
 * channel change. The channel comes from the command line and must be rust-toolchain.toml's; the
 * URL is the fixed origin and the checked dist/ path.
 */
async function pinCommand(argv) {
  const [wanted] = argv;
  const { channel } = readToolchain(fs.readFileSync(TOOLCHAIN_FILE, 'utf8'));
  if (!wanted || !CHANNEL.test(wanted)) throw new Error('usage: rust-toolchain.mjs pin <channel> (the channel rust-toolchain.toml names)');
  if (wanted !== channel) throw new Error(`rust-toolchain.toml's channel is ${channel}, not ${wanted}: change it first`);
  const rel = distPath(`dist/channel-rust-${wanted}.toml`);
  const res = await fetch(distUrl(rel));
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const sha = sha256(Buffer.from(await res.arrayBuffer()));
  const sums = await fetch(`${distUrl(rel)}.sha256`);
  if (!sums.ok) throw new Error(`${rel}.sha256: HTTP ${sums.status}`);
  const published = (await sums.text()).trim().split(/\s+/)[0];
  if (published !== sha) throw new Error(`${rel} has SHA-256 ${sha}, but its .sha256 says ${published}: try again later`);
  fs.writeFileSync(PIN_FILE, `${sha}  channel-rust-${wanted}.toml\n`);
  console.log(`${path.relative(ROOT, PIN_FILE)}: ${sha}  channel-rust-${wanted}.toml`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'key') return keyCommand();
  if (cmd === 'install') return installCommand(rest);
  if (cmd === 'pin') return pinCommand(rest);
  console.error('usage: rust-toolchain.mjs key | install [--components a,b] [--targets t] | pin <channel>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const infra = err instanceof InfraError;
    console.log(`::error title=Rust toolchain${infra ? ' (infrastructure)' : ''}::${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
