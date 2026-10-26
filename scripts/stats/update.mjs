#!/usr/bin/env node
// Daily usage snapshot from GitHub's public release counters (no telemetry; see stats.mjs).
//
//   node scripts/stats/update.mjs --repo Lucas-Angelo/swarmcast \
//     --history stats/history.json --summary stats/summary.json [--now 2026-10-26T06:00:00Z] \
//     [--releases releases.json --latest latest.json]   (offline input, for tests)
//
// Reads the history file (missing = empty), adds today's snapshot, writes both files.
// GITHUB_TOKEN (optional) only raises the API rate limit; the data is public.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSnapshot, buildSummary, takeSnapshot } from './stats.mjs';

const API = 'https://api.github.com';

/** @param {string} url */
async function getJson(url, { allow404 = false } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'swarmcast-stats' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 404 && allow404) return null;
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status < 500) throw new Error(`GET ${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

/** All releases of `repo` (paginated). */
export async function fetchReleases(repo) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await getJson(`${API}/repos/${repo}/releases?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (!m) throw new Error(`Unknown argument: ${argv[i]}`);
    opts[m[1]] = argv[++i];
  }
  if (!opts.repo || !opts.history || !opts.summary) {
    throw new Error('Usage: update.mjs --repo owner/name --history FILE --summary FILE [--now ISO] [--releases FILE --latest FILE]');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`Bad --repo: ${opts.repo}`);
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Bad --now: ${opts.now}`);

  const releases = opts.releases ? readJson(opts.releases, []) : await fetchReleases(opts.repo);
  const latest = opts.releases ? readJson(opts.latest ?? '', null) : await getJson(`${API}/repos/${opts.repo}/releases/latest`, { allow404: true });

  const history = addSnapshot(readJson(opts.history, null), takeSnapshot(releases, now));
  const summary = buildSummary({ releases, latest, history, now, repo: opts.repo });
  writeJson(opts.history, history);
  writeJson(opts.summary, summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (s) => {
      const apps = s.apps ? `about ${s.apps.week} apps this week (${s.apps.checks} update checks over ${s.apps.days} days${s.apps.partial ? ', extrapolated' : ''})` : 'apps: not enough data yet';
      console.log(`downloads: ${s.downloads.total} (shown as about ${s.downloads.about}); ${apps}; latest: ${s.latest?.tag ?? 'none'}`);
    },
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
