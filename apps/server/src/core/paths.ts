import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Per-user data directory. Never requires admin rights. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (env.SWARMCAST_DATA_DIR) return path.resolve(env.SWARMCAST_DATA_DIR);
  const home = os.homedir();
  switch (platform) {
    case 'win32':
      return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'SwarmCast');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'SwarmCast');
    default:
      return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'swarmcast');
  }
}

export interface AppPaths {
  dataDir: string;
  configFile: string;
  secretsFile: string;
  stateFile: string;
  logsDir: string;
  runDir: string;
  binDir: string;
  viewerDir: string;
  adminDir: string;
  /** Directory holding tray icons (generated at runtime). */
  iconsDir: string;
}

/** True when running as the packaged single executable (built with @yao-pkg/pkg). */
export function isPackaged(): boolean {
  return !!(process as unknown as { pkg?: unknown }).pkg || process.env.SWARMCAST_PACKAGED === '1';
}

/** Root of the source checkout (dev mode only). */
function repoRoot(): string {
  const here = typeof __filename !== 'undefined' ? path.dirname(__filename) : path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'apps', 'server')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function platformTag(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  return `${os}-${arch}`;
}

export function resolvePaths(dataDir = defaultDataDir()): AppPaths {
  let installDir: string;
  let binDir: string;
  if (isPackaged()) {
    installDir = path.dirname(process.execPath);
    binDir = path.join(installDir, 'bin');
  } else {
    installDir = repoRoot();
    binDir = path.join(installDir, 'vendor', platformTag());
  }
  if (process.env.SWARMCAST_BIN_DIR) binDir = path.resolve(process.env.SWARMCAST_BIN_DIR);
  const webRoot = isPackaged() ? path.join(installDir, 'web') : null;
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    secretsFile: path.join(dataDir, 'secrets.json'),
    stateFile: path.join(dataDir, 'state.json'),
    logsDir: path.join(dataDir, 'logs'),
    runDir: path.join(dataDir, 'run'),
    binDir,
    viewerDir: webRoot ? path.join(webRoot, 'viewer') : path.join(installDir, 'apps', 'viewer', 'dist'),
    adminDir: webRoot ? path.join(webRoot, 'admin') : path.join(installDir, 'apps', 'admin', 'dist'),
    iconsDir: path.join(dataDir, 'run', 'icons'),
  };
}

export function exe(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/** Create a directory readable only by the current user. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
}

/** Atomically write a file readable only by the current user. */
export function writePrivateFile(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
