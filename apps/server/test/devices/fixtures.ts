// Fixtures of the device suite, on top of the e2e ones (one e2e server for the run, reset and
// checked by the e2e stream gate before every test):
// - `device` (worker): the project's phone, once for the run: the Android emulator (attached or
//   booted) or the iOS Simulator with safaridriver;
// - `phone` (test): a fresh browser on it. Its screen is recorded; a failed test keeps the
//   recording, a screenshot of the whole screen and the device's log.
import fs from 'node:fs';
import path from 'node:path';
import { SEGMENT_DURATION_S } from '@swarmcast/shared';
import { loopbackBase } from '../../../../scripts/test/lib/loopback.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { liveLink, test as e2e } from '../e2e/fixtures.js';
import { AndroidDevice, AndroidPhone } from './android.js';
import { IosDevice } from './ios.js';
import type { Phone, Platform } from './phone.js';

export { expect } from '../e2e/fixtures.js';

type Device = AndroidDevice | IosDevice;

export const test = e2e.extend<{ phone: Phone }, { platform: Platform; device: Device }>({
  platform: ['android', { scope: 'worker', option: true }],
  device: [
    async ({ platform }, use, workerInfo) => {
      const logDir = path.join(workerInfo.project.outputDir, `${platform}-device`);
      fs.mkdirSync(logDir, { recursive: true });
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) throw new Error('the devices config sets use.baseURL (the e2e server)');
      const device = platform === 'android' ? await AndroidDevice.attach({ publicPort: Number(new URL(baseURL).port), logDir }) : await IosDevice.attach({ logDir });
      if (device instanceof AndroidDevice) await device.keyboardOnce(await liveLink());
      await use(device);
      await device.release();
    },
    // A cold emulator boot or a simulator's first boot after its automation settings.
    { scope: 'worker', timeout: 600_000 },
  ],
  phone: async ({ device }, use, testInfo) => {
    const phone = await device.newPhone();
    const recordingFile = testInfo.outputPath(device instanceof AndroidDevice ? 'screen.mp4' : 'screen.mov');
    const recording = process.env.DEVICES_VIDEO === 'off' ? null : device.startRecording(recordingFile);
    try {
      await use(phone);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await phone
          .screenshot()
          .then((body) => testInfo.attach('screen', { body, contentType: 'image/png' }))
          .catch((e: Error) => testInfo.attach('screen (failed)', { body: e.message }));
        if (phone instanceof AndroidPhone) {
          const page = await phone.pageScreenshot();
          if (page) await testInfo.attach('page', { body: page, contentType: 'image/png' });
        }
        if (device instanceof AndroidDevice) {
          const exit = device.emulatorExit();
          if (exit) await testInfo.attach('emulator', { body: exit, contentType: 'text/plain' });
          // A file next to the recording, so CI's test-results upload keeps it too.
          const log = testInfo.outputPath('logcat.txt');
          fs.writeFileSync(log, await device.logcat().catch((e: Error) => e.message));
          await testInfo.attach('logcat', { path: log, contentType: 'text/plain' });
        }
      }
      const stopped = await recording?.stop().then(
        () => true,
        (e: Error) => testInfo.attach('screen recording (failed)', { body: e.message }).then(() => false),
      );
      if (failed && stopped && fs.existsSync(recordingFile)) await testInfo.attach('screen recording', { path: recordingFile, contentType: device instanceof AndroidDevice ? 'video/mp4' : 'video/quicktime' });
      else fs.rmSync(recordingFile, { force: true });
      await phone.close();
    }
  },
});

// The e2e server's test control port (server.ts CONTROL_PORT; keep in sync, like fixtures.ts).
const CONTROL = loopbackBase(`http://127.0.0.1:${38082 + Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0)}`);

/** Milliseconds since the live's newest segment (GET /health on the control port, server.ts). */
async function sinceSegmentMs(): Promise<number | null> {
  const res = await fetch(new URL('/health', CONTROL));
  if (!res.ok) throw new Error(`test control GET /health: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { sinceSegmentMs: number | null }).sinceSegmentMs;
}

/**
 * Resolves once the live has made `segments` new segments: how long a viewer stays away to fall
 * that far behind (the e2e server's fake OBS makes one every SEGMENT_DURATION_S).
 */
export async function liveMovesOn(segments: number): Promise<void> {
  let last = (await sinceSegmentMs()) ?? Number.POSITIVE_INFINITY;
  let seen = 0;
  await until(
    async () => {
      const since = await sinceSegmentMs();
      if (since !== null && since < last) seen += 1;
      if (since !== null) last = since;
      return seen >= segments;
    },
    { timeoutMs: (segments + 5) * 2 * SEGMENT_DURATION_S * 1000, what: `${segments} new live segments`, detail: () => `${seen} seen`, pollMs: 200 },
  );
}
