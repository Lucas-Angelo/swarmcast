// How long a Node process's own work holds up its event loop, for the chat load checks
// (scripts/test/chat/bench.ts, apps/server/test/e2e/chat-flood.spec.ts).
import { performance } from 'node:perf_hooks';

/** Resolution of the measurement: the timer's period (ms). */
export const LOOP_TICK_MS = 10;

/**
 * How long the process's own work held up its event loop. A 10 ms timer on the process's thread;
 * each tick's lateness counts only as far as that thread was busy meanwhile: at most its CPU
 * time and at most the loop's active time (ELU) since the previous tick. Time in which the OS or
 * the VM did not run the process at all is left out.
 *
 * monitorEventLoopDelay counts that time too. On GitHub's macOS VMs it reached 50-110 ms in calm
 * seconds with the server idle (ELU 0.01-0.14 and 1 % CPU in the same second: the process was not
 * running), in a random scenario of every run, while a real Mac and the Linux and Windows runners
 * stayed flat (10-25 ms). Each bound covers the other's blind spot: a VM that stops the process
 * while its loop is active inflates the active time, not the CPU time; on Windows the thread's
 * CPU time advances in clock ticks (about 15 ms) while the active time is exact.
 */
export class OwnLoopDelay {
  /** @type {number[]} */
  #delays = [];
  #last = performance.now();
  #cpu = process.threadCpuUsage();
  #elu = performance.eventLoopUtilization();
  #timer = setInterval(() => this.#tick(), LOOP_TICK_MS);

  #tick() {
    const now = performance.now();
    const cpu = process.threadCpuUsage();
    const elu = performance.eventLoopUtilization();
    const ranMs = (cpu.user - this.#cpu.user + cpu.system - this.#cpu.system) / 1000;
    const activeMs = elu.active - this.#elu.active;
    const lateMs = now - this.#last - LOOP_TICK_MS;
    this.#delays.push(Math.max(0, Math.min(lateMs, ranMs, activeMs)));
    this.#last = now;
    this.#cpu = cpu;
    this.#elu = elu;
  }

  /**
   * p99 of the ticks since the previous call (ms), then starts over. The same rank as
   * monitorEventLoopDelay's percentile(99) (HdrHistogram: the value with 99 % of the samples at or
   * below it), so a check keeps the meaning it had, measured on the process's own work.
   * @returns {number}
   */
  takeP99() {
    const s = [...this.#delays].sort((a, b) => a - b);
    this.#delays.length = 0;
    return s.length ? s[Math.max(0, Math.floor(0.99 * s.length + 0.5) - 1)] : 0;
  }

  /** Stops the timer (the process can then exit). */
  stop() {
    clearInterval(this.#timer);
  }
}
