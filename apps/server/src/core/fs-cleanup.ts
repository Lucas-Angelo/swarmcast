import fs from 'node:fs';
import type { Logger } from './logger.js';

/**
 * Retries for deleting a folder whose files were just closed. On Windows a virus scanner
 * (Defender real-time scanning), the search indexer or a process that is still exiting can hold
 * a file for a moment after the child that wrote it stopped: the delete then fails with
 * EPERM/EBUSY. Node retries those (and ENOTEMPTY, EMFILE, ENFILE) with a linear backoff,
 * 100 ms longer each time: at most 5.5 s in all.
 */
export const REMOVE_RETRIES = { maxRetries: 10, retryDelay: 100 } as const;

/**
 * Delete a folder and everything in it, retrying while files are briefly locked. Never throws:
 * cleanup must not fail "Stop everything" or an install. Returns false (and logs why) when the
 * folder could not be deleted.
 */
export async function removeDir(dir: string, log: Logger, what: string): Promise<boolean> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, ...REMOVE_RETRIES });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    log.warn({ dir, code: e.code, err: e.message }, `could not delete the ${what} folder (another program, such as a virus scanner, still holds a file); left in place`);
    return false;
  }
}
