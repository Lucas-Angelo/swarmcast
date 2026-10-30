// The bots of the chat bench, in their own process so their work never counts as server CPU.
// bench.ts forks this file with an IPC channel:
//   parent → { type: 'start', base, link, scenario }   join every bot, then answer { type: 'joined' }
//   parent → { type: 'go' }                              run the scenario, then answer { type: 'drained' }
//   parent → { type: 'end-marker', seq }                 wait for it at every observer, answer { type: 'done', stats }
// Each bot joins like a browser (link → ticket cookie → /api/join → session cookie) behind its own
// address (CF-Connecting-IP from the benchmarking range 198.18.0.0/15, trusted from the fake
// quick tunnel), opens /control and sends chat frames the way the viewer page does.
//
// The schedule of a scenario (rates, raid and reconnect times, the run's length) is real time:
// it is the load being measured. The end of a run waits for facts instead: every bot's ping is
// answered (the server has handled every frame before it, in order), then every observer has the
// bench's end marker (a priority item, never dropped, so it has every message before it too).
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import WebSocket from 'ws';
import { CHAT_MAX_FRAMES_PER_10S, type ServerMessage } from '@swarmcast/shared';
import { CookieJar } from '../lib/cookie-jar.mjs';
import { CORPUS } from '../../../packages/shared/test/chat/corpus.js';
import { until } from '../lib/wait.mjs';
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
  /** Bots whose ping the server did not answer after the run (it never handled their frames). */
  undrained: number;
  /** Observers the end marker did not reach. */
  markerMissed: number;
}

/**
 * The server ends a socket that sends more than CHAT_MAX_FRAMES_PER_10S chat frames in a 10 s
 * window counted from the first frame it handles in it (control.ts). A bot keeps to that with a
 * margin: never more than that many frames in any FRAME_WINDOW_MS of its own send times, so the
 * first frame of a window may reach the server up to a second late (a stalled CI VM) and still no
 * window holds one frame too many. Jittered sends at 1.8 a second alone sometimes put 21 frames
 * in one window, and the server rightly closed that socket (flood on a macOS runner, 1 run in 14).
 */
const FRAME_WINDOW_MS = 11_000;
/** Time the server gets to answer every bot's ping after the run, and the end marker to arrive. */
const SETTLE_MS = 15_000;

class Bot {
  /** Its own browser, behind its own address (as Cloudflare reports it to the local connector). */
  readonly jar: CookieJar;
  ws: WebSocket | null = null;
  nonce = 0;
  acks = 0;
  gifAcks = 0;
  closing = false;
  /** Highest chat seq this bot has seen: a reconnect asks for what came after it, like the page. */
  lastSeq = 0;
  /** Send times of the last CHAT_MAX_FRAMES_PER_10S frames (FRAME_WINDOW_MS). */
  readonly sentAt: number[] = [];
  constructor(
    readonly i: number,
    base: string,
    readonly ip: string,
  ) {
    this.jar = new CookieJar(base, { headers: { 'cf-connecting-ip': ip } });
  }
}

const stats: BotStats = {
  bots: 0,
  sent: 0,
  acks: 0,
  rejects: [],
  closedByServer: [],
  latencies: [],
  skipped: 0,
  delivered: 0,
  maxGifAcksPerBot: 0,
  reconnected: 0,
  reconnectMaxMs: 0,
  joinFailures: 0,
  undrained: 0,
  markerMissed: 0,
};
const bots: Bot[] = [];
const rejects = new Map<string, number>();
const closedByServer = new Map<string, number>();
/** 'seq': a bot saw a new chat seq; 'pong': the server answered a bot's ping. */
const progress = new EventEmitter();
let base = '';
let link = '';
let scenario: Scenario;
let endMarker: (seq: number) => void = () => {};
const endMarkerSeq = new Promise<number>((resolve) => (endMarker = resolve));
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
  // The watch page reconnects with /control?chatAfter=<last seq shown> and gets only the delta in
  // hello.chat (a server without it ignores the parameter and sends the full snapshot).
  const query = bot.lastSeq > 0 ? `?chatAfter=${bot.lastSeq}` : '';
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control${query}`, { origin: base, headers: { cookie: bot.jar.header(), 'cf-connecting-ip': bot.ip } });
  bot.ws = ws;
  const hello = new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (d) => {
      const text = String(d);
      if (text.startsWith('~')) return;
      const m = JSON.parse(text) as ServerMessage;
      const seen = (seq: number | undefined): void => {
        if (seq === undefined || seq <= bot.lastSeq) return;
        bot.lastSeq = seq;
        progress.emit('seq');
      };
      if (m.t === 'hello') {
        seen(m.chat?.lastSeq);
        resolve();
        return;
      }
      if (m.t === 'chat.reset') seen(m.lastSeq);
      if (m.t === 'chat.batch') for (const it of m.items) if (it.k === 'm' || it.k === 'sys') seen(it.s);
      if (m.t === 'chat.ack') {
        seen(m.s);
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
  // A GIF reference as the picker sends it: provider, id, size and the provider's media path.
  if (b.kind === 'gif') return JSON.stringify({ t: 'chat.send', n, gif: { p: 'klipy', id: `g${bot.i}x${seq}`, w: 200, h: 150, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' } });
  let text: string;
  if (b.kind === 'corpus') text = CORPUS[(bot.i + seq) % CORPUS.length]!.input;
  else if (b.kind === 'same') text = 'compre seguidores baratos agora';
  // Ordinary chat: different people say different things (the bot and its count are in the
  // text), so the duplicate detector only fires in the dup-storm scenario.
  else text = `${WORDS[(bot.i + seq) % WORDS.length]} ${WORDS[(bot.i * 7 + seq) % WORDS.length]} ${bot.i}x${seq}`;
  return JSON.stringify({ t: 'chat.send', n, text });
}

/** Milliseconds until one more frame keeps `bot` within the frame ceiling (FRAME_WINDOW_MS). */
function frameSlotIn(bot: Bot): number {
  const n = bot.sentAt.length;
  return n < CHAT_MAX_FRAMES_PER_10S ? 0 : Math.max(0, bot.sentAt[n - CHAT_MAX_FRAMES_PER_10S]! + FRAME_WINDOW_MS + 1 - Date.now());
}

/** Sends at `perS` per bot with jitter, until `end`, never over the frame ceiling. */
function drive(group: Bot[], perS: number, end: number): Promise<void> {
  if (perS <= 0) return new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())));
  return Promise.all(
    group.map(async (bot) => {
      let seq = 0;
      // Spread the first sends over one period so the bots do not start in lockstep. Waits never
      // pass the end of the run (at low rates one period is longer than the run).
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, end - Date.now()))));
      await sleep(Math.random() * (1000 / perS));
      while (Date.now() < end) {
        if (bot.i >= (scenario.slowReaders ?? 0)) {
          await sleep(frameSlotIn(bot));
          const ws = bot.ws;
          if (Date.now() < end && ws?.readyState === WebSocket.OPEN) {
            ws.send(frameFor(bot, seq++));
            bot.sentAt.push(Date.now());
            if (bot.sentAt.length > CHAT_MAX_FRAMES_PER_10S) bot.sentAt.shift();
            stats.sent++;
          }
        }
        await sleep((1000 / perS) * (0.8 + Math.random() * 0.4));
      }
    }),
  ).then(() => {});
}

/** Resolves once the server has handled every frame sent on `ws` before now: it answers pings in order. */
function handledAll(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('pong', () => resolve());
    ws.ping();
  });
}

/** Pings every bot that can read; returns how many pongs did not come within SETTLE_MS. */
async function drain(): Promise<number> {
  // Slow readers stopped reading their socket on purpose (and never send).
  const open = bots.filter((b) => b.i >= (scenario.slowReaders ?? 0) && b.ws?.readyState === WebSocket.OPEN);
  let left = open.length;
  for (const b of open) {
    void handledAll(b.ws!).then(() => {
      left--;
      progress.emit('pong');
    });
  }
  return until(() => left === 0, { timeoutMs: SETTLE_MS, what: "every bot's pong", on: [[progress, 'pong']] }).then(
    () => 0,
    () => left,
  );
}

/** Waits until every connected observer has seen `seq`; returns how many had not within SETTLE_MS. */
async function observersReach(seq: number): Promise<number> {
  const watching = bots.filter((b) => isObserver(b) && b.ws?.readyState === WebSocket.OPEN);
  const behind = (): number => watching.filter((b) => b.lastSeq < seq).length;
  return until(() => behind() === 0, { timeoutMs: SETTLE_MS, what: 'the end marker at every observer', on: [[progress, 'seq']] }).then(
    () => 0,
    () => behind(),
  );
}

async function run(): Promise<void> {
  const b = scenario.behaviour;
  const perS = b.kind === 'idle' ? 0 : b.perBotPerS;
  const end = Date.now() + scenario.seconds * 1000;
  const jobs: Array<Promise<void>> = [drive([...bots], perS, end)];
  if (scenario.raid) {
    const r = scenario.raid;
    jobs.push(
      (async () => {
        await new Promise((res) => setTimeout(res, r.atS * 1000));
        const raiders = await joinAll(100_000, r.bots, 6, r.overS * 1000);
        await drive(raiders, 1.8, end);
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
  stats.undrained = await drain();
  process.send!({ type: 'drained' });
  stats.markerMissed = await observersReach(await endMarkerSeq);
  for (const bot of bots) stats.maxGifAcksPerBot = Math.max(stats.maxGifAcksPerBot, bot.acks);
  if (scenario.behaviour.kind !== 'gif') stats.maxGifAcksPerBot = 0;
  for (const bot of bots) {
    bot.closing = true;
    bot.ws?.terminate();
  }
}

process.on('message', (msg: { type: 'start'; base: string; link: string; scenario: Scenario } | { type: 'go' } | { type: 'end-marker'; seq: number }) => {
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
  } else if (msg.type === 'end-marker') {
    endMarker(msg.seq);
  }
});
