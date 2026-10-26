import path from 'node:path';
import type { SpeedTestResult } from '@swarmcast/shared';
import type { App } from '../app.js';
import { loadConfig } from '../core/config.js';
import { appVersion } from '../core/version.js';
import { ffmpegPin } from '../quality/ffmpeg.js';
import type { DesktopBridge } from './bridge.js';
import { needsSystemCheck, runSystemCheck } from './system-check.js';

/** ffmpeg download: first try, then 3 more after 2 s, 5 s and 10 s (docs/DESKTOP.md). */
export const FFMPEG_RETRY_DELAYS_MS = [2000, 5000, 10_000];
/** A speed test younger than this is reused instead of running another one. */
const SPEED_FRESH_MS = 10 * 60_000;

/** Wait until the startup speed test (scheduleSpeedTests) is over, then reuse it or run one. */
async function speedForCheck(app: App): Promise<SpeedTestResult | undefined | 'skipped'> {
  const { live, config } = app;
  if (!config.speedTest.enabled) return 'skipped';
  if (live.speedTestRunning) {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (live.speedTestRunning) return;
        live.off('state', check);
        resolve();
      };
      live.on('state', check);
      check();
    });
  }
  const last = live.speedTest;
  if (last && Date.now() - last.at < SPEED_FRESH_MS) return last;
  return live.runSpeedTest();
}

/**
 * First start of the desktop app (no system-check.json, or one from another version): the
 * system check the start scripts do before installing, then the video converter (ffmpeg),
 * with retries. Runs in the background; nothing here is fatal.
 */
export async function runDesktopFirstRun(app: App, bridge: DesktopBridge, o: { env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const env = o.env ?? process.env;
  const { log, live, paths } = app;
  const file = path.join(paths.dataDir, 'system-check.json');
  const version = appVersion();
  if (!needsSystemCheck(file, version)) return;

  bridge.setSystemCheck('running');
  try {
    // The ports SwarmCast wants (config.json), not the fallbacks chosen for this run.
    const wanted = loadConfig(paths.configFile).ports;
    const c = await runSystemCheck(file, {
      dataDir: paths.dataDir,
      appVersion: version,
      ports: [wanted.rtmp, wanted.public, wanted.admin],
      ownPorts: () => {
        const p = app.config.ports;
        // The panel is always ours; RTMP, HLS and the public server while the live is on.
        return live.phase === 'off' ? [p.admin] : [p.admin, p.rtmp, p.public, p.mediamtxHls];
      },
      speed: () => speedForCheck(app),
    });
    log.info({ below: c.belowMinimum }, 'desktop first run: system check saved');
    bridge.setSystemCheck('done');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'desktop first run: system check failed');
    bridge.setSystemCheck('failed');
  }

  const q = live.quality;
  if (q.ffmpegAvailable || !ffmpegPin() || env.SWARMCAST_NO_FFMPEG_INSTALL === '1') return;
  if (q.install && !['done', 'error'].includes(q.install.phase)) return; // started from the panel already
  log.info('desktop first run: installing the video converter (ffmpeg)');
  await q.installFfmpegWithRetries(FFMPEG_RETRY_DELAYS_MS, o.sleep).catch((err: Error) => {
    log.warn({ err: err.message }, 'desktop first run: could not install the video converter; viewers get the original quality (the panel offers "Try again")');
  });
}
