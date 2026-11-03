import fs from 'node:fs';
import path from 'node:path';
import { removeDir } from '../core/fs-cleanup.js';
import type { Logger } from '../core/logger.js';

/**
 * The program copy of the old start scripts (script mode, removed in 0.5.1: docs/DECISIONS.md).
 * They installed SwarmCast into `<data folder>/app` (`current/`, `previous/`, `failed/` and
 * `.staging-*` folders) next to the settings. The desktop app uses the same data folder, so a
 * streamer who switches keeps the settings, the stream key, the video converter (`tools/`) and
 * the logs; only that old copy is left over, and the app removes it (docs/DESKTOP.md).
 */
export const OLD_INSTALL_DIR = 'app';
/** What the start scripts put in `<data>/app`; a folder with anything else is not theirs and is kept. */
const OLD_INSTALL_ENTRY = /^(current|previous|failed|\.staging-.+)$/;
/** The old copy is renamed to this first, so it goes as a whole or not at all. */
export const OLD_INSTALL_REMOVING = '.app-removing';

export type OldInstallResult = 'none' | 'removed' | 'kept';

/**
 * Removes the old start scripts' copy from `dataDir`, never anything else. It is first renamed in
 * one step: while a file in it is in use (an old copy still running, Windows) the rename fails and
 * the copy stays, untouched, for the next start; once renamed, a partly finished delete is
 * finished at the next start. Never throws: the app works the same with the copy left in place.
 * `rename` is for tests (a copy in use).
 */
export async function removeOldScriptInstall(dataDir: string, log: Logger, o: { rename?: (from: string, to: string) => void } = {}): Promise<OldInstallResult> {
  const dir = path.join(dataDir, OLD_INSTALL_DIR);
  const removing = path.join(dataDir, OLD_INSTALL_REMOVING);
  if (fs.existsSync(removing)) await removeDir(removing, log, 'old SwarmCast copy');

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return 'none';
  }
  if (!stat.isDirectory()) {
    log.info({ kind: stat.isSymbolicLink() ? 'link' : 'file' }, 'old start-script copy: <data>/app is not a folder; left in place');
    return 'kept';
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log.info({ err: (err as Error).message }, 'old start-script copy: cannot read <data>/app; left in place');
    return 'kept';
  }
  const foreign = entries.filter((e) => !OLD_INSTALL_ENTRY.test(e));
  if (foreign.length) {
    log.info({ entries: foreign.length }, 'old start-script copy: <data>/app holds files the start scripts never made; left in place');
    return 'kept';
  }
  try {
    (o.rename ?? fs.renameSync)(dir, removing);
  } catch (err) {
    log.info({ code: (err as NodeJS.ErrnoException).code }, 'old start-script copy is in use (still running?); removing it at the next start');
    return 'kept';
  }
  const done = await removeDir(removing, log, 'old SwarmCast copy');
  log.info({ done }, done ? 'removed the old start-script copy of SwarmCast (settings kept)' : 'old start-script copy: renamed, the rest goes at the next start');
  return 'removed';
}
