// A phone that starts a test calm: no first-boot work, no daemon in a burst, nothing left over
// from the last test. A busy device lengthens what the harness cannot time itself: on iOS the
// finger's time down (finger down and up are steps of one W3C `POST /actions` that Safari's
// automation plays one after the other: 1.26 s once, which iOS took for a long press, Devices run
// 42515339177), on Android the system's own deadlines (SystemUI and Gboard ANRs at a cold boot,
// Devices run 42316622933). Each phone measures its CPU (ios.ts: the simulator's processes on the
// Mac; android.ts: the guest's /proc/stat) over CALM_WINDOW_MS, and `untilCalm` waits until two
// windows in a row stay under the phone's bar, writing every window to device.log.
import { until } from '../../../../scripts/test/lib/wait.mjs';

/** One measured window (docs/TESTING.md "Measured windows"): how long each CPU reading lasts. */
export const CALM_WINDOW_MS = 2_000;

/** A window's reading: the share of one CPU core used (1 = one core busy throughout), and who used the most. */
export interface Load {
  cores: number;
  busiest: string;
}

/** Resolves after `ms`: the length of a measured window, never a wait for something to happen. */
export function measuredWindow(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until two measured windows in a row use at most `maxCores` (`measure` measures one
 * window), within `timeoutMs`. Each window goes to `record`; a timeout names the last readings.
 */
export async function untilCalm(o: { what: string; maxCores: number; timeoutMs: number; measure(): Promise<Load>; record(line: string): void }): Promise<void> {
  const readings: Load[] = [];
  const started = Date.now();
  await until(
    async () => {
      const load = await o.measure();
      readings.push(load);
      o.record(`${o.what}: ${load.cores.toFixed(2)} cores (bar ${o.maxCores}); ${load.busiest}`);
      const last = readings.slice(-2);
      return last.length === 2 && last.every((l) => l.cores <= o.maxCores);
    },
    {
      timeoutMs: o.timeoutMs,
      pollMs: 100,
      what: `${o.what}: two ${CALM_WINDOW_MS / 1000} s windows in a row at ${o.maxCores} CPU cores or less`,
      detail: () => readings.slice(-3).map((l) => `${l.cores.toFixed(2)} cores (${l.busiest})`).join(' | '),
    },
  );
  o.record(`${o.what}: calm after ${Date.now() - started} ms`);
}
