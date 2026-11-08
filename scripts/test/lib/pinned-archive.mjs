// The verified archive of a pinned tool (scripts/build/versions.json) in CI's download cache, for
// the system tests that use a third-party file without downloading it at test time: the setup
// action fetches it before the tests (fetch-binaries.mjs --only <tool>, a set-up download with its
// own recoveries) and the test reads it from SC_DOWNLOAD_CACHE (docs/TESTING.md, "No third-party
// service in the gate").
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cachedArchive } from '../../build/fetch-binaries.mjs';

/**
 * The archive of asset `a` (versions.json `<tool>.assets[<target>]`) in SC_DOWNLOAD_CACHE,
 * checked against its pinned SHA-256. Throws, saying how to get it, when it is missing or wrong:
 * `setupInput` is the setup action's input that fetches it.
 * @param {{ asset: string, sha256: string }} a
 * @param {{ tool: string, setupInput: string, env?: NodeJS.ProcessEnv }} o
 * @returns {string}
 */
export function pinnedArchive(a, { tool, setupInput, env = process.env }) {
  const how = `CI: the setup action's ${setupInput} input; by hand: SC_DOWNLOAD_CACHE=<dir> node scripts/build/fetch-binaries.mjs --only ${tool} --out <dir2>`;
  if (!env.SC_DOWNLOAD_CACHE) throw new Error(`SC_DOWNLOAD_CACHE is not set: no pinned ${tool} archive (${how})`);
  const file = cachedArchive(path.resolve(env.SC_DOWNLOAD_CACHE), a);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing (${how})`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== a.sha256) throw new Error(`${file} does not match the pin: expected ${a.sha256}, got ${actual}`);
  return file;
}
