import type { ExecFileException } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, system32 } from '../../src/core/exec.js';

// runCommand, the one runner of the OS's command-line tools (core/exec.ts): every outcome comes
// back as a result, never as a rejection. The commands are this Node binary running a one-line
// script, so the tests run the same on every OS.

/** Far longer than any test may take: only the runner's timeout can end this command. */
const NEVER_MS = 60_000;
/** The runner's timeout in the timeout test. */
const TIMEOUT_MS = 200;

const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]];

describe('runCommand', () => {
  it('returns the output of a command that exits with 0', async () => {
    // Act
    const r = await runCommand(...node("process.stdout.write('out'); process.stderr.write('note')"));

    // Assert
    expect(r).toEqual({ ok: true, code: 0, stdout: 'out', stderr: 'note', error: null });
  });

  it('returns the exit code, the output and the error of a command that fails', async () => {
    // Act
    const r = await runCommand(...node("process.stdout.write('partial'); process.stderr.write('bad'); process.exit(3)"));

    // Assert
    expect(r).toMatchObject({ ok: false, code: 3, stdout: 'partial', stderr: 'bad' });
    expect(r.error?.message).toContain('Command failed');
  });

  it('reports a command that does not exist, without an exit code', async () => {
    // Act
    const r = await runCommand('sc-no-such-command', ['--version']);

    // Assert
    expect(r).toMatchObject({ ok: false, code: null, stdout: '', stderr: '' });
    expect((r.error as ExecFileException).code).toBe('ENOENT');
  });

  it('stops a command that runs past its timeout', async () => {
    // Act
    const r = await runCommand(...node(`setTimeout(() => {}, ${NEVER_MS})`), { timeoutMs: TIMEOUT_MS });

    // Assert
    expect(r.ok).toBe(false);
    expect((r.error as ExecFileException).killed).toBe(true);
  });

  it('stops a command when its signal is aborted', async () => {
    // Arrange
    const abort = new AbortController();
    abort.abort();

    // Act
    const r = await runCommand(...node(`setTimeout(() => {}, ${NEVER_MS})`), { signal: abort.signal });

    // Assert
    expect(r).toMatchObject({ ok: false, code: null });
    expect(r.error?.name).toBe('AbortError');
  });

  it('turns an argument execFile refuses before starting into a failed result', async () => {
    // Act
    const r = await runCommand(process.execPath, ['-e', 'a\0b']);

    // Assert
    expect(r).toMatchObject({ ok: false, code: null, stdout: '', stderr: '' });
    expect((r.error as ExecFileException).code).toBe('ERR_INVALID_ARG_VALUE');
  });
});

describe('system32', () => {
  it('builds the path under %SystemRoot%, or C:\\Windows when it is not set', () => {
    // Act
    const set = system32('tar.exe', { SystemRoot: 'D:\\Win' });
    const unset = system32('netsh.exe', {});

    // Assert
    expect(set).toBe(path.join('D:\\Win', 'System32', 'tar.exe'));
    expect(unset).toBe(path.join('C:\\Windows', 'System32', 'netsh.exe'));
  });
});
