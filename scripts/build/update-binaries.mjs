#!/usr/bin/env node
// Bumps the third-party binaries pinned in scripts/build/versions.json (MediaMTX and
// cloudflared) to their newest upstream GitHub release and refreshes the SHA-256 values.
//
//   node scripts/build/update-binaries.mjs            rewrite versions.json
//   node scripts/build/update-binaries.mjs --check    only report; exit 1 if anything is outdated
//   node scripts/build/update-binaries.mjs --file <versions.json>   use another file
//
// Rules:
//   - mediamtx: newest stable release with the SAME major version as the pinned one (v1.x).
//     A new major is reported but never applied automatically.
//   - cloudflared: calendar versions (YYYY.M.P) carry no compatibility promise, so the newest
//     stable release is taken, with a warning to read its release notes.
//
// Archive checksums come from the `digest` field ("sha256:<hex>") GitHub computes for every
// release asset (falls back to downloading and hashing the asset when a release predates
// digests). Entries with `binarySha256` (cloudflared's macOS .tgz) also need the hash of the
// binary inside the archive, which cloudflared publishes in its release notes as
// `<asset>: <sha256>` lines.
//
// Set GITHUB_TOKEN to avoid the unauthenticated API rate limit (60 requests/hour).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Per-tool update policy. */
const POLICY = {
  mediamtx: { sameMajor: true },
  cloudflared: { sameMajor: false, warning: 'cloudflared uses calendar versioning (no semver guarantees): read the release notes before shipping it.' },
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** "v1.21.3" / "2026.10.3" → [1, 21, 3]; null for anything that is not a plain release tag. */
function parseVersion(tag) {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(tag);
  return m ? m[1].split('.').map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//.exec(url);
  if (!m) throw new Error(`cannot derive a GitHub repository from ${url}`);
  return m[1];
}

function headers(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'swarmcast-update-binaries', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? ' (rate limited? set GITHUB_TOKEN)' : '';
    throw new Error(`HTTP ${res.status} for ${url}${hint}`);
  }
  return res.json();
}

/**
 * Stable (non-draft, non-prerelease) releases with a parseable tag, newest version first.
 * The API lists the most recently created releases first, so one page of 100 is plenty.
 */
async function stableReleases(repo) {
  const releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100`);
  return releases
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
    .sort((a, b) => compareVersions(parseVersion(b.tag_name), parseVersion(a.tag_name)));
}

async function hashRemoteAsset(asset) {
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'swarmcast-update-binaries' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${asset.name}`);
  return crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
}

async function assetSha256(asset) {
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '');
  if (m) return m[1];
  console.warn(`  ! ${asset.name} has no digest in the API; downloading it to hash it`);
  return hashRemoteAsset(asset);
}

/** `<asset>: <sha256>` lines from the release notes (cloudflared's checksum table). */
function bodyChecksums(body) {
  const map = new Map();
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = /^\s*([\w.+-]+):\s*([0-9a-f]{64})\s*$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** Asset name for `newVersion`, given the pinned name (MediaMTX embeds the version, cloudflared does not). */
function renameAsset(name, oldVersion, newVersion) {
  const strip = (v) => v.replace(/^v/, '');
  return name.split(oldVersion).join(newVersion).split(strip(oldVersion)).join(strip(newVersion));
}

async function planTool(tool, spec) {
  const policy = POLICY[tool] ?? { sameMajor: true };
  const repo = githubRepo(spec.url);
  const pinned = parseVersion(spec.version);
  if (!pinned) throw new Error(`${tool}: pinned version "${spec.version}" is not a release tag`);

  const releases = await stableReleases(repo);
  if (releases.length === 0) throw new Error(`${tool}: no stable releases found in ${repo}`);
  const newest = releases[0];
  const candidates = policy.sameMajor ? releases.filter((r) => parseVersion(r.tag_name)[0] === pinned[0]) : releases;
  const notes = [];
  if (policy.sameMajor && parseVersion(newest.tag_name)[0] !== pinned[0]) {
    notes.push(`new major ${newest.tag_name} available upstream; staying on major ${pinned[0]} (upgrade it deliberately)`);
  }
  const release = candidates[0];
  if (!release || compareVersions(parseVersion(release.tag_name), pinned) <= 0) {
    return { tool, from: spec.version, to: spec.version, changed: false, notes, next: spec };
  }
  if (policy.warning) notes.push(policy.warning);

  const byName = new Map(release.assets.map((a) => [a.name, a]));
  const sums = bodyChecksums(release.body);
  const next = { ...spec, version: release.tag_name, assets: {} };
  for (const [target, entry] of Object.entries(spec.assets)) {
    const name = renameAsset(entry.asset, spec.version, release.tag_name);
    const asset = byName.get(name);
    if (!asset) throw new Error(`${tool} ${release.tag_name}: asset ${name} (for ${target}) not found in the release`);
    const updated = { ...entry, asset: name, sha256: await assetSha256(asset) };
    if ('binarySha256' in entry) {
      const inner = sums.get(name);
      if (!inner) throw new Error(`${tool} ${release.tag_name}: no "${name}: <sha256>" line in the release notes for the inner binary`);
      if (inner === updated.sha256) throw new Error(`${tool} ${release.tag_name}: release notes list the archive hash for ${name}, not the inner binary's`);
      updated.binarySha256 = inner;
    }
    next.assets[target] = updated;
  }
  return { tool, from: spec.version, to: release.tag_name, changed: true, notes, next };
}

function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

async function main() {
  const check = process.argv.includes('--check');
  const file = path.resolve(arg('file') ?? path.join(here, 'versions.json'));
  const versions = JSON.parse(fs.readFileSync(file, 'utf8'));

  const plans = [];
  // Entries that are not GitHub releases with semver tags (ffmpeg autobuilds) are bumped by hand.
  for (const [tool, spec] of Object.entries(versions)) if (spec.bundle !== false) plans.push(await planTool(tool, spec));

  let outdated = false;
  for (const p of plans) {
    if (p.changed) {
      outdated = true;
      console.log(`${p.tool}: ${p.from} -> ${p.to}`);
      for (const [target, entry] of Object.entries(p.next.assets)) {
        const old = versions[p.tool].assets[target];
        console.log(`  ${target}: ${entry.asset}  sha256 ${old.sha256.slice(0, 12)}… -> ${entry.sha256.slice(0, 12)}…`);
      }
    } else {
      console.log(`${p.tool}: ${p.from} is up to date`);
    }
    for (const note of p.notes) console.warn(`  warning: ${note}`);
  }

  if (!outdated) return;
  if (check) {
    console.log(`\nOutdated binaries. Run \`node scripts/build/update-binaries.mjs\` to update ${displayPath(file)}.`);
    process.exitCode = 1;
    return;
  }
  for (const p of plans) versions[p.tool] = p.next;
  fs.writeFileSync(file, `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`\nUpdated ${displayPath(file)}. Run \`npm run fetch-bins\` and the integration tests before committing.`);
}

main().catch((err) => {
  console.error(`update-binaries.mjs: ${err.message}`);
  process.exit(2);
});
