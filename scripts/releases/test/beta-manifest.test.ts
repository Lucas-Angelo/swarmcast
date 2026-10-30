import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBetaManifest, isMinisignSignature, MAX_NOTES, PLATFORM_FILES, pickBetaRelease } from '../beta-manifest.mjs';

const REPO = 'Lucas-Angelo/swarmcast';
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'beta-manifest.mjs');

/** A signature shaped like Tauri's: base64 of a minisign signature file. */
function signature(seed: string): string {
  const sig = Buffer.alloc(74, seed).toString('base64');
  const global = Buffer.alloc(64, seed).toString('base64');
  const text = `untrusted comment: signature from tauri secret key\n${sig}\ntrusted comment: timestamp:1793313363\tfile:x\tversion:1\n${global}\n`;
  return Buffer.from(text).toString('base64');
}

/** A complete latest.json of release `tag`, as updater-manifest.mjs writes it. */
function manifest(tag: string, version = tag.replace(/^v/, '')): { version: string; notes: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> } {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const [key, file] of Object.entries(PLATFORM_FILES)) platforms[key] = { signature: signature(key), url: `${base}/${file(version)}` };
  return { version, notes: `notes of ${tag}`, pub_date: '2026-11-01T12:00:00Z', platforms };
}

function release(tag: string, o: { prerelease?: boolean; draft?: boolean; manifest?: boolean; base?: string } = {}) {
  const assets = [{ name: `SwarmCast_${tag.slice(1)}_x64-setup.exe`, browser_download_url: `${o.base ?? 'https://github.com/x'}/${tag}/setup.exe` }];
  if (o.manifest !== false) assets.push({ name: 'latest.json', browser_download_url: `${o.base ?? `https://github.com/${REPO}/releases/download`}/${tag}/latest.json` });
  return { tag_name: tag, prerelease: o.prerelease ?? tag.includes('-'), draft: o.draft ?? false, assets };
}

describe('pickBetaRelease', () => {
  it('a beta newer than every stable release is the beta feed', () => {
    expect(pickBetaRelease([release('v0.2.1'), release('v0.3.0-beta.1'), release('v0.2.2'), release('v0.3.0-beta.2')])?.tag_name).toBe('v0.3.0-beta.2');
  });

  it('a stable release newer than every beta replaces it (beta users get 0.3.0)', () => {
    expect(pickBetaRelease([release('v0.3.0-beta.2'), release('v0.3.0-rc.1'), release('v0.3.0')])?.tag_name).toBe('v0.3.0');
  });

  it('a hotfix on an older line does not displace the beta', () => {
    // Published after the beta, listed first by the API.
    expect(pickBetaRelease([release('v0.2.3'), release('v0.3.0-beta.2'), release('v0.2.2')])?.tag_name).toBe('v0.3.0-beta.2');
  });

  it('ignores releases without latest.json, drafts and non-SemVer tags', () => {
    expect(pickBetaRelease([release('v0.3.0-beta.1', { manifest: false }), release('v0.2.1')])?.tag_name).toBe('v0.2.1');
    expect(pickBetaRelease([release('v0.3.0-beta.1', { draft: true }), release('v0.2.1')])?.tag_name).toBe('v0.2.1');
    expect(pickBetaRelease([release('nightly'), release('v0.2.1')])?.tag_name).toBe('v0.2.1');
    expect(pickBetaRelease([release('v0.1.0', { manifest: false })])).toBeNull();
    expect(pickBetaRelease([])).toBeNull();
  });

  it('sorts beta.11 after beta.2 and rc after beta', () => {
    expect(pickBetaRelease([release('v0.3.0-beta.11'), release('v0.3.0-beta.2')])?.tag_name).toBe('v0.3.0-beta.11');
    expect(pickBetaRelease([release('v0.3.0-rc.1'), release('v0.3.0-beta.11')])?.tag_name).toBe('v0.3.0-rc.1');
  });
});

describe('buildBetaManifest (what every beta app reads: strict)', () => {
  const tag = 'v0.3.0-beta.2';
  const r = release(tag);
  const build = (m: unknown, rel = r) => buildBetaManifest(typeof m === 'string' ? m : JSON.stringify(m), rel, REPO);

  it('accepts the release’s own latest.json and rebuilds it from the checked fields only', () => {
    const m = manifest(tag);
    const out = build(m);
    expect(out).toEqual(m);
    expect(Object.keys(out)).toEqual(['version', 'notes', 'pub_date', 'platforms']);
    expect(Object.keys(out.platforms)).toEqual(Object.keys(PLATFORM_FILES).sort());
    // Only the required platforms is enough (an older release without the -deb entries).
    const minimal = manifest(tag);
    for (const k of ['windows-x86_64-nsis', 'linux-x86_64-deb', 'linux-aarch64-deb']) delete minimal.platforms[k];
    expect(Object.keys(build(minimal).platforms)).not.toContain('linux-x86_64-deb');
    expect(build(manifest('v0.3.0'), release('v0.3.0')).version).toBe('0.3.0');
  });

  it('refuses a package on another host, in another repository or another release', () => {
    for (const url of [
      'https://evil.example/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz',
      `https://github.com.evil.example/${REPO}/releases/download/${tag}/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz`,
      `http://github.com/${REPO}/releases/download/${tag}/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz`,
      `https://github.com/someone/swarmcast/releases/download/${tag}/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz`,
      `https://github.com/${REPO}/releases/download/v0.3.0-beta.1/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz`,
      `https://github.com/${REPO}/releases/download/${tag}/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz?x=1`,
    ]) {
      const m = manifest(tag);
      m.platforms['darwin-aarch64']!.url = url;
      expect(() => build(m), url).toThrow(/darwin-aarch64's file of release v0.3.0-beta.2/);
    }
  });

  it('refuses a path traversal or another file name', () => {
    for (const file of ['../../../evil/SwarmCast_0.3.0-beta.2_aarch64.app.tar.gz', '..%2F..%2Fevil.tar.gz', 'SwarmCast_0.3.0-beta.1_aarch64.app.tar.gz', 'SwarmCast_0.3.0-beta.2_x64.app.tar.gz', 'evil.exe']) {
      const m = manifest(tag);
      m.platforms['darwin-aarch64']!.url = `https://github.com/${REPO}/releases/download/${tag}/${file}`;
      expect(() => build(m), file).toThrow(/refused/);
    }
  });

  it('refuses extra fields, at the top and in a platform, and unknown platform keys', () => {
    expect(() => build({ ...manifest(tag), extra: 1 })).toThrow(/refused/);
    const m = manifest(tag);
    (m.platforms['linux-x86_64'] as Record<string, string>).with_elevated_task = 'true';
    expect(() => build(m)).toThrow(/refused/);
    const k = manifest(tag);
    k.platforms['windows-aarch64'] = k.platforms['windows-x86_64']!;
    expect(() => build(k)).toThrow(/refused/);
  });

  it('refuses a missing or malformed signature and a missing required platform', () => {
    const missing = manifest(tag) as unknown as { platforms: Record<string, Record<string, string>> };
    delete missing.platforms['linux-aarch64']!.signature;
    expect(() => build(missing)).toThrow(/refused/);
    for (const sig of ['', 'not base64!', Buffer.from('untrusted comment: x\nshort\n').toString('base64'), 'A'.repeat(5000)]) {
      const m = manifest(tag);
      m.platforms['linux-aarch64']!.signature = sig;
      expect(() => build(m), sig.slice(0, 20)).toThrow(/minisign/);
    }
    const noLinux = manifest(tag);
    delete noLinux.platforms['linux-aarch64'];
    expect(() => build(noLinux)).toThrow(/missing one of/);
    expect(isMinisignSignature(signature('x'))).toBe(true);
  });

  it('refuses another version, a stable version in a pre-release or the reverse, other pre-release ids', () => {
    expect(() => build(manifest(tag, '0.3.0-beta.1'))).toThrow(/release's version/);
    // A release marked pre-release with a stable version, and a stable release with a beta version.
    expect(() => build(manifest('v0.3.0'), release('v0.3.0', { prerelease: true }))).toThrow(/marked pre-release, but its version is stable/);
    expect(() => build(manifest(tag), release(tag, { prerelease: false }))).toThrow(/not marked pre-release, but its version is a pre-release/);
    expect(() => build(manifest('v0.3.0-alpha.1'), release('v0.3.0-alpha.1'))).toThrow(/not a release tag/);
    expect(() => build(manifest('0.3.0'), release('0.3.0', { prerelease: false }))).toThrow(/not a release tag/);
  });

  it('refuses oversized notes, a bad date, a non-object and non-JSON', () => {
    expect(() => build({ ...manifest(tag), notes: 'x'.repeat(MAX_NOTES + 1) })).toThrow(/refused/);
    expect(build({ ...manifest(tag), notes: 'x'.repeat(MAX_NOTES) }).notes).toHaveLength(MAX_NOTES);
    expect(() => build({ ...manifest(tag), notes: 7 })).toThrow(/refused/);
    expect(() => build({ ...manifest(tag), pub_date: 'yesterday' })).toThrow(/refused/);
    expect(() => build([])).toThrow(/refused/);
    expect(() => build('not json')).toThrow(/not JSON/);
  });
});

// Integration: the CLI as the site build runs it, against a local stand-in for the GitHub API
// (two pages of releases) and the release download URLs.
describe('beta-manifest.mjs (CLI, fake GitHub API)', () => {
  const run = promisify(execFile);
  let server: http.Server;
  let base = '';
  let releases: ReturnType<typeof release>[] = [];
  const files = new Map<string, string>();
  const requests: string[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-beta-feed-'));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === `/repos/${REPO}/releases`) {
        const page = Number(url.searchParams.get('page'));
        const per = Number(url.searchParams.get('per_page'));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(releases.slice((page - 1) * per, page * per)));
        return;
      }
      const file = files.get(url.pathname);
      if (file === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(file);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Releases served by the fake API; each latest.json is served as written (bytes kept). */
  function publish(tags: string[]): void {
    releases = tags.map((tag) => release(tag, { base: `${base}/dl` }));
    files.clear();
    for (const tag of tags) files.set(`/dl/${tag}/latest.json`, `${JSON.stringify(manifest(tag), null, 2)}\n`);
  }
  const cli = (out: string) => run(process.execPath, [SCRIPT, '--repo', REPO, '--out', out, '--api', base], { env: { ...process.env, GITHUB_TOKEN: '' } });

  it('publishes the highest release’s checked latest.json, across API pages', async () => {
    // 120 old stable releases (2 pages), then the beta and a later hotfix on the old line.
    const old = Array.from({ length: 120 }, (_, i) => `v0.1.${i}`);
    publish([...old, 'v0.3.0-beta.2', 'v0.2.3', 'v0.3.0-beta.1']);
    const out = path.join(tmp, 'site', 'public', 'updates', 'beta.json');
    const { stdout } = await cli(out);
    expect(stdout).toContain('v0.3.0-beta.2 (pre-release)');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(manifest('v0.3.0-beta.2'));
    expect(requests.filter((r) => r.startsWith(`/repos/${REPO}/releases`))).toEqual([`/repos/${REPO}/releases?per_page=100&page=1`, `/repos/${REPO}/releases?per_page=100&page=2`]);
    // Only the chosen release's manifest is downloaded.
    expect(requests.filter((r) => r.endsWith('latest.json'))).toEqual(['/dl/v0.3.0-beta.2/latest.json']);
  });

  it('follows the stable release once it is the highest, and removes the feed when nothing qualifies', async () => {
    const out = path.join(tmp, 'beta.json');
    publish(['v0.3.0-beta.2', 'v0.3.0']);
    await cli(out);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).version).toBe('0.3.0');
    publish(['v0.1.0']);
    files.clear();
    releases = [release('v0.1.0', { manifest: false })];
    const { stdout } = await cli(out);
    expect(stdout).toContain('no beta feed');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('fails (and keeps the previous feed) when the chosen manifest is wrong', async () => {
    const out = path.join(tmp, 'kept.json');
    fs.writeFileSync(out, 'previous');
    publish(['v0.3.0-beta.1']);
    files.set('/dl/v0.3.0-beta.1/latest.json', JSON.stringify(manifest('v0.3.0-beta.1', '0.2.0')));
    await expect(cli(out)).rejects.toMatchObject({ stderr: expect.stringContaining("not the release's version 0.3.0-beta.1") });
    expect(fs.readFileSync(out, 'utf8')).toBe('previous');
  });
});
