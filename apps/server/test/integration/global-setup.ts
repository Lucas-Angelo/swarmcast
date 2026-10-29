import { clipsDir, ensureClip, ffmpegBin, ffmpegVersion, hasInitialBurst } from '../../../../scripts/test/lib/ffmpeg.mjs';
import { FEEDS } from './helpers.js';

/**
 * Before the first integration test: name the ffmpeg in use, and encode the clips the fake OBS
 * sends (once; cached across runs by ffmpeg build and arguments), so no test pays for it.
 */
export default async function setup(): Promise<void> {
  const version = ffmpegVersion();
  if (!version) {
    // Locally the media tests skip themselves without ffmpeg; CI must never skip them silently.
    if (process.env.CI) throw new Error(`the test ffmpeg does not run: ${ffmpegBin()} (set FFMPEG_BIN)`);
    console.log(`ffmpeg for the tests: none (${ffmpegBin()} does not run); the media tests skip`);
    return;
  }
  const t0 = Date.now();
  const clips = await Promise.all(Object.values(FEEDS).map((o) => ensureClip(o)));
  console.log(`ffmpeg for the tests: ${ffmpegBin()} (${version.replace(/ Copyright.*/, '')}${hasInitialBurst() ? ', -readrate_initial_burst' : ''}); ${clips.length} clips in ${clipsDir()} ready in ${Date.now() - t0} ms`);
}
