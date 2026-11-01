#!/usr/bin/env node
// Keeps the repository's Actions caches under GitHub's 10 GB limit (.github/workflows/cache-hygiene.yml,
// .github/workflows/README.md "Caches"). Over the limit GitHub evicts the least recently used
// entries, so a job can find main's npm or Rust cache gone and run cold.
//
//   node scripts/ci/cache-hygiene.mjs [--dry-run] [--grace-hours 24] [--main-ref origin/main]
//                                     [--repo owner/name] [--caches listing.json]
//
// What it deletes:
// - the caches of a pull request that is no longer open (refs/pull/<n>/merge, refs/pull/<n>/head);
// - the caches of a branch that no longer exists;
// - on main, superseded entries: per cache "family" (the key with its hashes and versions taken
//   out, see familyOf), every entry except the ones still in use (see plan).
// Everything else stays (open pull requests, existing branches, tags).
//
// Never deleted on main: an entry whose key holds a hash of main's current inputs (the same
// hashFiles() the workflows and setup-node compute, from main's files: `--main-ref`), the newest
// entry of each family, the most recently used one, and an older entry that was still used after
// the newest one was saved, within the last `--grace-hours` (a run of an older commit, a pull
// request on an older base, a runner image version still being rolled out). An older entry last
// restored before the newest was saved is superseded: that is how a Rust or CodeQL cache rolls
// over (the run that saves the new entry restored the old one by prefix, then nothing does).
// --dry-run prints the plan and deletes nothing. --caches reads the listing from a file
// (`gh cache list --json id,key,ref,sizeInBytes,createdAt,lastAccessedAt`) instead of the API.
// Needs `gh` with GH_TOKEN (actions: write to delete; actions: read for a dry run).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAIN_BRANCH = 'main';

// Key segments that change with the inputs: hex hashes (lockfile hashes, rust-cache's 8-digit
// environment and lockfile hashes, commit SHAs) and dotted versions (runner image, CodeQL,
// Go, Playwright). Everything else names the family (tool, OS, architecture, job).
const HASH = /^[0-9a-f]{7,}$/;
const VERSION = /^\d+(\.\d+)+$/;

/** The family of a cache key: its segments with the hashes and versions replaced by `*`. */
export function familyOf(key) {
  return key
    .split('-')
    .map((s) => (HASH.test(s) || VERSION.test(s) ? '*' : s))
    .join('-');
}

/** GitHub's hashFiles(): SHA-256 over the SHA-256 digests of the files, in order (also setup-node's). */
export function hashFiles(contents) {
  const all = crypto.createHash('sha256');
  for (const c of contents) all.update(crypto.createHash('sha256').update(c).digest());
  return all.digest('hex');
}

// The inputs main's cache keys are built from, as the workflows hash them.
export const KEY_INPUTS = [
  { what: 'npm cache (setup-node)', files: ['package-lock.json', 'site/package-lock.json', '.github/actions/setup/action.yml'] },
  { what: 'package-lock.json (sc-pkg, apt-debs-playwright)', files: ['package-lock.json'] },
  { what: 'versions.json (sc-downloads)', files: ['scripts/build/versions.json'] },
  { what: 'go.sum (setup-go)', files: ['apps/tray/go.sum'] },
];

/**
 * The hashes in the keys current main would restore: one per KEY_INPUTS entry, plus main's
 * commit (codeql-trap-*). `read(path)` returns the file on main (a Buffer), or null if missing.
 */
export function currentTokens(read, mainSha) {
  const tokens = [];
  for (const { what, files } of KEY_INPUTS) {
    const contents = files.map(read);
    if (contents.some((c) => c == null)) continue;
    tokens.push({ what, token: hashFiles(contents) });
  }
  if (mainSha) tokens.push({ what: 'main commit (codeql-trap)', token: mainSha });
  return tokens;
}

const time = (s) => Date.parse(s);
const newestFirst = (by) => (a, b) => time(b[by]) - time(a[by]) || b.id - a.id;

/**
 * Which caches to delete. `caches`: the listing; `branches`: the names of the existing branches;
 * `openPrs`: the numbers of the open pull requests; `tokens`: currentTokens(); `now`: a Date.
 * Returns { keep, remove }, each a list of { cache, reason }.
 */
export function plan({ caches, branches, openPrs, tokens, now, graceHours = 24 }) {
  if (!branches.includes(MAIN_BRANCH)) throw new Error(`the branch list has no ${MAIN_BRANCH}: refusing to judge branches from it`);
  for (const t of tokens) if (!HASH.test(t.token)) throw new Error(`not a hash: ${t.what} = ${t.token}`);
  const mainRef = `refs/heads/${MAIN_BRANCH}`;
  const keep = [];
  const remove = [];
  const families = new Map();
  for (const cache of caches) {
    if (cache.ref === mainRef) {
      const f = familyOf(cache.key);
      if (!families.has(f)) families.set(f, []);
      families.get(f).push(cache);
      continue;
    }
    const pr = /^refs\/pull\/(\d+)\/(merge|head)$/.exec(cache.ref);
    const branch = /^refs\/heads\/(.+)$/.exec(cache.ref);
    if (pr) {
      const n = Number(pr[1]);
      if (openPrs.includes(n)) keep.push({ cache, reason: `pull request #${n} is open` });
      else remove.push({ cache, reason: `pull request #${n} is closed` });
    } else if (branch) {
      if (branches.includes(branch[1])) keep.push({ cache, reason: `branch ${branch[1]} exists` });
      else remove.push({ cache, reason: `branch ${branch[1]} no longer exists` });
    } else {
      keep.push({ cache, reason: 'not a branch or pull request ref' });
    }
  }
  const graceStart = now.getTime() - graceHours * 3600e3;
  for (const entries of families.values()) {
    const newest = [...entries].sort(newestFirst('createdAt'))[0];
    const lastUsed = [...entries].sort(newestFirst('lastAccessedAt'))[0];
    for (const cache of entries) {
      const current = tokens.find((t) => cache.key.includes(t.token));
      if (current) keep.push({ cache, reason: `current inputs: ${current.what}` });
      else if (cache === newest) keep.push({ cache, reason: 'newest of its family' });
      else if (cache === lastUsed) keep.push({ cache, reason: 'most recently used of its family' });
      else if (time(cache.lastAccessedAt) > time(newest.createdAt) && time(cache.lastAccessedAt) >= graceStart) {
        keep.push({ cache, reason: `still used (after the newest was saved, within ${graceHours} h)` });
      } else remove.push({ cache, reason: `superseded by ${newest.key}` });
    }
  }
  return { keep, remove };
}

const sum = (list) => list.reduce((n, { cache }) => n + cache.sizeInBytes, 0);
export const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The plan as text: deletions (with their reason), then what stays per reason, then the totals. */
export function report({ keep, remove }, { dryRun }) {
  const lines = [];
  const before = sum(keep) + sum(remove);
  lines.push(`${dryRun ? 'Would delete' : 'Deleting'} ${remove.length} of ${keep.length + remove.length} caches (${gb(sum(remove))}):`);
  for (const { cache, reason } of [...remove].sort((a, b) => a.cache.ref.localeCompare(b.cache.ref) || a.cache.key.localeCompare(b.cache.key))) {
    lines.push(`  - ${cache.key}  [${cache.ref}]  ${mb(cache.sizeInBytes)}  (${reason})`);
  }
  const byReason = new Map();
  for (const k of keep) byReason.set(k.reason, [...(byReason.get(k.reason) ?? []), k]);
  lines.push(`Keeping ${keep.length} caches (${gb(sum(keep))}):`);
  for (const [reason, list] of [...byReason].sort()) lines.push(`  ${String(list.length).padStart(3)} × ${reason}  ${gb(sum(list))}`);
  lines.push(`Size: ${gb(before)} before, ${gb(sum(keep))} after (GitHub's limit: 10 GB).`);
  return lines.join('\n');
}

// ---- CLI ----

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repo = arg('repo', process.env.GITHUB_REPOSITORY);
  const mainRef = arg('main-ref', `origin/${MAIN_BRANCH}`);
  const graceHours = Number(arg('grace-hours', '24'));
  const cachesFile = arg('caches');
  if (!repo) throw new Error('--repo owner/name (or GITHUB_REPOSITORY) is required');
  if (!(graceHours >= 0)) throw new Error('--grace-hours must be a number >= 0');
  const gh = (...args) => run('gh', args);

  const usage = () => JSON.parse(gh('api', `repos/${repo}/actions/cache/usage`));
  const usageBefore = usage();
  const caches = cachesFile
    ? JSON.parse(fs.readFileSync(cachesFile, 'utf8'))
    : JSON.parse(gh('cache', 'list', '-R', repo, '-L', '100000', '--json', 'id,key,ref,sizeInBytes,createdAt,lastAccessedAt'));
  const branches = gh('api', '--paginate', `repos/${repo}/branches?per_page=100`, '--jq', '.[].name').split('\n').filter(Boolean);
  const openPrs = gh('pr', 'list', '-R', repo, '--state', 'open', '-L', '1000', '--json', 'number', '--jq', '.[].number')
    .split('\n')
    .filter(Boolean)
    .map(Number);
  const read = (file) => {
    try {
      return execFileSync('git', ['show', `${mainRef}:${file}`], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const mainSha = run('git', ['rev-parse', `${mainRef}^{commit}`]).trim();
  const tokens = currentTokens(read, mainSha);

  console.log(`Repository ${repo}: ${usageBefore.active_caches_count} caches, ${gb(usageBefore.active_caches_size_in_bytes)} (usage API)`);
  console.log(`${branches.length} branches, open pull requests: ${openPrs.join(', ') || 'none'}`);
  console.log(`Main (${mainRef} = ${mainSha}): the keys it restores hold`);
  for (const t of tokens) {
    const found = caches.some((c) => c.ref === `refs/heads/${MAIN_BRANCH}` && c.key.includes(t.token));
    console.log(`  ${t.token}  ${t.what}${found ? '' : '  (no cache on main yet)'}`);
  }
  const result = plan({ caches, branches, openPrs, tokens, now: new Date(), graceHours });
  const text = report(result, { dryRun });
  console.log(text);

  let failed = 0;
  if (!dryRun) {
    for (const { cache } of result.remove) {
      try {
        gh('cache', 'delete', String(cache.id), '-R', repo);
      } catch (e) {
        // Gone already (another run, or GitHub's own eviction) or a transient API error: the
        // next run tries again.
        failed++;
        console.log(`::warning::could not delete ${cache.key} [${cache.ref}] (id ${cache.id}): ${String(e.stderr || e.message).trim()}`);
      }
    }
    const after = usage();
    console.log(`Deleted ${result.remove.length - failed} caches. Usage API now: ${after.active_caches_count} caches, ${gb(after.active_caches_size_in_bytes)} (it can lag a few minutes).`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const title = `### Cache hygiene${dryRun ? ' (dry run: nothing deleted)' : ''}`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${title}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
