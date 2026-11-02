// Surge bench: what happens when many people join at once, or turn P2P on at once.
//
//   node --import tsx scripts/test/surge/bench.ts [--scenario join-burst,p2p-burst | all] [--out test-results/surge-bench] [--viewer-dir apps/viewer/dist]
//
// Runs the real public server in this process (LiveController: joins, the browser check, sessions,
// /control, the tracker, the chat, the upload limiter, the HLS origin) fed by a synthetic HLS
// ladder (source.ts) instead of MediaMTX, behind an emulation of the quick tunnel's limits
// (tunnel.ts: 200 requests in flight, open WebSockets included, plus a round trip). The viewers are
// protocol-level players in their own processes (viewers.ts). The server is sampled every 250 ms.
//
// Writes <out>/<scenario>.json (samples and every viewer's report), <out>/summary.md and
// <out>/junit.xml; one PASS/FAIL line per scenario (what scripts/ci/soak-run.mjs counts); exits 1
// when a scenario fails its checks. Nothing here touches the user's SwarmCast data, OBS or the
// usual ports: everything listens on 127.0.0.1 port 0, no data folder.
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../../../apps/server/src/core/config.js';
import { ManifestSigner } from '../../../apps/server/src/hls/manifest.js';
import { TunnelProvider } from '../../../apps/server/src/tunnel/provider.js';
import { inactiveDirect, makeController } from '../../../apps/server/test/unit/live-helpers.js';
import { writeJunit } from '../lib/junit.mjs';
import { OwnLoopDelay } from '../lib/loop-delay.mjs';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { startSyntheticSource } from './source.js';
import type { ViewerReport } from './viewers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** Looks like the quick tunnel (so CF-Connecting-IP is trusted from 127.0.0.1); the emulator in front is tunnel.ts. */
class FakeQuickTunnel extends TunnelProvider {
  readonly name = 'cloudflare-quick';
  private current: string | null = null;
  async start(localPort: number): Promise<string> {
    this.current = `http://127.0.0.1:${localPort}`;
    return this.current;
  }
  async stop(): Promise<void> {
    this.current = null;
  }
  get url(): string | null {
    return this.current;
  }
}

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SAMPLE_MS = 250;

interface Sample {
  t: number;
  cpu: number;
  ownDelayP99Ms: number;
  queued: number;
  uploadMbps: number;
  /** Everything toward viewers, through the emulated uplink, Mbps over the last sample. */
  uplinkMbps: number;
  httpInFlight: number;
  tunnelInFlight: number;
  tunnelWs: number;
  refused: number;
  sessions: number;
  trackerPeers: number;
  /** The attack shield: detector state, its main signal, admission limits in force. */
  shield: string;
  /** Every detector signal over its threshold: name level value/threshold. */
  signals: string;
  maxViewers: number;
}

interface TunnelTick {
  uplinkBytes: number;
  inFlight: number;
  peak: number;
  ws: number;
  refused: number;
  served: number;
}

function child(file: string): ChildProcess {
  return fork(path.join(here, file), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
}

function once<T>(c: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (m: { type: string } & T): void => {
      if (m.type !== type) return;
      c.off('message', onMsg);
      resolve(m);
    };
    c.on('message', onMsg);
    c.once('exit', (code) => reject(new Error(`${type}: child exited with ${code}`)));
  });
}

/** Stalls of `v` overlapping [from, to): count and seconds inside the window. */
function stallsIn(v: ViewerReport, from: number, to: number, end: number): { n: number; s: number } {
  let n = 0;
  let s = 0;
  for (const [a, b0] of v.stalls) {
    const b = b0 ?? end;
    if (b <= from || a >= to) continue;
    n += 1;
    s += (Math.min(b, to) - Math.max(a, from)) / 1000;
  }
  return { n, s };
}

export interface Result {
  scenario: string;
  description: string;
  variant: string;
  passed: boolean;
  failures: string[];
  summary: Record<string, number | string>;
  samples: Sample[];
  viewers: ViewerReport[];
  marks: Record<string, number>;
}

export async function runScenario(sc: Scenario, o: { viewerDir: string; variant: string }): Promise<Result> {
  const streamKey = `sc_${crypto.randomBytes(12).toString('hex')}`;
  const source = await startSyntheticSource(streamKey, sc.ladder);
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: source.port };
  config.security.requireBrowserCheck = sc.browserCheck;
  config.uploadLimitMbps = sc.uploadMbps;
  config.quality.upload.mode = 'manual';
  config.quality.ladder = { ...config.quality.ladder, mode: 'manual', enabled: false };
  config.maxViewers = 1000;
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const signer = await ManifestSigner.create(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const { live } = makeController(inactiveDirect(), {
    config,
    streamKey,
    signer,
    viewerDir: o.viewerDir,
    tunnel: new FakeQuickTunnel(),
    // The server's own public address (P2P privacy): a documentation address no viewer has.
    egress: { lookup: async () => ({ v4: '192.0.2.1' }), interfaces: () => 'bench-net', tickMs: 3_600_000 },
  });
  await live.start();
  const tunnel = child('tunnel.ts');
  let tick: TunnelTick = { uplinkBytes: 0, inFlight: 0, peak: 0, ws: 0, refused: 0, served: 0 };
  tunnel.on('message', (m: { type: string } & TunnelTick) => {
    if (m.type === 'tick') tick = m;
  });
  // The uplink itself: the cap is 85 % of it (the default headroom, docs/QUALITY.md §3).
  tunnel.send({ type: 'start', target: live.publicPort, limit: sc.tunnel.limit, rttMs: sc.tunnel.rttMs, uplinkMbps: round(sc.uploadMbps / 0.85) });
  const { port } = await once<{ port: number }>(tunnel, 'ready');
  const base = `http://127.0.0.1:${port}`;
  const link = live.liveLink!.replace(/^https?:\/\/[^/]+/, base);
  // Wait until the origin serves the stream.
  while (!live.origin.available || live.access.p2pChecking) await sleep(100);

  const total = sc.existing + sc.burst;
  const procs = Array.from({ length: Math.max(1, Math.min(os.availableParallelism() - 2, Math.ceil(total / 15))) }, () => child('viewers.ts'));
  const procOf = (id: number): ChildProcess => procs[id % procs.length]!;
  await Promise.all(
    procs.map((p) => {
      p.send({ type: 'init', base, link });
      return once(p, 'ready');
    }),
  );
  const joinGroup = (ids: number[], cohort: string, spreadMs: number): void => {
    for (const p of procs) {
      const mine = ids.filter((id) => procOf(id) === p);
      if (mine.length) p.send({ type: 'join', viewers: mine.map((id) => ({ id, cohort })), spreadMs });
    }
  };

  const samples: Sample[] = [];
  const own = new OwnLoopDelay();
  let cpu = process.cpuUsage();
  let at = performance.now();
  const t0 = Date.now();
  const limiter = live.limiter as unknown as { queue: unknown[] };
  let lastUplink = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    const dt = (now - at) / 1000;
    at = now;
    const c = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    samples.push({
      t: round((Date.now() - t0) / 1000, 2),
      cpu: round(((c.user + c.system) / 1000 / (dt * 1000)) * 100),
      ownDelayP99Ms: round(own.takeP99()),
      queued: limiter.queue.length,
      uploadMbps: round(live.limiter.currentMbps()),
      uplinkMbps: round(((tick.uplinkBytes - lastUplink) * 8) / 1e6 / dt),
      httpInFlight: live.httpStats.inFlight,
      tunnelInFlight: tick.peak,
      tunnelWs: tick.ws,
      refused: tick.refused,
      sessions: live.access.sessions.size,
      trackerPeers: live.tracker.peerCount(),
      shield: `${live.shield.detector.state}${live.shield.detector.report.signals[0] ? `:${live.shield.detector.report.signals[0].signal}` : ''}:pow${live.shield.powLevel()}`,
      signals: live.shield.detector.report.signals.map((g) => `${g.signal}${g.level}:${round(g.value)}/${round(g.threshold)}`).join(','),
      maxViewers: live.shield.effectiveLimits().maxViewers,
    });
    lastUplink = tick.uplinkBytes;
  }, SAMPLE_MS);

  const marks: Record<string, number> = {};
  try {
    const existing = Array.from({ length: sc.existing }, (_, i) => i);
    const burst = Array.from({ length: sc.burst }, (_, i) => sc.existing + i);
    marks.existingAt = Date.now();
    joinGroup(existing, 'existing', sc.existingSpreadMs);
    await sleep(sc.existingSpreadMs + sc.settleS * 1000);
    // Joining dozens of bots in seconds looks like a join storm to the shield; the burst starts
    // from a calm state, as a live does once its audience is in.
    live.clearAttackAlert();
    marks.burstAt = Date.now();
    if (burst.length) joinGroup(burst, 'burst', sc.burstSpreadMs);
    if (sc.p2p) {
      const ids = existing.slice(0, sc.p2p.count);
      for (const p of procs) {
        const mine = ids.filter((id) => procOf(id) === p);
        if (mine.length) p.send({ type: 'p2p', ids: mine, spreadMs: sc.p2p.spreadMs });
      }
    }
    await sleep(sc.observeS * 1000);
    marks.endAt = Date.now();
    const reports = await Promise.all(
      procs.map(async (p) => {
        p.send({ type: 'report' });
        return (await once<{ viewers: ViewerReport[] }>(p, 'report')).viewers;
      }),
    );
    const viewers = reports.flat().sort((a, b) => a.id - b.id);
    return { ...analyse(sc, viewers, samples, marks), samples, viewers, marks, scenario: sc.name, description: sc.description, variant: o.variant };
  } finally {
    clearInterval(sampler);
    own.stop();
    await Promise.all(
      procs.map(async (p) => {
        p.send({ type: 'stop' });
        await once(p, 'stopped').catch(() => {});
        p.kill();
      }),
    );
    tunnel.kill();
    await live.stop().catch(() => {});
    await source.close();
  }
}

function analyse(sc: Scenario, viewers: ViewerReport[], samples: Sample[], marks: Record<string, number>): { passed: boolean; failures: string[]; summary: Record<string, number | string> } {
  const { burstAt, endAt, existingAt } = marks as { burstAt: number; endAt: number; existingAt: number };
  const calmFrom = burstAt - Math.min(20, sc.settleS) * 1000;
  const old = viewers.filter((v) => v.cohort === 'existing');
  const fresh = viewers.filter((v) => v.cohort === 'burst');
  const tSec = (ms: number): number => (ms - existingAt) / 1000;
  const calmSamples = samples.filter((s) => s.t >= tSec(calmFrom) && s.t < tSec(burstAt));
  const burstSamples = samples.filter((s) => s.t >= tSec(burstAt) && s.t < tSec(endAt));

  const calmStalls = old.map((v) => stallsIn(v, calmFrom, burstAt, endAt));
  const burstStalls = old.map((v) => stallsIn(v, burstAt, endAt, endAt));
  const segs = (vs: ViewerReport[], from: number, to: number): number[] => vs.flatMap((v) => v.loads.filter((l) => l.kind === 'segment' && l.status === 200 && l.at >= from && l.at < to).map((l) => l.ms));
  const pls = (vs: ViewerReport[], from: number, to: number): number[] => vs.flatMap((v) => v.loads.filter((l) => l.kind === 'playlist' && l.status === 200 && l.at >= from && l.at < to).map((l) => l.ms));
  const refusals = (vs: ViewerReport[], from: number, to: number): number => vs.reduce((a, v) => a + v.loads.filter((l) => l.at >= from && l.at < to && (l.status === 429 || l.status <= 0 || l.status >= 500)).length, 0);
  const ttff = fresh.filter((v) => v.firstFrameAt).map((v) => (v.firstFrameAt! - v.joinAt) / 1000);
  const freshStalls = fresh.map((v) => stallsIn(v, v.firstFrameAt ?? endAt, endAt, endAt));
  // Mean bitrate the existing viewers played (kbps), calm vs burst: how much ABR gave up.
  const kbpsOf = (vs: ViewerReport[], from: number, to: number): number => {
    const loads = vs.flatMap((v) => v.loads.filter((l) => l.kind === 'segment' && l.status === 200 && l.at >= from && l.at < to));
    return loads.length ? Math.round(mean(loads.map((l) => (l.bytes * 8) / 2 / 1000))) : 0;
  };
  const p2p = viewers.filter((v) => v.p2p);
  const signal = p2p.filter((v) => v.p2p!.firstAnswerAt).map((v) => v.p2p!.firstAnswerAt! - v.p2p!.onAt);
  const closed = viewers.filter((v) => v.controlClosed !== undefined);
  const joinFailed = viewers.filter((v) => !v.joined);
  const stepP95 = (name: string, vs: ViewerReport[]): number => q(vs.map((v) => v.steps[name] ?? 0), 0.95);
  const refusedTunnel = (samples.at(-1)?.refused ?? 0) - (calmSamples[0]?.refused ?? 0);

  const summary: Record<string, number | string> = {
    'existing stalls calm → burst (n / s)': `${calmStalls.reduce((a, s) => a + s.n, 0)} / ${round(calmStalls.reduce((a, s) => a + s.s, 0))} → ${burstStalls.reduce((a, s) => a + s.n, 0)} / ${round(burstStalls.reduce((a, s) => a + s.s, 0))}`,
    'existing viewers who stalled in burst': burstStalls.filter((s) => s.n > 0).length,
    'existing segment p50/p95 ms calm': `${q(segs(old, calmFrom, burstAt), 0.5)}/${q(segs(old, calmFrom, burstAt), 0.95)}`,
    'existing segment p50/p95 ms burst': `${q(segs(old, burstAt, endAt), 0.5)}/${q(segs(old, burstAt, endAt), 0.95)}`,
    'existing playlist p95 ms calm/burst': `${q(pls(old, calmFrom, burstAt), 0.95)}/${q(pls(old, burstAt, endAt), 0.95)}`,
    'existing kbps calm → burst': `${kbpsOf(old, calmFrom, burstAt)} → ${kbpsOf(old, burstAt, endAt)}`,
    'existing refused/failed requests in burst': refusals(old, burstAt, endAt),
    'segment downloads aborted (3 s without bytes)': viewers.reduce((a, v) => a + v.aborts, 0),
  };
  if (fresh.length) {
    Object.assign(summary, {
      'newcomers TTFF p50/p95/max s': `${round(q(ttff, 0.5))}/${round(q(ttff, 0.95))}/${round(Math.max(0, ...ttff))}`,
      'newcomers without first frame': fresh.length - ttff.length,
      'newcomers stalls after first frame (n / s)': `${freshStalls.reduce((a, s) => a + s.n, 0)} / ${round(freshStalls.reduce((a, s) => a + s.s, 0))}`,
      'newcomers join p95 ms (link/join/watch/config)': `${stepP95('link', fresh)}/${stepP95('join', fresh)}/${stepP95('watchPage', fresh)}/${stepP95('config', fresh)}`,
      'newcomers solve p95 ms': stepP95('solve', fresh),
      'newcomers refused/failed requests': refusals(fresh, burstAt, endAt),
      'asset bytes per join': fresh[0]?.assetBytes ?? 0,
    });
  }
  if (p2p.length) {
    Object.assign(summary, {
      'p2p first tracker answer p50/p95/max ms': `${q(signal, 0.5)}/${q(signal, 0.95)}/${Math.max(0, ...signal)}`,
      'p2p refused channels': p2p.filter((v) => v.p2p!.refused).length,
      'p2p offers in / answers out': `${p2p.reduce((a, v) => a + v.p2p!.offersIn, 0)} / ${p2p.reduce((a, v) => a + v.p2p!.answersOut, 0)}`,
      'p2p max frames per 10 s (one viewer)': Math.max(0, ...p2p.map((v) => v.p2p!.maxFramesPer10s)),
    });
  }
  Object.assign(summary, {
    'control sockets closed by server': closed.length,
    'join failures': joinFailed.length,
    'server CPU mean/max % calm': `${round(mean(calmSamples.map((s) => s.cpu)))}/${round(Math.max(0, ...calmSamples.map((s) => s.cpu)))}`,
    'server CPU mean/max % burst': `${round(mean(burstSamples.map((s) => s.cpu)))}/${round(Math.max(0, ...burstSamples.map((s) => s.cpu)))}`,
    'own loop delay p99 calm/burst ms (max)': `${round(Math.max(0, ...calmSamples.map((s) => s.ownDelayP99Ms)))}/${round(Math.max(0, ...burstSamples.map((s) => s.ownDelayP99Ms)))}`,
    'upload Mbps mean calm/burst': `${round(mean(calmSamples.map((s) => s.uploadMbps)))}/${round(mean(burstSamples.map((s) => s.uploadMbps)))}`,
    'uplink Mbps mean calm/burst (all bytes)': `${round(mean(calmSamples.map((s) => s.uplinkMbps)))}/${round(mean(burstSamples.map((s) => s.uplinkMbps)))}`,
    'limiter queue max calm/burst': `${Math.max(0, ...calmSamples.map((s) => s.queued))}/${Math.max(0, ...burstSamples.map((s) => s.queued))}`,
    'tunnel in-flight peak calm/burst': `${Math.max(0, ...calmSamples.map((s) => s.tunnelInFlight))}/${Math.max(0, ...burstSamples.map((s) => s.tunnelInFlight))}`,
    'tunnel 429s in burst': refusedTunnel,
    'shield states in burst': [...new Set(burstSamples.map((s) => s.shield))].join(' '),
    'admission limit min in burst': Math.min(...burstSamples.map((s) => s.maxViewers)),
  });

  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok) failures.push(what);
  };
  const why = new Map<string, number>();
  for (const v of joinFailed) why.set(v.joinError ?? '?', (why.get(v.joinError ?? '?') ?? 0) + 1);
  summary['join failures'] = joinFailed.length ? `${joinFailed.length} (${[...why].map(([k, n]) => `${k} ×${n}`).join(', ')})` : 0;
  check(joinFailed.length === 0, `${joinFailed.length} viewers could not join (${[...why].map(([k, n]) => `${k} ×${n}`).join(', ')})`);
  check(closed.length === 0, `the server closed ${closed.length} control sockets`);
  return { passed: failures.length === 0, failures, summary };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const names = arg('scenario', 'all');
  const out = path.resolve(root, arg('out', 'test-results/surge-bench'));
  const viewerDir = path.resolve(root, arg('viewer-dir', 'apps/viewer/dist'));
  const variant = arg('variant', 'current');
  const chosen = names === 'all' ? SCENARIOS : SCENARIOS.filter((s) => names.split(',').includes(s.name));
  if (chosen.length === 0) {
    console.error(`unknown scenario "${names}"; known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const results: Result[] = [];
  for (const sc of chosen) {
    console.log(`\n▶ ${sc.name}: ${sc.description}`);
    const r = await runScenario(sc, { viewerDir, variant });
    results.push(r);
    fs.writeFileSync(path.join(out, `${sc.name}.json`), JSON.stringify(r));
    console.log(r.summary);
    console.log(r.passed ? `PASS surge bench ${sc.name}` : `FAIL surge bench ${sc.name} — ${r.failures.join('; ')}`);
  }
  const md = [
    `# Surge bench (${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, ${variant})`,
    '',
    ...results.flatMap((r) => [`## ${r.scenario}: ${r.description} — ${r.passed ? 'pass' : '**FAIL**'}`, '', '| metric | value |', '|---|---|', ...Object.entries(r.summary).map(([k, v]) => `| ${k} | ${v} |`), '', ...r.failures.map((f) => `- ${f}`), '']),
  ].join('\n');
  fs.writeFileSync(path.join(out, 'summary.md'), md + '\n');
  writeJunit(path.join(out, 'junit.xml'), 'surge bench', results.map((r) => ({ group: 'surge bench', name: r.scenario, status: r.passed ? 'pass' : 'fail', detail: r.failures.join('; ') })));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}
