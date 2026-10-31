// Firefox as the test harnesses launch it (Playwright): what it needs beyond Playwright's defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachePath = null;

/**
 * The environment for a Firefox the harnesses launch (Playwright's `env` launch option): `base`
 * plus MOZ_STARTUP_CACHE, so its startup cache stays in memory and is never written to disk.
 *
 * Firefox writes that cache (the compiled scripts of its own UI and automation) from a background
 * task that first lowers its own priority (nsAutoLowPriorityIO: on Windows
 * THREAD_MODE_BACKGROUND_BEGIN, the lowest CPU and I/O priority; on macOS throttled I/O) and
 * then holds the cache's lock for the whole write, while the browser's main thread takes the same
 * lock whenever it needs a cached script (StartupCache::GetBuffer). On a busy machine the write
 * starves and the whole browser freezes until it ends: no page event, no request, no screenshot,
 * and a slow close. The first write comes once startup goes idle (no cache yet: always so with
 * Playwright's fresh profiles), the next 60 s after the last new script. Seen on the Windows
 * runners (windows-app section 1, and its reproduction under CPU load): pages stopped answering
 * for 70 s and more, the parent's main thread waiting in StartupCache::GetBuffer behind a
 * background thread inside WriteFile for StartupCache::WriteToDisk. Mozilla removed the low
 * priority only for the write at shutdown (bug 2037923, Firefox 154); Firefox 157 still has it.
 *
 * MOZ_STARTUP_CACHE (read by StartupCache::Init) names the cache file: here a file in a folder
 * that is never created. Loading finds no cache, as a fresh profile does, and each write stops at
 * its first step, opening the file, before any data is compressed or written.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function firefoxEnv(base = process.env) {
  if (!cachePath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-firefox-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    cachePath = path.join(dir, 'never-created', 'startupCache');
  }
  return { ...base, MOZ_STARTUP_CACHE: cachePath };
}
