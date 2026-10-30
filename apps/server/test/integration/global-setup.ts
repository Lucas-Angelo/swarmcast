import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipsDir, ensureClip, ffmpegBin, ffmpegVersion, hasInitialBurst } from '../../../../scripts/test/lib/ffmpeg.mjs';
import { FEEDS } from './helpers.js';

/**
 * Before the first integration test: a folder of this run's own for every temporary folder the
 * tests make (tmpDir() in helpers.ts reads SWARMCAST_TEST_TMP; the workers inherit it), the
 * ffmpeg in use, and the clips the fake OBS sends (encoded once; cached across runs by ffmpeg
 * build and arguments), so no test pays for them.
 * After the last file: that folder is deleted. Every process a test started is gone by then
 * (each file stops its own and confirms it), so nothing holds a file in it, also on Windows.
 */
export default async function setup(): Promise<() => void> {
  const version = ffmpegVersion();
  // Locally the media tests skip themselves without ffmpeg; CI must never skip them silently.
  if (!version && process.env.CI) throw new Error(`the test ffmpeg does not run: ${ffmpegBin()} (set FFMPEG_BIN)`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-it-run-'));
  process.env.SWARMCAST_TEST_TMP = root;
  const teardown = (): void => fs.rmSync(root, { recursive: true, force: true });
  if (!version) {
    console.log(`ffmpeg for the tests: none (${ffmpegBin()} does not run); the media tests skip`);
    return teardown;
  }
  const t0 = Date.now();
  const clips = await Promise.all(Object.values(FEEDS).map((o) => ensureClip(o)));
  console.log(`ffmpeg for the tests: ${ffmpegBin()} (${version.replace(/ Copyright.*/, '')}${hasInitialBurst() ? ', -readrate_initial_burst' : ''}); ${clips.length} clips in ${clipsDir()} ready in ${Date.now() - t0} ms`);
  return teardown;
}
