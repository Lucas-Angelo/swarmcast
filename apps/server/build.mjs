// Bundle the server into one CommonJS file for packaging with @yao-pkg/pkg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const version = process.env.SWARMCAST_VERSION ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const result = await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, 'dist/swarmcast.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  define: { __SWARMCAST_VERSION__: JSON.stringify(version) },
  // Optional native accelerators of `ws`; it falls back to pure JS without them.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
  // paths.ts guards import.meta behind a __filename check, which is what CJS uses.
  logOverride: { 'empty-import-meta': 'silent' },
});
fs.writeFileSync(path.join(here, 'dist/meta.json'), JSON.stringify(result.metafile));
console.log(`✓ server bundle built (v${version})`);
