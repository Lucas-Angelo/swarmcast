// Scenarios of the surge bench (bench.ts). Each one: an audience already watching ("existing"),
// then a burst (people joining within a few seconds, or many turning P2P on at once), observed
// next to the existing viewers. Real time is the subject: the join schedule and the observation
// windows are the load being measured.
import type { Rendition } from './source.js';

export interface Scenario {
  name: string;
  description: string;
  /** The server's upload cap (Settings → upload limit, manual), Mbps: the streamer's uplink. */
  uploadMbps: number;
  ladder?: Rendition[];
  /** The quick tunnel: requests in flight it holds (200) and the round trip it adds (ms). */
  tunnel: { limit: number; rttMs: number };
  /** The browser check on joins (on by default in the app; the bench's viewers solve it). */
  browserCheck: boolean;
  existing: number;
  /** The existing audience joins over this long, then plays for settleS before the burst. */
  existingSpreadMs: number;
  settleS: number;
  /** Newcomers joining within burstSpreadMs. */
  burst: number;
  burstSpreadMs: number;
  /** Viewers turning P2P on at the burst (counted from the existing audience). */
  p2p?: { count: number; spreadMs: number };
  /** Observation after the burst starts, s. */
  observeS: number;
}

const tunnel = { limit: 200, rttMs: 60 };

export const SCENARIOS: Scenario[] = [
  {
    name: 'join-burst',
    description: '15 watching on a 60 Mbps upload cap, then 30 join within 3 s (everyone still fits at 480p)',
    uploadMbps: 60,
    tunnel,
    browserCheck: true,
    existing: 15,
    existingSpreadMs: 10_000,
    settleS: 40,
    burst: 30,
    burstSpreadMs: 3_000,
    observeS: 45,
  },
  {
    name: 'join-burst-tight',
    description: '20 watching on a 30 Mbps upload cap, then 40 join within 3 s (more than the uplink carries at 480p)',
    uploadMbps: 30,
    tunnel,
    browserCheck: true,
    existing: 20,
    existingSpreadMs: 10_000,
    settleS: 40,
    burst: 40,
    burstSpreadMs: 3_000,
    observeS: 45,
  },
  {
    name: 'join-burst-big',
    description: '40 watching on a 60 Mbps uplink, then 80 join within 5 s (the tunnel\'s practical maximum)',
    uploadMbps: 60,
    tunnel,
    browserCheck: true,
    existing: 40,
    existingSpreadMs: 15_000,
    settleS: 40,
    burst: 80,
    burstSpreadMs: 5_000,
    observeS: 45,
  },
  {
    name: 'p2p-burst',
    description: '80 watching on a 120 Mbps upload cap, then 70 of them turn P2P on within 2 s',
    uploadMbps: 120,
    tunnel,
    browserCheck: false,
    existing: 80,
    existingSpreadMs: 60_000,
    settleS: 30,
    burst: 0,
    burstSpreadMs: 0,
    p2p: { count: 70, spreadMs: 2_000 },
    observeS: 40,
  },
];
