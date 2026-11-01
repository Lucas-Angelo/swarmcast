// A cache restore with a time limit and one more try (.github/actions/cache-restore).
//
// actions/cache/restore and setup-node's built-in cache can hang for many minutes when the
// download from the cache's blob storage stalls: SEGMENT_DOWNLOAD_TIMEOUT_MINS only bounds the
// download of data, not the request before it. A simulation that dropped the TLS handshake with
// *.blob.core.windows.net hung actions/cache/restore for 748 s with SEGMENT_DOWNLOAD_TIMEOUT_MINS=2
// (soak/cache-stall-sim, run 41293309829), and a composite action's steps cannot have a
// timeout-minutes. So this runs actions/cache's own restore code (its restore-only entry point,
// which the runner downloaded for the job) as a child process, kills it after `timeoutMs`, and
// tries once more when a try timed out or failed ("Failed to restore"); a plain miss is not
// retried. A cache is a speed-up: every outcome is a hit or a miss, never an error.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** The restore-only entry point of the actions/cache versions the runner downloaded for this job. */
export function findRestoreScript(actionsDir) {
  let found = null;
  let dirs;
  try {
    dirs = fs.readdirSync(path.join(actionsDir, 'actions', 'cache'));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const script = path.join(actionsDir, 'actions', 'cache', d, 'dist', 'restore-only', 'index.js');
    if (!fs.existsSync(script)) continue;
    const mtime = fs.statSync(script).mtimeMs;
    if (!found || mtime > found.mtime) found = { script, mtime };
  }
  return found?.script ?? null;
}

/** `name=value` lines and `name<<EOF` blocks of a GITHUB_OUTPUT file. */
export function parseOutputs(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const body = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]);
      out[heredoc[1]] = body.join('\n');
    } else {
      const eq = lines[i].indexOf('=');
      if (eq > 0) out[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
    }
  }
  return out;
}

function killTree(child) {
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** One try: { outputs, timedOut, failed, output, seconds }. */
function attempt({ node, script, env, timeoutMs, log }) {
  return new Promise((resolve) => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cache-restore-')), 'output');
    fs.writeFileSync(outFile, '');
    const start = Date.now();
    // Its own process group, so a kill also stops the tar it extracts with.
    const child = spawn(node, [script], { env: { ...env, GITHUB_OUTPUT: outFile }, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let output = '';
    const onData = (d) => {
      output += d;
      log(String(d).replace(/\n$/, ''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const outputs = parseOutputs(fs.readFileSync(outFile, 'utf8'));
      // "Failed to restore: ..." is actions/cache's warning for a lookup or download that failed
      // (it then reports a miss); a non-zero exit is a failure too.
      const failed = !timedOut && (code !== 0 || /Failed to restore/.test(output));
      resolve({ outputs, timedOut, failed, output, seconds: Math.round((Date.now() - start) / 1000) });
    });
  });
}

/** Removes what a cut-off try may have half-extracted (paths are actions/cache `path` lines). */
export function clearPaths(paths) {
  for (const p of paths) {
    const matches = /[*?[]/.test(p) ? fs.globSync(p) : [p];
    for (const m of matches) fs.rmSync(m, { recursive: true, force: true });
  }
}

/**
 * Restores `key` (else a `restoreKeys` prefix) into `paths` with actions/cache's restore code,
 * each try limited to `timeoutMs`, at most `tries` tries. Returns { hit, matchedKey, tries: [...] }.
 */
export async function restore({ script, node = process.execPath, paths, key, restoreKeys = [], timeoutMs, tries = 2, env = process.env, log = console.log }) {
  const childEnv = {
    ...env,
    INPUT_PATH: paths.join('\n'),
    INPUT_KEY: key,
    'INPUT_RESTORE-KEYS': restoreKeys.join('\n'),
    INPUT_ENABLECROSSOSARCHIVE: 'false',
    'INPUT_FAIL-ON-CACHE-MISS': 'false',
    'INPUT_LOOKUP-ONLY': 'false',
  };
  const results = [];
  for (let n = 1; n <= tries; n++) {
    const r = await attempt({ node, script, env: childEnv, timeoutMs, log });
    results.push({ timedOut: r.timedOut, failed: r.failed, seconds: r.seconds });
    const matchedKey = r.outputs['cache-matched-key'] || '';
    if (matchedKey && !r.timedOut && !r.failed) {
      return { hit: matchedKey === key, matchedKey, tries: results };
    }
    if (!r.timedOut && !r.failed) return { hit: false, matchedKey: '', tries: results }; // a plain miss
    clearPaths(paths);
    const why = r.timedOut ? `cut off after ${Math.round(timeoutMs / 1000)} s` : 'failed';
    log(`::warning::cache restore of ${key}: try ${n} of ${tries} ${why}${n < tries ? ', trying again' : ', going on without it'}`);
  }
  return { hit: false, matchedKey: '', tries: results };
}
