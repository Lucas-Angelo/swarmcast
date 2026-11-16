#!/usr/bin/env node
// The saved copy of the device suite's Android SDK archives (scripts/test/devices/android-sdk.pins):
// an artifact that main's build stage saves (.github/actions/android-sdk/save) and the devices
// workflow's Android job restores (.github/actions/android-sdk), so that `setup.sh install android`
// installs with no download (.github/workflows/README.md, "Android SDK").
//
//   node .github/scripts/android-sdk.mjs find <name>   run-id= and artifact-id= of the saved copy, or nothing
//   node .github/scripts/android-sdk.mjs plan <name>   save=true when main must save it (again), else nothing
//
// Environment: GITHUB_REPOSITORY, GITHUB_TOKEN (actions: read), GITHUB_API_URL, TRUSTED_BRANCHES
// (the default branch only: only main saves it). Trusted as test-images.mjs trusts: a run of this
// repository, not a fork's, not about to expire; the newest wins. The name holds a hash of the
// pins (`setup.sh artifact android`), and setup.sh checks every archive's SHA-256 anyway.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findArtifact, findCommand } from './test-images.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Main saves a new copy once the newest has less than this left of its 90 days: about every 60
 * days, so a copy is always there for the devices jobs (which run on main by hand only) as long
 * as main's pipeline runs, and at most two (about 2.4 GB each) exist at once.
 */
export const REFRESH_MS = 30 * DAY_MS;

/**
 * Whether main must save the copy: none yet (the first run after a pin change, or after one
 * expired), or the newest expires within REFRESH_MS of `now`.
 * @param {{ expires_at: string } | null} newest
 * @param {number} now
 */
export function needsSave(newest, now) {
  return newest === null || Date.parse(newest.expires_at) - now < REFRESH_MS;
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'find' && name) {
    await findCommand(name, 'android-sdk');
    return;
  }
  if (cmd === 'plan' && name) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const base = process.env.GITHUB_API_URL || 'https://api.github.com';
    const branches = (process.env.TRUSTED_BRANCHES || '').split(/\s+/).filter(Boolean);
    if (!repo || !token || branches.length === 0) {
      console.error('android-sdk: GITHUB_REPOSITORY, GITHUB_TOKEN and TRUSTED_BRANCHES are required');
      process.exit(2);
    }
    const newest = await findArtifact({ name, repo, token, base, branches, label: 'android-sdk' });
    if (needsSave(newest, Date.now())) {
      console.error(newest ? `android-sdk: ${name} expires ${newest.expires_at}: saving a new copy` : `android-sdk: saving ${name}`);
      console.log('save=true');
    }
    return;
  }
  console.error('usage: android-sdk.mjs find|plan <artifact name>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`android-sdk: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
