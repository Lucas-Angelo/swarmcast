// SemVer 2.0.0 for the release scripts (no dependency: `semver` is only a transitive one).
//
// Release versions are `X.Y.Z` (stable) or `X.Y.Z-beta.N` / `X.Y.Z-rc.N` (pre-releases, the beta
// channel; docs/RELEASING.md section 4). SemVer orders them as
//   0.3.0-beta.1 < 0.3.0-beta.2 < 0.3.0-beta.11 < 0.3.0-rc.1 < 0.3.0
// which is also what the desktop app's updater uses (semver::Version), so a pre-release is never
// "newer" than its own stable version.

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The only versions release.yml publishes: stable, or beta.N / rc.N pre-releases (N ≥ 1). */
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|rc)\.[1-9]\d*)?$/;

/**
 * @param {string} v a version, with or without a leading "v"
 * @returns {{ major: number, minor: number, patch: number, pre: Array<string | number>, build: string }} or null if not SemVer
 */
export function parse(v) {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, build: m[5] ?? '' };
}

/** SemVer precedence (§11): -1, 0 or 1. Build metadata is ignored. Throws on a non-SemVer input. */
export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x) throw new Error(`not a SemVer version: ${a}`);
  if (!y) throw new Error(`not a SemVer version: ${b}`);
  for (const k of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  // A version without pre-release identifiers is higher than one with them.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    // Numeric identifiers sort numerically and below alphanumeric ones.
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(v) {
  const p = parse(v);
  if (!p) throw new Error(`not a SemVer version: ${v}`);
  return p.pre.length > 0;
}

/**
 * The update channel a release version goes to: `stable`, or `beta` for beta.N / rc.N.
 * Anything else (alpha, beta2, build metadata, a leading "v") throws: release.yml stops there.
 */
export function releaseChannel(v) {
  if (!RELEASE_VERSION.test(String(v))) {
    throw new Error(`${v} is not a release version: use X.Y.Z, X.Y.Z-beta.N or X.Y.Z-rc.N (a dot before the number, N from 1)`);
  }
  return String(v).includes('-') ? 'beta' : 'stable';
}

/**
 * Should this release become GitHub's "Latest"? Only a stable version that is at least every
 * stable release already published, so a hotfix on an older line (0.2.3 after 0.3.0) does not
 * take the download button back to the old line.
 * @param {string} version
 * @param {string[]} stableTags tags of the published, non-pre-release releases
 */
export function isLatestStable(version, stableTags) {
  if (isPrerelease(version)) return false;
  return stableTags.filter((t) => parse(t) && !isPrerelease(t)).every((t) => compare(version, t) >= 0);
}

/**
 * The Version field of the .deb. dpkg reads `0.3.0-beta.1` as upstream version 0.3.0 with Debian
 * revision `beta.1`, which sorts ABOVE 0.3.0: apt then refuses the stable 0.3.0 as a downgrade
 * ("Packages were downgraded and -y was used without --allow-downgrades") and `dpkg -i` (the
 * updater) warns "downgrading". `~` sorts before everything, so `0.3.0~beta.1 < 0.3.0~rc.1 < 0.3.0`.
 * A stable version is unchanged. Hyphens inside the pre-release become dots (a Debian upstream
 * version may only contain a hyphen when it also has a revision).
 */
export function debianVersion(v) {
  const p = parse(v);
  if (!p) throw new Error(`not a SemVer version: ${v}`);
  const base = `${p.major}.${p.minor}.${p.patch}`;
  const pre = p.pre.length ? `~${p.pre.join('.').replaceAll('-', '.')}` : '';
  const build = p.build ? `+${p.build.replaceAll('-', '.')}` : '';
  return `${base}${pre}${build}`;
}
