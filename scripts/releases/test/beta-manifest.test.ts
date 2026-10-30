// The beta update feed (beta-manifest.mjs): which release it follows, how strictly it checks that
// release's latest.json before every beta app reads it, and the CLI the site build runs, against a
// local stand-in for the GitHub API (pages of releases) and the release download URLs: a fresh one
// per test, on a port the OS picks on 127.0.0.1.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, onTestFinished } from 'vitest';
import { it } from '../../build/test/fixtures.js';
import { buildBetaManifest, isMinisignSignature, MAX_NOTES, PLATFORM_FILES, pickBetaRelease } from '../beta-manifest.mjs';

const REPO = 'Lucas-Angelo/swarmcast';
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'beta-manifest.mjs');
const TAG = 'v0.3.0-beta.2';
const AARCH64_PACKAGE = 'SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz';

type Manifest = { version: string; notes: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> };
type Release = ReturnType<typeof release>;

/** A signature shaped like Tauri's: base64 of a minisign signature file. */
function signature(seed: string): string {
  const sig = Buffer.alloc(74, seed).toString('base64');
  const global = Buffer.alloc(64, seed).toString('base64');
  const text = `untrusted comment: signature from tauri secret key\n${sig}\ntrusted comment: timestamp:1793313363\tfile:x\tversion:1\n${global}\n`;
  return Buffer.from(text).toString('base64');
}

/** A complete latest.json of release `tag`, as updater-manifest.mjs writes it. */
function manifest(tag: string, version = tag.replace(/^v/, '')): Manifest {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const platforms: Manifest['platforms'] = {};
  for (const [key, file] of Object.entries(PLATFORM_FILES)) platforms[key] = { signature: signature(key), url: `${base}/${file(version)}` };
  return { version, notes: `notes of ${tag}`, pub_date: '2026-11-01T12:00:00Z', platforms };
}

/** A release as the GitHub API lists it; with `manifest` (the default) it has a latest.json asset. */
function release(tag: string, o: { prerelease?: boolean; draft?: boolean; manifest?: boolean; base?: string } = {}) {
  const assets = [{ name: `SwarmCast_${tag.slice(1)}_x64-setup.exe`, browser_download_url: `${o.base ?? 'https://github.com/x'}/${tag}/setup.exe` }];
  if (o.manifest !== false) assets.push({ name: 'latest.json', browser_download_url: `${o.base ?? `https://github.com/${REPO}/releases/download`}/${tag}/latest.json` });
  return { tag_name: tag, prerelease: o.prerelease ?? tag.includes('-'), draft: o.draft ?? false, assets };
}

/** buildBetaManifest of `m` (an object is sent as JSON) for release `rel`. */
const build = (m: unknown, rel: Release = release(TAG)) => buildBetaManifest(typeof m === 'string' ? m : JSON.stringify(m), rel, REPO);

/** `manifest(TAG)` with darwin-aarch64's package at `url`. */
function withAarch64Url(url: string): Manifest {
  const m = manifest(TAG);
  m.platforms['darwin-aarch64']!.url = url;
  return m;
}

/**
 * A fake GitHub for one test: the releases API (paged like GitHub's) and the release downloads.
 * `publish` serves `tags` as releases, each with its latest.json as written (bytes kept); `files`
 * and `releases` can be changed afterwards. Every request path is kept in `requests`.
 */
async function fakeGithub() {
  const files = new Map<string, string>();
  const requests: string[] = [];
  const state = { releases: [] as Release[] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === `/repos/${REPO}/releases`) {
      const page = Number(url.searchParams.get('page'));
      const per = Number(url.searchParams.get('per_page'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.releases.slice((page - 1) * per, page * per)));
      return;
    }
    const file = files.get(url.pathname);
    if (file === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(file);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    api,
    files,
    requests,
    state,
    publish(tags: string[]): void {
      state.releases = tags.map((tag) => release(tag, { base: `${api}/dl` }));
      files.clear();
      for (const tag of tags) files.set(`/dl/${tag}/latest.json`, `${JSON.stringify(manifest(tag), null, 2)}\n`);
    },
    /** The CLI as the site build runs it, writing the feed to `out`. */
    cli: (out: string) => promisify(execFile)(process.execPath, [SCRIPT, '--repo', REPO, '--out', out, '--api', api], { env: { ...process.env, GITHUB_TOKEN: '' } }),
  };
}

describe('pickBetaRelease', () => {
  it.each([
    ['a beta newer than every stable release is the beta feed', ['v0.2.1', 'v0.3.0-beta.1', 'v0.2.2', 'v0.3.0-beta.2'], 'v0.3.0-beta.2'],
    ['a stable release newer than every beta replaces it (beta users get 0.3.0)', ['v0.3.0-beta.2', 'v0.3.0-rc.1', 'v0.3.0'], 'v0.3.0'],
    ['a hotfix on an older line, published after the beta and listed first, does not displace it', ['v0.2.3', 'v0.3.0-beta.2', 'v0.2.2'], 'v0.3.0-beta.2'],
    ['beta.11 sorts after beta.2', ['v0.3.0-beta.11', 'v0.3.0-beta.2'], 'v0.3.0-beta.11'],
    ['rc sorts after beta', ['v0.3.0-rc.1', 'v0.3.0-beta.11'], 'v0.3.0-rc.1'],
  ])('%s', (_case, tags, picked) => {
    // Arrange
    const releases = tags.map((tag) => release(tag));

    // Act
    const chosen = pickBetaRelease(releases);

    // Assert
    expect(chosen?.tag_name).toBe(picked);
  });

  it.each([
    ['without latest.json', release('v0.3.0-beta.1', { manifest: false })],
    ['that is a draft', release('v0.3.0-beta.1', { draft: true })],
    ['whose tag is not SemVer', release('nightly')],
  ])('ignores a release %s', (_case, ignored) => {
    // Act
    const chosen = pickBetaRelease([ignored, release('v0.2.1')]);

    // Assert
    expect(chosen?.tag_name).toBe('v0.2.1');
  });

  it.each([
    ['no release has a latest.json', [release('v0.1.0', { manifest: false })]],
    ['there is no release', []],
  ])('picks nothing when %s', (_case, releases) => {
    // Act
    const chosen = pickBetaRelease(releases);

    // Assert
    expect(chosen).toBeNull();
  });
});

describe('buildBetaManifest (what every beta app reads: strict)', () => {
  it('accepts the release’s own latest.json and rebuilds it from the checked fields only', () => {
    // Arrange
    const m = manifest(TAG);

    // Act
    const out = build(m);

    // Assert
    expect(out).toEqual(m);
    expect(Object.keys(out)).toEqual(['version', 'notes', 'pub_date', 'platforms']);
    expect(Object.keys(out.platforms)).toEqual(Object.keys(PLATFORM_FILES).sort());
  });

  it('accepts only the required platforms (an older release without the -deb entries)', () => {
    // Arrange
    const minimal = manifest(TAG);
    for (const k of ['windows-x86_64-nsis', 'linux-x86_64-deb', 'linux-aarch64-deb']) delete minimal.platforms[k];

    // Act
    const out = build(minimal);

    // Assert
    expect(Object.keys(out.platforms)).not.toContain('linux-x86_64-deb');
  });

  it('accepts a stable release’s latest.json', () => {
    // Act
    const out = build(manifest('v0.3.0'), release('v0.3.0'));

    // Assert
    expect(out.version).toBe('0.3.0');
  });

  it.each([
    ['another host', `https://evil.example/${AARCH64_PACKAGE}`],
    ['a lookalike host', `https://github.com.evil.example/${REPO}/releases/download/${TAG}/${AARCH64_PACKAGE}`],
    ['plain http', `http://github.com/${REPO}/releases/download/${TAG}/${AARCH64_PACKAGE}`],
    ['another repository', `https://github.com/someone/swarmcast/releases/download/${TAG}/${AARCH64_PACKAGE}`],
    ['another release', `https://github.com/${REPO}/releases/download/v0.3.0-beta.1/${AARCH64_PACKAGE}`],
    ['a query string', `https://github.com/${REPO}/releases/download/${TAG}/${AARCH64_PACKAGE}?x=1`],
  ])('refuses a package on %s', (_case, url) => {
    // Arrange
    const m = withAarch64Url(url);

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/darwin-aarch64's file of release v0.3.0-beta.2/);
  });

  it.each(['../../../evil/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz', '..%2F..%2Fevil.tar.gz', 'SwarmCast_0.3.0-beta.1_aarch64.app.tar.gz', 'SwarmCast_0.3.0-beta.2_x64.app.tar.gz', 'evil.exe'])(
    'refuses the file name %s (path traversal or another file)',
    (file) => {
      // Arrange
      const m = withAarch64Url(`https://github.com/${REPO}/releases/download/${TAG}/${file}`);

      // Act
      const rebuild = () => build(m);

      // Assert
      expect(rebuild).toThrow(/refused/);
    },
  );

  it('refuses an extra field at the top', () => {
    // Act
    const rebuild = () => build({ ...manifest(TAG), extra: 1 });

    // Assert
    expect(rebuild).toThrow(/refused/);
  });

  it('refuses an extra field in a platform', () => {
    // Arrange
    const m = manifest(TAG);
    (m.platforms['linux-x86_64'] as Record<string, string>).with_elevated_task = 'true';

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/refused/);
  });

  it('refuses an unknown platform key', () => {
    // Arrange
    const m = manifest(TAG);
    m.platforms['windows-aarch64'] = m.platforms['windows-x86_64']!;

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/refused/);
  });

  it('refuses a platform without a signature', () => {
    // Arrange
    const m = manifest(TAG) as unknown as { platforms: Record<string, Record<string, string>> };
    delete m.platforms['linux-aarch64']!.signature;

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/refused/);
  });

  it.each([
    ['empty', ''],
    ['not base64', 'not base64!'],
    ['too short a file', Buffer.from('untrusted comment: x\nshort\n').toString('base64')],
    ['far too long', 'A'.repeat(5000)],
  ])('refuses a signature that is %s', (_case, sig) => {
    // Arrange
    const m = manifest(TAG);
    m.platforms['linux-aarch64']!.signature = sig;

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/minisign/);
  });

  it('refuses a manifest without a required platform', () => {
    // Arrange
    const m = manifest(TAG);
    delete m.platforms['linux-aarch64'];

    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(/missing one of/);
  });

  it('takes a Tauri-shaped signature as minisign', () => {
    // Act
    const ok = isMinisignSignature(signature('x'));

    // Assert
    expect(ok).toBe(true);
  });

  it.each([
    ['another version than its release', manifest(TAG, '0.3.0-beta.1'), release(TAG), /release's version/],
    ['a stable version in a release marked pre-release', manifest('v0.3.0'), release('v0.3.0', { prerelease: true }), /marked pre-release, but its version is stable/],
    ['a pre-release version in a release not marked pre-release', manifest(TAG), release(TAG, { prerelease: false }), /not marked pre-release, but its version is a pre-release/],
    ['another pre-release identifier', manifest('v0.3.0-alpha.1'), release('v0.3.0-alpha.1'), /not a release tag/],
    ['a release tag without the v', manifest('0.3.0'), release('0.3.0', { prerelease: false }), /not a release tag/],
  ])('refuses a manifest with %s', (_case, m, rel, error) => {
    // Act
    const rebuild = () => build(m, rel);

    // Assert
    expect(rebuild).toThrow(error);
  });

  it('accepts notes of exactly MAX_NOTES characters', () => {
    // Act
    const out = build({ ...manifest(TAG), notes: 'x'.repeat(MAX_NOTES) });

    // Assert
    expect(out.notes).toHaveLength(MAX_NOTES);
  });

  it.each([
    ['notes over MAX_NOTES', { ...manifest(TAG), notes: 'x'.repeat(MAX_NOTES + 1) }, /refused/],
    ['notes that are not text', { ...manifest(TAG), notes: 7 }, /refused/],
    ['a bad date', { ...manifest(TAG), pub_date: 'yesterday' }, /refused/],
    ['a non-object', [], /refused/],
    ['text that is not JSON', 'not json', /not JSON/],
  ])('refuses %s', (_case, m, error) => {
    // Act
    const rebuild = () => build(m);

    // Assert
    expect(rebuild).toThrow(error);
  });
});

describe('beta-manifest.mjs (CLI, fake GitHub API)', () => {
  it('publishes the highest release’s checked latest.json, across API pages, downloading only that manifest', async ({ tmp }) => {
    // Arrange
    const github = await fakeGithub();
    const old = Array.from({ length: 120 }, (_, i) => `v0.1.${i}`);
    github.publish([...old, 'v0.3.0-beta.2', 'v0.2.3', 'v0.3.0-beta.1']);
    const out = path.join(tmp, 'site', 'public', 'updates', 'beta.json');

    // Act
    const { stdout } = await github.cli(out);

    // Assert
    expect(stdout).toContain('v0.3.0-beta.2 (pre-release)');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(manifest('v0.3.0-beta.2'));
    expect(github.requests.filter((r) => r.startsWith(`/repos/${REPO}/releases`))).toEqual([`/repos/${REPO}/releases?per_page=100&page=1`, `/repos/${REPO}/releases?per_page=100&page=2`]);
    expect(github.requests.filter((r) => r.endsWith('latest.json'))).toEqual(['/dl/v0.3.0-beta.2/latest.json']);
  });

  it('follows the stable release once it is the highest', async ({ tmp }) => {
    // Arrange
    const github = await fakeGithub();
    github.publish(['v0.3.0-beta.2', 'v0.3.0']);
    const out = path.join(tmp, 'beta.json');

    // Act
    await github.cli(out);

    // Assert
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).version).toBe('0.3.0');
  });

  it('removes the feed when no release qualifies', async ({ tmp }) => {
    // Arrange
    const github = await fakeGithub();
    github.state.releases = [release('v0.1.0', { manifest: false })];
    const out = path.join(tmp, 'beta.json');
    fs.writeFileSync(out, JSON.stringify(manifest('v0.3.0')));

    // Act
    const { stdout } = await github.cli(out);

    // Assert
    expect(stdout).toContain('no beta feed');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('fails, and keeps the previous feed, when the chosen manifest is wrong', async ({ tmp }) => {
    // Arrange
    const github = await fakeGithub();
    github.publish(['v0.3.0-beta.1']);
    github.files.set('/dl/v0.3.0-beta.1/latest.json', JSON.stringify(manifest('v0.3.0-beta.1', '0.2.0')));
    const out = path.join(tmp, 'kept.json');
    fs.writeFileSync(out, 'previous');

    // Act
    const run = github.cli(out);

    // Assert
    await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining("not the release's version 0.3.0-beta.1") });
    expect(fs.readFileSync(out, 'utf8')).toBe('previous');
  });
});
