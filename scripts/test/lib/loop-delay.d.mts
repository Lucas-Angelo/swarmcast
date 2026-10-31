/** Resolution of the measurement: the timer's period (ms). */
export const LOOP_TICK_MS: number;

/** How long the process's own work held up its event loop (time the OS or VM did not run it left out). */
export class OwnLoopDelay {
  /** p99 of the ticks since the previous call (ms), then starts over. */
  takeP99(): number;
  /** Stops the timer (the process can then exit). */
  stop(): void;
}
