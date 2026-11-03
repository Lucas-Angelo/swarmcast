// X-SC-Need (need-header.ts): how soon the page needs each segment, for the server's upload order
// (docs/QUALITY.md "Upload order").
import { describe, expect, it } from 'vitest';
import { NEED_HEADER, needHeaders, needRequestSetup, needSeconds, type NeedSource } from '../../src/need-header.js';

const U = 'https://live.example/hls/';
const frags = (prefix: string, startAt: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ url: `${U}${prefix}${i}.mp4`, start: startAt + 2 * i, initSegment: { url: `${U}${prefix}init.mp4` } }));

function source(o: { currentTime?: number; readyState?: number; media?: boolean } = {}): NeedSource {
  return {
    levels: [{ details: { fragments: frags('v', 100, 20) } }, {}],
    audioTracks: [{ details: { fragments: frags('a', 100, 40) } }],
    media: o.media === false ? null : { currentTime: o.currentTime ?? 110, readyState: o.readyState ?? 4 },
  };
}

describe('needSeconds', () => {
  it('is the fragment start minus the playhead, one decimal, never below 0', () => {
    expect(needSeconds(source({ currentTime: 110.04 }), `${U}v8.mp4`)).toBe(6);
    expect(needSeconds(source({ currentTime: 110.25 }), `${U}a6.mp4`)).toBe(1.8);
    expect(needSeconds(source({ currentTime: 130 }), `${U}v1.mp4`)).toBe(0);
  });

  it('is 0 before the first picture and for init segments', () => {
    expect(needSeconds(source({ readyState: 1 }), `${U}v19.mp4`)).toBe(0);
    expect(needSeconds(source({ media: false }), `${U}v19.mp4`)).toBe(0);
    expect(needSeconds(source(), `${U}vinit.mp4`)).toBe(0);
  });

  it('is unknown for a URL no playlist in use lists (playlists, other files)', () => {
    expect(needSeconds(source(), `${U}index.m3u8`)).toBeUndefined();
    expect(needHeaders(source(), `${U}index.m3u8`)).toEqual({});
    expect(needHeaders(source({ currentTime: 100 }), `${U}v3.mp4`)).toEqual({ [NEED_HEADER]: '6.0' });
  });
});

describe('needRequestSetup', () => {
  it('builds the request p2p-media-loader would, with the header, its Range and its abort signal', async () => {
    const ac = new AbortController();
    const setup = needRequestSetup(() => source({ currentTime: 104 }));
    const req = await setup(`${U}v5.mp4`, undefined, ac.signal, { start: 1000 });
    expect(req.url).toBe(`${U}v5.mp4`);
    expect(req.headers.get(NEED_HEADER)).toBe('6.0');
    expect(req.headers.get('Range')).toBe('bytes=1000-');
    ac.abort();
    expect(req.signal.aborted).toBe(true);
  });

  it('works before hls.js exists (no header) and without a range', async () => {
    const req = await needRequestSetup(() => null)(`${U}v5.mp4`, undefined, undefined, undefined);
    expect(req.headers.get(NEED_HEADER)).toBeNull();
    expect(req.headers.get('Range')).toBeNull();
  });
});
