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

/** @param {string[]} argv */
export function classify(argv) {
  const [version, ...stableTags] = argv;
  if (!version) throw new Error('usage: version.mjs <version> [<stable tag>...]');
  const channel = releaseChannel(version);
  const prerelease = channel === 'beta';
  return { channel, prerelease, is_latest: !prerelease && isLatestStable(version, stableTags.filter(Boolean)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const r = classify(process.argv.slice(2));
    for (const [k, v] of Object.entries(r)) console.log(`${k}=${v}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
