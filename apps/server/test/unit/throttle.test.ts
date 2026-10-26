import { describe, expect, it } from 'vitest';
import { BandwidthLimiter } from '../../src/hls/throttle.js';

async function drain(r: NodeJS.ReadableStream): Promise<number> {
  let n = 0;
  for await (const c of r) n += (c as Buffer).length;
  return n;
}

describe('BandwidthLimiter', () => {
  it('converts Mbps', () => {
    expect(BandwidthLimiter.fromMbps(8).mbps).toBe(8);
  });

  it('caps throughput globally across concurrent streams', async () => {
    // 400 KB/s, burst = 100 KB. Two streams of 200 KB = 400 KB → ≥ 0.75 s.
    const lim = new BandwidthLimiter(400_000);
    const t0 = performance.now();
    const [a, b] = await Promise.all([drain(lim.stream(Buffer.alloc(200_000))), drain(lim.stream(Buffer.alloc(200_000)))]);
    const secs = (performance.now() - t0) / 1000;
    expect(a + b).toBe(400_000);
    expect(secs).toBeGreaterThan(0.65);
    expect(secs).toBeLessThan(2.5);
  });

  it('applies a new limit at runtime', async () => {
    const lim = new BandwidthLimiter(100_000);
    lim.setMbps(80); // 10 MB/s
    const t0 = performance.now();
    await drain(lim.stream(Buffer.alloc(1_000_000)));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('rejects waiters when closed', async () => {
    const lim = new BandwidthLimiter(1000);
    await lim.take(250); // burst used
    const p = lim.take(50_000);
    lim.close();
    await expect(p).rejects.toThrow(/closed/);
  });
});
