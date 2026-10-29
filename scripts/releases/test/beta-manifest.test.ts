import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkManifest, pickBetaRelease } from '../beta-manifest.mjs';

const REPO = 'Lucas-Angelo/swarmcast';
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'beta-manifest.mjs');

function manifest(tag: string, version = tag.replace(/^v/, '')) {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  return {
    version,
    notes: `notes of ${tag}`,
    pub_date: '2026-11-01T12:00:00Z',
    platforms: {
      'darwin-aarch64': { signature: `sig-${tag}`, url: `${base}/SwarmCast_${version}_aarch64.app.tar.gz` },
      'linux-x86_64-deb': { signature: `sig-${tag}`, url: `${base}/SwarmCast_${version}_amd64.deb` },
    },
  };
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

describe('checkManifest', () => {
  it('accepts the release’s own latest.json', () => {
    expect(checkManifest(JSON.stringify(manifest('v0.3.0-beta.1')), release('v0.3.0-beta.1'), REPO).version).toBe('0.3.0-beta.1');
  });

  it('rejects another version, packages outside the release, missing signatures or platforms', () => {
    const r = release('v0.3.0-beta.2');
    expect(() => checkManifest(JSON.stringify(manifest('v0.3.0-beta.2', '0.3.0-beta.1')), r, REPO)).toThrow(/announces version 0.3.0-beta.1/);
    const outside = manifest('v0.3.0-beta.2');
    outside.platforms['darwin-aarch64'].url = 'https://example.com/SwarmCast.app.tar.gz';
    expect(() => checkManifest(JSON.stringify(outside), r, REPO)).toThrow(/points outside the release/);
    const older = manifest('v0.3.0-beta.2');
    older.platforms['darwin-aarch64'].url = `https://github.com/${REPO}/releases/download/v0.3.0-beta.1/x.tar.gz`;
    expect(() => checkManifest(JSON.stringify(older), r, REPO)).toThrow(/points outside the release/);
    const unsigned = manifest('v0.3.0-beta.2');
    unsigned.platforms['darwin-aarch64'].signature = '';
    expect(() => checkManifest(JSON.stringify(unsigned), r, REPO)).toThrow(/no url or signature/);
    expect(() => checkManifest(JSON.stringify({ ...manifest('v0.3.0-beta.2'), platforms: {} }), r, REPO)).toThrow(/no platforms/);
    expect(() => checkManifest('not json', r, REPO)).toThrow();
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

  it('writes an exact copy of the highest release’s latest.json, across API pages', async () => {
    // 120 old stable releases (2 pages), then the beta and a later hotfix on the old line.
    const old = Array.from({ length: 120 }, (_, i) => `v0.1.${i}`);
    publish([...old, 'v0.3.0-beta.2', 'v0.2.3', 'v0.3.0-beta.1']);
    const out = path.join(tmp, 'site', 'public', 'updates', 'beta.json');
    const { stdout } = await cli(out);
    expect(stdout).toContain('v0.3.0-beta.2 (pre-release)');
    expect(fs.readFileSync(out, 'utf8')).toBe(files.get('/dl/v0.3.0-beta.2/latest.json'));
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
    await expect(cli(out)).rejects.toMatchObject({ stderr: expect.stringContaining('announces version 0.2.0') });
    expect(fs.readFileSync(out, 'utf8')).toBe('previous');
  });
});
