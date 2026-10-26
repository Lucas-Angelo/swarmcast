import fs from 'node:fs';
import path from 'node:path';

declare const __SWARMCAST_VERSION__: string | undefined;

export function appVersion(): string {
  if (typeof __SWARMCAST_VERSION__ === 'string') return __SWARMCAST_VERSION__;
  try {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'swarmcast' && pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* ignore */
  }
  return '0.0.0-dev';
}
