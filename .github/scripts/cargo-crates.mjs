#!/usr/bin/env node
// The Rust crates of apps/desktop/src-tauri/Cargo.lock for the jobs that run cargo, from an
// artifact an earlier run saved, so that no gating job asks crates.io for them
// (.github/actions/cargo-crates; .github/workflows/README.md, "Rust crates").
//
//   node .github/scripts/cargo-crates.mjs name          the artifact name: this Cargo.lock and toolchain
//   node .github/scripts/cargo-crates.mjs find <name>   run-id= and artifact-id= of the newest one this
//                                                       run may trust (test-images.mjs's rules), or nothing
//   node .github/scripts/cargo-crates.mjs fetch         `cargo fetch --locked` from crates.io, with tries (the cold path)
//   node .github/scripts/cargo-crates.mjs check         every crate of Cargo.lock in the registry cache, with
//                                                       its checksum, then an offline `cargo metadata`
//   node .github/scripts/cargo-crates.mjs pack <tar>    those crates and the index cache, as a tar of
//                                                       $CARGO_HOME/registry (the job that saves them)
//
// What the artifact holds is what `cargo fetch --locked` leaves in $CARGO_HOME/registry: the .crate
// files of every target platform (cache/) and the sparse index entries cargo resolves the lockfile
// with (index/), about 120 MB. A job extracts it into its own $CARGO_HOME/registry and then runs
// cargo with CARGO_NET_OFFLINE=true, so cargo neither downloads a crate nor revalidates the index
// (a cargo that is online asks index.crates.io on every run, even with every crate cached).
// `check` compares each .crate with the SHA-256 that Cargo.lock records, as cargo does when it
// downloads one (it does not check a .crate it finds in its cache), so a crate from the artifact
// is the crate crates.io served. The registry's folder name (index.crates.io-1949cf8c6b5b557f) is
// the same on every OS since cargo 1.85; the offline `cargo metadata` of `check` catches a
// difference, and the job then fetches from crates.io.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommand } from './test-images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRATE_DIR = path.join(ROOT, 'apps/desktop/src-tauri');
const MANIFEST = path.join(CRATE_DIR, 'Cargo.toml');
const LOCKFILE = path.join(CRATE_DIR, 'Cargo.lock');
const TOOLCHAIN_FILE = path.join(CRATE_DIR, 'rust-toolchain.toml');
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const isWin = process.platform === 'win32';

/** Tries of the cold path's `cargo fetch`. */
export const FETCH_TRIES = 3;
/**
 * One try is cut off after this: a whole cold fetch (index and 504 crates, 78 MB) took 12 s from a
 * laptop, and cargo's own limit is 30 s without data per request. With the pauses, at most 3.7
 * minutes in all.
 */
export const FETCH_TRY_MS = 60_000;
/** Pause before try 2, then before try 3. */
export const FETCH_PAUSES_MS = [10_000, 30_000];

/**
 * The packages of a Cargo.lock that come from crates.io: { name, version, checksum }. Throws on a
 * package from any other source (a git dependency, another registry): the artifact would not
 * hold it, and an offline cargo could not build.
 * @param {string} lock
 * @returns {{ name: string, version: string, checksum: string }[]}
 */
export function lockedCrates(lock) {
  const crates = [];
  const others = [];
  for (const block of lock.replace(/\r\n/g, '\n').split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1];
    const name = field('name');
    const version = field('version');
    const source = field('source');
    if (!name || !version) throw new Error(`Cargo.lock: a [[package]] without a name or version:\n${block.trim()}`);
    if (source === undefined) continue; // the workspace's own crate
    if (source !== CRATES_IO) {
      others.push(`${name} ${version} (${source})`);
      continue;
    }
    const checksum = field('checksum');
    if (!checksum || !/^[0-9a-f]{64}$/.test(checksum)) throw new Error(`Cargo.lock: ${name} ${version} has no checksum`);
    crates.push({ name, version, checksum });
  }
  if (others.length) throw new Error(`Cargo.lock has packages from outside crates.io, which the saved crates do not hold: ${others.join(', ')}`);
  return crates;
}

/** The toolchain channel of rust-toolchain.toml. */
export function toolchainChannel(toml) {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!channel) throw new Error('rust-toolchain.toml: no channel');
  return channel;
}

/**
 * The artifact's name: the toolchain (its cargo writes the index cache) and a hash of Cargo.lock
 * (line ends ignored), so any trusted artifact of that name holds exactly these crates.
 * @param {string} lock
 * @param {string} channel
 */
export function artifactName(lock, channel) {
  const hash = crypto.createHash('sha256').update(lock.replace(/\r\n/g, '\n')).digest('hex');
  return `cargo-crates-${channel}-${hash.slice(0, 16)}`;
}

/** $CARGO_HOME/registry, as cargo finds it. */
export function registryDir(env = process.env) {
  return path.join(env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'registry');
}

/**
 * Which of `crates` the registry at `registry` holds with the checksum Cargo.lock records:
 * { dir, ok, missing, wrong }, `dir` being the crates.io folder of registry/cache that holds the
 * most of them (null when there is none).
 * @param {{ name: string, version: string, checksum: string }[]} crates
 * @param {string} registry
 */
export function checkCrates(crates, registry) {
  const cache = path.join(registry, 'cache');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('index.crates.io-')) : [];
  let best = { dir: /** @type {string | null} */ (null), ok: 0, missing: crates.map((c) => `${c.name} ${c.version}`), wrong: /** @type {string[]} */ ([]) };
  for (const dir of dirs) {
    const result = { dir, ok: 0, missing: /** @type {string[]} */ ([]), wrong: /** @type {string[]} */ ([]) };
    for (const c of crates) {
      const file = path.join(cache, dir, `${c.name}-${c.version}.crate`);
      if (!fs.existsSync(file)) {
        result.missing.push(`${c.name} ${c.version}`);
        continue;
      }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (sha === c.checksum) result.ok++;
      else result.wrong.push(`${c.name} ${c.version}`);
    }
    if (result.ok > best.ok || best.dir === null) best = result;
  }
  return best;
}

/** Lines of cargo's output that show a network failure, a retry's reason (see isNetworkError). */
const NETWORK = [
  /failed to download from/,
  /failed to get successful HTTP response/,
  /spurious network error/,
  /download of \S+ failed/,
  /failed to verify the checksum of/,
  /Could(?:n't| not) resolve host/,
  /Timeout was reached|Operation timed out/,
  /Connection (?:reset|refused|timed out)|Failed to connect/,
  /SSL connect error|TLS handshake|SSL_ERROR/,
  /HTTP\/2 stream|HTTP2 framing layer|transfer closed|Recv failure|Send failure|partial file/,
];

/**
 * The first line of a failed `cargo fetch`'s output that shows a network failure, or null.
 * crates.io's CDN answered a crate's download with `206` and a partial body (release rehearsal
 * 42799834042), which cargo does not count as spurious and so does not try again; a cut-off or
 * corrupt download ("failed to verify the checksum") is the network too, and the next try
 * downloads that crate again. A lockfile that needs an update, a manifest error and the like are
 * not: they fail at once.
 * @param {string} output
 * @returns {string | null}
 */
export function networkError(output) {
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, '').trim();
    if (NETWORK.some((re) => re.test(line))) return line;
  }
  return null;
}

/**
 * `cargo fetch --locked` with tries: one more after a try that failed on the network or ran past
 * `tryMs` (each try keeps what the earlier ones downloaded), at most `tries`; any other failure
 * fails at once. `run(tryMs)` runs one try and resolves { code, output, timedOut }. Returns
 * { tries } or throws with the reason. A fetch that worked only after failed tries logs an
 * `infra recovery:` warning (docs/TESTING.md, "Infra recoveries").
 */
export async function fetchWithTries({ run, tries = FETCH_TRIES, tryMs = FETCH_TRY_MS, pauses = FETCH_PAUSES_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  let first = '';
  for (let n = 1; n <= tries; n++) {
    const r = await run(tryMs);
    if (r.code === 0 && !r.timedOut) {
      if (n > 1) log(`::warning title=cargo-crates::infra recovery: cargo fetch from crates.io worked on try ${n} of ${tries} (try 1: ${first})`);
      return { tries: n };
    }
    const why = r.timedOut ? `cut off after ${Math.round(tryMs / 1000)} s` : networkError(r.output);
    if (!why) throw new Error(`cargo fetch failed (exit ${r.code}), not on the network: not tried again`);
    first ||= why;
    if (n === tries) throw new Error(`cargo fetch failed ${tries} times on the network; last: ${why}`);
    const pause = pauses[Math.min(n - 1, pauses.length - 1)] ?? 0;
    log(`::warning title=cargo-crates::cargo fetch try ${n} of ${tries} failed (${why}); trying again in ${Math.round(pause / 1000)} s`);
    await sleep(pause);
  }
  throw new Error('unreachable');
}

function killTree(child) {
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** The environment of the cargo this script runs: the pinned toolchain, online unless `offline`. */
function cargoEnv(offline) {
  const env = { ...process.env, RUSTUP_TOOLCHAIN: toolchainChannel(fs.readFileSync(TOOLCHAIN_FILE, 'utf8')) };
  if (offline) env.CARGO_NET_OFFLINE = 'true';
  else delete env.CARGO_NET_OFFLINE;
  return env;
}

/** One `cargo fetch --locked`, its output shown as it comes and kept. */
function cargoFetch(tryMs) {
  return new Promise((resolve) => {
    // Its own process group, so a cut-off try also stops the cargo behind rustup's proxy.
    const child = spawn('cargo', ['fetch', '--locked', '--manifest-path', MANIFEST], { env: cargoEnv(false), stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin, shell: isWin });
    let output = '';
    const onData = (d) => {
      output += d;
      process.stdout.write(d);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, tryMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
}

/** The host's target triple, from rustc. */
function hostTriple() {
  const out = spawnSync('rustc', ['-vV'], { env: cargoEnv(true), encoding: 'utf8', shell: isWin });
  const host = /^host: (.+)$/m.exec(out.stdout ?? '')?.[1]?.trim();
  if (!host) throw new Error(`rustc -vV: no host (${(out.stderr ?? '').trim()})`);
  return host;
}

function check() {
  const crates = lockedCrates(fs.readFileSync(LOCKFILE, 'utf8'));
  const registry = registryDir();
  const { dir, ok, missing, wrong } = checkCrates(crates, registry);
  const list = (names) => names.slice(0, 10).join(', ') + (names.length > 10 ? `, and ${names.length - 10} more` : '');
  if (missing.length || wrong.length) {
    const problems = [missing.length ? `${missing.length} missing (${list(missing)})` : '', wrong.length ? `${wrong.length} with another checksum than Cargo.lock's (${list(wrong)})` : ''].filter(Boolean);
    console.log(`::warning title=cargo-crates::the crates in ${registry} do not match Cargo.lock: ${problems.join('; ')}`);
    return false;
  }
  // The index cache and the folder name: cargo itself, offline, resolves the lockfile and unpacks
  // this host's crates (which the build would do next anyway).
  const triple = hostTriple();
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', MANIFEST, '--filter-platform', triple], {
    env: cargoEnv(true),
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    shell: isWin,
  });
  if (meta.status !== 0) {
    console.log(`::warning title=cargo-crates::cargo metadata --offline failed with the crates in ${registry}: ${(meta.stderr ?? '').trim().split('\n').slice(-3).join(' / ')}`);
    return false;
  }
  console.log(`cargo-crates: all ${ok} crates of Cargo.lock in ${path.join(registry, 'cache', dir ?? '')} with Cargo.lock's checksums; cargo resolves them offline for ${triple}`);
  return true;
}

function pack(out) {
  const crates = lockedCrates(fs.readFileSync(LOCKFILE, 'utf8'));
  const registry = registryDir();
  const { dir, missing, wrong } = checkCrates(crates, registry);
  if (!dir || missing.length || wrong.length) throw new Error(`pack: the registry at ${registry} does not hold every crate of Cargo.lock (run check first)`);
  const files = [`index/${dir}`, ...crates.map((c) => `cache/${dir}/${c.name}-${c.version}.crate`)];
  const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-crates-')), 'files.txt');
  fs.writeFileSync(listFile, `${files.join('\n')}\n`);
  const tar = spawnSync('tar', ['-cf', out, '-C', registry, '-T', listFile], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`pack: tar exited with ${tar.status}`);
  console.log(`cargo-crates: ${crates.length} crates and the index cache of ${dir}: ${Math.round(fs.statSync(out).size / 1e6)} MB in ${out}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'name':
      console.log(artifactName(fs.readFileSync(LOCKFILE, 'utf8'), toolchainChannel(fs.readFileSync(TOOLCHAIN_FILE, 'utf8'))));
      return;
    case 'find':
      if (!arg) break;
      await findCommand(arg, 'cargo-crates');
      return;
    case 'fetch': {
      const start = Date.now();
      const { tries } = await fetchWithTries({ run: cargoFetch });
      console.log(`cargo-crates: cargo fetch from crates.io in ${Math.round((Date.now() - start) / 1000)} s (${tries} ${tries === 1 ? 'try' : 'tries'})`);
      return;
    }
    case 'check':
      if (!check()) process.exit(1);
      return;
    case 'pack':
      if (!arg) break;
      pack(path.resolve(arg));
      return;
  }
  console.error('usage: cargo-crates.mjs name | find <name> | fetch | check | pack <tar>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=cargo-crates::${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
