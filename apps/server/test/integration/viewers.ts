import { once } from 'node:events';
import WebSocket from 'ws';
import type { ChatItem, ServerMessage } from '@swarmcast/shared';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import type { LiveController, LiveDeps } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from '../unit/live-helpers.js';
import { until, type Jar } from './helpers.js';

// The viewer side of a live in this process: a LiveController with its real public server
// (joins, /control, the tracker, the chat), and viewers on its /control socket. Only the Vitest
// suites import this file (helpers.ts also serves the E2E server and the scripts).

/**
 * How long a viewer waits for a message before the test fails, naming it and listing what did
 * arrive. Messages take milliseconds; this bound only decides how a broken behaviour fails.
 * Latencies the product promises are asserted where they matter, as measured durations.
 */
export const MESSAGE_TIMEOUT_MS = 10_000;

/**
 * Direct mode of a live that never turns it on. The real one talks to the router (UPnP,
 * NAT-PMP) and to public-address services: systems outside this machine, not ours to call.
 */
export const NO_DIRECT = { noteViewer: () => {}, snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;

export type Hello = Extract<ServerMessage, { t: 'hello' }>;
type Of<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>;

const lives = new Set<LiveController>();
const clients = new Set<ControlClient>();

export interface ViewerLiveOptions {
  /** Chat settings over the defaults. */
  chat?: Partial<AppConfig['chat']>;
  /** Replaces LiveController dependencies (tunnel, log, egress...). */
  deps?: Partial<LiveDeps>;
}

/**
 * A LiveController whose public server is real (on a port the OS picks, the browser check off)
 * and whose MediaMTX is makeController's stand-in. Not started yet: see goLive().
 */
export function viewerLive(o: ViewerLiveOptions = {}): LiveController {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  config.security.requireBrowserCheck = false;
  config.chat = { ...config.chat, ...o.chat };
  const { live } = makeController(NO_DIRECT, { config, ...o.deps });
  lives.add(live);
  return live;
}

/** Starts `live`; its public base URL and live link. */
export async function goLive(live: LiveController): Promise<{ base: string; link: string }> {
  await live.start();
  return { base: `http://127.0.0.1:${live.publicPort}`, link: live.liveLink! };
}

/** viewerLive() + goLive(). */
export async function startViewerLive(o: ViewerLiveOptions = {}): Promise<{ live: LiveController; base: string; link: string }> {
  const live = viewerLive(o);
  return { live, ...(await goLive(live)) };
}

/** Closes every viewer socket and stops every live of the test (afterEach). */
export async function stopViewerLives(): Promise<void> {
  for (const c of clients) c.ws.terminate();
  clients.clear();
  const all = [...lives];
  lives.clear();
  await Promise.all(all.map((l) => l.stop()));
}

/**
 * A viewer page's /control socket: its JSON messages and tracker frames (`~...`), in arrival
 * order. Every wait is on the messages themselves.
 */
export class ControlClient {
  readonly messages: ServerMessage[] = [];
  readonly frames: string[] = [];
  /** The close code, once the socket closed. */
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    clients.add(this);
    ws.on('message', (d) => {
      const text = String(d);
      if (text.startsWith('~')) this.frames.push(text);
      else this.messages.push(JSON.parse(text) as ServerMessage);
    });
    this.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  }

  /** The server's first message. */
  get hello(): Hello {
    const h = this.messages.find((m) => m.t === 'hello');
    if (!h) throw new Error(`no hello yet (${this.describe()})`);
    return h as Hello;
  }

  /** A JSON message, `t` first as the viewer serialises it (the server's cheap pre-parse expects that). */
  send(m: { t: string } & Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }

  /** A tracker frame (`~o1`, `~d1 {...}`, see encodeTrackerFrame). */
  sendFrame(frame: string): void {
    this.ws.send(frame);
  }

  all<K extends ServerMessage['t']>(t: K): Array<Of<K>> {
    return this.messages.filter((m): m is Of<K> => m.t === t);
  }

  last<K extends ServerMessage['t']>(t: K): Of<K> | undefined {
    return this.all(t).at(-1);
  }

  /** The chat items of every batch and reset, in order. */
  items(): ChatItem[] {
    return this.messages.flatMap((m) => (m.t === 'chat.batch' || m.t === 'chat.reset' ? m.items : []));
  }

  /** Resolves once `pred` holds, re-checked on every message and on close. */
  until(pred: () => boolean, what: string): Promise<void> {
    return until(pred, { timeoutMs: MESSAGE_TIMEOUT_MS, what, on: [[this.ws, 'message'], [this.ws, 'close']], detail: () => this.describe() });
  }

  /** The first message of type `t` from index `from` on that matches `pred`. */
  async next<K extends ServerMessage['t']>(t: K, pred: (m: Of<K>) => boolean = () => true, from = 0): Promise<Of<K>> {
    let found: Of<K> | undefined;
    await this.until(() => (found = this.messages.slice(from).find((m): m is Of<K> => m.t === t && pred(m as Of<K>))) !== undefined, `a ${t} message`);
    return found!;
  }

  /** The first tracker frame that matches. */
  async frame(pred: (f: string) => boolean, what: string): Promise<string> {
    let found: string | undefined;
    await this.until(() => (found = this.frames.find(pred)) !== undefined, what);
    return found!;
  }

  describe(): string {
    return `messages ${JSON.stringify(this.messages.map((m) => m.t))}; frames ${JSON.stringify(this.frames)}; socket state ${this.ws.readyState}`;
  }
}

/** Opens /control with the viewer's cookies (and `headers`), like the watch page, and waits for its hello. */
export async function openControl(base: string, jar: Jar, o: { query?: string; headers?: Record<string, string> } = {}): Promise<ControlClient> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control${o.query ?? ''}`, { origin: base, headers: { cookie: jar.header(), ...o.headers } });
  const client = new ControlClient(ws);
  await once(ws, 'open');
  await client.next('hello');
  return client;
}

/**
 * The HTTP status a WebSocket upgrade to `url` gets: 101 when the socket opened (it is closed
 * again at once), else the refusal's status. A network error rejects.
 */
export function upgradeStatus(url: string, o: { origin: string; headers?: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: o.origin, headers: o.headers });
    ws.on('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      resolve(101);
      ws.close();
    });
  });
}
