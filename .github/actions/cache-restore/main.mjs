// .github/actions/cache-restore: see action.yml and .github/actions/cache-restore/restore.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { findRestoreScript, restore } from './restore.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const setOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);

const key = input('key');
// The runner keeps the actions it downloads for the job in <work>/_actions (RUNNER_WORKSPACE is
// <work>/<repository>).
const script = findRestoreScript(path.join(process.env.RUNNER_WORKSPACE ?? '', '..', '_actions'));
if (!script) {
  console.log(`::warning::cache restore of ${key}: actions/cache was not downloaded for this job (reference it in a step), going on without the cache`);
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
