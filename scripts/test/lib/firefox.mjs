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

/**
 * On a GitHub-hosted Windows runner, points TEMP and TMP of this process at the job's own
 * folder on the runner's local disk (RUNNER_TEMP, D:), so that the profile Playwright creates
 * for every browser it launches (in os.tmpdir(), which reads TEMP on Windows) is not on the
 * system disk C:. The test workers and browsers this process starts inherit it. Elsewhere (not
 * Windows, or no RUNNER_TEMP: a developer's machine) nothing changes. Returns the folder now
 * used, or undefined.
 *
 * C: on these runners is a network disk with a throughput cap ("Virtual_Disk NVME Premium");
 * D: is the VM's own NVMe disk. A few minutes after a job starts, Windows updates Microsoft
 * Defender's signatures (MpSigStub, AM_Delta, then MsMpEng reading and writing 100-560 MB/s on
 * C:), even with real-time protection off. For the next 30-90 s a write to C: takes 0.3-0.9 s
 * (6 ms otherwise); D: stays under 30 ms. Firefox's parent process writes its new profile's
 * databases on its main thread, the one that answers Playwright and passes every request of a
 * page, and each SQLite commit waits for the disk (Gecko profile: 2.8 s in
 * `INSERT INTO moz_bookmarks` during a first page load). In soak 41543430258 the update fell on
 * two workers' first Firefox: 15.8 s to launch, a first `goto` that never loaded in 30 s, 14 s to
 * close. Cold Firefox launches in a loop (soak 41564352271): every slow one came inside that
 * window, none outside it.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string | undefined}
 */
export function browserTempOnWorkDisk(env = process.env, platform = process.platform) {
  const dir = env.RUNNER_TEMP;
  if (platform !== 'win32' || !dir) return undefined;
  env.TEMP = dir;
  env.TMP = dir;
  return dir;
}

/**
 * The preferences for a Firefox the harnesses launch (Playwright's `firefoxUserPrefs`): `extra`
 * plus form history turned off.
 *
 * Playwright gives each browser context its own cookies and storage, but in Firefox the contexts
 * of one browser share one profile, and with it the form history (formhistory.sqlite): Firefox
 * saves the text fields of every submitted form there, even a submit the page cancels (the
 * DOMFormBeforeSubmit event comes before the page's submit handler). So the nicknames a test typed
 * on the join page came back in a later test's own new context: typing "A" opened Firefox's
 * autocomplete list under the nickname field, right over "Watch". That list is browser UI, not
 * the page: Playwright cannot see it (the button was visible, enabled and the hit target), and
 * Firefox's Playwright build closes it before each mouse event but not when it opens after that,
 * so it took the press and the page got only the release: no click, so no join (nickname.spec
 * "one character", e2e chat group on macOS, in CI and in a soak). Chromium's and WebKit's
 * contexts keep nothing like it; with form history off, Firefox's do not either.
 * @param {Record<string, string | number | boolean>} [extra]
 * @returns {Record<string, string | number | boolean>}
 */
export function firefoxPrefs(extra = {}) {
  return { 'browser.formfill.enable': false, ...extra };
}
