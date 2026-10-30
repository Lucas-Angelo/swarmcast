// Chat load bench (docs/CHAT.md "Load and soak", chat plan §8.4 and §10.5). Runs the real public
// server and chat hub in this process (fake MediaMTX, a fake quick tunnel on 127.0.0.1, no data
// folder, port 0), forks bots.ts for the bots, samples the server every second and checks each
// scenario's pass criteria:
//
//   node --import tsx scripts/test/chat/bench.ts [--scenario lively,flood | all] [--seconds 30] [--out test-results/chat-bench]
//
// Writes <out>/<scenario>.json (every sample) and <out>/summary.md; exits 1 when a scenario fails.
// Nothing here touches the user's SwarmCast data, OBS or the usual ports.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../../../apps/server/src/core/config.js';
import type { DirectMode } from '../../../apps/server/src/direct/direct.js';
import { TunnelProvider } from '../../../apps/server/src/tunnel/provider.js';
import { makeController } from '../../../apps/server/test/unit/live-helpers.js';
import type { BotStats } from './bots.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** Looks like the quick tunnel (so CF-Connecting-IP is trusted from 127.0.0.1) but serves the local port. */
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

interface Sample {
  t: number;
  phase: 'baseline' | 'run';
  /** Server process CPU, % of one core, over the last second. */
  cpu: number;
  elu: number;
  loopP99Ms: number;
  rssMb: number;
  accepted: number;
  egressKbps: number;
  budgetKbps: number;
  globalPerS: number;
  skipped: number;
  protect: string;
  guard: string;
  tunnelInFlight: number;
  viewers: number;
}

interface Result {
  scenario: string;
  description: string;
  passed: boolean;
  failures: string[];
  summary: Record<string, number | string>;
  bots: BotStats;
  samples: Sample[];
}

const p = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

async function runScenario(sc: Scenario): Promise<Result> {
  const direct = { noteViewer: () => {}, snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  config.security.requireBrowserCheck = false;
  config.uploadLimitMbps = sc.uploadMbps;
  config.maxViewers = 1000;
  config.maxSessionsPerDevice = 3;
  config.chat = { ...config.chat, ...sc.chat, content: { ...config.chat.content, ...sc.chat?.content }, gif: { ...config.chat.gif, ...sc.chat?.gif } };
  const { live } = makeController(direct, {
    config,
    tunnel: new FakeQuickTunnel(),
    // The server's own public address: none (never asks Cloudflare's trace endpoint).
    egress: { lookup: async () => ({}), interfaces: () => 'bench-net', tickMs: 3_600_000 },
  });
  await live.start();
  const base = `http://127.0.0.1:${live.publicPort}`;
  const link = live.liveLink!;
  const child = fork(path.join(here, 'bots.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const fromChild = <T>(type: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const onMsg = (m: { type: string } & T): void => {
        if (m.type === type) {
          child.off('message', onMsg);
          resolve(m);
        }
      };
      child.on('message', onMsg);
      child.once('exit', (code) => reject(new Error(`bots exited with ${code} before "${type}"`)));
    });

  try {
    child.send({ type: 'start', base, link, scenario: sc });
    const joined = await fromChild<{ bots: number; joinFailures: number }>('joined');
    // Joining 120 bots in a few seconds looks like a join storm to the shield; the scenario starts
    // from a calm state, as a live does once its audience is in.
    live.clearAttackAlert();
    live.chat.setProtect('off');

    const samples: Sample[] = [];
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    let cpu = process.cpuUsage();
    let elu = performance.eventLoopUtilization();
    let lastSeq = live.chat.adminState().lastSeq;
    let at = performance.now();
    const t0 = Date.now();
    const sample = (phase: Sample['phase']): void => {
      const now = performance.now();
      const dt = (now - at) / 1000;
      at = now;
      const c = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      const e = performance.eventLoopUtilization(elu);
      elu = performance.eventLoopUtilization();
      const state = live.chat.adminState();
      const counters = state.counters;
      samples.push({
        t: round((Date.now() - t0) / 1000),
        phase,
        cpu: round(((c.user + c.system) / 1000 / (dt * 1000)) * 100),
        elu: round(e.utilization, 3),
        loopP99Ms: round(loop.percentile(99) / 1e6),
        rssMb: round(process.memoryUsage().rss / 1048576),
        accepted: round((state.lastSeq - lastSeq) / dt),
        egressKbps: counters.egressKbps,
        budgetKbps: counters.budgetKbps,
        globalPerS: counters.globalPerS,
        skipped: counters.skipped,
        protect: counters.protectReason ? `${counters.protect}:${counters.protectReason.split('.').pop()}:${live.shield.detector.state}` : counters.protect,
        guard: counters.guard,
        tunnelInFlight: live.tunnelInFlight(),
        viewers: live.access.sessions.size,
      });
      lastSeq = state.lastSeq;
      loop.reset();
    };

    // 5 s of calm with everyone connected: the baseline the run is compared with.
    for (let s = 0; s < 5; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      sample('baseline');
    }
    const linkBefore = live.liveLink;
    child.send({ type: 'go' });
    const done = fromChild<{ stats: BotStats }>('done');
    let finished = false;
    void done.then(() => (finished = true));
    while (!finished) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!finished) sample('run');
    }
    const bots = (await done).stats;
    loop.disable();

    const base0 = samples.filter((s) => s.phase === 'baseline');
    const run = samples.filter((s) => s.phase === 'run');
    const steady = run.slice(3); // the buckets and G settle in the first seconds
    const failures: string[] = [];
    const check = (ok: boolean, what: string): void => {
      if (!ok) failures.push(what);
    };

    const baseLoop = p(base0.map((s) => s.loopP99Ms), 0.5);
    const runLoop = p(run.map((s) => s.loopP99Ms), 0.95);
    const budget = Math.max(...run.map((s) => s.budgetKbps));
    const egressP95 = p(steady.map((s) => s.egressKbps), 0.95);
    const maxG = Math.max(...run.map((s) => s.globalPerS));
    const acceptedP95 = p(steady.map((s) => s.accepted), 0.95);
    const lat95 = p(bots.latencies, 0.95);
    const rssGrowth = Math.max(...run.map((s) => s.rssMb)) - mean(base0.map((s) => s.rssMb));
    const protects = new Set(run.map((s) => s.protect.split(':')[0]!));
    const protectStates = new Set(run.map((s) => s.protect));
    const rejects = new Map(bots.rejects);
    const rejected = [...rejects.values()].reduce((a, b) => a + b, 0);
    const closed = bots.closedByServer.reduce((a, [, n]) => a + n, 0);
    const inflightBase = Math.max(...base0.map((s) => s.tunnelInFlight));
    const inflightRun = Math.max(...run.map((s) => s.tunnelInFlight));

    // Every scenario: nobody who keeps to the limits is disconnected, chat never adds a
    // connection, the event loop stays within 20 ms (+ the 10 ms histogram resolution) of calm,
    // and chat upload stays inside its budget (10 % slack for the one-second sampling).
    check(joined.joinFailures === 0, `${joined.joinFailures} bots could not join`);
    check(closed === 0, `the server closed ${closed} bot sockets (${JSON.stringify(bots.closedByServer)})`);
    check(runLoop <= baseLoop + 30, `event-loop p99 ${runLoop} ms vs calm ${baseLoop} ms (limit +30)`);
    // Join snapshots, acks and refusals are sent at once and only charged to the budget (a
    // viewer must get its hello), so scenarios that join or reconnect many viewers during the run
    // may go over it while they last: at most twice the budget there.
    const slack = sc.raid || sc.reconnectAtS !== undefined ? 2 : 1.1;
    check(egressP95 <= budget * slack, `chat upload p95 ${egressP95} kbps over ${slack} × the budget ${budget} kbps`);
    check(inflightRun <= inflightBase + 2 + (sc.raid?.bots ?? 0), `tunnel in-flight ${inflightBase} → ${inflightRun}`);
    switch (sc.name) {
      case 'quiet':
      case 'lively':
        check(lat95 <= 1000, `delivery p95 ${lat95} ms (limit 1000)`);
        check(bots.delivered > 0, 'no message delivered');
        // Normal chat is never treated as a flood (no false positives, chat plan §6.3).
        check(!protects.has('slow') && !protects.has('lockdown'), `normal chat switched protection on (${[...protectStates].join(' ')})`);
        check(rejected <= Math.ceil(bots.sent * 0.02), `normal chat was refused: ${JSON.stringify(bots.rejects)}`);
        // Far below the budget, every accepted message reaches everyone.
        check(bots.skipped <= Math.ceil(bots.delivered * 0.01), `observers missed ${bots.skipped} messages (got ${bots.delivered}) with chat upload at ${egressP95} of ${budget} kbps`);
        break;
      case 'flood':
        check(acceptedP95 <= maxG * 1.25 + 1, `accepted p95 ${acceptedP95}/s over G ${maxG}/s`);
        check((rejects.get('chat.err.busy') ?? 0) + (rejects.get('chat.err.slow') ?? 0) > 0, 'the flood was never limited');
        break;
      case 'raid':
        check(protects.has('slow') || protects.has('lockdown'), `protection never reached slow or lockdown (${[...protects].join(', ')})`);
        check(live.liveLink === linkBefore, 'chat alone rotated the link');
        break;
      case 'zalgo':
        check(p(steady.map((s) => s.cpu), 0.95) <= 50, `server CPU p95 ${p(steady.map((s) => s.cpu), 0.95)} % of a core (limit 50)`);
        break;
      case 'slow-readers':
        check(rssGrowth <= 30, `RSS grew ${round(rssGrowth)} MB (limit 30)`);
        check(lat95 <= 1500, `delivery p95 to readers ${lat95} ms (limit 1500)`);
        break;
      case 'dup-storm':
        check((rejects.get('chat.err.dup') ?? 0) > 0 || protects.has('slow') || protects.has('lockdown'), 'repeats were neither refused nor detected');
        break;
      case 'gif-spam': {
        const limit = Math.ceil(sc.seconds / 30) + 1;
        check(bots.maxGifAcksPerBot <= limit, `a bot got ${bots.maxGifAcksPerBot} GIFs through (limit ${limit})`);
        check(bots.maxGifAcksPerBot >= 1, 'no GIF was accepted');
        break;
      }
      case 'reconnect-storm':
        check(bots.reconnected === joined.bots, `${bots.reconnected} of ${joined.bots} bots got their hello back`);
        check(bots.reconnectMaxMs <= 10_000, `slowest reconnect ${bots.reconnectMaxMs} ms (limit 10 s)`);
        break;
    }

    const summary = {
      bots: joined.bots + (sc.raid?.bots ?? 0),
      sent: bots.sent,
      acks: bots.acks,
      rejected,
      'delivery p50 ms': p(bots.latencies, 0.5),
      'delivery p95 ms': lat95,
      'accepted/s p95': acceptedP95,
      'G max/s': maxG,
      'egress p95 kbps': egressP95,
      'budget kbps': budget,
      'server CPU mean %': round(mean(run.map((s) => s.cpu))),
      'loop p99 calm/run ms': `${baseLoop}/${runLoop}`,
      'RSS growth MB': round(rssGrowth),
      'tunnel in-flight calm/run': `${inflightBase}/${inflightRun}`,
      protection: [...protectStates].join(' '),
      'skipped (observers)': bots.skipped,
      rejects: bots.rejects
        .map(([k, v]) => `${k.replace(/^(chat\.err|text)\./, '')} ${v}`)
        .join(', '),
    };
    return { scenario: sc.name, description: sc.description, passed: failures.length === 0, failures, summary, bots: { ...bots, latencies: [] }, samples };
  } finally {
    child.kill();
    await live.stop().catch(() => {});
  }
}

const names = arg('scenario', 'all');
const seconds = Number(arg('seconds', '0'));
const out = path.resolve(root, arg('out', 'test-results/chat-bench'));
const chosen = names === 'all' ? SCENARIOS : SCENARIOS.filter((s) => names.split(',').includes(s.name));
if (chosen.length === 0) {
  console.error(`unknown scenario "${names}"; known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const results: Result[] = [];
for (const sc of chosen) {
  const s = seconds > 0 ? { ...sc, seconds } : sc;
  console.log(`\n▶ ${s.name}: ${s.description} (${s.seconds} s)`);
  const r = await runScenario(s);
  results.push(r);
  fs.writeFileSync(path.join(out, `${s.name}.json`), JSON.stringify(r, null, 2));
  console.log(r.summary);
  // One PASS/FAIL line per scenario: what scripts/ci/soak-run.mjs (lineChecks) counts.
  console.log(r.passed ? `PASS chat bench ${s.name}` : `FAIL chat bench ${s.name} — ${r.failures.join('; ')}`);
}

const keys = Object.keys(results[0]!.summary);
const md = [
  `# Chat bench (${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version})`,
  '',
  `| scenario | result | ${keys.join(' | ')} |`,
  `|---|---|${keys.map(() => '---').join('|')}|`,
  ...results.map((r) => `| ${r.scenario} | ${r.passed ? 'pass' : '**FAIL**'} | ${keys.map((k) => String(r.summary[k])).join(' | ')} |`),
  '',
  ...results.flatMap((r) => (r.failures.length ? [`**${r.scenario}**:`, ...r.failures.map((f) => `- ${f}`), ''] : [])),
].join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), md + '\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(`\n${md}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
