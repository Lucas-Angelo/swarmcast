import type { SpeedTestResult } from '@swarmcast/shared';

export interface SpeedTestOptions {
  downloadUrl?: string;
  uploadUrl?: string;
  fetchImpl?: typeof fetch;
  /** Bytes per download request. */
  downloadBytes?: number;
  /** Bytes per upload request. */
  uploadBytes?: number;
  rounds?: number;
}

const DEFAULTS = {
  // Cloudflare's speed test endpoints (used by @cloudflare/speedtest). Kept small on purpose.
  downloadUrl: 'https://speed.cloudflare.com/__down',
  uploadUrl: 'https://speed.cloudflare.com/__up',
  downloadBytes: 10_000_000,
  uploadBytes: 4_000_000,
  rounds: 2,
};

/**
 * Small, infrequent upload/download test (~30 MB in total). Upload is what matters:
 * it decides how many viewers the streamer can serve directly.
 */
export async function runSpeedTest(opts: SpeedTestOptions = {}): Promise<SpeedTestResult> {
  const o = { ...DEFAULTS, ...opts };
  const f = o.fetchImpl ?? fetch;
  const headers = { 'User-Agent': 'SwarmCast speed check' };

  // Latency: a few tiny requests, take the median.
  const latencies: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await f(`${o.downloadUrl}?bytes=0`, { headers, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    await r.arrayBuffer();
    latencies.push(performance.now() - t0);
  }
  latencies.sort((a, b) => a - b);
  const latencyMs = latencies[Math.floor(latencies.length / 2)] ?? 0;

  const down: number[] = [];
  for (let i = 0; i < o.rounds; i++) {
    const t0 = performance.now();
    const r = await f(`${o.downloadUrl}?bytes=${o.downloadBytes}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`download test failed (HTTP ${r.status})`);
    const n = (await r.arrayBuffer()).byteLength;
    const secs = Math.max(0.001, (performance.now() - t0 - latencyMs) / 1000);
    down.push((n * 8) / secs / 1e6);
  }

  const up: number[] = [];
  const body = new Uint8Array(o.uploadBytes);
  for (let i = 0; i < o.rounds; i++) {
    const t0 = performance.now();
    const r = await f(o.uploadUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`upload test failed (HTTP ${r.status})`);
    const secs = Math.max(0.001, (performance.now() - t0 - latencyMs) / 1000);
    up.push((o.uploadBytes * 8) / secs / 1e6);
  }

  return {
    at: Date.now(),
    downloadMbps: round1(Math.max(...down)),
    uploadMbps: round1(Math.max(...up)),
    latencyMs: Math.round(latencyMs),
    source: new URL(o.downloadUrl).host,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Plain-language summary for the panel. */
export function describeSpeed(r: SpeedTestResult): string {
  const quality = r.uploadMbps >= 50 ? 'great' : r.uploadMbps >= 20 ? 'good' : r.uploadMbps >= 10 ? 'okay' : 'low';
  return `Upload ${r.uploadMbps} Mbps (${quality}), download ${r.downloadMbps} Mbps, ping ${r.latencyMs} ms.`;
}
