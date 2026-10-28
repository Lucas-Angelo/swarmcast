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
