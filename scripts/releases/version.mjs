#!/usr/bin/env node
// Classify a release version for release.yml (verify job):
//
//   node scripts/releases/version.mjs <version> [<stable tag>...]
//
// prints, for $GITHUB_OUTPUT:
//   channel=stable|beta     beta for X.Y.Z-beta.N and X.Y.Z-rc.N
//   prerelease=true|false
//   is_latest=true|false    a stable version ≥ every stable tag given (GitHub's "Latest")
// and exits with 1 (and a ::error:: line) for any other pre-release identifier (alpha, beta2,
// beta.0, build metadata…): those are never published.
import { fileURLToPath } from 'node:url';
import { isLatestStable, releaseChannel } from './semver.mjs';

/**
 * Remote branches (`origin/...`) a release tag may sit on: main, or the maintenance branch
 * release/X.Y; a pre-release X.Y.Z-beta.N / -rc.N also release/X.Y.Z (the minor's release pull
 * request branch, before it is merged: main only takes the stable version), with that same X.Y.Z.
 * @param {string} version
 */
export function allowedTagBranches(version) {
  releaseChannel(version); // throws for anything else
  const [core, pre] = version.split('-');
  const minor = core.split('.').slice(0, 2).join('.');
  return ['origin/main', `origin/release/${minor}`, ...(pre ? [`origin/release/${core}`] : [])];
}

/** @param {string[]} argv */
export function classify(argv) {
  const [version, ...stableTags] = argv;
  if (!version) throw new Error('usage: version.mjs <version> [<stable tag>...]');
  const channel = releaseChannel(version);
  const prerelease = channel === 'beta';
  return { channel, prerelease, is_latest: !prerelease && isLatestStable(version, stableTags.filter(Boolean)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [first, ...rest] = process.argv.slice(2);
  // node version.mjs --on-branch <version> <remote branch>...: exit 1 unless one is allowed.
  if (first === '--on-branch') {
    try {
      const [version, ...branches] = rest;
      const allowed = allowedTagBranches(version);
      const ok = branches.filter((b) => allowed.includes(b));
      if (ok.length === 0) throw new Error(`v${version} is not on ${allowed.join(', ')} (it is on: ${branches.join(', ') || 'no remote branch'})`);
      console.log(`v${version} is on ${ok.join(', ')}`);
    } catch (err) {
      console.error(`::error::${err.message}. Tag the release commit there (docs/RELEASING.md, section 4).`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const r = classify(process.argv.slice(2));
    for (const [k, v] of Object.entries(r)) console.log(`${k}=${v}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
