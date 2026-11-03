/** On a GitHub-hosted Windows runner: TEMP and TMP to RUNNER_TEMP (the local disk), so the browser profiles Playwright makes are not on the system disk, which Defender's signature update saturates; the originals are kept for userTempEnv. Returns the folder, or undefined when nothing changed. */
export function browserTempOnWorkDisk(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | undefined;
/** A copy of `env` with this machine's own TEMP and TMP back (as before browserTempOnWorkDisk): the app under test's environment. */
export function userTempEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
