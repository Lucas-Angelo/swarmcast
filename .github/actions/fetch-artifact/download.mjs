// Try 1 of fetch-artifact (.github/actions/fetch-artifact/action.yml): actions/download-artifact,
// run as a child process with a time limit of its own and a cut when the download stops making
// progress, into a folder of its own that is moved into the destination only when the download
// finished (place.mjs).
//
// A composite action's steps cannot have a timeout-minutes; they share what is left of the calling
// step's (.github/workflows/README.md, "Artifact uploads"). When download-artifact ran as such a
// step, a blob download that stalled used up the caller's whole limit: release rehearsal
// 44018931697 (`docker / AppImage debian:12 x64`) got the 200 for linux-docker-x64 (335 MB), then
// nothing for 599 s, until "The action has timed out" ended try 1 and, in the same instant, every
// step after it (the diagnostics in 7 ms, try 2 skipped). So download-artifact runs here, from the
// copy ../fetch-remote fetches, under limits of its own: LIST_S to list the artifacts
// (`- <name> (ID: <id>, Size: <bytes>, ...)`); then the whole try has, from its start, the
// caller's `max-try-seconds`, the room its step leaves each try ((step limit - 110 s - the step's
// other work) / 2), and it is cut off as soon as STALL_S pass without a byte more. The stall cut is
// the guard against a download that hangs; a slow one that keeps moving may use the whole room:
// release rehearsal 44603650109 cut the crates' 82 MB off at a size-based 50 s with 73.5 MB
// written (the blob store sent about 1.5 MB/s, and 0.8 MB/s to try 2). Try 2 (rest.sh fetch,
// another client and route) has the same limit.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placeInto, removeStage, stageFor } from './place.mjs';

const isWin = process.platform === 'win32';

/** Seconds without a byte more in the destination after which a try has stalled. */
export const STALL_S = 30;
/** Seconds for download-artifact to start and list the artifacts (it takes about 1 s). */
export const LIST_S = 30;
/** How often the destination is measured. */
export const POLL_MS = 2_000;

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
 * must be cut off, or null. `limitMs` bounds the whole try from its start (the caller's
 * `max-try-seconds`); STALL_S without a byte more ends it sooner.
 */
export class Watchdog {
  constructor(now, size, limitMs) {
    if (!(limitMs > 0)) throw new Error(`a try needs a time limit (max-try-seconds), got ${limitMs}`);
    this.start = now;
    this.limitMs = limitMs;
    this.listedAt = null;
    this.bytes = 0;
    this.count = 0;
    this.deadline = now + Math.min(LIST_S * 1000, limitMs);
    this.size = size;
    this.progressAt = now;
  }

  listed(bytes, now) {
    this.bytes += bytes;
    this.count += 1;
    this.listedAt ??= now;
    this.deadline = this.start + this.limitMs;
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
 * Runs download-artifact's `script` with `env` into `dest` under the Watchdog's limits (`limitMs`).
 * Resolves { ok, why, bytes, seconds }: `why` says what went wrong (empty when ok), `bytes` what
 * download-artifact listed. Its `::error` lines become warnings: try 2 may still get the files.
 * `clock` (now, every) is injectable, so the tests decide when time passes.
 */
export function downloadOnce({ script, env, dest, limitMs, node = process.execPath, clock = realClock, log = console.log }) {
  return new Promise((resolve) => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-artifact-')), 'output');
    fs.writeFileSync(outFile, '');
    const start = clock.now();
    const dog = new Watchdog(start, bytesUnder(dest), limitMs);
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

/**
 * Try 1 as fetch-artifact runs it: downloadOnce into a new folder next to `dest` (`env(stage)`
 * gives download-artifact its inputs with that folder as its path), and only when it finished, its
 * files moved into `dest`. A try that failed, stalled or was cut off leaves `dest` as it was:
 * download-artifact unzips as the bytes arrive, so a cut-off try has a part of each file written,
 * and nothing may take that for the artifact. Same result as downloadOnce.
 */
export async function downloadPlaced({ script, env, dest, limitMs, node = process.execPath, clock = realClock, log = console.log }) {
  const stage = stageFor(dest);
  try {
    const result = await downloadOnce({ script, env: env(stage), dest: stage, limitMs, node, clock, log });
    if (result.ok) {
      try {
        placeInto(stage, dest);
      } catch (err) {
        return { ...result, ok: false, why: `could not move the download into ${dest} (${err.message})` };
      }
    }
    return result;
  } finally {
    removeStage(stage, log);
  }
}
