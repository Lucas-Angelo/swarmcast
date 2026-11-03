/**
 * Tells the server how soon each segment is needed (docs/QUALITY.md "Upload order"): every
 * segment request carries `X-SC-Need: <seconds>`, the segment's start minus the playhead (0 before
 * the first picture, and for init segments). When the streamer's upload is the bottleneck (many
 * people joining at once, a full uplink), the server sends the soonest-needed bytes first: a viewer
 * about to run out of video, or waiting for its first picture, goes before one filling its buffer
 * far ahead. Without the header a request is scheduled as "later" (8 s), never refused.
 *
 * Both paths a segment can take set it: p2p-media-loader's own HTTP downloads (httpRequestSetup;
 * every segment goes through its core, P2P on or off) and hls.js' loader when the P2P fallback
 * takes over (xhrSetup, p2p-fallback.ts).
 */
export const NEED_HEADER = 'X-SC-Need';

interface FragmentLike {
  url: string;
  start: number;
  initSegment?: { url: string } | null;
}

interface DetailsLike {
  fragments: FragmentLike[];
}

/** What the header needs from hls.js: the playlists in use and the media element. */
export interface NeedSource {
  levels: Array<{ details?: DetailsLike }>;
  audioTracks: Array<{ details?: DetailsLike }>;
  media: Pick<HTMLMediaElement, 'currentTime' | 'readyState'> | null;
}

/** Media element states (HTMLMediaElement.HAVE_CURRENT_DATA): a picture is there. */
const HAVE_CURRENT_DATA = 2;

/**
 * Seconds until the bytes at `url` are needed: 0 before the first picture and for an init
 * segment, the fragment's start minus the playhead otherwise (at least 0, one decimal). Undefined
 * for a URL that no playlist in use lists (the server then treats it as "later").
 */
export function needSeconds(src: NeedSource, url: string): number | undefined {
  const media = src.media;
  const lists = [...src.levels, ...src.audioTracks];
  for (const l of lists) {
    for (const f of l.details?.fragments ?? []) {
      if (f.initSegment?.url === url) return 0;
      if (f.url !== url) continue;
      if (!media || media.readyState < HAVE_CURRENT_DATA) return 0;
      return Math.max(0, Math.round((f.start - media.currentTime) * 10) / 10);
    }
  }
  return undefined;
}

/** The header for `url`, or none. */
export function needHeaders(src: NeedSource, url: string): Record<string, string> {
  const s = needSeconds(src, url);
  return s === undefined ? {} : { [NEED_HEADER]: s.toFixed(1) };
}

/**
 * p2p-media-loader's `httpRequestSetup`: the request it would make itself (Range when it resumes a
 * download, its abort signal), plus the header.
 */
export function needRequestSetup(src: () => NeedSource | null): (url: string, byteRange: unknown, signal: AbortSignal | undefined, range: { start: number; end?: number } | undefined) => Promise<Request> {
  return async (url, _byteRange, signal, range) => {
    const s = src();
    const headers = new Headers(s ? needHeaders(s, url) : {});
    if (range) headers.set('Range', `bytes=${range.start}-${range.end ?? ''}`);
    return new Request(url, { headers, ...(signal ? { signal } : {}) });
  };
}
