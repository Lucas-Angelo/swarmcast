// Prints how the adaptive upload controller behaves on a simulated uplink (same model as
// apps/server/test/unit/upload-controller.test.ts). Usage:
//   node --import tsx scripts/test/quality/simulate-controller.ts
import { RttTracker, UploadController } from '../../../apps/server/src/quality/upload-controller.js';

interface Scenario {
  name: string;
  capacityMbps: number;
  otherStreamMbps: number;
  demandMbps: number;
  ceilingMbps?: number;
  obs?: boolean;
  rtt?: boolean;
}

function run(s: Scenario, ticks = 900): string {
  const c = new UploadController();
  const rtt = new RttTracker();
  c.reset(s.ceilingMbps, 100);
  let q = 0;
  let congested = 0;
  let backoffs = 0;
  const caps: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const sent = Math.min(c.capMbps, s.demandMbps);
    const excess = sent + s.otherStreamMbps - s.capacityMbps * 0.97;
    q = Math.max(0, Math.min(2000, q + (excess / s.capacityMbps) * 2000));
    if (excess < 0) q = Math.max(0, q - 200);
    if (q > 100) congested++;
    rtt.add(i * 2000, 30 + q);
    const r = c.tick({
      now: i * 2000,
      ceilingMbps: s.ceilingMbps,
      fallbackMaxMbps: 100,
      signals: {
        usedMbps: sent,
        demandLimited: s.demandMbps > c.capMbps,
        ...(s.rtt !== false ? { rttMs: rtt.currentMs, baseRttMs: rtt.baseMs, queueDelayMs: rtt.queueDelayMs } : {}),
        ...(s.obs ? { obsCongestion: Math.min(1, q / 500) } : {}),
      },
    });
    if (r.backoff) backoffs++;
    caps.push(r.capMbps);
  }
  const tail = caps.slice(-ticks / 2);
  const free = s.capacityMbps * 0.97 - s.otherStreamMbps;
  const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
  return `| ${s.name} | ${free.toFixed(1)} | ${avg.toFixed(1)} (${Math.round((avg / free) * 100)} %) | ${Math.max(...tail).toFixed(1)} | ${(100 * congested / ticks).toFixed(1)} % | ${backoffs} |`;
}

console.log('| Scenario | Free uplink (Mbps) | Avg cap, 2nd half | Max cap | Time with queue > 100 ms | Backoffs (30 min) |');
console.log('|---|---|---|---|---|---|');
for (const s of [
  { name: '20 Mbps up, other stream 6, no speed test, RTT only', capacityMbps: 20, otherStreamMbps: 6, demandMbps: 40 },
  { name: '20 Mbps up, other stream 6, OBS congestion only', capacityMbps: 20, otherStreamMbps: 6, demandMbps: 40, ceilingMbps: 40, obs: true, rtt: false },
  { name: '20 Mbps up, other stream 6, speed test (ceiling 11.5)', capacityMbps: 20, otherStreamMbps: 6, demandMbps: 40, ceilingMbps: 11.5 },
  { name: '10 Mbps up, other stream 6, RTT only', capacityMbps: 10, otherStreamMbps: 6, demandMbps: 40 },
  { name: '100 Mbps up, other stream 8, speed test (ceiling 75)', capacityMbps: 100, otherStreamMbps: 8, demandMbps: 200, ceilingMbps: 75 },
] as Scenario[]) {
  console.log(run(s));
}
