/** `base` plus MOZ_STARTUP_CACHE: Firefox keeps its startup cache in memory and never writes it (its background write can freeze the browser). */
export function firefoxEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** `extra` plus form history off: the contexts of one Firefox share its profile, and a test would find the text another typed. */
export function firefoxPrefs(extra?: Record<string, string | number | boolean>): Record<string, string | number | boolean>;
