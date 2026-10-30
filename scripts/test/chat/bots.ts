// The bots of the chat bench, in their own process so their work never counts as server CPU.
// bench.ts forks this file with an IPC channel:
//   parent → { type: 'start', base, link, scenario }   join every bot, then answer { type: 'joined' }
//   parent → { type: 'go' }                              run the scenario, then answer { type: 'done', stats }
// Each bot joins like a browser (link → ticket cookie → /api/join → session cookie) behind its own
// address (CF-Connecting-IP from the benchmarking range 198.18.0.0/15, trusted from the fake
// quick tunnel), opens /control and sends chat frames the way the viewer page does.
import type net from 'node:net';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import WebSocket from 'ws';
import type { ServerMessage } from '@swarmcast/shared';
import { Jar } from '../../../apps/server/test/integration/helpers.js';
import { CORPUS } from '../../../packages/shared/test/chat/corpus.js';
import type { Scenario } from './scenarios.js';

export interface BotStats {
  bots: number;
  sent: number;
  acks: number;
  /** Reject code → count (pairs: codes come from the network, so never object keys). */
  rejects: Array<[string, number]>;
  /** Sockets the server closed (code → count); a bot that keeps to the limits must never see one. */
  closedByServer: Array<[string, number]>;
  /** Delivery latency (server receive → bot receive) seen by the observer bots, ms. */
  latencies: number[];
  /** Messages the server told observers it skipped for them (skip items). */
  skipped: number;
  /** Messages that reached observers. */
  delivered: number;
  /** Most GIFs one bot got accepted. */
  maxGifAcksPerBot: number;
  /** Reconnect storm: bots that got their hello back, and the slowest, ms. */
  reconnected: number;
  reconnectMaxMs: number;
  joinFailures: number;
}

class Bot {
  readonly jar: Jar;
  ws: WebSocket | null = null;
  nonce = 0;
  acks = 0;
  gifAcks = 0;
  closing = false;
  constructor(
    readonly i: number,
    base: string,
    readonly ip: string,
  ) {
    const jar = new Jar(base);
    const plain = jar.fetch.bind(jar);
    jar.fetch = (p, init = {}) => plain(p, { ...init, headers: { ...(init.headers as Record<string, string>), 'cf-connecting-ip': ip } });
    this.jar = jar;
  }
}

const stats: BotStats = { bots: 0, sent: 0, acks: 0, rejects: [], closedByServer: [], latencies: [], skipped: 0, delivered: 0, maxGifAcksPerBot: 0, reconnected: 0, reconnectMaxMs: 0, joinFailures: 0 };
const bots: Bot[] = [];
const rejects = new Map<string, number>();
const closedByServer = new Map<string, number>();
let base = '';
let link = '';
let scenario: Scenario;
const OBSERVERS = 10;
const WORDS = ['oi', 'boa', 'noite', 'kkkk', 'que', 'jogada', 'gg', 'nice', 'play', 'hello', 'lol', 'top', 'demais', 'vamo', '🔥', '😂', '👏'];

function ipFor(i: number): string {
  return `198.18.${(i >> 8) & 255}.${i & 255}`;
}

async function join(bot: Bot): Promise<void> {
  const r1 = await bot.jar.fetch(link);
  if (r1.status !== 303) throw new Error(`join link ${r1.status}`);
  const ch = (await (await bot.jar.fetch('/api/join/challenge')).json()) as { required: boolean; challenge?: Challenge };
  const pow = ch.required ? { challenge: ch.challenge!, solution: await solveChallenge({ challenge: ch.challenge!, deriveKey }) } : undefined;
  const nickname = `bot_${bot.i}`;
  const r2 = await bot.jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname, pow } : { nickname }) });
  if (r2.status !== 200) throw new Error(`join ${r2.status}: ${await r2.text()}`);
}

function isObserver(bot: Bot): boolean {
  const first = scenario.slowReaders ?? 0;
  return bot.i >= first && bot.i < first + OBSERVERS;
}

async function connect(bot: Bot): Promise<void> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: bot.jar.header(), 'cf-connecting-ip': bot.ip } });
  bot.ws = ws;
  const hello = new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (d) => {
      const text = String(d);
      if (text.startsWith('~')) return;
      const m = JSON.parse(text) as ServerMessage;
      if (m.t === 'hello') resolve();
      else if (m.t === 'chat.ack') {
        bot.acks++;
        stats.acks++;
      } else if (m.t === 'chat.reject') rejects.set(String(m.code), (rejects.get(String(m.code)) ?? 0) + 1);
      else if (m.t === 'chat.batch' && isObserver(bot)) {
        const now = Date.now();
        for (const it of m.items) {
          if (it.k === 'm') {
            stats.delivered++;
            stats.latencies.push(now - it.at);
          } else if (it.k === 'skip') stats.skipped += it.n;
        }
      }
    });
  });
  ws.on('close', (code) => {
    if (!bot.closing && ws === bot.ws) closedByServer.set(String(code), (closedByServer.get(String(code)) ?? 0) + 1);
  });
  await hello;
  if (bot.i < (scenario.slowReaders ?? 0)) (ws as unknown as { _socket: net.Socket })._socket.pause();
}

async function joinAll(from: number, count: number, concurrency: number, overMs = 0): Promise<Bot[]> {
  const mine = Array.from({ length: count }, (_, k) => new Bot(from + k, base, ipFor(from + k)));
  let next = 0;
  const started = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = next++;
      if (k >= mine.length) return;
      if (overMs > 0) {
        const due = started + (k / mine.length) * overMs;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
      }
      const bot = mine[k]!;
      try {
        await join(bot);
        await connect(bot);
        bots.push(bot);
        stats.bots++;
      } catch {
        stats.joinFailures++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return mine.filter((b) => b.ws);
}

function frameFor(bot: Bot, seq: number): string {
  const n = (bot.nonce = (bot.nonce % 2_000_000_000) + 1);
  const b = scenario.behaviour;
  if (b.kind === 'gif') return JSON.stringify({ t: 'chat.send', n, gif: { p: 'klipy', id: `g${bot.i}x${seq}`, w: 200, h: 150 } });
  let text: string;
  if (b.kind === 'corpus') text = CORPUS[(bot.i + seq) % CORPUS.length]!.input;
  else if (b.kind === 'same') text = 'compre seguidores baratos agora';
  else text = `${WORDS[(bot.i + seq) % WORDS.length]} ${WORDS[(bot.i * 7 + seq) % WORDS.length]} ${seq}`;
  return JSON.stringify({ t: 'chat.send', n, text });
}

/** Sends at `perS` per bot with jitter, until `until`. */
function drive(group: Bot[], perS: number, until: number): Promise<void> {
  if (perS <= 0) return new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())));
  return Promise.all(
    group.map(async (bot) => {
      let seq = 0;
      // Spread the first sends over one period so the bots do not start in lockstep. Waits never
      // pass the end of the run (at low rates one period is longer than the run).
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, until - Date.now()))));
      await sleep(Math.random() * (1000 / perS));
      while (Date.now() < until) {
        if (bot.i >= (scenario.slowReaders ?? 0) && bot.ws?.readyState === WebSocket.OPEN) {
          bot.ws.send(frameFor(bot, seq++));
          stats.sent++;
        }
        await sleep((1000 / perS) * (0.8 + Math.random() * 0.4));
      }
    }),
  ).then(() => {});
}

async function run(): Promise<void> {
  const b = scenario.behaviour;
  const perS = b.kind === 'idle' ? 0 : b.perBotPerS;
  const until = Date.now() + scenario.seconds * 1000;
  const jobs: Array<Promise<void>> = [drive([...bots], perS, until)];
  if (scenario.raid) {
    const r = scenario.raid;
    jobs.push(
      (async () => {
        await new Promise((res) => setTimeout(res, r.atS * 1000));
        const raiders = await joinAll(100_000, r.bots, 6, r.overS * 1000);
        await drive(raiders, 1.8, until);
      })(),
    );
  }
  if (scenario.reconnectAtS !== undefined) {
    jobs.push(
      (async () => {
        await new Promise((res) => setTimeout(res, scenario.reconnectAtS! * 1000));
        await Promise.all(
          bots.map(async (bot) => {
            const t0 = Date.now();
            bot.closing = true;
            bot.ws?.terminate();
            bot.closing = false;
            try {
              await connect(bot);
              stats.reconnected++;
              stats.reconnectMaxMs = Math.max(stats.reconnectMaxMs, Date.now() - t0);
            } catch {
              /* counted as not reconnected */
            }
          }),
        );
      })(),
    );
  }
  await Promise.all(jobs);
  // Let the last batches arrive.
  await new Promise((res) => setTimeout(res, 1500));
  for (const bot of bots) stats.maxGifAcksPerBot = Math.max(stats.maxGifAcksPerBot, bot.acks);
  if (scenario.behaviour.kind !== 'gif') stats.maxGifAcksPerBot = 0;
  for (const bot of bots) {
    bot.closing = true;
    bot.ws?.terminate();
  }
}

process.on('message', (msg: { type: 'start'; base: string; link: string; scenario: Scenario } | { type: 'go' }) => {
  if (msg.type === 'start') {
    base = msg.base;
    link = msg.link;
    scenario = msg.scenario;
    void joinAll(0, scenario.bots, 8).then(() => process.send!({ type: 'joined', bots: stats.bots, joinFailures: stats.joinFailures }));
  } else if (msg.type === 'go') {
    void run().then(() => {
      stats.rejects = [...rejects];
      stats.closedByServer = [...closedByServer];
      process.send!({ type: 'done', stats }, () => process.exit(0));
    });
  }
});
