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
  { what: 'package-lock.json (sc-pkg, apt-debs-playwright)', token: LOCK },
  { what: 'main commit (codeql-trap)', token: SHA },
];

let nextId = 1;
/** A cache entry; `created` and `used` are hours before NOW. */
function cache(key: string, { ref = 'refs/heads/main', created = 48, used = created, size = 1e6 } = {}) {
  const at = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();
  return { id: nextId++, key, ref, sizeInBytes: size, createdAt: at(created), lastAccessedAt: at(used) };
}

function run(caches: ReturnType<typeof cache>[], opts: { branches?: string[]; openPrs?: number[]; graceHours?: number } = {}) {
  const result = plan({ caches, branches: opts.branches ?? ['main'], openPrs: opts.openPrs ?? [], tokens: TOKENS, now: NOW, graceHours: opts.graceHours ?? 24 });
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
      'ms-playwright-Linux-X64-1.64.1': 'ms-playwright-Linux-X64-*',
      [`sc-downloads-macOS-ARM64-ffmpeg-true-${LOCK}`]: 'sc-downloads-macOS-ARM64-ffmpeg-true-*',
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
      { what: 'package-lock.json (sc-pkg, apt-debs-playwright)', token: hashFiles([Buffer.from('lock')]) },
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
