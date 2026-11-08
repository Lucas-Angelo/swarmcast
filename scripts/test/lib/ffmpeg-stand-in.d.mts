/** The verified archive of the app's ffmpeg pin in SC_DOWNLOAD_CACHE; throws, saying how to get it, when missing or wrong. */
export function pinnedFfmpegArchive(a: { asset: string; sha256: string }, env?: NodeJS.ProcessEnv): string;

/** Serves `file` at http://127.0.0.1:<port>/<its name>; with `stallAfterHeaders`, the headers and then nothing. */
export function startFfmpegStandIn(
  file: string,
  o?: { stallAfterHeaders?: boolean },
): Promise<{ url: string; appEnv: { SWARMCAST_TEST_FFMPEG_URL: string }; requests: () => number; close: () => Promise<void> }>;
