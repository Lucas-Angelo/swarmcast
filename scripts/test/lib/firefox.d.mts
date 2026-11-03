/** `base` plus MOZ_STARTUP_CACHE: Firefox keeps its startup cache in memory and never writes it (its background write can freeze the browser). */
export function firefoxEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** `extra` plus form history off: the contexts of one Firefox share its profile, and a test would find the text another typed. */
export function firefoxPrefs(extra?: Record<string, string | number | boolean>): Record<string, string | number | boolean>;
/** On a GitHub-hosted Windows runner: TEMP and TMP to RUNNER_TEMP (the local disk), so the browser profiles Playwright makes are not on the system disk, which Defender's signature update saturates. Returns the folder, or undefined when nothing changed. */
export function browserTempOnWorkDisk(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | undefined;
