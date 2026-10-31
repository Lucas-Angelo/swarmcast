// Bundle the server into one CommonJS file for packaging with @yao-pkg/pkg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const version = process.env.SWARMCAST_VERSION ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/**
 * Optional peers a dependency only tries to load (`debug` wraps `require('supports-color')` in a
 * try): the bundle gets an empty module for them, so its contents never depend on which dev tools
 * happened to install them (c8 does) and the shipped server behaves the same either way (no colour
 * detection, as when the package is absent). The release guard (.github/scripts/no-dev-deps.mjs)
 * fails a bundle that pulls in a devDependency.
 */
const OPTIONAL_PEERS = ['supports-color'];
const optionalPeersAbsent = {
  name: 'optional-peers-absent',
  setup(b) {
    const filter = new RegExp(`^(${OPTIONAL_PEERS.join('|')})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'optional-peer-absent' }));
    b.onLoad({ filter: /.*/, namespace: 'optional-peer-absent' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

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
  plugins: [optionalPeersAbsent],
  logLevel: 'warning',
  // paths.ts guards import.meta behind a __filename check, which is what CJS uses.
  logOverride: { 'empty-import-meta': 'silent' },
});
fs.writeFileSync(path.join(here, 'dist/meta.json'), JSON.stringify(result.metafile));
console.log(`✓ server bundle built (v${version})`);
