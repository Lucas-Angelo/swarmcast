// Playback benchmark: plays the quality server's stream in Chrome under DevTools network
// emulation and records stalls, startup time, latency and selected level for each player
// configuration. Start scripts/test/quality/server.ts first, then:
//   node --import tsx scripts/test/quality/bench.ts [--minutes 2.5] [--networks 4g,fast3g] [--configs before,stable-abr]
// Results: test-results/quality/results-<timestamp>.json and a Markdown table on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, type BrowserContext, type CDPSession } from '@playwright/test';
import { hlsConfigFor } from '../../../apps/viewer/src/player-config.js';

const require = createRequire(import.meta.url);
const HLS_JS = fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'), 'utf8');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
}

const env = JSON.parse(fs.readFileSync(path.join('test-results', 'quality', 'env.json'), 'utf8')) as { adminLoginUrl: string; adminUrl: string; base: string; readyAt: number };
const MINUTES = Number(arg('minutes', '2.5'));

// ---- network profiles (CDP Network.emulateNetworkConditions; throughput in bytes/s) ----

interface NetStep {
  latency: number;
  downMbps: number;
  upMbps: number;
  packetLoss?: number;
  offline?: boolean;
}
interface Network {
  name: string;
  label: string;
  /** Conditions for second `t` of the run (called every 5 s). */
  at: (t: number, rnd: () => number) => NetStep;
}

const NETWORKS: Network[] = [
  { name: '5g', label: '5G-ish 50 Mbps / 40 ms', at: () => ({ latency: 40, downMbps: 50, upMbps: 20 }) },
  { name: '4g', label: '4G 9 Mbps / 170 ms', at: () => ({ latency: 170, downMbps: 9, upMbps: 3 }) },
  {
    name: '4g-jitter',
    label: '4G fluctuating 1.5–9 Mbps / 100–300 ms, 1 % loss',
    at: (_t, rnd) => ({ latency: 100 + Math.round(rnd() * 200), downMbps: 1.5 + rnd() * 7.5, upMbps: 2, packetLoss: 1 }),
  },
  {
    name: 'dropouts',
    label: '4G 9 Mbps / 170 ms, offline 10 s every 60 s',
    at: (t) => ({ latency: 170, downMbps: 9, upMbps: 3, offline: t % 60 >= 40 && t % 60 < 50 }),
  },
  {
    name: 'dropouts15',
    label: '4G 9 Mbps / 170 ms, offline 15 s every 60 s',
    at: (t) => ({ latency: 170, downMbps: 9, upMbps: 3, offline: t % 60 >= 35 && t % 60 < 50 }),
  },
  { name: 'fast3g', label: 'Fast 3G 1.44 Mbps / 562 ms', at: () => ({ latency: 562.5, downMbps: 1.44, upMbps: 0.675 }) },
];

// ---- player configurations ----

const RETRY = {
  maxTimeToFirstByteMs: 10_000,
  maxLoadTimeMs: 20_000,
  timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' },
};

interface PlayerConfig {
  name: string;
  label: string;
  hls: Record<string, unknown>;
  /** Lock playback to the highest level (what viewers got before the ladder existed). */
  pinTop: boolean;
}

const CONFIGS: PlayerConfig[] = [
  {
    name: 'before',
    label: 'Before: watch.ts settings, source only',
    pinTop: true,
    hls: {
      lowLatencyMode: false,
      liveSyncDurationCount: 7,
      liveMaxLatencyDurationCount: 12,
      maxBufferLength: 20,
      maxMaxBufferLength: 30,
      backBufferLength: 10,
      fragLoadPolicy: { default: RETRY },
      playlistLoadPolicy: { default: RETRY },
      manifestLoadPolicy: { default: RETRY },
    },
  },
  { name: 'stable-source', label: 'Stable profile, source only', pinTop: true, hls: hlsConfigFor('stable', { isMobile: false, initialEstimate: 2_000_000 }) as Record<string, unknown> },
  { name: 'stable-abr', label: 'Stable profile + ladder (Auto)', pinTop: false, hls: hlsConfigFor('stable', { isMobile: false, initialEstimate: 2_000_000 }) as Record<string, unknown> },
  { name: 'lowdelay-abr', label: 'Lower-delay profile + ladder (Auto)', pinTop: false, hls: hlsConfigFor('low-delay', { isMobile: false, initialEstimate: 2_000_000 }) as Record<string, unknown> },
];

// ---- the page under test ----

const BENCH_HTML = `<!doctype html><meta charset="utf-8"><title>bench</title>
<video id="v" muted playsinline autoplay style="width:1280px;height:720px"></video>
<script src="/__bench/hls.js"></script>
<script>
(async () => {
  const cfg = window.__CFG__;
  const t0 = performance.now();
  const m = { startupMs: null, stalls: 0, stallMs: 0, latency: [], wallLatency: [], heights: {}, switches: 0, errors: {}, fatal: 0 };
  window.__bench = m;
  const conf = await (await fetch('/api/config', { credentials: 'same-origin' })).json();
  const video = document.getElementById('v');
  const hls = new Hls(cfg.hls);
  window.__hls = hls;
  let stallAt = null;
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (cfg.pinTop) {
      let top = 0;
      hls.levels.forEach((l, i) => { if ((l.height || 0) > (hls.levels[top].height || 0)) top = i; });
      hls.startLevel = top;
      hls.loadLevel = top;
    }
    video.play().catch(() => {});
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, () => { m.switches += 1; });
  hls.on(Hls.Events.ERROR, (_e, d) => {
    m.errors[d.details] = (m.errors[d.details] || 0) + 1;
    if (d.fatal) {
      m.fatal += 1;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError(); else setTimeout(() => hls.startLoad(), 1000);
    }
  });
  video.addEventListener('playing', () => {
    if (m.startupMs === null) m.startupMs = Math.round(performance.now() - t0);
    if (stallAt !== null) { m.stallMs += performance.now() - stallAt; stallAt = null; }
  });
  video.addEventListener('waiting', () => {
    if (m.startupMs !== null && stallAt === null) { m.stalls += 1; stallAt = performance.now(); }
  });
  setInterval(() => {
    if (m.startupMs === null) return;
    if (stallAt !== null) { m.stallMs += performance.now() - stallAt; stallAt = performance.now(); }
    const lvl = hls.levels[hls.currentLevel];
    if (lvl && !video.paused) { const h = lvl.height || 0; m.heights[h] = (m.heights[h] || 0) + 1; }
    if (hls.latency > 0) m.latency.push(hls.latency);
    const pd = hls.playingDate;
    if (pd) m.wallLatency.push((Date.now() - pd.getTime()) / 1000);
  }, 1000);
  hls.loadSource(conf.playlistUrl);
  hls.attachMedia(video);
})();
</script>`;

async function adminCookie(): Promise<string> {
  const res = await fetch(env.adminLoginUrl, { redirect: 'manual' });
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}

async function liveLink(cookie: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const s = (await (await fetch(`${env.adminUrl}/api/state`, { headers: { cookie } })).json()) as { phase: string; liveLink?: string };
    if (s.phase === 'live' && s.liveLink) return s.liveLink;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('stream never became live');
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function applyNet(cdp: CDPSession, step: NetStep): Promise<boolean> {
  const base = {
    offline: step.offline ?? false,
    latency: step.latency,
    downloadThroughput: (step.downMbps * 1e6) / 8,
    uploadThroughput: (step.upMbps * 1e6) / 8,
  };
  if (step.packetLoss) {
    try {
      await cdp.send('Network.emulateNetworkConditions', { ...base, packetLoss: step.packetLoss, packetQueueLength: 0, packetReordering: false } as never);
      return true;
    } catch {
      /* older Chrome: no packet loss emulation */
    }
  }
  await cdp.send('Network.emulateNetworkConditions', base);
  return false;
}

interface RunResult {
  network: string;
  config: string;
  startupMs: number | null;
  stalls: number;
  stallSeconds: number;
  rebufferPercent: number;
  avgLatency: number | null;
  avgWallLatency: number | null;
  heightShare: Record<string, number>;
  switches: number;
  fatal: number;
  errors: Record<string, number>;
  packetLossApplied: boolean;
}

async function runOne(context: BrowserContext, link: string, net: Network, cfg: PlayerConfig, seconds: number): Promise<RunResult> {
  const page = await context.newPage();
  await page.route('**/__bench', (r) => r.fulfill({ contentType: 'text/html', body: BENCH_HTML.replace('window.__CFG__', JSON.stringify({ hls: cfg.hls, pinTop: cfg.pinTop })) }));
  await page.route('**/__bench/hls.js', (r) => r.fulfill({ contentType: 'text/javascript', body: HLS_JS }));
  await page.goto(link);
  const join = await context.request.post(`${env.base}/api/join`, { data: { nickname: `${cfg.name}-${net.name}`.slice(0, 24) } });
  if (!join.ok()) throw new Error(`join failed: ${join.status()} ${await join.text()}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const rnd = seeded(42);
  let lossApplied = await applyNet(cdp, net.at(0, rnd));
  const started = performance.now();
  const ticker = setInterval(() => {
    const t = Math.round((performance.now() - started) / 1000);
    void applyNet(cdp, net.at(t, rnd)).then((ok) => (lossApplied ||= ok), () => {});
  }, 5000);
  await page.goto(`${env.base}/__bench`);
  await page.waitForTimeout(seconds * 1000);
  clearInterval(ticker);
  const m = (await page.evaluate(() => (window as unknown as { __bench: Record<string, unknown> }).__bench)) as {
    startupMs: number | null;
    stalls: number;
    stallMs: number;
    latency: number[];
    wallLatency: number[];
    heights: Record<string, number>;
    switches: number;
    fatal: number;
    errors: Record<string, number>;
  };
  await page.close();
  const total = Object.values(m.heights).reduce((a, b) => a + b, 0) || 1;
  const avg = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const played = seconds - (m.startupMs ?? seconds * 1000) / 1000;
  return {
    network: net.name,
    config: cfg.name,
    startupMs: m.startupMs,
    stalls: m.stalls,
    stallSeconds: Math.round(m.stallMs / 100) / 10,
    rebufferPercent: played > 0 ? Math.round((m.stallMs / 1000 / played) * 1000) / 10 : 100,
    avgLatency: avg(m.latency),
    avgWallLatency: avg(m.wallLatency),
    heightShare: Object.fromEntries(Object.entries(m.heights).map(([h, n]) => [`${h}p`, Math.round((n / total) * 100)])),
    switches: m.switches,
    fatal: m.fatal,
    errors: m.errors,
    packetLossApplied: lossApplied,
  };
}

const wantedNets = arg('networks', NETWORKS.map((n) => n.name).join(',')).split(',');
const wantedCfgs = arg('configs', CONFIGS.map((c) => c.name).join(',')).split(',');
// Let the live playlist fill its 40 s window first, as for a viewer joining a running stream.
const warm = env.readyAt + 50_000 - Date.now();
if (warm > 0) await new Promise((r) => setTimeout(r, warm));
const cookie = await adminCookie();
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM_CHANNEL ?? 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const results: RunResult[] = [];
try {
  for (const net of NETWORKS.filter((n) => wantedNets.includes(n.name))) {
    console.error(`▶ ${net.label}: ${wantedCfgs.join(', ')} for ${MINUTES} min`);
    // One fresh browser context (own cookies, own emulated link) per configuration, run side by side.
    const runs = CONFIGS.filter((c) => wantedCfgs.includes(c.name)).map(async (cfg) => {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      try {
        return await runOne(context, await liveLink(cookie), net, cfg, MINUTES * 60);
      } finally {
        await context.close();
      }
    });
    for (const r of await Promise.all(runs)) {
      results.push(r);
      console.error(`  ${r.config}: stalls ${r.stalls} (${r.stallSeconds} s), startup ${r.startupMs} ms, latency ${r.avgLatency} s, levels ${JSON.stringify(r.heightShare)}`);
    }
  }
} finally {
  await browser.close();
}

const outFile = path.join('test-results', 'quality', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify({ minutes: MINUTES, networks: NETWORKS.map((n) => [n.name, n.label]), configs: CONFIGS.map((c) => [c.name, c.label]), results }, null, 2));
console.log(`| Network | Config | Startup (s) | Stalls | Stalled (s) | Rebuffer % | Latency to edge (s) | Wall-clock latency (s) | Levels played | Switches |`);
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const net = NETWORKS.find((n) => n.name === r.network)!.label;
  const lv = Object.entries(r.heightShare).sort((a, b) => parseInt(b[0]) - parseInt(a[0])).map(([h, p]) => `${h} ${p}%`).join(', ');
  console.log(`| ${net} | ${r.config} | ${r.startupMs === null ? 'never' : (r.startupMs / 1000).toFixed(1)} | ${r.stalls} | ${r.stallSeconds} | ${r.rebufferPercent} | ${r.avgLatency ?? '—'} | ${r.avgWallLatency ?? '—'} | ${lv || '—'} | ${r.switches} |`);
}
console.error(`saved ${outFile}`);
