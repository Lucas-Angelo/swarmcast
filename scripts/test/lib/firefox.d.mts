/** `base` plus MOZ_STARTUP_CACHE: Firefox keeps its startup cache in memory and never writes it (its background write can freeze the browser). */
export function firefoxEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
