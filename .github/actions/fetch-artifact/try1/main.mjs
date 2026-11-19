// .github/actions/fetch-artifact/try1: see action.yml and ../download.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchActions } from '../../fetch-remote/fetch.mjs';
import { childEnv, downloadPlaced } from '../download.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const setOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
const what = input('name') || input('pattern');

let result;
let script = null;
try {
  // Two tries, 5 s apart (at most 2 x 30 + 5 s): when git cannot fetch it, try 2 goes on without it.
  const [dir] = await fetchActions({ workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(), repos: ['actions/download-artifact'], waits: [5] });
  script = path.join(dir, 'dist', 'index.js');
  if (!fs.existsSync(script)) throw new Error('actions/download-artifact has no dist/index.js');
} catch (err) {
  result = { ok: false, why: `download-artifact could not be fetched (${err.message})`, bytes: 0, seconds: 0 };
}
if (!result) {
  // Where download-artifact would put the files (its own `~` expansion and path.resolve); it
  // writes into a folder next to it, moved in only when the download finished (../place.mjs).
  const dest = path.resolve(input('path').replace(/^~/, os.homedir()));
  const env = (stage) =>
    childEnv(process.env, {
      name: input('name'),
      pattern: input('pattern'),
      dest: stage,
      mergeMultiple: input('merge-multiple') || 'false',
      runId: input('run-id'),
      token: input('github-token'),
    });
  result = await downloadPlaced({ script, env, dest, limitMs: Number(input('max-try-seconds')) * 1000 });
}
if (result.ok) console.log(`fetch-artifact: ${what}: ${result.bytes} bytes in ${result.seconds} s (try 1 of 2, download-artifact)`);
else console.log(`::warning title=Artifact download::${what}: try 1 of 2 (download-artifact) failed after ${result.seconds} s: ${result.why}; try 2 goes through the REST API`);
setOutput('ok', result.ok);
setOutput('why', result.why);
setOutput('bytes', result.bytes || '');
