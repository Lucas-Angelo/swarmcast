// The selection logic of scripts/ci/cache-hygiene.mjs (.github/workflows/cache-hygiene.yml): which
// Actions caches it deletes, and above all which ones it never deletes. The keys are real ones from
// the repository's cache listing of 2026-11-01 (10.94 GB, over GitHub's 10 GB limit).
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { currentTokens, familyOf, hashFiles, plan } from '../cache-hygiene.mjs';

const NOW = new Date('2026-11-01T09:00:00Z');
const NPM = '64688b63838856f962300baf9ebba890d3806155d3ca272a78cefa2a9cbbb362';
const NPM_OLD = '474c91ea47aa68008acdf2123ec3dbc7423f2bc5858a8fc8294e423719ff5710';
const LOCK = '2236283c60392aa5b46cb93c39c8935aab366d9c38a0af3059070b294bf29d0f';
const LOCK_OLD = '9473d0b666ed258e3a5d5f23dd31dede3d0e8d4e3521b1488d586644905366ed';
const SHA = '6400aa2403182a423673b5dcaaef4355363cce09';
const TOKENS = [
  { what: 'npm cache (setup-node)', token: NPM },
  { what: 'package-lock.json (sc-tauri-tools, apt-debs-playwright)', token: LOCK },
  { what: 'main commit (codeql-trap)', token: SHA },
];

let nextId = 1;
/** A cache entry; `created` and `used` are hours before NOW. */
function cache(key: string, { ref = 'refs/heads/main', created = 48, used = created, size = 1e6 } = {}) {
  const at = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();
  return { id: nextId++, key, ref, sizeInBytes: size, createdAt: at(created), lastAccessedAt: at(used) };
}

function run(caches: ReturnType<typeof cache>[], opts: { branches?: string[]; openPrs?: number[]; graceHours?: number; staleHours?: number } = {}) {
  const result = plan({ caches, branches: opts.branches ?? ['main'], openPrs: opts.openPrs ?? [], tokens: TOKENS, now: NOW, graceHours: opts.graceHours ?? 24, staleHours: opts.staleHours ?? 96 });
  const reason = (c: ReturnType<typeof cache>) => [...result.keep, ...result.remove].find((x) => x.cache === c)?.reason;
  return { removed: result.remove.map((x) => x.cache), kept: result.keep.map((x) => x.cache), reason };
}

describe('familyOf', () => {
  it('takes the hashes and versions out of a key, and keeps what names the cache', () => {
    // Arrange
    const keys = {
      [`node-cache-Linux-x64-npm-${NPM}`]: 'node-cache-Linux-x64-npm-*',
      'v0-rust-checks-node-Linux-x64-a74c6f26-17576c0a': 'v0-rust-checks-node-Linux-x64-*-*',
      'v0-rust-macos-x64-build-Darwin-arm64-420b16e8-17576c0a': 'v0-rust-macos-x64-build-Darwin-arm64-*-*',
      [`codeql-trap-1-2.27.3-javascript-${SHA}`]: 'codeql-trap-1-*-javascript-*',
      'apt-debs-desktop-test-linux-arm64-ubuntu24-arm64-20261026.166.1-ARM64': 'apt-debs-desktop-test-linux-arm64-ubuntu24-arm64-*-ARM64',
      [`apt-debs-playwright-${LOCK}-ubuntu24-20261026.354.1-X64`]: 'apt-debs-playwright-*-ubuntu24-*-X64',
      [`apt-debs-v2-ubuntu24-X64-playwright-${LOCK}-20261111.364.1-1a2b3c4d5e6f7081`]: 'apt-debs-v2-ubuntu24-X64-playwright-*-*-*',
      'apt-debs-v2-ubuntu22-arm64-ARM64-tauri-build-20261101.179.1-0a1b2c3d4e5f6071': 'apt-debs-v2-ubuntu22-arm64-ARM64-tauri-build-*-*',
      'ms-playwright-Linux-X64-1.64.1': 'ms-playwright-Linux-X64-*',
      [`sc-downloads-macOS-ARM64-ffmpeg-true-${LOCK}`]: 'sc-downloads-macOS-ARM64-ffmpeg-true-*',
      [`sc-downloads-Windows-X64-ffmpeg-true-for-windows-x64-${LOCK}-42472780332-1a2b3c4d5e6f`]: 'sc-downloads-Windows-X64-ffmpeg-true-for-windows-x64-*-*-*',
      [`sc-downloads-Windows-X64-ffmpeg-true-app-ffmpeg-for-windows-x64-${LOCK}-42472780332-2b3c4d5e6f70`]: 'sc-downloads-Windows-X64-ffmpeg-true-app-ffmpeg-for-windows-x64-*-*-*',
      [`sc-downloads-Windows-X64-ffmpeg-true-obs-studio-for-windows-x64-${LOCK}-42472780332-3c4d5e6f7081`]: 'sc-downloads-Windows-X64-ffmpeg-true-obs-studio-for-windows-x64-*-*-*',
    };

    // Act
    const families = Object.keys(keys).map(familyOf);

    // Assert
    expect(families).toEqual(Object.values(keys));
  });
});

describe('hashFiles', () => {
  it("is GitHub's hashFiles(): SHA-256 of the files' SHA-256 digests, in order", () => {
    // Arrange
    const files = [Buffer.from('a'), Buffer.from('b')];
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest();

    // Act
    const hash = hashFiles(files);

    // Assert
    expect(hash).toBe(crypto.createHash('sha256').update(Buffer.concat(files.map(sha))).digest('hex'));
    expect(hashFiles([...files].reverse())).not.toBe(hash);
  });
});

describe('currentTokens', () => {
  it("hashes main's key inputs and adds main's commit, skipping an input whose file is missing", () => {
    // Arrange
    const files: Record<string, string> = { 'package-lock.json': 'lock', 'site/package-lock.json': 'site', '.github/actions/setup/action.yml': 'setup' };
    const read = (f: string) => (f in files ? Buffer.from(files[f]) : null);

    // Act
    const tokens = currentTokens(read, SHA);

    // Assert
    expect(tokens).toEqual([
      { what: 'npm cache (setup-node)', token: hashFiles([Buffer.from('lock'), Buffer.from('site'), Buffer.from('setup')]) },
      { what: 'package-lock.json (sc-tauri-tools, apt-debs-playwright)', token: hashFiles([Buffer.from('lock')]) },
      { what: 'main commit (codeql-trap)', token: SHA },
    ]);
  });
});

describe('plan: pull requests and branches', () => {
  it('deletes the caches of closed pull requests and gone branches, keeps open ones, existing branches and tags', () => {
    // Arrange
    const closed = cache(`node-cache-Linux-x64-npm-${NPM}`, { ref: 'refs/pull/53/merge' });
    const closedHead = cache(`node-cache-Linux-x64-npm-${NPM}`, { ref: 'refs/pull/53/head' });
    const open = cache(`node-cache-Linux-x64-npm-${NPM}`, { ref: 'refs/pull/69/merge' });
    const gone = cache('setup-go-Windows-x64-go-1.27.3-732f833b', { ref: 'refs/heads/fix/tunnel-dns-2' });
    const branch = cache('setup-go-Windows-x64-go-1.27.3-732f833b', { ref: 'refs/heads/soak/tunnel-start-1' });
    const tag = cache('node-cache-Linux-x64-npm-0123456789abcdef', { ref: 'refs/tags/v0.4.1' });

    // Act
    const r = run([closed, closedHead, open, gone, branch, tag], { branches: ['main', 'soak/tunnel-start-1'], openPrs: [69] });

    // Assert
    expect(r.removed).toEqual([closed, closedHead, gone]);
    expect(r.reason(closed)).toBe('pull request #53 is closed');
    expect(r.reason(gone)).toBe('branch fix/tunnel-dns-2 no longer exists');
    expect(r.kept).toEqual([open, branch, tag]);
  });

  it('refuses to judge branches from a list without main (a failed or truncated listing)', () => {
    // Arrange
    const caches = [cache('x-1', { ref: 'refs/heads/feature' })];

    // Act
    const act = () => plan({ caches, branches: [], openPrs: [], tokens: TOKENS, now: NOW });

    // Assert
    expect(act).toThrow(/no main/);
  });

  it('refuses a current-input token that is not a hash (it would match too much)', () => {
    // Act
    const act = () => plan({ caches: [], branches: ['main'], openPrs: [], tokens: [{ what: 'x', token: '' }], now: NOW });

    // Assert
    expect(act).toThrow(/not a hash/);
  });
});

describe('plan: superseded entries on main', () => {
  it("deletes old lockfile hashes and keeps the current one, even when an old entry is newer", () => {
    // Arrange: an old-hash entry saved after the current one (a re-run of an old commit).
    const current = cache(`node-cache-Windows-x64-npm-${NPM}`, { created: 40, used: 1 });
    const old = cache(`node-cache-Windows-x64-npm-${NPM_OLD}`, { created: 30, used: 30 });
    const older = cache(`node-cache-Windows-x64-npm-b15f0fab3f9441a75bc43767b63635ca8fea95fe685ec3aef2544e2e0f6288f7`, { created: 60, used: 60 });

    // Act
    const r = run([current, old, older], { graceHours: 0 });

    // Assert
    expect(r.removed).toEqual([older]);
    expect(r.reason(current)).toBe('current inputs: npm cache (setup-node)');
    expect(r.reason(old)).toBe('newest of its family');
  });

  it('never deletes an entry for the current inputs, however old and unused', () => {
    // Arrange
    const current = cache(`sc-pkg-Linux-X64-${LOCK}`, { created: 150, used: 150 });
    const newer = cache(`sc-pkg-Linux-X64-${LOCK_OLD}`, { created: 2, used: 1 });

    // Act
    const r = run([current, newer], { graceHours: 0 });

    // Assert
    expect(r.removed).toEqual([]);
  });

  it('keeps only the newest of the per-run entries for the current inputs, unless an older one is still used', () => {
    // Arrange: entries saved by runs that added files (.github/scripts/cache-files.mjs).
    const base = `sc-tauri-tools-Windows-X64-${LOCK}`;
    const first = cache(`${base}-42439987029-1a2b3c4d5e6f`, { created: 30, used: 29 });
    const stillUsed = cache(`${base}-42440000000-2b3c4d5e6f70`, { created: 20, used: 3 });
    const newest = cache(`${base}-42465017555-3c4d5e6f7081`, { created: 10, used: 1 });

    // Act
    const r = run([first, stillUsed, newest]);

    // Assert
    expect(familyOf(newest.key)).toBe('sc-tauri-tools-Windows-X64-*-*-*');
    expect(r.reason(newest)).toBe('current inputs: package-lock.json (sc-tauri-tools, apt-debs-playwright)');
    expect(r.reason(stillUsed)).toBe('still used (after the newest was saved, within 24 h)');
    expect(r.removed).toEqual([first]);
    expect(r.reason(first)).toBe(`superseded by ${newest.key}`);
  });

  it('rolls a Rust cache over: the entry for the old environment hash goes once the new one is saved', () => {
    // Arrange: the run that saved the new entry restored the old one (by prefix) just before.
    const stale = cache('v0-rust-macos-x64-build-Darwin-arm64-420b16e8-17576c0a', { created: 72, used: 0.6 });
    const fresh = cache('v0-rust-macos-x64-build-Darwin-arm64-48b30d6e-17576c0a', { created: 0.5, used: 0.5 });
    const other = cache('v0-rust-macos-arm64-build-Darwin-arm64-48b30d6e-17576c0a', { created: 50, used: 50 });

    // Act
    const r = run([stale, fresh, other]);

    // Assert
    expect(r.removed).toEqual([stale]);
    expect(r.reason(stale)).toBe('superseded by v0-rust-macos-x64-build-Darwin-arm64-48b30d6e-17576c0a');
    expect(r.reason(other)).toBe('newest of its family');
  });

  it("keeps only the newest CodeQL TRAP cache (CodeQL restores the newest by prefix)", () => {
    // Arrange
    const traps = [5, 4, 3, 2].map((h) => cache(`codeql-trap-1-2.27.3-javascript-${String(h).repeat(40)}`, { created: h }));

    // Act
    const r = run(traps);

    // Assert
    expect(r.kept).toEqual([traps[3]]);
    expect(r.removed).toEqual(traps.slice(0, 3));
  });

  it('keeps an older entry still used after the newest was saved (runner image rollout, older pull request base), within the grace period', () => {
    // Arrange: jobs land on both runner image versions; the old image's entry was saved last.
    const newImage = cache('apt-debs-desktop-test-linux-x64-ubuntu24-20261026.354.1-X64', { created: 60, used: 0.2 });
    const oldImage = cache('apt-debs-desktop-test-linux-x64-ubuntu24-20261018.96.1-X64', { created: 4, used: 4 });
    const stillUsed = cache(`sc-pkg-macOS-ARM64-${LOCK_OLD}`, { created: 50, used: 3 });
    const lastUsedLongAgo = cache(`sc-pkg-macOS-ARM64-cb1201846c29b1da35de650d008da67084a22f79338a7e42164ce515664160b0`, { created: 70, used: 30 });
    const currentPkg = cache(`sc-pkg-macOS-ARM64-${LOCK}`, { created: 10, used: 2 });

    // Act
    const r = run([newImage, oldImage, stillUsed, lastUsedLongAgo, currentPkg]);

    // Assert
    expect(r.reason(newImage)).toBe('most recently used of its family');
    expect(r.reason(oldImage)).toBe('newest of its family');
    expect(r.reason(stillUsed)).toBe('still used (after the newest was saved, within 24 h)');
    expect(r.removed).toEqual([lastUsedLongAgo]);
  });

  it('deletes an older entry used after the newest was saved once that use is older than the grace period', () => {
    // Arrange
    const newest = cache('apt-debs-tauri-build-ubuntu24-20261026.354.1-X64', { created: 100, used: 1 });
    const retired = cache('apt-debs-tauri-build-ubuntu24-20261018.96.1-X64', { created: 120, used: 30 });

    // Act
    const r = run([newest, retired], { graceHours: 24 });

    // Assert
    expect(r.removed).toEqual([retired]);
  });

  it('judges families separately: one entry per OS, architecture and job stays', () => {
    // Arrange
    const caches = ['Linux-x64', 'Windows_NT-x64', 'Darwin-arm64'].map((os) => cache(`v0-rust-checks-node-${os}-a74c6f26-17576c0a`, { created: 100, used: 100 }));

    // Act
    const r = run(caches, { graceHours: 0 });

    // Assert
    expect(r.removed).toEqual([]);
  });
});

describe('plan: families no job restores any more', () => {
  it("deletes a family whose key changed shape once main's other caches were used for 96 h without it", () => {
    // Arrange: the download cache before its keys had a run and a hash, and the pre-v2 .deb cache
    // whose sets took over; the listing of 2026-11-14.
    const oldShape = cache(`sc-downloads-Linux-X64-ffmpeg-false-for-linux-x64-${LOCK_OLD}`, { created: 200, used: 140 });
    const newShape = cache(`sc-downloads-Linux-X64-ffmpeg-false-for-linux-x64-${LOCK}-42487648849-bfaf36a0c91e`, { created: 100, used: 1 });
    const preV2 = cache(`apt-debs-playwright-${LOCK}-ubuntu24-20261101.360.1-X64`, { created: 300, used: 100 });
    const v2 = cache(`apt-debs-v2-ubuntu24-X64-playwright-${LOCK}-20261101.360.1-37d84ceb636022b1`, { created: 90, used: 1 });

    // Act
    const r = run([oldShape, newShape, preV2, v2]);

    // Assert
    expect(r.removed).toEqual([oldShape, preV2]);
    expect(r.reason(preV2)).toBe("no job restored its family for 96 h while main's other caches were used");
    expect(r.reason(v2)).toBe('current inputs: package-lock.json (sc-tauri-tools, apt-debs-playwright)');
  });

  it("keeps a family used within 96 h of main's last use, and deletes nothing after a quiet week", () => {
    // Arrange: no run on main for a week, then nothing new; a weekly job's family used 90 h before.
    const weekly = cache('ms-playwright-Linux-X64-1.64.1', { created: 400, used: 258 });
    const daily = cache(`node-cache-Linux-x64-npm-${NPM}`, { created: 400, used: 168 });

    // Act
    const r = run([weekly, daily]);

    // Assert
    expect(r.removed).toEqual([]);
  });

  it('keeps the Rust toolchain copies of a host that main restores, and rolls them over like any family', () => {
    // Arrange: a node job saved a fuller copy after a build job had saved the first.
    const first = cache('rust-toolchain-v1-x86_64-unknown-linux-gnu-1.99.1-43600000001-0a1b2c3d4e5f6071', { created: 50, used: 40 });
    const fuller = cache('rust-toolchain-v1-x86_64-unknown-linux-gnu-1.99.1-43600000002-1a2b3c4d5e6f7081', { created: 30, used: 1 });
    const arm = cache('rust-toolchain-v1-aarch64-unknown-linux-gnu-1.99.1-43600000001-2b3c4d5e6f708192', { created: 50, used: 2 });

    // Act
    const r = run([first, fuller, arm]);

    // Assert
    expect(familyOf(fuller.key)).toBe('rust-toolchain-v1-x86_64-unknown-linux-gnu-*-*-*');
    expect(r.removed).toEqual([first]);
    expect(r.reason(arm)).toBe('newest of its family');
  });
});
