import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OLD_INSTALL_REMOVING, removeOldScriptInstall } from '../../src/desktop/old-install.js';
import { captureLog, tempDir } from './helpers.js';

// The desktop app removes the program copy the old start scripts (script mode, gone in 0.5.1)
// left in the shared data folder (<data>/app: current/, previous/, failed/, .staging-*), and
// nothing else: settings, stream key, video converter and logs stay.

/** Writes `rel` (with its folders) under `dir`. */
function put(dir: string, rel: string, text = 'x'): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A data folder with the user's files and an old start-script copy of SwarmCast. */
function dataFolderWithOldCopy(): string {
  const data = tempDir('sc-old-install-');
  put(data, 'config.json', '{}');
  put(data, 'secrets.json', '{}');
  put(data, 'tools/ffmpeg/ffmpeg', 'ffmpeg');
  put(data, 'logs/setup-2026-10-01.log', 'old setup log');
  put(data, 'app/current/swarmcast', 'binary');
  put(data, 'app/current/VERSION', '0.5.0\n');
  put(data, 'app/current/bin/mediamtx', 'binary');
  put(data, 'app/previous/VERSION', '0.4.2\n');
  put(data, 'app/.staging-ab12cd/swarmcast', 'half unpacked');
  return data;
}

const userFiles = ['config.json', 'secrets.json', 'tools/ffmpeg/ffmpeg', 'logs/setup-2026-10-01.log'];

describe('removeOldScriptInstall', () => {
  it('removes <data>/app and keeps every other file of the data folder', async () => {
    // Arrange
    const data = dataFolderWithOldCopy();
    const { log, lines } = captureLog('info');
    // Act
    const result = await removeOldScriptInstall(data, log);
    // Assert
    expect(result).toBe('removed');
    expect(fs.existsSync(path.join(data, 'app'))).toBe(false);
    expect(fs.existsSync(path.join(data, OLD_INSTALL_REMOVING))).toBe(false);
    for (const f of userFiles) expect(fs.existsSync(path.join(data, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).toBe('{}');
    expect(lines().map((l) => l.msg)).toContain('removed the old start-script copy of SwarmCast (settings kept)');
  });

  it('does nothing when there is no old copy', async () => {
    // Arrange
    const data = tempDir('sc-old-install-');
    put(data, 'config.json', '{}');
    // Act
    const result = await removeOldScriptInstall(data, captureLog().log);
    // Assert
    expect(result).toBe('none');
    expect(fs.readdirSync(data)).toEqual(['config.json']);
  });

  it('keeps <data>/app when it holds anything the start scripts never made', async () => {
    // Arrange
    const data = dataFolderWithOldCopy();
    put(data, 'app/my-notes.txt', 'not SwarmCast');
    // Act
    const result = await removeOldScriptInstall(data, captureLog().log);
    // Assert
    expect(result).toBe('kept');
    expect(fs.readFileSync(path.join(data, 'app/my-notes.txt'), 'utf8')).toBe('not SwarmCast');
    expect(fs.existsSync(path.join(data, 'app/current/VERSION'))).toBe(true);
  });

  it('keeps <data>/app when it is a file, not a folder', async () => {
    // Arrange
    const data = tempDir('sc-old-install-');
    put(data, 'app', 'a file');
    // Act
    const result = await removeOldScriptInstall(data, captureLog().log);
    // Assert
    expect(result).toBe('kept');
    expect(fs.readFileSync(path.join(data, 'app'), 'utf8')).toBe('a file');
  });

  it('never follows a link: <data>/app pointing elsewhere is kept, and so is its target', async () => {
    // Arrange (a junction on Windows: a directory symlink there needs extra rights)
    const data = tempDir('sc-old-install-');
    const elsewhere = tempDir('sc-old-install-target-');
    put(elsewhere, 'current/VERSION', '0.5.0\n');
    fs.symlinkSync(elsewhere, path.join(data, 'app'), process.platform === 'win32' ? 'junction' : 'dir');
    // Act
    const result = await removeOldScriptInstall(data, captureLog().log);
    // Assert
    expect(result).toBe('kept');
    expect(fs.existsSync(path.join(elsewhere, 'current/VERSION'))).toBe(true);
    expect(fs.lstatSync(path.join(data, 'app')).isSymbolicLink()).toBe(true);
  });

  it('keeps the whole copy, untouched, while it is in use (the rename fails), and says so', async () => {
    // Arrange
    const data = dataFolderWithOldCopy();
    const { log, lines } = captureLog('info');
    const busy = (): void => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    // Act
    const result = await removeOldScriptInstall(data, log, { rename: busy });
    // Assert
    expect(result).toBe('kept');
    for (const f of ['app/current/swarmcast', 'app/current/bin/mediamtx', 'app/previous/VERSION', 'app/.staging-ab12cd/swarmcast', ...userFiles]) expect(fs.existsSync(path.join(data, f)), f).toBe(true);
    expect(lines().find((l) => l.code === 'EBUSY')?.msg).toBe('old start-script copy is in use (still running?); removing it at the next start');
  });

  it('finishes a removal an earlier start left half done', async () => {
    // Arrange
    const data = tempDir('sc-old-install-');
    put(data, 'config.json', '{}');
    put(data, `${OLD_INSTALL_REMOVING}/current/swarmcast`, 'binary');
    // Act
    const result = await removeOldScriptInstall(data, captureLog().log);
    // Assert
    expect(result).toBe('none');
    expect(fs.readdirSync(data)).toEqual(['config.json']);
  });
});
