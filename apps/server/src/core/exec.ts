import { execFile, type ExecFileException } from 'node:child_process';
import path from 'node:path';

/**
 * One way to run the operating system's command-line tools (netsh, reg, tar, sw_vers…) and read
 * their output. Long-lived children (MediaMTX, cloudflared, ffmpeg renditions) are ManagedChild
 * (process/children.ts) instead: they must never outlive SwarmCast.
 */

export interface CommandOptions {
  /** Kill the command after this long (execFile's `timeout`); 0 or missing: no limit. */
  timeoutMs?: number;
  /** Kills the command when aborted. */
  signal?: AbortSignal;
  /** Windows: pass the arguments to the program as they are, unquoted (execFile's `windowsVerbatimArguments`). */
  verbatim?: boolean;
}

export interface CommandResult {
  /** The command ran and exited with code 0. */
  ok: boolean;
  /** Exit code; null when there is none (not found, killed by the timeout or the signal, could not start). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** execFile's error (its message names the command and the reason); null when ok. */
  error: Error | null;
}

/**
 * Run `command` with `args` and collect its output. Never rejects: a failure, including one
 * execFile throws before starting (an invalid argument), comes back as `ok: false` with its
 * error. The window of a console program stays hidden on Windows.
 */
export function runCommand(command: string, args: readonly string[], o: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const done = (error: ExecFileException | null, stdout: unknown, stderr: unknown): void => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ ok: error === null, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
    };
    try {
      execFile(command, args, { windowsHide: true, windowsVerbatimArguments: !!o.verbatim, timeout: o.timeoutMs, signal: o.signal }, (err, stdout, stderr) => done(err, stdout, stderr));
    } catch (err) {
      done(err as ExecFileException, '', '');
    }
  });
}

/**
 * A Windows tool by absolute path in `%SystemRoot%\System32`, so a same-named program earlier on
 * PATH (Git's GNU tar, MSYS, a shim) is never run instead.
 */
export function system32(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
}
