// .github/scripts/rust-toolchain.mjs: the Rust toolchain the cargo jobs install with no download
// from static.rust-lang.org when the runner image or the saved copy has it (the macOS node job
// of campaign run 43573407339 lost DNS and failed in `rustup toolchain install`, before any
// test). What the pin and rust-toolchain.toml say, which components a job needs as rustup names
// them, the check of a saved mirror against the pinned manifest, which installed toolchain counts
// as the pinned one, and the cold path's downloads: tried again after a 5xx, a damaged body, a
// stall or a lookup failure (an `(infrastructure)` error in the end), never after a 404. A local
// HTTP server stands in for static.rust-lang.org.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InfraError,
  PAUSES_MS,
  archives,
  cachePrefix,
  checkMirror,
  downloadWithTries,
  hostTriple,
  linkToolchain,
  manifestName,
  parseManifest,
  readPin,
  readToolchain,
  saveKey,
  usableInstalled,
  wanted,
} from '../../../.github/scripts/rust-toolchain.mjs';

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const HOST = 'x86_64-unknown-linux-gnu';
const DATE = '2026-10-15';
const CHANNEL = '1.99.1';

/** The bytes of each archive in the test manifest, by package and target. */
const ARCHIVE = (pkg: string, target: string) => `${pkg} ${CHANNEL} for ${target}`;
const archiveRel = (pkg: string, target: string) => `dist/${DATE}/${pkg.replace(/-preview$/, '')}-${CHANNEL}-${target}.tar.xz`;

/** A channel manifest in static.rust-lang.org's format, with `pkgs` ([package, target]) available. */
function manifestText(pkgs: [string, string][], extra = '') {
  const tables = pkgs.map(
    ([pkg, target]) =>
      `[pkg.${pkg}.target.${target === '*' ? '"*"' : target}]\navailable = true\nurl = "https://static.rust-lang.org/${archiveRel(pkg, target).replace(/\.xz$/, '.gz')}"\nhash = "${sha256(`gz ${ARCHIVE(pkg, target)}`)}"\nxz_url = "https://static.rust-lang.org/${archiveRel(pkg, target)}"\nxz_hash = "${sha256(ARCHIVE(pkg, target))}"\ncomponents = []\nextensions = []\n`,
  );
  return [
    'manifest-version = "2"',
    `date = "${DATE}"`,
    '',
    '[pkg.rust.target.x86_64-unknown-linux-gnu]\navailable = true\n',
    '[[pkg.rust.target.x86_64-unknown-linux-gnu.components]]\npkg = "rustc"\ntarget = "x86_64-unknown-linux-gnu"\n',
    ...tables,
    '[pkg.rust-mingw.target.x86_64-pc-windows-gnu]\navailable = true\nxz_url = "https://static.rust-lang.org/dist/2026-10-15/rust-mingw-1.99.1-x86_64-pc-windows-gnu.tar.xz"\nxz_hash = "' + sha256('mingw') + '"\n',
    '[pkg.miri-preview.target.x86_64-unknown-linux-gnu]\navailable = false\n',
    '[renames.clippy]\nto = "clippy-preview"\n',
    '[renames.rustfmt]\nto = "rustfmt-preview"\n',
    '[renames.llvm-tools]\nto = "llvm-tools-preview"\n',
    '[profiles]\nminimal = ["rustc", "cargo", "rust-std", "rust-mingw"]\ndefault = ["rustc", "cargo", "rust-std", "rust-mingw", "rust-docs", "rustfmt-preview", "clippy-preview"]\n',
    extra,
  ].join('\n');
}

const PKGS: [string, string][] = [
  ['rustc', HOST],
  ['cargo', HOST],
  ['rust-std', HOST],
  ['rust-std', 'x86_64-apple-darwin'],
  ['rustfmt-preview', HOST],
  ['clippy-preview', HOST],
  ['llvm-tools-preview', HOST],
  ['rust-src', '*'],
];
const MANIFEST = manifestText(PKGS);
const PIN = sha256(MANIFEST);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-toolchain-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A mirror at dir/mirror with the manifest (unless null) and the archives of `pkgs`. */
function mirror(pkgs: [string, string][], manifest: string | null = MANIFEST) {
  const root = path.join(dir, 'mirror');
  fs.mkdirSync(path.join(root, 'dist', DATE), { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(root, 'dist', manifestName(CHANNEL)), manifest);
  for (const [pkg, target] of pkgs) fs.writeFileSync(path.join(root, archiveRel(pkg, target)), ARCHIVE(pkg, target));
  return root;
}

/** A rustup home with `toolchains` ([name, manifest hash rustup recorded, components]). */
function rustupHome(toolchains: [string, string, string[]][]) {
  const home = path.join(dir, 'rustup');
  fs.mkdirSync(path.join(home, 'update-hashes'), { recursive: true });
  for (const [name, hash, components] of toolchains) {
    fs.mkdirSync(path.join(home, 'toolchains', name, 'lib', 'rustlib'), { recursive: true });
    fs.writeFileSync(path.join(home, 'toolchains', name, 'lib', 'rustlib', 'components'), components.map((c) => `${c}\n`).join(''));
    fs.writeFileSync(path.join(home, 'update-hashes', name), hash);
  }
  return home;
}

const MINIMAL = [`rustc-${HOST}`, `cargo-${HOST}`, `rust-std-${HOST}`];
const TOML_COMPONENTS = [`rustfmt-preview-${HOST}`, `clippy-preview-${HOST}`];

describe('readToolchain and readPin', () => {
  it("reads rust-toolchain.toml's channel, profile and components, not the comments", () => {
    // Arrange
    const toml = '# The Rust the desktop app is built with; channel = "nightly" in a comment\n[toolchain]\nchannel = "1.99.1"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

    // Act
    const t = readToolchain(toml.replace(/\n/g, '\r\n'));

    // Assert
    expect(t).toEqual({ channel: '1.99.1', profile: 'minimal', components: ['rustfmt', 'clippy'], targets: [] });
  });

  it("returns the pin in static.rust-lang.org's .sha256 format", () => {
    // Act
    const pin = readPin(`${PIN}  channel-rust-1.99.1.toml\n`, CHANNEL);

    // Assert
    expect(pin).toBe(PIN);
  });

  it("refuses a pin of another channel's manifest: rust-toolchain.toml changed without it", () => {
    // Act
    const read = () => readPin(`${PIN}  channel-rust-1.99.1.toml\n`, '1.100.0');

    // Assert
    expect(read).toThrow(/pins channel-rust-1\.99\.1\.toml, but rust-toolchain\.toml's channel is 1\.100\.0: run node \.github\/scripts\/rust-toolchain\.mjs pin/);
  });

  it("the repository's pin is the one of rust-toolchain.toml's channel", () => {
    // Arrange
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const toml = fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/rust-toolchain.toml'), 'utf8');

    // Act
    const pin = readPin(fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/rust-toolchain.sha256'), 'utf8'), readToolchain(toml).channel);

    // Assert
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hostTriple and the keys', () => {
  it("names each runner's host as rustup does", () => {
    // Act
    const hosts = [hostTriple('linux', 'x64'), hostTriple('linux', 'arm64'), hostTriple('win32', 'x64'), hostTriple('darwin', 'arm64'), hostTriple('darwin', 'x64')];

    // Assert
    expect(hosts).toEqual(['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']);
  });

  it('keys the saved copy by host and channel, a new entry by its run and content', () => {
    // Arrange
    const prefix = cachePrefix(HOST, CHANNEL);
    const a = new Map([
      ['dist/x/rustc.tar.xz', 'aa'],
      ['dist/x/cargo.tar.xz', 'bb'],
    ]);
    const sameReordered = new Map([...a].reverse());
    const more = new Map([...a, ['dist/x/clippy.tar.xz', 'cc']]);

    // Act
    const keys = [saveKey(prefix, '42', a), saveKey(prefix, '42', sameReordered), saveKey(prefix, '42', more)];

    // Assert
    expect(prefix).toBe('rust-toolchain-v1-x86_64-unknown-linux-gnu-1.99.1-');
    expect(keys[0]).toMatch(/^rust-toolchain-v1-x86_64-unknown-linux-gnu-1\.99\.1-42-[0-9a-f]{16}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe('parseManifest, wanted and archives', () => {
  it('reads the date, each package per target, the renames and the profiles', () => {
    // Act
    const m = parseManifest(MANIFEST);

    // Assert
    expect(m.date).toBe(DATE);
    expect(m.pkgs.get(`clippy-preview|${HOST}`)).toMatchObject({ available: true, xz_hash: sha256(ARCHIVE('clippy-preview', HOST)) });
    expect(m.pkgs.get('rust-src|*')).toMatchObject({ available: true });
    expect(m.renames.get('llvm-tools')).toBe('llvm-tools-preview');
    expect(m.profiles.minimal).toEqual(['rustc', 'cargo', 'rust-std', 'rust-mingw']);
  });

  it('refuses a file that is not a channel manifest (an error page)', () => {
    // Act
    const parse = () => parseManifest('<html><body>503 Service Unavailable</body></html>');

    // Assert
    expect(parse).toThrow(/not a Rust channel manifest/);
  });

  it("names the profile's, the renamed and the extra target's components as rustup records them", () => {
    // Arrange
    const manifest = parseManifest(MANIFEST);

    // Act
    const list = wanted({ host: HOST, components: ['rustfmt', 'clippy', 'llvm-tools', 'rust-src'], targets: ['x86_64-apple-darwin'], manifest });

    // Assert
    expect(list.map((w) => w.name)).toEqual([...MINIMAL, ...TOML_COMPONENTS, `llvm-tools-preview-${HOST}`, 'rust-src', 'rust-std-x86_64-apple-darwin']);
  });

  it('gives the same names before the manifest is known (the image check)', () => {
    // Act
    const list = wanted({ host: HOST, components: ['rustfmt', 'clippy', 'llvm-tools'] });

    // Assert
    expect(list.map((w) => w.name)).toEqual([...MINIMAL, ...TOML_COMPONENTS, `llvm-tools-preview-${HOST}`]);
  });

  it('refuses a component the release does not have for the host', () => {
    // Arrange
    const manifest = parseManifest(MANIFEST);

    // Act
    const list = () => wanted({ host: HOST, components: ['miri'], manifest });

    // Assert
    expect(list).toThrow(/component miri is not available for x86_64-unknown-linux-gnu/);
  });

  it("takes each component's .tar.xz, with its path below the mirror and the manifest's SHA-256", () => {
    // Arrange
    const manifest = parseManifest(MANIFEST);

    // Act
    const files = archives(manifest, wanted({ host: HOST, components: ['clippy'], manifest }));

    // Assert
    expect(files.map((f) => f.rel)).toEqual([archiveRel('rustc', HOST), archiveRel('cargo', HOST), archiveRel('rust-std', HOST), archiveRel('clippy-preview', HOST)]);
    expect(files[3]).toMatchObject({ url: `https://static.rust-lang.org/${archiveRel('clippy-preview', HOST)}`, sha: sha256(ARCHIVE('clippy-preview', HOST)) });
  });
});

describe('checkMirror', () => {
  it('passes a saved copy whose manifest has the pinned SHA-256 and whose archives match it', () => {
    // Arrange
    const root = mirror(PKGS.slice(0, 3));

    // Act
    const check = checkMirror(root, CHANNEL, PIN);

    // Assert
    expect(check.manifest?.date).toBe(DATE);
    expect([...check.ok.keys()].sort()).toEqual(PKGS.slice(0, 3).map(([p, t]) => archiveRel(p, t)).sort());
    expect(check.removed).toEqual([]);
  });

  it('drops a manifest that is not the pinned one, and judges no archive by it', () => {
    // Arrange
    const root = mirror(PKGS.slice(0, 3), manifestText(PKGS, '# another build of the manifest\n'));

    // Act
    const check = checkMirror(root, CHANNEL, PIN);

    // Assert
    expect(check.manifest).toBeNull();
    expect(check.removed).toEqual([{ rel: `dist/${manifestName(CHANNEL)}`, why: expect.stringMatching(/not the pinned/) }]);
    expect(fs.existsSync(path.join(root, archiveRel('rustc', HOST)))).toBe(true);
  });

  it('deletes a damaged archive and a file that is not of this release, and keeps the rest', () => {
    // Arrange
    const root = mirror(PKGS.slice(0, 3));
    fs.writeFileSync(path.join(root, archiveRel('cargo', HOST)), 'cut off');
    fs.writeFileSync(path.join(root, 'dist', DATE, 'rustc-1.98.0-x86_64-unknown-linux-gnu.tar.xz'), 'old');

    // Act
    const check = checkMirror(root, CHANNEL, PIN);

    // Assert
    expect([...check.ok.keys()].sort()).toEqual([archiveRel('rust-std', HOST), archiveRel('rustc', HOST)].sort());
    expect(check.removed.map((r) => r.rel).sort()).toEqual([archiveRel('cargo', HOST), `dist/${DATE}/rustc-1.98.0-x86_64-unknown-linux-gnu.tar.xz`].sort());
    expect(fs.existsSync(path.join(root, archiveRel('cargo', HOST)))).toBe(false);
  });

  it('has nothing to judge by without a manifest (none saved yet)', () => {
    // Arrange
    const root = mirror([], null);

    // Act
    const check = checkMirror(root, CHANNEL, PIN);

    // Assert
    expect(check).toEqual({ manifest: null, ok: new Map(), removed: [] });
  });
});

describe('usableInstalled and linkToolchain', () => {
  const want = wanted({ host: HOST, components: ['rustfmt', 'clippy'] });

  it('uses <channel>-<host> as it is when rustup installed it from the pinned manifest with every component', () => {
    // Arrange
    const home = rustupHome([[`${CHANNEL}-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]]]);

    // Act
    const found = usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want });

    // Assert
    expect(found).toMatchObject({ use: 'exact', name: `${CHANNEL}-${HOST}` });
  });

  it("takes the runner image's stable when it was installed from the same manifest (stable's is that version's file)", () => {
    // Arrange
    const home = rustupHome([
      [`beta-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]],
      [`stable-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS, `rust-docs-${HOST}`]],
      ['stable-aarch64-unknown-linux-gnu', PIN.slice(0, 20), []],
    ]);

    // Act
    const found = usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want });

    // Assert
    expect(found).toMatchObject({ use: 'alias', name: `${CHANNEL}-${HOST}`, from: `stable-${HOST}` });
  });

  it('does not take a stable of another release, and says why', () => {
    // Arrange
    const home = rustupHome([[`stable-${HOST}`, sha256('channel-rust-1.100.0.toml').slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]]]);

    // Act
    const found = usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want });

    // Assert
    expect(found.use).toBeNull();
    expect(found.notes).toEqual([expect.stringMatching(/^stable-x86_64-unknown-linux-gnu: installed from another manifest/)]);
  });

  it('does not take the pinned release without a component the job needs (llvm-tools), and names it', () => {
    // Arrange
    const home = rustupHome([[`stable-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]]]);

    // Act
    const found = usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want: wanted({ host: HOST, components: ['rustfmt', 'clippy', 'llvm-tools'] }) });

    // Assert
    expect(found.use).toBeNull();
    expect(found.notes).toEqual([`stable-${HOST}: installed from the pinned manifest, without llvm-tools-preview-${HOST}`]);
  });

  it('links nothing over an installed <channel>-<host> from another manifest: rustup updates that one from the mirror', () => {
    // Arrange
    const home = rustupHome([
      [`${CHANNEL}-${HOST}`, sha256('a re-published manifest').slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]],
      [`stable-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]],
    ]);

    // Act
    const found = usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want });

    // Assert
    expect(found).toMatchObject({ use: null, name: `${CHANNEL}-${HOST}`, from: null });
  });

  it('links a toolchain under the pinned name with the manifest hash rustup recorded for it', () => {
    // Arrange
    const home = rustupHome([[`stable-${HOST}`, PIN.slice(0, 20), [...MINIMAL, ...TOML_COMPONENTS]]]);

    // Act
    linkToolchain(home, `stable-${HOST}`, `${CHANNEL}-${HOST}`);

    // Assert
    expect(fs.readFileSync(path.join(home, 'toolchains', `${CHANNEL}-${HOST}`, 'lib', 'rustlib', 'components'), 'utf8')).toContain(`clippy-preview-${HOST}`);
    expect(fs.readFileSync(path.join(home, 'update-hashes', `${CHANNEL}-${HOST}`), 'utf8')).toBe(PIN.slice(0, 20));
    expect(usableInstalled({ rustupHome: home, channel: CHANNEL, host: HOST, pin: PIN, want }).use).toBe('exact');
  });
});

describe('downloadWithTries (the cold path)', () => {
  type Answer = (res: http.ServerResponse) => void;
  const BODY = 'rustc archive bytes';
  const ok: Answer = (res) => res.end(BODY);
  const unavailable: Answer = (res) => res.writeHead(503).end('Service Unavailable');
  const damaged: Answer = (res) => res.end(BODY.slice(0, 5));
  const notFound: Answer = (res) => res.writeHead(404).end('Not Found');
  const stall: Answer = (res) => res.writeHead(200, { 'Content-Length': String(BODY.length) }).flushHeaders();

  /** A stand-in for static.rust-lang.org that gives `answers` in turn, then the file. */
  async function server(answers: Answer[]) {
    let requests = 0;
    const s = http.createServer((_req, res) => {
      requests++;
      (answers.shift() ?? ok)(res);
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/dist/${DATE}/rustc.tar.xz`;
    return { url, requests: () => requests, close: () =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    };
  }
  const opts = (url: string, logs: string[], pauses: number[]) => ({
    url,
    file: path.join(dir, 'out', 'rustc.tar.xz'),
    sha: sha256(BODY),
    sleep: async (ms: number) => void pauses.push(ms),
    log: (l: string) => void logs.push(l),
  });

  it('downloads the file and checks it, in one try', async () => {
    // Arrange
    const s = await server([]);
    const logs: string[] = [];

    // Act
    const result = await downloadWithTries(opts(s.url, logs, []));
    await s.close();

    // Assert
    expect(result.tries).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'out', 'rustc.tar.xz'), 'utf8')).toBe(BODY);
    expect(logs).toEqual([]);
  });

  it('tries again after a 503 and a damaged body, and logs the recovery', async () => {
    // Arrange
    const s = await server([unavailable, damaged]);
    const logs: string[] = [];
    const pauses: number[] = [];

    // Act
    const result = await downloadWithTries(opts(s.url, logs, pauses));
    await s.close();

    // Assert
    expect(result.tries).toBe(3);
    expect(pauses).toEqual(PAUSES_MS);
    expect(logs.at(-1)).toMatch(/infra recovery: .* downloaded on try 3 of 3 \(try 1: HTTP 503\)/);
    expect(fs.existsSync(path.join(dir, 'out', 'rustc.tar.xz.part'))).toBe(false);
  });

  it('cuts off a try that stops sending, and fails as infrastructure when every try did', async () => {
    // Arrange
    const s = await server([stall, stall]);
    const logs: string[] = [];

    // Act
    const result = downloadWithTries({ ...opts(s.url, logs, []), tries: 2, idleMs: 200 });

    // Assert
    await expect(result).rejects.toThrow(InfraError);
    await expect(result).rejects.toThrow(/2 tries failed, the last: no data for 200 ms/);
    await s.close();
    expect(fs.existsSync(path.join(dir, 'out', 'rustc.tar.xz'))).toBe(false);
  });

  it('fails as infrastructure with the lookup error when the runner has no DNS (the incident)', async () => {
    // Arrange
    const lookupFailed = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND static.rust-lang.org'), { code: 'ENOTFOUND' }) });
    };
    const pauses: number[] = [];

    // Act
    const result = downloadWithTries({ ...opts('https://static.rust-lang.org/dist/channel-rust-1.99.1.toml', [], pauses), fetchImpl: lookupFailed });

    // Assert
    await expect(result).rejects.toThrow(InfraError);
    await expect(result).rejects.toThrow(/3 tries failed, the last: fetch failed \(ENOTFOUND getaddrinfo ENOTFOUND static\.rust-lang\.org\)/);
    expect(pauses).toEqual(PAUSES_MS);
  });

  it('does not try a 404 again, and it is not an infrastructure failure', async () => {
    // Arrange
    const s = await server([notFound]);

    // Act
    const result = downloadWithTries(opts(s.url, [], []));

    // Assert
    await expect(result).rejects.toThrow(/static\.rust-lang\.org has no .* \(HTTP 404\)/);
    await expect(result).rejects.not.toThrow(InfraError);
    await s.close();
    expect(s.requests()).toBe(1);
  });

  it('starts no try that could not end before the cold path runs out of time', async () => {
    // Arrange
    const s = await server([unavailable]);
    const pauses: number[] = [];

    // Act
    const result = downloadWithTries({ ...opts(s.url, [], pauses), tryMs: 60_000, deadline: 60_000, now: () => 1000 });

    // Assert
    await expect(result).rejects.toThrow(InfraError);
    await expect(result).rejects.toThrow(/1 try failed, the last: HTTP 503/);
    await s.close();
    expect(pauses).toEqual([]);
  });

  it('starts no file once the cold path ran out of time, as infrastructure', async () => {
    // Arrange
    const s = await server([]);

    // Act
    const result = downloadWithTries({ ...opts(s.url, [], []), deadline: 1000, now: () => 1000 });

    // Assert
    await expect(result).rejects.toThrow(InfraError);
    await expect(result).rejects.toThrow(/the cold path had no time left for it/);
    await s.close();
    expect(s.requests()).toBe(0);
  });
});
