// Files reach their destination only when they are complete: a download or an unpack writes into
// a folder of its own next to the destination (stageFor), and only what came out whole and
// checked is moved in (placeInto); a try that failed, stalled or was cut off leaves the
// destination as it was. Release rehearsal 44603650109 (`docker / Build linux-x64`): try 1 of
// fetch-artifact was cut off with 73.5 of the crates' 82 MB written into its path, try 2 timed out
// too, and the cargo-crates step unpacked that half tar into the cargo registry; its last .crate,
// cut short, then broke the cold path's `cargo fetch` (.github/workflows/README.md, "Artifact
// downloads").
//
//   node place.mjs <from> <to>   moves everything in <from> into <to> (rest.sh, after try 2's
//                                artifacts all came with their recorded size and digest)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A new, empty folder next to `dest` (same file system, so placing is a rename), named so that
 * nothing takes it for `dest`'s own content.
 * @param {string} dest
 * @param {string} [prefix]
 */
export function stageFor(dest, prefix = '.fetch-artifact-') {
  const parent = path.dirname(path.resolve(dest));
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function move(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Moves every entry of `from` into `to` (created when missing): a folder that is in both is
 * merged, anything else in `to` with the same name is replaced. Returns the paths it put in `to`,
 * so a caller whose later check fails can take them out again.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function placeInto(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const placed = [];
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    const there = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (e.isDirectory() && there?.isDirectory()) {
      placed.push(...placeInto(src, dst));
      continue;
    }
    if (there) fs.rmSync(dst, { recursive: true, force: true });
    move(src, dst);
    placed.push(dst);
  }
  return placed;
}

/** Removes a stage folder; one that cannot go (a file still held on Windows) is only reported. */
export function removeStage(stage, log = console.log) {
  try {
    fs.rmSync(stage, { recursive: true, force: true });
  } catch (err) {
    log(`fetch-artifact: could not remove ${stage} (${/** @type {Error} */ (err).message}); nothing reads it`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: place.mjs <from> <to>');
    process.exit(2);
  }
  placeInto(from, to);
}
