// TEMPORARY diagnostic (WP7d, removed before merge): how fast does media really play in each
// browser on this runner? Prints one JSON line per variant; asserts nothing.
import os from 'node:os';
import { chromium, type Browser, type Page } from '@playwright/test';
import { join, test, uid, waitForPlaylist, waitPlaying } from './fixtures.js';

const BASE_ARGS = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];

async function measure(page: Page, seconds: number, unmute: boolean): Promise<unknown> {
  return page.evaluate(
    async ({ seconds, unmute }) => {
      const v = document.querySelector('video')!;
      if (unmute) v.muted = false;
      let raf = 0;
      let on = true;
      const loop = (): void => {
        raf += 1;
        if (on) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      let ctx: AudioContext | null;
      try {
        ctx = new AudioContext();
        await ctx.resume().catch(() => {});
      } catch {
        ctx = null;
      }
      const q0 = v.getVideoPlaybackQuality?.();
      const t0 = { wall: performance.now(), media: v.currentTime, audio: ctx?.currentTime ?? null };
      let ticks = 0;
      let maxGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks += 1;
      }, 100);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      clearInterval(timer);
      on = false;
      const q1 = v.getVideoPlaybackQuality?.();
      const wall = (performance.now() - t0.wall) / 1000;
      const out = {
        wallS: Math.round(wall * 100) / 100,
        mediaRate: Math.round(((v.currentTime - t0.media) / wall) * 1000) / 1000,
        playbackRate: v.playbackRate,
        muted: v.muted,
        paused: v.paused,
        readyState: v.readyState,
        audioCtx: ctx ? { state: ctx.state, rate: t0.audio === null ? null : Math.round(((ctx.currentTime - t0.audio) / wall) * 1000) / 1000, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency } : null,
        framesPerS: q0 && q1 ? Math.round((q1.totalVideoFrames - q0.totalVideoFrames) / wall) : null,
        droppedPerS: q0 && q1 ? Math.round(((q1.droppedVideoFrames - q0.droppedVideoFrames) / wall) * 10) / 10 : null,
        rafPerS: Math.round(raf / wall),
        timer100msPerS: Math.round((ticks / wall) * 10) / 10,
        timerMaxGapMs: Math.round(maxGap),
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
      };
      await ctx?.close().catch(() => {});
      return out;
    },
    { seconds, unmute },
  );
}

async function variant(name: string, browser: Browser, o: { unmute?: boolean } = {}): Promise<void> {
  const { context, page } = await join(browser, uid(`pr${name}`.slice(0, 12)));
  await waitPlaying(page);
  const load0 = os.loadavg()[0];
  const r = await measure(page, 15, !!o.unmute);
  console.log(`PROBE ${JSON.stringify({ variant: name, platform: process.platform, cpus: os.cpus().length, load1: [load0, os.loadavg()[0]], ...(r as object) })}`);
  await context.close();
}

test('probe: media clock per browser variant on this runner', { tag: '@probe' }, async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'one pass is enough');
  test.setTimeout(600_000);
  await waitForPlaylist(32);
  await variant('A-config', browser);
  await variant('A-unmuted', browser, { unmute: true });
  for (const [name, args] of [
    ['B-nogpu', ['--disable-gpu']],
    ['C-noaudio', ['--disable-audio-output']],
    ['D-swiftshader', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']],
  ] as const) {
    const b = await chromium.launch({ channel: process.env.PW_CHROMIUM_CHANNEL ?? 'chrome', args: [...BASE_ARGS, ...args] });
    try {
      await variant(name, b);
    } finally {
      await b.close();
    }
  }
});
