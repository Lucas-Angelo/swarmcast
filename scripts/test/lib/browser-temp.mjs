// Where the browsers the tests and harnesses launch keep their profiles on a Windows CI runner,
// and the temporary folder the app under test keeps all the same.

/** The variable that keeps this machine's own TEMP and TMP once browserTempOnWorkDisk moved them. */
const USER_TEMP = 'SC_USER_TEMP_VARS';

/**
 * On a GitHub-hosted Windows runner, points TEMP and TMP of this process at the job's own
 * folder on the runner's local disk (RUNNER_TEMP, D:), so that the profile Playwright creates
 * for every browser it launches (in os.tmpdir(), which reads TEMP on Windows) is not on the
 * system disk C:. The test workers, browsers and other processes this process starts inherit it;
 * the app under test does not (userTempEnv). Elsewhere (not Windows, or no RUNNER_TEMP: a
 * developer's machine) nothing changes. Returns the folder now used, or undefined.
 *
 * C: on these runners is a network disk with a throughput cap ("Virtual_Disk NVME Premium");
 * D: is the VM's own NVMe disk. A few minutes after a job starts, Windows updates Microsoft
 * Defender's signatures (MpSigStub, AM_Delta, then MsMpEng reading and writing 100-760 MB/s on
 * C:), even with real-time protection off. For the next 30-90 s a write to C: takes 0.3-1.2 s
 * (6 ms otherwise); D: stays under 35 ms. Firefox's parent process writes its new profile's
 * databases on its main thread, the one that answers Playwright and passes every request of a
 * page, and each SQLite commit waits for the disk (Gecko profile: 2.8 s in
 * `INSERT INTO moz_bookmarks` during a first page load). In soak 41543430258 the update fell on
 * two workers' first Firefox: 15.8 s to launch, a first `goto` that never loaded in 30 s, 14 s to
 * close. Cold Firefox launches in a loop (soak 41564352271): all 15 slow ones out of 3306 came
 * inside that window, none outside it.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string | undefined}
 */
export function browserTempOnWorkDisk(env = process.env, platform = process.platform) {
  const dir = env.RUNNER_TEMP;
  if (platform !== 'win32' || !dir) return undefined;
  // Kept once: a second call (a Playwright worker loads its config again) must not keep D:.
  if (env[USER_TEMP] === undefined) env[USER_TEMP] = JSON.stringify({ TEMP: env.TEMP, TMP: env.TMP });
  env.TEMP = dir;
  env.TMP = dir;
  return dir;
}

/**
 * `env` with this machine's own TEMP and TMP back, as they were before browserTempOnWorkDisk:
 * the environment of the app under test (bareEnv), which must see the folders a user's machine
 * has (its quality ladder and every other temporary file go there). A copy; `env` unchanged when
 * nothing was moved.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function userTempEnv(env) {
  const saved = env[USER_TEMP];
  if (saved === undefined) return env;
  const { [USER_TEMP]: _saved, TEMP: _temp, TMP: _tmp, ...rest } = env;
  const user = JSON.parse(saved);
  return { ...rest, ...(user.TEMP === undefined ? {} : { TEMP: user.TEMP }), ...(user.TMP === undefined ? {} : { TMP: user.TMP }) };
}
