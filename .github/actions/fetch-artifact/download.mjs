// Try 1 of fetch-artifact (.github/actions/fetch-artifact/action.yml): actions/download-artifact,
// run as a child process with a time limit that follows the artifacts' size and a cut when the
// download stops making progress.
//
// A composite action's steps cannot have a timeout-minutes; they share what is left of the calling
// step's (.github/workflows/README.md, "Artifact uploads"). When download-artifact ran as such a
// step, a blob download that stalled used up the caller's whole limit: release rehearsal
// 44018931697 (`docker / AppImage debian:12 x64`) got the 200 for linux-docker-x64 (335 MB), then
// nothing for 599 s, until "The action has timed out" ended try 1 and, in the same instant, every
// step after it (the diagnostics in 7 ms, try 2 skipped). So download-artifact runs here, from the
// copy ../fetch-remote fetches, under limits of its own: LIST_S to list the artifacts
// (`- <name> (ID: <id>, Size: <bytes>, ...)`); then the whole try has, from its start,
// LIMIT_BASE_S, PER_ARTIFACT_S per artifact and the bytes at RATE_FLOOR_BPS (or the caller's
// cap), and it is cut off as soon as STALL_S pass without a byte more in the destination. Try 2
// (rest.sh fetch, another client and route) then has the same budget in what is left of the
// caller's limit.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

/**
 * The slowest rate a working download is given, in bytes per second. In 60 pipeline runs before
 * release rehearsal 44018931697, download-artifact got 11-64 MB/s (335 MB in 15-22 s, 2.4 GB in
 * 38-55 s) and its slowest step that worked, 335 MB in 91 s with the action's fetch and the unpack,
 * still ran at 3.7 MB/s (.github/workflows/README.md, "Artifact downloads"). rest.sh's
 * RATE_FLOOR_BPS is the same number (fetch-artifact.test.ts checks).
 */
export const RATE_FLOOR_BPS = 4_000_000;
/** Seconds a try has over its bytes at RATE_FLOOR_BPS: the requests and the unzip's end... */
export const LIMIT_BASE_S = 45;
/** ...and over that, for each artifact (its own request, redirect and unzip). */
export const PER_ARTIFACT_S = 1;
/** Seconds without a byte more in the destination after which a try has stalled. */
export const STALL_S = 30;
/** Seconds for download-artifact to start and list the artifacts (it takes about 1 s). */
export const LIST_S = 30;
/** How often the destination is measured. */
export const POLL_MS = 2_000;

/** A try's time limit, in ms, for `count` artifacts of `bytes` in all. */
export function tryLimitMs(bytes, count = 1) {
  return (LIMIT_BASE_S + PER_ARTIFACT_S * count + Math.ceil(bytes / RATE_FLOOR_BPS)) * 1000;
}

/** { name, id, bytes } from download-artifact's `- <name> (ID: <id>, Size: <bytes>, ...)` line, or null. */
export function parseListed(line) {
  const m = /^- (.+) \(ID: (\d+), Size: (\d+), Expected Digest: /.exec(line);
  return m ? { name: m[1], id: Number(m[2]), bytes: Number(m[3]) } : null;
}

/** Bytes of every file under `dir` (0 when it does not exist yet). */
export function bytesUnder(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += bytesUnder(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        // removed between the listing and the stat
      }
    }
  }
  return total;
}

/**
 * The limits of one try, fed the clock and the destination's size: `listed` for each artifact
 * download-artifact says it downloads, `check` at every measurement; `check` returns why the try
 * must be cut off, or null. `capMs` (optional) bounds the whole try from its start, for a caller
 * whose own step limit is smaller than two tries at RATE_FLOOR_BPS (a saved copy of gigabytes).
 */
export class Watchdog {
  constructor(now, size, capMs = Infinity) {
    this.start = now;
    this.capMs = capMs;
    this.listedAt = null;
    this.bytes = 0;
    this.count = 0;
    this.deadline = now + Math.min(LIST_S * 1000, capMs);
    this.size = size;
    this.progressAt = now;
  }

  listed(bytes, now) {
    this.bytes += bytes;
    this.count += 1;
    this.listedAt ??= now;
    this.deadline = this.start + Math.min(tryLimitMs(this.bytes, this.count), this.capMs);
  }

  check(size, now) {
    if (size !== this.size) {
      this.size = size;
      this.progressAt = now;
    }
    if (this.listedAt === null) {
      return now >= this.deadline ? `listed no artifact in ${Math.round((this.deadline - this.start) / 1000)} s` : null;
    }
    const got = `${size} of ${this.bytes} bytes written`;
    if (now >= this.deadline) return `reached its time limit of ${Math.round((this.deadline - this.start) / 1000)} s for ${this.bytes} bytes (${got})`;
    if (now - Math.max(this.progressAt, this.listedAt) >= STALL_S * 1000) return `stalled: no byte more in ${STALL_S} s (${got})`;
    return null;
  }
}

function killTree(child) {
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** The real clock: `every(ms, fn)` calls fn every ms and returns what stops it. */
export const realClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

/** download-artifact's inputs as the runner would give them (INPUT_*), over `env` without ours. */
export function childEnv(env, { name = '', pattern = '', dest, mergeMultiple = 'false', runId = '', token = '' }) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('INPUT_')));
  return {
    ...out,
    INPUT_NAME: name,
    INPUT_PATTERN: pattern,
    INPUT_PATH: dest,
    'INPUT_MERGE-MULTIPLE': mergeMultiple,
    'INPUT_RUN-ID': runId || env.GITHUB_RUN_ID || '',
    'INPUT_GITHUB-TOKEN': token,
    INPUT_REPOSITORY: env.GITHUB_REPOSITORY ?? '',
    'INPUT_ARTIFACT-IDS': '',
    'INPUT_SKIP-DECOMPRESS': 'false',
    'INPUT_DIGEST-MISMATCH': 'error',
  };
}

/**
 * Runs download-artifact's `script` with `env` into `dest` under the Watchdog's limits (`capMs`).
 * Resolves { ok, why, bytes, seconds }: `why` says what went wrong (empty when ok), `bytes` what
 * download-artifact listed. Its `::error` lines become warnings: try 2 may still get the files.
 * `clock` (now, every) is injectable, so the tests decide when time passes.
 */
export function downloadOnce({ script, env, dest, capMs = Infinity, node = process.execPath, clock = realClock, log = console.log }) {
  return new Promise((resolve) => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-artifact-')), 'output');
    fs.writeFileSync(outFile, '');
    const start = clock.now();
    const dog = new Watchdog(start, bytesUnder(dest), capMs);
    // Its own process group, so a kill also stops whatever it started.
    const child = spawn(node, [script], { env: { ...env, GITHUB_OUTPUT: outFile }, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let cut = '';
    let lastError = '';
    const pending = { stdout: '', stderr: '' };
    const onLine = (line) => {
      const listed = parseListed(line);
      if (listed) dog.listed(listed.bytes, clock.now());
      if (line.startsWith('::error')) {
        lastError = line.replace(/^::error[^:]*::/, '');
        line = line.replace(/^::error/, '::warning');
      }
      log(line);
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (d) => {
        const lines = (pending[stream] + d).split(/\r?\n/);
        pending[stream] = lines.pop();
        lines.forEach(onLine);
      });
    }
    const stop = clock.every(POLL_MS, () => {
      if (cut) return;
      const why = dog.check(bytesUnder(dest), clock.now());
      if (why) {
        cut = why;
        killTree(child);
      }
    });
    child.on('close', (code) => {
      stop();
      for (const stream of ['stdout', 'stderr']) if (pending[stream]) onLine(pending[stream]);
      fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
      const seconds = Math.round((clock.now() - start) / 1000);
      const why = cut || (code === 0 ? '' : lastError || `download-artifact ended with exit code ${code}`);
      resolve({ ok: !why, why, bytes: dog.bytes, seconds });
    });
  });
}
