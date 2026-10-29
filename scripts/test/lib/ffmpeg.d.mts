export interface FeedOptions {
  /** Picture size, "WxH" (default 640x360). */
  size?: string;
  /** Video bitrate (default 1200). */
  kbps?: number;
  /** Constant bitrate with filler, like OBS's CBR, so segment sizes match the nominal bitrate. */
  cbr?: boolean;
}

/** Absolute path of the test ffmpeg: $FFMPEG_BIN, else the first `ffmpeg` on PATH, else "ffmpeg". */
export function ffmpegBin(): string;

/** True when the test ffmpeg runs (with or without libx264: feeds without it die at once). */
export function hasFfmpeg(): boolean;

/** First line of `ffmpeg -version`, or null when it does not run. */
export function ffmpegVersion(): string | null;

/** Arguments for a feed encoded live, in real time (x264 ultrafast). */
export function liveFeedArgs(rtmpUrl: string, o?: FeedOptions): string[];

export interface ClipOptions extends FeedOptions {
  /** Clip length, a whole number of 2 s keyframe intervals (default CLIP_SECONDS). */
  seconds?: number;
}

/** Default clip length (10 s). */
export const CLIP_SECONDS: number;

/** Where the clips are cached: $SC_TEST_CLIPS_DIR, else <tmp>/swarmcast-test-clips. */
export function clipsDir(): string;

/** The cache file of a clip, named after the ffmpeg build and the encode arguments. */
export function clipPath(o?: ClipOptions): string;

/** The clip for these options, encoded now (blocking) if it is not cached yet. */
export function ensureClipSync(o?: ClipOptions): string;

/** The clip for these options, encoded now if it is not cached yet. */
export function ensureClip(o?: ClipOptions): Promise<string>;

/** True when this ffmpeg has -readrate_initial_burst (FFmpeg 6.1 and later). */
export function hasInitialBurst(): boolean;

/** Arguments that send `clip` in a loop, in real time, with `-c copy`. */
export function clipFeedArgs(clip: string, rtmpUrl: string, o?: { burstSeconds?: number }): string[];
