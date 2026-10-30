// The Version field of a .deb for a SemVer pre-release (desktop.mjs, Linux).
//
// Tauri writes the app version into the .deb as it is: `0.3.0-beta.1`. dpkg reads that as upstream
// version 0.3.0 with Debian revision `beta.1`, which sorts ABOVE `0.3.0`: going from the beta to the
// stable 0.3.0 is then a downgrade for dpkg (apt refuses it with -y, `dpkg -i`, which the updater
// runs, warns "downgrading"). The .deb gets `0.3.0~beta.1` instead (semver.mjs debianVersion). The
// file name, the app inside and the updater keep the SemVer version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The control file with its Version field replaced (throws when it has none). */
export function withVersion(control, version) {
  if (!/^[0-9][A-Za-z0-9.+~]*$/.test(version)) throw new Error(`not a Debian upstream version: ${version}`);
  if (!/^Version: .*$/m.test(control)) throw new Error('the control file has no Version field');
  return control.replace(/^Version: .*$/m, `Version: ${version}`);
}

/**
 * Rewrites the Version field of `deb` in place: unpacks it (dpkg-deb -R), edits DEBIAN/control and
 * packs it again owned by root, as Tauri's own .deb is. Everything else is unchanged.
 */
export function setDebVersion(deb, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-deb-'));
  try {
    const root = path.join(tmp, 'root');
    execFileSync('dpkg-deb', ['-R', deb, root]);
    const control = path.join(root, 'DEBIAN', 'control');
    fs.writeFileSync(control, withVersion(fs.readFileSync(control, 'utf8'), version));
    const out = path.join(tmp, 'out.deb');
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zgzip', '--build', root, out], { stdio: ['ignore', 'ignore', 'inherit'] });
    fs.copyFileSync(out, deb);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const written = execFileSync('dpkg-deb', ['--field', deb, 'Version'], { encoding: 'utf8' }).trim();
  if (written !== version) throw new Error(`${path.basename(deb)} has Version ${written} after the rewrite, not ${version}`);
}
