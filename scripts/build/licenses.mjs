// Collect license texts of everything shipped in a package: npm production dependencies
// of the server, viewer and admin bundles, plus MediaMTX, cloudflared and the tray helper, and
// the Fredoka font. For the desktop app (desktop.mjs) also the Rust crates compiled into it
// (crate-licenses.mjs) and what its installers carry, instead of the Go tray helper.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crateLicenses } from './crate-licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
/** The Fredoka licence next to the font files the panel and viewer pages bundle. */
export const FREDOKA_OFL = path.join(root, 'packages', 'shared', 'web', 'fonts', 'OFL-Fredoka.txt');

function prodPackages() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable', '--workspaces'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(String(out).split(/\r?\n/).filter((p) => p.includes(`${path.sep}node_modules${path.sep}`)))];
}

function licenseText(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) return fs.readFileSync(path.join(dir, name), 'utf8').trim();
  }
  return null;
}

/** What the desktop installers of each OS carry besides the app and its crates. */
function desktopInstallerNotes(target) {
  if (target.startsWith('windows')) {
    return [
      '== NSIS (https://nsis.sourceforge.io), the Windows installer and uninstaller — zlib/libpng License ==',
      '== Tauri NSIS plugins (https://github.com/tauri-apps/nsis-tauri-utils) — MIT OR Apache-2.0 ==',
      '== Microsoft Edge WebView2 Runtime bootstrapper (Windows installer only: installs the WebView2 Runtime when it is missing) — Microsoft software license terms, https://developer.microsoft.com/microsoft-edge/webview2/ ==',
    ];
  }
  if (target.startsWith('linux')) {
    return [
      '== AppImage runtime (https://github.com/AppImage/type2-runtime) — MIT License (.AppImage only) ==',
      'The .AppImage also carries shared libraries copied from the build system (GTK, WebKitGTK and their',
      'dependencies; most are LGPL-2.1-or-later). Their licences and source code are those of the Ubuntu',
      'packages they come from (https://packages.ubuntu.com/, https://launchpad.net/ubuntu). The .deb carries',
      'none of them: it uses the ones of your system.',
    ];
  }
  return [];
}

/**
 * The THIRD_PARTY_LICENSES.txt text.
 * @param {{ desktop?: { target: string, triple: string, manifestPath?: string } }} [options]
 *   desktop: for the desktop app of that release target / Rust triple (adds the Rust crates and
 *   throws when one has no allowed licence; no Go tray helper).
 */
export function thirdPartyLicenses({ desktop } = {}) {
  const sections = [
    desktop ? 'The SwarmCast desktop app bundles the following third-party software.' : 'SwarmCast bundles the following third-party software.',
    '',
    '== MediaMTX (https://github.com/bluenviron/mediamtx) — MIT License ==',
    '== cloudflared (https://github.com/cloudflare/cloudflared) — Apache License 2.0 ==',
    ...(desktop
      ? ['== Tauri (https://tauri.app) and the other Rust crates of the app window — see "Rust crates" at the end ==', ...desktopInstallerNotes(desktop.target)]
      : ['== fyne.io/systray (https://github.com/fyne-io/systray) — Apache License 2.0 (tray helper) ==']),
    '== Node.js runtime (https://nodejs.org) — MIT License and bundled third-party licenses: https://github.com/nodejs/node/blob/main/LICENSE ==',
    '',
    'NOT bundled: FFmpeg (https://ffmpeg.org), used for the optional extra viewer qualities. The start scripts',
    '(or the panel button "Install the video converter") download the build pinned in binaries.json straight',
    'from its publisher on the user\'s own computer and verify its SHA-256: BtbN FFmpeg-Builds (LGPL-3.0-or-later)',
    'on Windows and Linux, Martin Riedl builds (GPL-3.0-or-later) on macOS. SwarmCast does not redistribute',
    'FFmpeg; it runs it as a separate program. <data>/tools/ffmpeg/SOURCE.txt records where it came from.',
    '',
    '== Fredoka font (https://github.com/hafontia/Fredoka-One), in web/*/assets — SIL Open Font License 1.1 ==',
    fs.readFileSync(FREDOKA_OFL, 'utf8').trim(),
    '',
    "== Emoji names and keywords of the viewer's chat emoji picker — from emojibase-data (MIT, listed below), ==",
    'which builds them from the Unicode CLDR annotations: Unicode License v3, https://www.unicode.org/license.txt.',
    'Copyright © 1991-2025 Unicode, Inc. The emoji themselves are drawn by the operating system, not shipped.',
    '',
  ];
  let pkgs = [];
  try {
    pkgs = prodPackages();
  } catch {
    pkgs = [];
  }
  const seen = new Set();
  for (const dir of pkgs.sort()) {
    let pj;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const id = `${pj.name}@${pj.version}`;
    if (seen.has(id) || pj.name?.startsWith('@swarmcast/') || pj.private) continue;
    seen.add(id);
    const lic = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? 'see package';
    sections.push(`== ${id} — ${lic} ==`);
    const text = licenseText(dir);
    if (text) sections.push(text);
    sections.push('');
  }
  if (desktop) sections.push(crateLicenses({ triple: desktop.triple, manifestPath: desktop.manifestPath }).text);
  return { text: sections.join('\n'), npmPackages: seen.size };
}

/** Write THIRD_PARTY_LICENSES.txt (see thirdPartyLicenses for the options). Returns the npm package count. */
export function writeThirdPartyLicenses(outFile, options = {}) {
  const { text, npmPackages } = thirdPartyLicenses(options);
  fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`);
  return npmPackages;
}
