// .github/actions/cache-restore: see action.yml and .github/actions/cache-restore/restore.mjs.
import fs from 'node:fs';
import { fetchActions } from '../fetch-remote/fetch.mjs';
import { restore, restoreScriptIn } from './restore.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const setOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);

const key = input('key');
// actions/cache at its pin (.github/actions/remote-pins), fetched with git and its own tries
// (../fetch-remote/fetch.mjs); in a job that has it already, nothing is fetched.
let script = null;
try {
  const [dir] = await fetchActions({ workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(), repos: ['actions/cache'] });
  script = restoreScriptIn(dir);
  if (!script) console.log(`::warning::cache restore of ${key}: actions/cache has no dist/restore-only/index.js, going on without the cache`);
} catch (err) {
  console.log(`::warning::cache restore of ${key}: ${err.message}, going on without the cache`);
}
if (!script) {
  setOutput('cache-hit', 'false');
  setOutput('cache-matched-key', '');
} else {
  const result = await restore({
    script,
    paths: lines(input('path')),
    key,
    restoreKeys: lines(input('restore-keys')),
    timeoutMs: Number(input('timeout-seconds') || '90') * 1000,
    tries: Number(input('tries') || '2'),
  });
  const summary = result.tries.map((t, i) => `try ${i + 1}: ${t.seconds} s${t.timedOut ? ' (cut off)' : t.failed ? ' (failed)' : ''}`).join(', ');
  console.log(`${result.matchedKey ? `restored ${result.matchedKey}` : 'no cache restored'} (${summary})`);
  setOutput('cache-hit', String(result.hit));
  setOutput('cache-matched-key', result.matchedKey);
}
