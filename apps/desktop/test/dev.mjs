#!/usr/bin/env node
// Run the desktop shell in debug mode with the mock server (no bundling, no real server):
//
//   npm run desktop:dev [-- --background]
//
// Uses a throwaway data folder (.cache/desktop-dev) unless SWARMCAST_DATA_DIR is set, so a
// dev run never touches the real SwarmCast settings. MOCK_* variables are passed to the mock
// (see mock-server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const mock = path.join(here, 'mock-server.mjs');
if (process.platform !== 'win32') fs.chmodSync(mock, 0o755);

const env = {
  ...process.env,
  SWARMCAST_SIDECAR: process.platform === 'win32' ? path.join(here, 'mock-server.cmd') : mock,
  SWARMCAST_DATA_DIR: process.env.SWARMCAST_DATA_DIR ?? path.join(root, '.cache', 'desktop-dev'),
};
const res = spawnSync('cargo', ['run', '--manifest-path', path.join(here, '..', 'src-tauri', 'Cargo.toml'), '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 1);
