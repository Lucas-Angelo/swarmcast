// The first seconds of a stream's run (a live starting, OBS reconnecting). The fake OBS, like an
// OBS that flushes a backlog, sends its first 4 s at once; MediaMTX dates those 2 s segments 1 ms
// apart. hls.js lines the audio playlist up with the video one by these dates, so until the burst
// left the window (~40 s) a viewer who joined got audio and video of different moments, filled
// the holes out of order and jumped to where the video started and the audio did not: Linux
// WebKit froze for good on that jump (its GStreamer media source deadlocks; seen in
// branding.spec on CI, where a page froze mid-assertion and the next test's page never loaded).
// The origin now dates each segment of a run as the previous one plus its duration (hls/playlist.ts
// withDate). Checked on every engine: the served dates right after a reconnect, and viewers
// joining one after the other through the run's first 30 s all play.
import type { Page } from '@playwright/test';
import { expect, reconnectObs, test, uid, waitPlaying } from './fixtures.js';

/** The served video and audio playlists, through the viewer's own session. */
async function playlists(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ['video1_stream.m3u8', 'audio2_stream.m3u8']) out[name] = await (await page.request.get(`/hls/${name}`)).text();
  return out;
}

/** The init segment of the playlist's newest run (each run of OBS has its own). */
const newestMap = (text: string): string | undefined => text.match(/#EXT-X-MAP:URI="([^"]+)"/g)?.at(-1);

/** [date, duration] of each listed segment of the playlist's newest run. */
function newestRun(text: string): Array<[number, number]> {
  let run: Array<[number, number]> = [];
  let date: number | undefined;
  let duration = 0;
  for (const line of text.split('\n')) {
    if (line === '#EXT-X-DISCONTINUITY') run = [];
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) date = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith('#') && date !== undefined) {
      run.push([date, duration]);
      date = undefined;
    }
  }
  return run;
}

test('right after OBS reconnects, the served dates follow the segment durations and new viewers play', { tag: '@media' }, async ({ viewers }) => {
  test.setTimeout(150_000);
  // Arrange
  const { page: watcher } = await viewers.join(uid('runwatch'));
  const before = Object.fromEntries(Object.entries(await playlists(watcher)).map(([name, text]) => [name, newestMap(text)]));

  // Act
  await reconnectObs(null);
  const since = Date.now();

  // Assert: the new run's first segments (the burst) are dated in step with their durations, to
  // the millisecond (hls.js shifts the audio by any difference).
  let lists: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        lists = await playlists(watcher);
        // The new run, with at least three segments in both playlists.
        return Object.entries(lists).every(([name, text]) => newestMap(text) !== before[name] && newestRun(text).length >= 3);
      },
      { timeout: 30_000, message: "the reconnected run's first three segments listed" },
    )
    .toBe(true);
  for (const [name, text] of Object.entries(lists)) {
    const run = newestRun(text);
    const gaps = run.slice(1).map(([d], i) => d - run[i]![0] - run[i]![1] * 1000);
    for (const gap of gaps) expect(Math.abs(gap), `${name}: a date ${gap} ms off the segment's duration\n${text}`).toBeLessThanOrEqual(1);
  }

  // Assert: viewers who join during the run's first 30 s play (each one a new browser).
  for (let i = 0; Date.now() - since < 30_000; i++) {
    const { page, context } = await viewers.join(uid(`runjoin${i}`));
    await waitPlaying(page);
    await context.close();
  }
});
