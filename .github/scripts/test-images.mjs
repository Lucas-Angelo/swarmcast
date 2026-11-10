#!/usr/bin/env node
// Which earlier run's artifact holds a job's Docker test images (.github/actions/test-images;
// .github/workflows/README.md, "Test images").
//
//   node .github/scripts/test-images.mjs find <artifact name>
//
// Prints `run-id=<id>` and `artifact-id=<id>` lines (for GITHUB_OUTPUT) for the newest artifact of
// that name that this run may trust, or nothing when there is none. Environment: GITHUB_REPOSITORY,
// GITHUB_TOKEN (actions: read), GITHUB_API_URL, TRUSTED_BRANCHES (space-separated: the default
// branch and this run's own branch).
//
// Trusted, like the Actions cache's scopes: an artifact uploaded by a run of this repository (not
// of a fork: a fork's pull request runs here too, and could upload under the same name) on the
// default branch or on this run's own branch, that has not expired and will not within the hour.
// The name holds the key of every image in it (scripts/test/docker/images.sh), so any trusted
// artifact of that name has the right images; the newest wins.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** An artifact that expires sooner than this is passed over (the download must finish first). */
export const MIN_LIFE_MS = 60 * 60 * 1000;
const API_TRIES = 3;
const API_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ id: number, name: string, expired: boolean, created_at: string, expires_at: string,
 *   workflow_run?: { id?: number, repository_id?: number, head_repository_id?: number, head_branch?: string } }} Artifact
 */

/**
 * The artifact to restore: the newest of `artifacts` uploaded by a run of this repository on one
 * of `branches`, not expired and not expiring within `MIN_LIFE_MS` of `now`; null when none is.
 * @param {Artifact[]} artifacts
 * @param {{ branches: string[], now: number }} o
 * @returns {Artifact | null}
 */
export function pickArtifact(artifacts, { branches, now }) {
  const ok = artifacts.filter((a) => {
    const run = a.workflow_run;
    if (a.expired || !run || run.id === undefined) return false;
    if (run.repository_id === undefined || run.head_repository_id !== run.repository_id) return false;
    if (!branches.includes(run.head_branch ?? '')) return false;
    return Date.parse(a.expires_at) - now > MIN_LIFE_MS;
  });
  ok.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  return ok[0] ?? null;
}

/**
 * GET `url` from the REST API: each try limited to API_TIMEOUT_MS, API_TRIES tries (5 s, 15 s apart)
 * after a network error or a 5xx/429; any other status fails at once.
 * @param {string} url
 * @param {string} token
 * @param {string} label
 */
async function api(url, token, label) {
  let last = '';
  for (let i = 1; i <= API_TRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (i < API_TRIES) {
      console.error(`${label}: ${url}: ${last} (try ${i} of ${API_TRIES})`);
      await new Promise((r) => setTimeout(r, 5000 * 3 ** (i - 1)));
    }
  }
  throw new Error(`${url}: ${last}`);
}

/**
 * The newest artifact named `name` that this run may trust (pickArtifact), from the REST API, or
 * null. Also used by .github/scripts/cargo-crates.mjs, whose saved Rust crates follow the same rules.
 * @param {{ name: string, repo: string, token: string, base: string, branches: string[], label?: string }} o
 * @returns {Promise<Artifact | null>}
 */
export async function findArtifact({ name, repo, token, base, branches, label = 'test-images' }) {
  /** @type {Artifact[]} */
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const body = await api(`${base}/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`, token, label);
    all.push(...body.artifacts);
    if (body.artifacts.length < 100) break;
  }
  const hit = pickArtifact(all, { branches, now: Date.now() });
  if (!hit) console.error(`${label}: no artifact ${name} from a trusted branch (${all.length} of that name in all)`);
  else console.error(`${label}: ${name} from run ${hit.workflow_run?.id} on ${hit.workflow_run?.head_branch}, uploaded ${hit.created_at}`);
  return hit;
}

/**
 * The `find` command for GITHUB_OUTPUT: `run-id=` and `artifact-id=` lines, or nothing on a miss.
 * Environment: GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL, TRUSTED_BRANCHES.
 * @param {string} name
 * @param {string} [label]
 */
export async function findCommand(name, label = 'test-images') {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const branches = (process.env.TRUSTED_BRANCHES || '').split(/\s+/).filter(Boolean);
  if (!repo || !token || branches.length === 0) {
    console.error(`${label}: GITHUB_REPOSITORY, GITHUB_TOKEN and TRUSTED_BRANCHES are required`);
    process.exit(2);
  }
  const hit = await findArtifact({ name, repo, token, base, branches, label });
  if (!hit) return;
  console.log(`run-id=${hit.workflow_run?.id}`);
  console.log(`artifact-id=${hit.id}`);
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  if (cmd !== 'find' || !name) {
    console.error('usage: test-images.mjs find <artifact name>');
    process.exit(2);
  }
  await findCommand(name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`test-images: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
