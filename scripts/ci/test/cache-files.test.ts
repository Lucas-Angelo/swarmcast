// .github/scripts/cache-files.mjs: which download and Tauri tools cache entries a job saves (a new
// entry only when it added files to what it restored), so a job that needs fewer files can never
// leave the jobs that need more without theirs (PR #141).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFiles, planSave } from '../../../.github/scripts/cache-files.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../../.github/scripts/cache-files.mjs');
const BASE = 'sc-downloads-macOS-ARM64-ffmpeg-true-for-macos-arm64-c58d30313f0d-';
const FFMPEG = `${'c'.repeat(64)}-ffmpeg.zip`;
const MEDIAMTX = `${'b'.repeat(64)}-mediamtx_v1.21.3_darwin_arm64.tar.gz`;
const CLOUDFLARED = `${'3'.repeat(64)}-cloudflared-darwin-arm64.tgz`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-files-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `files` (paths with `/`) under `root`. */
function put(root: string, files: string[]) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), f);
  }
}

describe('listFiles', () => {
  it('lists every file below the folder, sorted, with / separators on every OS', () => {
    // Arrange
    const root = path.join(dir, 'tauri');
    put(root, ['NSIS/makensis.exe', 'NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll', 'AppRun-x86_64']);

    // Act
    const files = listFiles(root);

    // Assert
    expect(files).toEqual(['AppRun-x86_64', 'NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll', 'NSIS/makensis.exe']);
  });

  it('is empty for a folder that does not exist (nothing restored)', () => {
    // Act
    const files = listFiles(path.join(dir, 'missing'));

    // Assert
    expect(files).toEqual([]);
  });
});

describe('planSave', () => {
  it('saves nothing when the job added no file, also when it pruned one', () => {
    // Act
    const same = planSave({ now: [FFMPEG, MEDIAMTX], restored: [FFMPEG, MEDIAMTX], keyBase: BASE, runId: '1' });
    const pruned = planSave({ now: [FFMPEG], restored: [FFMPEG, MEDIAMTX], keyBase: BASE, runId: '1' });

    // Assert
    expect(same).toEqual({ added: [], key: null });
    expect(pruned).toEqual({ added: [], key: null });
  });

  it('saves a new entry named by the run and the whole file list when the job added files', () => {
    // Act
    const a = planSave({ now: [CLOUDFLARED, FFMPEG, MEDIAMTX], restored: [FFMPEG], keyBase: BASE, runId: '42466842103' });
    const b = planSave({ now: [CLOUDFLARED, MEDIAMTX], restored: [], keyBase: BASE, runId: '42466842103' });

    // Assert
    expect(a.added).toEqual([CLOUDFLARED, MEDIAMTX]);
    expect(a.key).toMatch(new RegExp(`^${BASE}42466842103-[0-9a-f]{12}$`));
    expect(b.key).not.toBe(a.key);
  });

  it('PR #141: the preflight job saved the test ffmpeg alone; the node job then saves a fuller entry, and the preflight job never replaces it', () => {
    // Act
    const preflight = planSave({ now: [FFMPEG], restored: [], keyBase: BASE, runId: '42439987029' });
    const node = planSave({ now: [CLOUDFLARED, FFMPEG, MEDIAMTX], restored: [FFMPEG], keyBase: BASE, runId: '42465017555' });
    const preflightAgain = planSave({ now: [CLOUDFLARED, FFMPEG, MEDIAMTX], restored: [CLOUDFLARED, FFMPEG, MEDIAMTX], keyBase: BASE, runId: '42466842103' });

    // Assert
    expect(preflight.key).not.toBeNull();
    expect(node.key).not.toBeNull();
    expect(node.key).not.toBe(preflight.key);
    expect(preflightAgain.key).toBeNull();
  });
});

describe('the command line (as setup and setup/save run it)', () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  it('lists what the restore brought, then writes the key only when the job added a file', () => {
    // Arrange
    const cache = path.join(dir, 'downloads');
    const list = path.join(dir, 'downloads.restored');
    const output = path.join(dir, 'output');
    put(cache, [FFMPEG]);
    fs.writeFileSync(output, '');

    // Act
    const listed = run(['list', cache, list]);
    const nothingNew = run(['plan', 'dl', cache, list, BASE], { GITHUB_RUN_ID: '7', GITHUB_OUTPUT: output });
    const afterNothing = fs.readFileSync(output, 'utf8');
    put(cache, [MEDIAMTX]);
    const added = run(['plan', 'dl', cache, list, BASE], { GITHUB_RUN_ID: '7', GITHUB_OUTPUT: output });

    // Assert
    expect(listed.status).toBe(0);
    expect(fs.readFileSync(list, 'utf8')).toBe(`${FFMPEG}\n`);
    expect(nothingNew.status).toBe(0);
    expect(afterNothing).toBe('');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(MEDIAMTX);
    expect(fs.readFileSync(output, 'utf8')).toMatch(new RegExp(`^dl-key=${BASE}7-[0-9a-f]{12}\\n$`));
  });

  it('takes a missing list as an empty restore, and refuses bad usage', () => {
    // Arrange
    const cache = path.join(dir, 'downloads');
    const output = path.join(dir, 'output');
    put(cache, [FFMPEG]);
    fs.writeFileSync(output, '');

    // Act
    const planned = run(['plan', 'dl', cache, path.join(dir, 'none'), BASE], { GITHUB_RUN_ID: '7', GITHUB_OUTPUT: output });
    const usage = run(['plan', 'dl']);

    // Assert
    expect(planned.status).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toMatch(/^dl-key=/);
    expect(usage.status).toBe(2);
  });
});
