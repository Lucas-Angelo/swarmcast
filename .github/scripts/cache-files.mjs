#!/usr/bin/env node
// Which cache entries a job saves (.github/actions/setup and setup/save; .github/workflows/README.md,
// "Release downloads").
//
//   node .github/scripts/cache-files.mjs list <dir> <list file>
//   node .github/scripts/cache-files.mjs plan <name> <dir> <list file> <key base>
//
// `list`, right after the restore: writes the files the restore brought (paths under <dir>, one
// per line, sorted) to <list file>, which lives outside <dir>.
// `plan`, at the end of the job: when <dir> now holds a file that the list does not have, prints
// `<name>-key=<key base><GITHUB_RUN_ID>-<12 hex of the file list>` to GITHUB_OUTPUT (and says which
// files are new), so the save step saves a new entry; otherwise prints nothing and the save is
// skipped.
//
// Why not one entry per key, saved when the key missed: an entry is saved once and an exact hit is
// never saved again, so the first job to save a key decided what every later job got. On main,
// `desktop macos-arm64 / clean-machine` (ffmpeg for the preflight, nothing else) saved the
// macOS arm64 entry first after a versions.json change: 28 MB, the test ffmpeg only. The node and
// e2e jobs restored that exact key, downloaded MediaMTX, cloudflared and Pebble from github.com on
// every run, and could not add them to the entry; when github.com answered 504, they failed
// (PR #141). Now a job that brought new files saves a new entry, named by the run and its file
// list, and the restore takes the newest entry of the prefix. A job saves only what it restored
// plus what it added, so the newest entry holds what the jobs before it needed; one that adds
// nothing saves nothing, so a job that needs less never replaces a fuller entry with its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The files under `dir`, as sorted paths relative to it with `/` separators; empty when `dir`
 * does not exist.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/**
 * What to save: the files of `now` that `restored` does not have, and the key of the new entry
 * (`keyBase`, the run, a hash of the whole list), or null when nothing is new.
 * @param {{ now: string[], restored: string[], keyBase: string, runId: string }} o
 * @returns {{ added: string[], key: string | null }}
 */
export function planSave({ now, restored, keyBase, runId }) {
  const before = new Set(restored);
  const added = now.filter((f) => !before.has(f));
  if (added.length === 0) return { added, key: null };
  const hash = crypto.createHash('sha256').update(now.join('\n')).digest('hex').slice(0, 12);
  return { added, key: `${keyBase}${runId}-${hash}` };
}

/** The list file `list` wrote, or an empty list when there is none (nothing was restored). */
function readList(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function main([cmd, ...args]) {
  if (cmd === 'list' && args.length === 2) {
    const [dir, listFile] = args;
    const files = listFiles(dir);
    fs.writeFileSync(listFile, files.map((f) => `${f}\n`).join(''));
    console.log(`${dir}: ${files.length} file(s) restored`);
    return 0;
  }
  if (cmd === 'plan' && args.length === 4) {
    const [name, dir, listFile, keyBase] = args;
    const runId = process.env.GITHUB_RUN_ID;
    if (!runId) throw new Error('GITHUB_RUN_ID is not set');
    const { added, key } = planSave({ now: listFiles(dir), restored: readList(listFile), keyBase, runId });
    if (!key) {
      console.log(`${name}: nothing new in ${dir}, no save`);
      return 0;
    }
    console.log(`${name}: ${added.length} new file(s) (${added.join(', ')}): save as ${key}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}-key=${key}\n`);
    return 0;
  }
  console.error('usage: cache-files.mjs list <dir> <list file> | plan <name> <dir> <list file> <key base>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
