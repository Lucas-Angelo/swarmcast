#!/usr/bin/env node
// Archive release/staging/<target> into release/SwarmCast-v<version>-<target>.(zip|tar.gz).
// Files sit at the archive root (no top-level folder), as the start scripts expect.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// On Windows, Git for Windows puts GNU tar first in PATH; it reads "C:\..." as a remote host.
// The OS ships bsdtar (which also handles .zip) in System32.
function tarBin() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function has(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function archive(target, version) {
  const staging = path.join(root, 'release', 'staging', target);
  if (!fs.existsSync(path.join(staging, 'VERSION'))) throw new Error(`${staging} is not staged`);
  const isWin = target.startsWith('windows');
  const out = path.join(root, 'release', `SwarmCast-v${version}-${target}.${isWin ? 'zip' : 'tar.gz'}`);
  fs.rmSync(out, { force: true });
  const entries = fs.readdirSync(staging);
  if (isWin) {
    if (process.platform !== 'win32' && has('zip')) {
      execFileSync('zip', ['-qr', '-X', out, ...entries], { cwd: staging, stdio: 'inherit' });
    } else {
      // bsdtar (Windows 10+, macOS) writes zip with -a based on the extension.
      execFileSync(tarBin(), ['-a', '-cf', out, ...entries], { cwd: staging, stdio: 'inherit' });
    }
  } else {
    const env = { ...process.env, COPYFILE_DISABLE: '1' }; // no macOS ._ files
    // bsdtar on macOS would also store extended attributes (com.apple.provenance) that GNU
    // tar on Linux warns about.
    const noMeta = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : [];
    execFileSync(tarBin(), [...noMeta, '-czf', out, ...entries], { cwd: staging, stdio: 'inherit', env });
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = arg('version', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  const target = arg('target');
  if (!target) throw new Error('--target is required');
  archive(target, version).then((o) => console.log(`✓ ${path.relative(root, o)}`));
}
