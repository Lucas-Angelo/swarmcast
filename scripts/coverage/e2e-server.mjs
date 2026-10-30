// Server-side coverage of the Playwright suite (docs/DEVELOPMENT.md, "Coverage").
//
//   node scripts/coverage/e2e-server.mjs --run [playwright test arguments...]   (npm run coverage:e2e)
//   node scripts/coverage/e2e-server.mjs <dir>    after `NODE_V8_COVERAGE=<dir> npx playwright test` (CI)
//
// With NODE_V8_COVERAGE set, every Node process writes its V8 coverage into that folder when it
// exits. Only the e2e server counts (the process that ran apps/server/test/e2e/server.ts), not
// Playwright's runner and workers: what a spec imports is test code, and their copies of a shared
// file are other transforms of it, whose ranges must not be merged with the server's. Playwright
// stops the server with SIGTERM (webServer.gracefulShutdown), which Windows does not have: this
// works on Linux and macOS, where the e2e jobs run.
//
// c8 maps the V8 ranges onto apps/server/src and packages/shared/src through the source maps tsx
// registered (Node keeps them in the coverage files, "source-map-cache") and counts the files the
// suite never loaded as 0 % (--all). Writes coverage/e2e-server (lcov, json-summary). c8 counts
// every line of a file (comments too) and only the functions and branches V8 compiled, so only
// its line figure has a fixed denominator: the floors are on lines. Not merged with the Vitest
// suites, which count executable lines and statements from the syntax tree.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'coverage', 'e2e-server');
const SERVER = 'apps/server/test/e2e/server.ts';
const require = createRequire(import.meta.url);

let dir = process.argv[2];
let status = 0;
if (dir === '--run') {
  dir = path.join(ROOT, 'coverage', 'e2e-server-v8');
  fs.rmSync(dir, { recursive: true, force: true });
  const run = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(3)], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir } });
  status = run.status ?? 1;
}
if (!dir) throw new Error('usage: node scripts/coverage/e2e-server.mjs --run [playwright args] | <NODE_V8_COVERAGE dir>');

// coverage-<pid>-<timestamp>-<thread id>.json, one per process and thread. The server's main
// thread is the one that ran server.ts (a runner's source map cache may quote that path, so the
// scripts it ran decide, not the text); its other threads (tsx's loader) come along.
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^coverage-\d+-\d+-\d+\.json$/.test(f)) : [];
const ranServer = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).result.some((s) => s.url.endsWith(`/${SERVER}`));
const pids = new Set(files.filter(ranServer).map((f) => f.split('-')[1]));
const server = files.filter((f) => pids.has(f.split('-')[1]));
if (server.length === 0) {
  console.error(`No coverage from the e2e server in ${dir} (${files.length} files): it did not start, or it was killed instead of stopped.`);
  process.exit(1);
}
const picked = path.join(dir, 'e2e-server');
fs.rmSync(picked, { recursive: true, force: true });
fs.mkdirSync(picked);
for (const f of server) fs.copyFileSync(path.join(dir, f), path.join(picked, f));
console.log(`e2e server coverage: ${server.length} of ${files.length} files (process ${[...pids].join(', ')})`);

// prettier-ignore
execFileSync(process.execPath, [
  require.resolve('c8/bin/c8.js'), 'report', '--temp-directory', picked, '--reports-dir', OUT,
  '--reporter', 'text-summary', '--reporter', 'lcov', '--reporter', 'json-summary',
  '--all', '--src', 'apps/server/src', '--src', 'packages/shared/src',
  '--include', 'apps/server/src/**', '--include', 'packages/shared/src/**',
  '--exclude', '**/*.d.ts', '--exclude', '**/*.generated.ts', '--exclude-after-remap',
], { cwd: ROOT, stdio: 'inherit' });
process.exitCode = status;
