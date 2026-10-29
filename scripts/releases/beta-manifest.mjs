#!/usr/bin/env node
// The beta update feed: https://lucas-angelo.github.io/swarmcast/updates/beta.json
//
//   node scripts/releases/beta-manifest.mjs --repo Lucas-Angelo/swarmcast --out site/public/updates/beta.json
//        [--api https://api.github.com]
//
// Run by the website build (_site.yml). It lists the published releases (pre-releases included,
// drafts never), keeps those that have a `latest.json` asset, picks the HIGHEST SemVer among them
// and publishes that release's manifest. If 0.3.0 stable is newer than every beta, beta apps are
// offered 0.3.0; a hotfix 0.2.3 does not displace 0.3.0-beta.2, because it is lower. Without any
// such release the file is not written (the app then reads a 404 as "no update" and still checks
// the stable feed).
//
// Every beta app's updater reads this file, so the downloaded latest.json is never copied as it
// is: it is parsed and checked field by field (manifestSchema below: the release's own version,
// only our platform keys, each URL exactly a file of that release with our artifact name, a
// minisign-shaped signature, nothing else), and beta.json is written from a new object built
// from the checked values only. The app still verifies each package's signature and signed
// version; this keeps the feed from ever pointing apps anywhere else.
//
// Why GitHub Pages: immutable releases cannot carry a rolling `beta.json` asset, and
// /releases/latest/ never points at a pre-release.
//
// GITHUB_TOKEN (optional) only raises the API rate limit; the data is public.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RELEASE_VERSION, compare, isPrerelease, parse } from './semver.mjs';

export const MANIFEST = 'latest.json';
/** The longest release notes accepted (the shell and the panel cut them further). */
export const MAX_NOTES = 20_000;
const MAX_SIGNATURE = 4096;

/**
 * Platform key → our artifact's file name for a version (scripts/build/updater-manifest.mjs).
 * @type {Record<string, (v: string) => string>}
 */
export const PLATFORM_FILES = {
  'windows-x86_64': (v) => `SwarmCast_${v}_x64-setup.exe`,
  'windows-x86_64-nsis': (v) => `SwarmCast_${v}_x64-setup.exe`,
  'darwin-aarch64': (v) => `SwarmCast_${v}_aarch64.app.tar.gz`,
  'darwin-aarch64-app': (v) => `SwarmCast_${v}_aarch64.app.tar.gz`,
  'darwin-x86_64': (v) => `SwarmCast_${v}_x64.app.tar.gz`,
  'darwin-x86_64-app': (v) => `SwarmCast_${v}_x64.app.tar.gz`,
  'linux-x86_64': (v) => `SwarmCast_${v}_amd64.AppImage`,
  'linux-x86_64-appimage': (v) => `SwarmCast_${v}_amd64.AppImage`,
  'linux-aarch64': (v) => `SwarmCast_${v}_aarch64.AppImage`,
  'linux-aarch64-appimage': (v) => `SwarmCast_${v}_aarch64.AppImage`,
  'linux-x86_64-deb': (v) => `SwarmCast_${v}_amd64.deb`,
  'linux-aarch64-deb': (v) => `SwarmCast_${v}_arm64.deb`,
};
/** Every release has these (updater-manifest.mjs --require-all). */
export const REQUIRED_PLATFORMS = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64'];

/**
 * A Tauri updater signature: base64 of a minisign signature file (untrusted comment, signature,
 * trusted comment, global signature).
 */
export function isMinisignSignature(sig) {
  if (typeof sig !== 'string' || !sig || sig.length > MAX_SIGNATURE || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || sig.length % 4 !== 0) return false;
  const lines = Buffer.from(sig, 'base64').toString('utf8').split('\n').filter((l) => l !== '');
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  return (
    lines.length === 4 &&
    lines[0].startsWith('untrusted comment: ') &&
    b64.test(lines[1]) &&
    Buffer.from(lines[1], 'base64').length === 74 &&
    lines[2].startsWith('trusted comment: ') &&
    b64.test(lines[3]) &&
    Buffer.from(lines[3], 'base64').length === 64
  );
}

/** The shape of a release's latest.json, for the release `tag` of `repo` (unknown fields refused). */
export function manifestSchema(tag, repo) {
  const version = tag.replace(/^v/, '');
  const base = `https://github.com/${repo}/releases/download/v${version}/`;
  const platform = (key) =>
    z.strictObject({
      signature: z.string().refine(isMinisignSignature, 'not a minisign signature'),
      url: z.literal(`${base}${encodeURIComponent(PLATFORM_FILES[key](version))}`, { error: `not ${key}'s file of release v${version}` }),
    });
  return z.strictObject({
    version: z.literal(version, { error: `not the release's version ${version}` }).refine((v) => RELEASE_VERSION.test(v), 'not a release version (X.Y.Z, X.Y.Z-beta.N, X.Y.Z-rc.N)'),
    notes: z.string().max(MAX_NOTES),
    pub_date: z.iso.datetime({ offset: true }),
    platforms: z
      .strictObject(Object.fromEntries(Object.keys(PLATFORM_FILES).map((k) => [k, platform(k).optional()])))
      .refine((p) => REQUIRED_PLATFORMS.every((k) => p[k]), `missing one of ${REQUIRED_PLATFORMS.join(', ')}`),
  });
}

/**
 * @typedef {{ name: string, browser_download_url: string, state?: string }} Asset
 * @typedef {{ tag_name: string, draft?: boolean, prerelease?: boolean, assets?: Asset[] }} Release
 */

/**
 * The release whose latest.json becomes beta.json: the highest version among the published
 * releases (stable or pre-release) that carry one. Tags that are not SemVer are ignored.
 * @param {Release[]} releases
 * @returns {Release | null}
 */
export function pickBetaRelease(releases) {
  let best = null;
  for (const r of releases) {
    if (r.draft || !parse(r.tag_name)) continue;
    if (!(r.assets ?? []).some((a) => a.name === MANIFEST && (a.state ?? 'uploaded') === 'uploaded')) continue;
    if (!best || compare(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/**
 * Checks a release's latest.json and returns beta.json's content, built from the checked
 * values only (never the downloaded text). Throws with the reason otherwise.
 * @param {string} text the latest.json as downloaded
 * @param {Release} release
 * @param {string} repo owner/name
 */
export function buildBetaManifest(text, release, repo) {
  const where = `${release.tag_name}/${MANIFEST}`;
  if (!/^v/.test(release.tag_name) || !RELEASE_VERSION.test(release.tag_name.slice(1))) throw new Error(`${release.tag_name} is not a release tag (vX.Y.Z, vX.Y.Z-beta.N, vX.Y.Z-rc.N)`);
  // A pre-release version on a release not marked pre-release, or the reverse: refused.
  if (Boolean(release.prerelease) !== isPrerelease(release.tag_name)) {
    throw new Error(`${release.tag_name} is ${release.prerelease ? '' : 'not '}marked pre-release, but its version is ${isPrerelease(release.tag_name) ? 'a pre-release' : 'stable'}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where} is not JSON: ${err.message}`, { cause: err });
  }
  const r = manifestSchema(release.tag_name, repo).safeParse(raw);
  if (!r.success) throw new Error(`${where} refused: ${z.prettifyError(r.error)}`);
  const m = r.data;
  const platforms = {};
  for (const key of Object.keys(PLATFORM_FILES).sort()) {
    if (m.platforms[key]) platforms[key] = { signature: m.platforms[key].signature, url: m.platforms[key].url };
  }
  return { version: m.version, notes: m.notes, pub_date: m.pub_date, platforms };
}

/** @param {string} url */
async function get(url, { json = true } = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'User-Agent': 'swarmcast-site', 'X-GitHub-Api-Version': '2022-11-28', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com') headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return json ? res.json() : res.text();
    if (attempt >= 3 || res.status < 500) throw new Error(`GET ${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

/** Every release of `repo` (paginated). */
export async function fetchReleases(api, repo) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await get(`${api}/repos/${repo}/releases?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** @param {string[]} argv */
export async function main(argv) {
  /** @type {Record<string, string>} */
  const opts = { api: 'https://api.github.com' };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (!m || argv[i + 1] === undefined) throw new Error(`Unknown argument: ${argv[i]}`);
    opts[m[1]] = argv[++i];
  }
  if (!opts.repo || !opts.out) throw new Error('Usage: beta-manifest.mjs --repo owner/name --out FILE [--api URL]');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`Bad --repo: ${opts.repo}`);
  const api = opts.api.replace(/\/+$/, '');

  const release = pickBetaRelease(await fetchReleases(api, opts.repo));
  if (!release) {
    fs.rmSync(opts.out, { force: true });
    console.log(`No release of ${opts.repo} has a ${MANIFEST} yet: no beta feed (the app reads the 404 as "no update").`);
    return null;
  }
  const asset = /** @type {Asset} */ ((release.assets ?? []).find((a) => a.name === MANIFEST));
  const manifest = buildBetaManifest(await get(asset.browser_download_url, { json: false }), release, opts.repo);
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  const tmp = `${opts.out}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, opts.out);
  console.log(`✓ ${opts.out}: ${release.tag_name}${release.prerelease ? ' (pre-release)' : ''}, ${Object.keys(manifest.platforms).length} platform entries`);
  return { tag: release.tag_name, version: manifest.version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::beta.json: ${err.message}`);
    process.exit(1);
  });
}
