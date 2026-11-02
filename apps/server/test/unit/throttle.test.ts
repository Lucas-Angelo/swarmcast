import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BandwidthLimiter, DEFAULT_NEED_S, MAX_CHUNK_WAIT_MS, MAX_NEED_S } from '../../src/hls/throttle.js';

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

describe('BandwidthLimiter order (docs/QUALITY.md "Upload order")', () => {
  /** Starts `streams` together on `lim` and records when each one finished (virtual ms). */
  async function race(lim: BandwidthLimiter, streams: Array<{ name: string; bytes: number; needInS?: number }>, untilMs = 20_000): Promise<Record<string, number>> {
    const t0 = Date.now();
    const done: Record<string, number> = {};
    const all = Promise.all(
      streams.map(async (s) => {
        const got = { bytes: 0 };
        await drain(lim.stream(Buffer.alloc(s.bytes), s.needInS), got);
        expect(got.bytes).toBe(s.bytes);
        done[s.name] = Date.now() - t0;
      }),
    );
    while (Object.keys(done).length < streams.length && Date.now() - t0 < untilMs) await vi.advanceTimersByTimeAsync(STEP_MS);
    await all;
    return done;
  }

  it('sends the soonest-needed response first: a viewer about to stall goes before buffer fill that arrived earlier', async () => {
    // Arrange: 100 KB/s; four 200 KB "fill" responses needed in 20 s, then one needed now.
    vi.useFakeTimers();
    const lim = new BandwidthLimiter(100_000);
    await lim.take(25_000); // empty the burst: the cap is the bottleneck from the start
    const fill = [1, 2, 3, 4].map((i) => ({ name: `fill${i}`, bytes: 200_000, needInS: 20 }));
    // Act
    const done = await race(lim, [...fill, { name: 'urgent', bytes: 100_000, needInS: 0 }]);
    // Assert: alone, 100 KB takes 1 s; shared equally with four others it took about 5 s. The
    // fill responses still get a 16 KB chunk each about every MAX_CHUNK_WAIT_MS meanwhile (4 × 16
    // KB/s of the 100 KB/s here), so the urgent one ends within 2.1 s.
    expect(done.urgent).toBeLessThanOrEqual(2_100);
    for (const f of fill) expect(done[f.name]).toBeGreaterThan(done.urgent!);
  });

  it('keeps every waiting response moving: no chunk waits more than MAX_CHUNK_WAIT_MS while others go first', async () => {
    // Arrange: an urgent 1 MB response (10 s at 100 KB/s) next to a low-priority one.
    vi.useFakeTimers();
    const lim = new BandwidthLimiter(100_000);
    await lim.take(25_000);
    const low = lim.stream(Buffer.alloc(64 * 1024), 30);
    const urgent = lim.stream(Buffer.alloc(1_000_000), 0);
    const gaps: number[] = [];
    let last = Date.now();
    low.on('data', () => {
      gaps.push(Date.now() - last);
      last = Date.now();
    });
    void drain(urgent, { bytes: 0 });
    // Act
    const t0 = Date.now();
    let ended = false;
    low.on('end', () => (ended = true));
    while (!ended && Date.now() - t0 < 15_000) await vi.advanceTimersByTimeAsync(STEP_MS);
    // Assert: four 16 KB chunks, each within the longest wait (plus one chunk time and a step).
    expect(ended).toBe(true);
    expect(gaps).toHaveLength(4);
    for (const g of gaps) expect(g).toBeLessThanOrEqual(MAX_CHUNK_WAIT_MS + 200 + STEP_MS);
  });

  it('shares equal needs in arrival order (round robin), as before', async () => {
    // Arrange: two 200 KB responses with the same need finish together, like two of the default.
    vi.useFakeTimers();
    const lim = new BandwidthLimiter(100_000);
    await lim.take(25_000);
    // Act
    const done = await race(lim, [
      { name: 'a', bytes: 200_000 },
      { name: 'b', bytes: 200_000 },
    ]);
    // Assert: 400 KB at 100 KB/s: both near 4 s, within a couple of chunks of each other.
    expect(Math.abs(done.a! - done.b!)).toBeLessThanOrEqual(400);
    expect(Math.max(done.a!, done.b!)).toBeGreaterThanOrEqual(3_900);
  });

  it('clamps needs to 0…MAX_NEED_S and treats a missing or broken one as DEFAULT_NEED_S', () => {
    // Arrange
    let now = 1_000;
    const lim = new BandwidthLimiter(100_000, () => now);
    // Act + Assert
    expect(lim.dueIn(-5)).toBe(1_000);
    expect(lim.dueIn(1e9)).toBe(1_000 + MAX_NEED_S * 1000);
    expect(lim.dueIn(Number.NaN)).toBe(1_000 + DEFAULT_NEED_S * 1000);
    expect(lim.dueIn()).toBe(1_000 + DEFAULT_NEED_S * 1000);
    now = 5_000;
    expect(lim.dueIn(2)).toBe(7_000);
  });
});
