// .github/actions/fetch-remote: see action.yml and fetch.mjs.
import fs from 'node:fs';
import { fetchActions } from './fetch.mjs';

const repos = (process.env.INPUT_REPOS ?? '').split(/[\s,]+/).filter(Boolean);
const optional = (process.env.INPUT_OPTIONAL ?? '').trim() === 'true';
let fetched = false;
try {
  if (repos.length === 0) throw new Error('fetch-remote: no repos given');
  await fetchActions({ workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(), repos });
  fetched = true;
} catch (err) {
  console.log(`::${optional ? 'warning' : 'error'}::${err.message}${optional ? ' (going on without it)' : ''}`);
  if (!optional) process.exitCode = 1;
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `fetched=${fetched}\n`);
