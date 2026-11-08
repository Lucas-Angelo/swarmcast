// .github/scripts/cache-files.mjs: which download and Tauri tools cache entries a job saves (a new
// entry only when it added or changed files in what it restored), so a job that needs fewer files
// can never leave the jobs that need more without theirs (PR #141).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFiles, planSave, snapshot } from '../../../.github/scripts/cache-files.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../../.github/scripts/cache-files.mjs');
const BASE = 'sc-downloads-macOS-ARM64-ffmpeg-true-for-macos-arm64-c58d30313f0d-';
const FFMPEG = `${'c'.repeat(64)}-ffmpeg.zip`;
const MEDIAMTX = `${'b'.repeat(64)}-mediamtx_v1.21.3_darwin_arm64.tar.gz`;
const CLOUDFLARED = `${'3'.repeat(64)}-cloudflared-darwin-arm64.tgz`;
const PLUGIN = 'NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll';

/** A snapshot line of `file` (its content's SHA-256 as `hash`, a stand-in). */
const at = (file: string, hash = 'a'.repeat(64)) => `${hash}  ${file}`;
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

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
    const lines = snapshot(path.join(dir, 'missing'));

    // Assert
    expect(files).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('snapshot', () => {
  it("lists each file with its content's SHA-256, as sha256sum does", () => {
    // Arrange
    const root = path.join(dir, 'tauri');
    put(root, ['NSIS/makensis.exe']);

    // Act
    const lines = snapshot(root);

    // Assert
    expect(lines).toEqual([at('NSIS/makensis.exe', sha256('NSIS/makensis.exe'))]);
  });
});

describe('planSave', () => {
  it('saves nothing when the job added no file, also when it pruned one', () => {
    // Act
    const same = planSave({ now: [at(FFMPEG), at(MEDIAMTX)], restored: [at(FFMPEG), at(MEDIAMTX)], keyBase: BASE, runId: '1' });
    const pruned = planSave({ now: [at(FFMPEG)], restored: [at(FFMPEG), at(MEDIAMTX)], keyBase: BASE, runId: '1' });

    // Assert
    expect(same).toEqual({ added: [], key: null });
    expect(pruned).toEqual({ added: [], key: null });
  });

  it('saves a new entry named by the run and the whole file list when the job added files', () => {
    // Act
    const a = planSave({ now: [at(CLOUDFLARED), at(FFMPEG), at(MEDIAMTX)], restored: [at(FFMPEG)], keyBase: BASE, runId: '42466842103' });
    const b = planSave({ now: [at(CLOUDFLARED), at(MEDIAMTX)], restored: [], keyBase: BASE, runId: '42466842103' });

    // Assert
    expect(a.added).toEqual([CLOUDFLARED, MEDIAMTX]);
    expect(a.key).toMatch(new RegExp(`^${BASE}42466842103-[0-9a-f]{12}$`));
    expect(b.key).not.toBe(a.key);
  });

  it('saves a new entry when a file kept its name but not its content (a Tauri CLI update replaced the NSIS plugin)', () => {
    // Act
    const replaced = planSave({ now: [at('NSIS/makensis.exe'), at(PLUGIN, 'e'.repeat(64))], restored: [at('NSIS/makensis.exe'), at(PLUGIN, 'd'.repeat(64))], keyBase: 'sc-tauri-tools-Windows-X64-1a2b3c4d-', runId: '9' });

    // Assert
    expect(replaced.added).toEqual([PLUGIN]);
    expect(replaced.key).toMatch(/^sc-tauri-tools-Windows-X64-1a2b3c4d-9-[0-9a-f]{12}$/);
  });

  it('PR #141: the preflight job saved the test ffmpeg alone; the node job then saves a fuller entry, and the preflight job never replaces it', () => {
    // Act
    const preflight = planSave({ now: [at(FFMPEG)], restored: [], keyBase: BASE, runId: '42439987029' });
    const node = planSave({ now: [at(CLOUDFLARED), at(FFMPEG), at(MEDIAMTX)], restored: [at(FFMPEG)], keyBase: BASE, runId: '42465017555' });
    const preflightAgain = planSave({ now: [at(CLOUDFLARED), at(FFMPEG), at(MEDIAMTX)], restored: [at(CLOUDFLARED), at(FFMPEG), at(MEDIAMTX)], keyBase: BASE, runId: '42466842103' });

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
    expect(fs.readFileSync(list, 'utf8')).toBe(`${at(FFMPEG, sha256(FFMPEG))}\n`);
    expect(nothingNew.status).toBe(0);
    expect(afterNothing).toBe('');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(MEDIAMTX);
    expect(fs.readFileSync(output, 'utf8')).toMatch(new RegExp(`^dl-key=${BASE}7-[0-9a-f]{12}\\n$`));
  });

  it('writes the key when the job rewrote a restored file with other content', () => {
    // Arrange
    const tools = path.join(dir, 'tauri');
    const list = path.join(dir, 'tauri-tools.restored');
    const output = path.join(dir, 'output');
    put(tools, ['NSIS/makensis.exe', PLUGIN]);
    fs.writeFileSync(output, '');
    run(['list', tools, list]);

    // Act
    fs.writeFileSync(path.join(tools, PLUGIN), 'nsis_tauri_utils v0.5.3');
    const changed = run(['plan', 'tauri-tools', tools, list, 'sc-tauri-tools-Windows-X64-1a2b3c4d-'], { GITHUB_RUN_ID: '8', GITHUB_OUTPUT: output });

    // Assert
    expect(changed.status).toBe(0);
    expect(changed.stdout).toContain(PLUGIN);
    expect(fs.readFileSync(output, 'utf8')).toMatch(/^tauri-tools-key=sc-tauri-tools-Windows-X64-1a2b3c4d-8-[0-9a-f]{12}\n$/);
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
