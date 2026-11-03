// A stand-in for MediaMTX's local HLS server, for the surge bench (bench.ts): a live fMP4-style
// ladder whose segments are random bytes of the right size. The origin (apps/server/src/hls/origin.ts)
// polls it exactly as it polls MediaMTX: index.m3u8 → one media playlist per rendition → init and
// segments. Nothing here is decoded by anyone: the bench's viewers are protocol-level players
// (viewers.ts), so the sizes and the timing are what matter.
//
// The clock is real time: one new 2 s segment per rendition every SEGMENT_S, and the window starts
// full (WINDOW segments already "recorded"), like a stream that has been live for a while.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Rendition {
  height: number;
  /** Video + audio, kbit/s: each segment is SEGMENT_S × this. */
  kbps: number;
}

/** The ladder of a GPU streamer (docs/QUALITY.md): 1080p copy + 720p, 480p, 360p. */
export const DEFAULT_LADDER: Rendition[] = [
  { height: 1080, kbps: 6000 },
  { height: 720, kbps: 3000 },
  { height: 480, kbps: 1400 },
  { height: 360, kbps: 800 },
];

export const SEGMENT_S = 2;
/** Segments listed per playlist: 40 s, PLAYLIST_WINDOW_S. */
export const WINDOW = 20;

export interface SyntheticSource {
  port: number;
  /** Media sequence of the newest segment right now. */
  newest(): number;
  close(): Promise<void>;
}

const width = (h: number): number => Math.round((h * 16) / 9 / 2) * 2;

/**
 * Serves `/live/<key>/…` on 127.0.0.1 (a port the OS picks). Every segment of a rendition has the
 * same size; its first 8 bytes are its sequence number, so every segment has its own SHA-256.
 */
export async function startSyntheticSource(streamKey: string, ladder: Rendition[] = DEFAULT_LADDER): Promise<SyntheticSource> {
  const t0 = Date.now() - WINDOW * SEGMENT_S * 1000;
  const newest = (): number => Math.floor((Date.now() - t0) / (SEGMENT_S * 1000));
  const bodies = new Map(ladder.map((r) => [r.height, crypto.randomBytes(Math.round((r.kbps * 1000 * SEGMENT_S) / 8))]));
  const init = crypto.randomBytes(900);
  const prefix = `/live/${streamKey}/`;

  const multivariant = [
    '#EXTM3U',
    '#EXT-X-VERSION:9',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    ...ladder.flatMap((r) => [`#EXT-X-STREAM-INF:BANDWIDTH=${r.kbps * 1000},AVERAGE-BANDWIDTH=${r.kbps * 1000},CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=${width(r.height)}x${r.height},FRAME-RATE=30.000`, `v${r.height}.m3u8`]),
    '',
  ].join('\n');

  const media = (h: number): string => {
    const last = newest();
    const first = Math.max(0, last - WINDOW + 1);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:9', `#EXT-X-TARGETDURATION:${SEGMENT_S}`, `#EXT-X-MEDIA-SEQUENCE:${first}`, '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="init_v${h}.mp4"`];
    for (let n = first; n <= last; n++) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + n * SEGMENT_S * 1000).toISOString()}`, `#EXTINF:${SEGMENT_S.toFixed(5)},`, `seg_v${h}_${n}.mp4`);
    }
    return lines.join('\n') + '\n';
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith(prefix)) return void res.writeHead(404).end();
    const name = url.slice(prefix.length);
    if (name === 'index.m3u8') return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(multivariant);
    let m = /^v(\d+)\.m3u8$/.exec(name);
    if (m && bodies.has(Number(m[1]))) return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(media(Number(m[1])));
    if (/^init_v\d+\.mp4$/.test(name)) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(init);
    m = /^seg_v(\d+)_(\d+)\.mp4$/.exec(name);
    const body = m ? bodies.get(Number(m[1])) : undefined;
    if (m && body && Number(m[2]) <= newest()) {
      const out = Buffer.from(body);
      out.writeBigUInt64BE(BigInt(m[2]!), 0);
      return void res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': out.length }).end(out);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    newest,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
