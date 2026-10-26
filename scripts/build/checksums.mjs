#!/usr/bin/env node
// Writes <dir>/SHA256SUMS.txt for every regular file directly inside <dir> (except the
// checksum file itself), in GNU coreutils format so `sha256sum -c SHA256SUMS.txt` works:
//
//   <sha256>  <file name>
//
// Usage: node scripts/build/checksums.mjs <dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const SUMS_FILE = 'SHA256SUMS.txt';

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Hashes the files in `dir`, writes `dir/SHA256SUMS.txt` and returns its contents. */
export async function writeChecksums(dir) {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== SUMS_FILE)
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) throw new Error(`no files to checksum in ${dir}`);
  let out = '';
  for (const name of names) out += `${await sha256(path.join(dir, name))}  ${name}\n`;
  fs.writeFileSync(path.join(dir, SUMS_FILE), out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/build/checksums.mjs <dir>');
    process.exit(2);
  }
  writeChecksums(path.resolve(dir))
    .then((out) => {
      process.stdout.write(out);
      console.log(`wrote ${path.join(dir, SUMS_FILE)}`);
    })
    .catch((err) => {
      console.error(`checksums.mjs: ${err.message}`);
      process.exit(1);
    });
}
