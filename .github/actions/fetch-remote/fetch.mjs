// Fetches pinned remote actions with git, so a step can run them from a local path
// (.github/actions/fetch-remote; also used by .github/actions/cache-restore).
//
// The runner downloads every remote action a job or a composite action uses as a tarball from
// codeload.github.com, and it never tries again after a 404 (actions/runner,
// src/Runner.Worker/ActionManager.cs, DownloadRepositoryArchive: "It doesn't make sense to retry
// in this case"), in "Set up job" and inside a composite action alike. A codeload 404 for a
// commit that exists failed `desktop macos-arm64 / build` in pipeline run 41636784175 ("An action
// could not be found at the URI ... after 1 attempts"). So our steps run these actions from a
// path (`uses: ./.git/remote-actions/<owner>/<repo>[/<path>]`), and this puts them there first:
// `git fetch` of the pinned commit from github.com (git checks every object against its hash, so
// the files are exactly that commit's), each try limited in time, tried again after any failure.
// The SHAs are the `uses:` lines of .github/actions/remote-pins/action.yml, which never runs and
// is in that format so Dependabot bumps them. Inside .git, the copies are out of the way of
// everything that reads the workspace (git status and clean, ESLint, a later checkout).
// .github/workflows/README.md, "Remote actions".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PINS_FILE = path.join('.github', 'actions', 'remote-pins', 'action.yml');
export const ACTIONS_DIR = path.join('.git', 'remote-actions');
/** Seconds to wait before try 2, 3 and 4: at most 4 x 30 + 35 s for one action. */
export const WAITS_S = [5, 10, 20];
/**
 * Limit of each git command. A depth-1 fetch of each pinned action took 0.7-1.6 s (6.5-15 MB,
 * measured from a home connection); a try that takes this long has stalled.
 */
export const TRY_TIMEOUT_MS = 30_000;

/** `owner/repo` -> { sha, version } from the `uses:` lines of the pins file. */
export function parsePins(text) {
  const pins = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w.-]+)(?:\/[^@\s]*)?@([0-9a-f]{40})\s*#\s*(v\S+)\s*$/.exec(line);
    if (!m) continue;
    const [, repo, sha, version] = m;
    const seen = pins.get(repo);
    if (seen && seen.sha !== sha) throw new Error(`${PINS_FILE}: ${repo} is pinned twice, at ${seen.sha} and ${sha}`);
    pins.set(repo, { sha, version });
  }
  return pins;
}

/** Where `repo` goes in `workspace`. */
export function actionDir(workspace, repo) {
  return path.join(workspace, ACTIONS_DIR, ...repo.split('/'));
}

/** Runs git in `cwd`; { ok, output, timedOut }. */
function runGit(args, { cwd, timeoutMs }) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error && !timedOut ? r.error.message : ''}`.trim();
  return { ok: r.status === 0 && !r.error, output, timedOut };
}

// The files as committed, as in codeload's tarball (compared file by file for every pin): no CRLF
// on Windows, where Git for Windows sets core.autocrlf and a bash script with CRLF does not run.
// No credentials: these repositories are public.
const GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'credential.helper=', '-c', 'advice.detachedHead=false'];
const COMPLETE = 'remote-action-sha';

/** True when `dir` already holds `sha`, fetched completely. */
function isComplete(dir, sha) {
  try {
    return fs.readFileSync(path.join(dir, '.git', COMPLETE), 'utf8').trim() === sha;
  } catch {
    return false;
  }
}

/** One try: a fresh repository in `dir` at `sha`. Returns null, or what went wrong. */
function fetchOnce({ repo, sha, dir, git, timeoutMs }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const steps = [
    ['init', '-q'],
    ['fetch', '--depth=1', '--no-tags', '--quiet', `https://github.com/${repo}.git`, sha],
    ['checkout', '-q', '--detach', 'FETCH_HEAD'],
    ['rev-parse', 'HEAD'],
  ];
  for (const args of steps) {
    const r = git([...GIT_CONFIG, ...args], { cwd: dir, timeoutMs });
    if (r.timedOut) return `git ${args[0]} was cut off after ${Math.round(timeoutMs / 1000)} s`;
    if (!r.ok) return `git ${args[0]} failed: ${r.output || 'no output'}`;
    if (args[0] === 'rev-parse' && r.output !== sha) return `HEAD is ${r.output}, not ${sha}`;
  }
  fs.writeFileSync(path.join(dir, '.git', COMPLETE), `${sha}\n`);
  return null;
}

/**
 * Puts `repo` at `sha` into `dir` (nothing to do when it is there already), at most
 * `waits.length + 1` tries. Returns { tries, seconds }; throws after the last failed try.
 */
export async function fetchAction({
  repo,
  sha,
  version,
  dir,
  git = runGit,
  sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
  now = Date.now,
  waits = WAITS_S,
  timeoutMs = TRY_TIMEOUT_MS,
  log = console.log,
}) {
  if (isComplete(dir, sha)) return { tries: 0, seconds: 0 };
  const start = now();
  const tries = waits.length + 1;
  for (let n = 1; ; n++) {
    const problem = fetchOnce({ repo, sha, dir, git, timeoutMs });
    const seconds = Math.round((now() - start) / 100) / 10;
    if (!problem) {
      log(`${repo}@${sha} (${version}): fetched in ${seconds} s${n > 1 ? ` (try ${n} of ${tries})` : ''}`);
      return { tries: n, seconds };
    }
    if (n === tries) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`${repo}@${sha} (${version}): not fetched after ${tries} tries in ${seconds} s; last: ${problem}`);
    }
    log(`::warning::${repo}@${sha} (${version}): try ${n} of ${tries}: ${problem}; trying again in ${waits[n - 1]} s`);
    await sleep(waits[n - 1]);
  }
}

/** Fetches each of `repos` into `workspace`, at the pins of `workspace`'s pins file. */
export async function fetchActions({ workspace, repos, ...options }) {
  const pins = parsePins(fs.readFileSync(path.join(workspace, PINS_FILE), 'utf8'));
  const dirs = [];
  for (const repo of repos) {
    const pin = pins.get(repo);
    if (!pin) throw new Error(`${repo} has no pin in ${PINS_FILE}`);
    const dir = actionDir(workspace, repo);
    await fetchAction({ repo, ...pin, dir, ...options });
    dirs.push(dir);
  }
  return dirs;
}
