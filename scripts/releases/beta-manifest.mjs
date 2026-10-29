#!/usr/bin/env node
// The beta update feed: https://lucas-angelo.github.io/swarmcast/updates/beta.json
//
//   node scripts/releases/beta-manifest.mjs --repo Lucas-Angelo/swarmcast --out site/public/updates/beta.json
//        [--api https://api.github.com]
//
// Run by the website build (_site.yml). It lists the published releases (pre-releases included,
// drafts never), keeps those that have a `latest.json` asset, picks the HIGHEST SemVer among them
// and writes an exact copy of that release's latest.json, after checking that it announces the
// release's own version and points only at that release's files. If 0.3.0 stable is newer than
// every beta, beta apps are offered 0.3.0; a hotfix 0.2.3 does not displace 0.3.0-beta.2, because
// it is lower. Without any such release the file is not written (the app then reads a 404 as
// "no update" and still checks the stable feed).
//
// Why GitHub Pages: immutable releases cannot carry a rolling `beta.json` asset, and
// /releases/latest/ never points at a pre-release. The packages stay on the versioned release
// URLs, signed as before (the app checks the signature and the signed version).
//
// GITHUB_TOKEN (optional) only raises the API rate limit; the data is public.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, parse } from './semver.mjs';

export const MANIFEST = 'latest.json';

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
 * Checks a release's latest.json before it is published as beta.json: its version is the tag's,
 * and every package URL is a file of that very release.
 * @param {string} text the latest.json as downloaded
 * @param {Release} release
 * @param {string} repo owner/name
 */
export function checkManifest(text, release, repo) {
  const m = JSON.parse(text);
  const version = release.tag_name.replace(/^v/, '');
  if (!m || typeof m !== 'object') throw new Error(`${release.tag_name}/${MANIFEST} is not a JSON object`);
  if (m.version !== version) throw new Error(`${release.tag_name}/${MANIFEST} announces version ${m.version}, not ${version}`);
  const platforms = Object.entries(m.platforms ?? {});
  if (platforms.length === 0) throw new Error(`${release.tag_name}/${MANIFEST} has no platforms`);
  const base = `https://github.com/${repo}/releases/download/${release.tag_name}/`;
  for (const [key, p] of platforms) {
    if (typeof p?.signature !== 'string' || !p.signature || typeof p.url !== 'string') throw new Error(`${release.tag_name}/${MANIFEST}: ${key} has no url or signature`);
    if (!p.url.startsWith(base)) throw new Error(`${release.tag_name}/${MANIFEST}: ${key} points outside the release (${p.url})`);
  }
  return m;
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

/** Every release of `repo` (paginated), drafts included only when the token may see them. */
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
  const text = await get(asset.browser_download_url, { json: false });
  const manifest = checkManifest(text, release, opts.repo);
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  const tmp = `${opts.out}.tmp`;
  fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
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
