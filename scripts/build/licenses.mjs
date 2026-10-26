// Collect license texts of everything shipped in a package: npm production dependencies
// of the server, viewer and admin bundles, plus MediaMTX, cloudflared and the tray helper.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

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
  for (const name of fs.readdirSync(dir)) {
    if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) return fs.readFileSync(path.join(dir, name), 'utf8').trim();
  }
  return null;
}

export function writeThirdPartyLicenses(outFile) {
  const sections = [
    'SwarmCast bundles the following third-party software.',
    '',
    '== MediaMTX (https://github.com/bluenviron/mediamtx) — MIT License ==',
    '== cloudflared (https://github.com/cloudflare/cloudflared) — Apache License 2.0 ==',
    '== fyne.io/systray (https://github.com/fyne-io/systray) — Apache License 2.0 (tray helper) ==',
    '== Node.js runtime (https://nodejs.org) — MIT License and bundled third-party licenses: https://github.com/nodejs/node/blob/main/LICENSE ==',
    '',
    'NOT bundled: FFmpeg (https://ffmpeg.org), used for the optional extra viewer qualities. The start scripts',
    '(or the panel button "Install the video converter") download the build pinned in binaries.json straight',
    'from its publisher on the user\'s own computer and verify its SHA-256: BtbN FFmpeg-Builds (LGPL-3.0-or-later)',
    'on Windows and Linux, Martin Riedl builds (GPL-3.0-or-later) on macOS. SwarmCast does not redistribute',
    'FFmpeg; it runs it as a separate program. <data>/tools/ffmpeg/SOURCE.txt records where it came from.',
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
  fs.writeFileSync(outFile, sections.join('\n'));
  return seen.size;
}
