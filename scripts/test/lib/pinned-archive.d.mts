/** The archive of a pinned asset in SC_DOWNLOAD_CACHE, checked against its SHA-256; throws, saying how to get it (`setupInput`), when missing or wrong. */
export function pinnedArchive(a: { asset: string; sha256: string }, o: { tool: string; setupInput: string; env?: NodeJS.ProcessEnv }): string;
