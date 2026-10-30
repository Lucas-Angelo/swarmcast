import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BandwidthLimiter } from '../../src/hls/throttle.js';

// The global upload limiter: a token bucket shared by every viewer, with a burst of 250 ms worth
// of traffic. Time is the subject here, so the clock is fake (timers, Date and performance.now):
// the bucket's waits pass in virtual time, exactly, whatever the machine's load.

afterEach(() => {
  vi.useRealTimers();
});

/** Reads `r` to the end, counting its bytes in `got`. */
async function drain(r: Readable, got: { bytes: number }): Promise<void> {
  for await (const c of r) got.bytes += (c as Buffer).length;
}

/** Virtual time step between two looks at what was delivered, ms. */
const STEP_MS = 10;

describe('BandwidthLimiter', () => {
  it('converts Mbps', () => {
    // Act
    const lim = BandwidthLimiter.fromMbps(8);
    // Assert
    expect(lim.mbps).toBe(8);
  });

  it('caps throughput globally across concurrent streams (two of 200 KB at 400 KB/s, 100 KB burst: 0.75 s)', async () => {
    // Arrange
    vi.useFakeTimers();
    const lim = new BandwidthLimiter(400_000);
    const a = { bytes: 0 };
    const b = { bytes: 0 };
    const t0 = Date.now();
    let finishedAtMs: number | undefined;
    // Act
    const done = Promise.all([drain(lim.stream(Buffer.alloc(200_000)), a), drain(lim.stream(Buffer.alloc(200_000)), b)]).then(() => (finishedAtMs = Date.now() - t0));
    const delivered: Array<{ atMs: number; bytes: number }> = [];
    while (finishedAtMs === undefined && Date.now() - t0 < 2000) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      delivered.push({ atMs: Date.now() - t0, bytes: a.bytes + b.bytes });
    }
    await done;
    // Assert
    expect(a.bytes + b.bytes).toBe(400_000);
    for (const d of delivered) expect(d.bytes, `${d.atMs} ms`).toBeLessThanOrEqual(100_000 + 400 * d.atMs);
    expect(finishedAtMs).toBeGreaterThanOrEqual(700);
    expect(finishedAtMs).toBeLessThanOrEqual(800);
  });

  it('applies a new limit at runtime (1 MB: 10 s at 100 KB/s, about 0.1 s at 80 Mbps)', async () => {
    // Arrange
    vi.useFakeTimers();
    const lim = new BandwidthLimiter(100_000);
    const got = { bytes: 0 };
    const t0 = Date.now();
    // Act
    lim.setMbps(80);
    const done = drain(lim.stream(Buffer.alloc(1_000_000)), got).then(() => Date.now() - t0);
    await vi.advanceTimersByTimeAsync(200);
    // Assert
    const tookMs = await done;
    expect(got.bytes).toBe(1_000_000);
    expect(tookMs).toBeGreaterThan(90);
    expect(tookMs).toBeLessThan(110);
  });

  it('rejects waiters when closed', async () => {
    // Arrange
    const lim = new BandwidthLimiter(1000);
    await lim.take(250);
    const waiting = lim.take(50_000);
    // Act
    lim.close();
    // Assert
    await expect(waiting).rejects.toThrow(/closed/);
  });
});
