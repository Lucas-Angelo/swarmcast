import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Logger } from '../core/logger.js';

/**
 * Round-trip time of a TCP handshake to a nearby anycast edge (Cloudflare's 1.1.1.1:443 by
 * default, the same network the quick tunnel uses). When the uplink is saturated, the
 * router's buffer fills and every packet (including this SYN) waits in it, so the handshake
 * time grows well above its baseline: the classic bufferbloat signal LEDBAT/BBR use.
 * One SYN/SYN-ACK every few seconds costs nothing.
 */
export function tcpConnectRtt(host = '1.1.1.1', port = 443, timeoutMs = 3000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host, port });
    const done = (v: number | undefined): void => {
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.once('connect', () => done(performance.now() - t0));
    sock.once('error', () => done(undefined));
  });
}

export interface ObsStreamStatus {
  outputActive: boolean;
  outputReconnecting: boolean;
  outputCongestion: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
  outputDuration: number;
}

export interface ObsHealth {
  /** 0..1, OBS's own estimate of how full its send buffer is. */
  congestion: number;
  reconnecting: boolean;
  /** Frames dropped for network reasons since the previous sample, percent. */
  droppedPercent?: number;
  /** Bitrate of her main OBS output (e.g. to Twitch or YouTube) since the previous sample, kbps. */
  kbps?: number;
  active: boolean;
}

/**
 * obs-websocket v5 authentication string (protocol.md "Creating an authentication string").
 * This is the protocol's challenge-response, not password storage: the server picks the salt and
 * challenge, and OBS only accepts base64(sha256(base64(sha256(password + salt)) + challenge)).
 * The password itself never leaves this PC's loopback and is kept only in the private config.
 */
export function obsAuth(password: string, salt: string, challenge: string): string {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

// Whatever listens on the obs-websocket port (OBS, an older OBS, another program) is not trusted:
// every message is checked before use, and anything else is ignored.
const count = z.number().finite().nonnegative();
const obsMessageSchema = z.discriminatedUnion('op', [
  // Hello: `authentication` is present when OBS asks for the password.
  z.object({ op: z.literal(0), d: z.object({ authentication: z.object({ challenge: z.string().max(512), salt: z.string().max(512) }).optional() }) }),
  // Identified.
  z.object({ op: z.literal(2), d: z.object({}) }),
  // RequestResponse.
  z.object({ op: z.literal(7), d: z.object({ requestStatus: z.object({ result: z.boolean() }), responseData: z.unknown().optional() }) }),
]);
const streamStatusSchema = z.object({
  outputActive: z.boolean(),
  outputReconnecting: z.boolean(),
  outputCongestion: z.number().finite().min(0).max(1).nullable().optional(),
  outputBytes: count,
  outputSkippedFrames: count,
  outputTotalFrames: count,
  outputDuration: count,
});

/** One obs-websocket message, or null when it is not JSON or not a message this client handles. */
export function parseObsMessage(raw: string): z.infer<typeof obsMessageSchema> | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const op = (json as { op?: unknown } | null)?.op;
  if (op !== 0 && op !== 2 && op !== 7) return null;
  const r = obsMessageSchema.safeParse(json);
  return r.success ? r.data : null;
}

/** GetStreamStatus responseData with sane numbers, or null. */
export function parseStreamStatus(data: unknown): ObsStreamStatus | null {
  const r = streamStatusSchema.safeParse(data);
  return r.success ? { ...r.data, outputCongestion: r.data.outputCongestion ?? 0 } : null;
}

/** Turn two consecutive GetStreamStatus samples into health numbers. */
export function obsHealthFrom(prev: ObsStreamStatus | null, cur: ObsStreamStatus): ObsHealth {
  const h: ObsHealth = { congestion: cur.outputCongestion ?? 0, reconnecting: cur.outputReconnecting, active: cur.outputActive };
  if (prev && prev.outputActive && cur.outputActive) {
    const frames = cur.outputTotalFrames - prev.outputTotalFrames;
    const dropped = cur.outputSkippedFrames - prev.outputSkippedFrames;
    // Same formula as OBS's stats dock: dropped (network) / total frames.
    if (frames > 0 && dropped >= 0) h.droppedPercent = (dropped / frames) * 100;
    const ms = cur.outputDuration - prev.outputDuration;
    const bytes = cur.outputBytes - prev.outputBytes;
    if (ms > 500 && bytes >= 0) h.kbps = Math.round((bytes * 8) / ms);
  }
  return h;
}

/**
 * Minimal obs-websocket v5 client (opt-in, loopback only). It only ever sends
 * GetStreamStatus: it never changes anything in OBS.
 */
export class ObsWebsocketClient {
  connected = false;
  error?: string;
  health?: ObsHealth;
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private prev: ObsStreamStatus | null = null;
  private stopped = true;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly password: string | undefined,
    private readonly log: Logger,
    private readonly intervalMs = 2000,
  ) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('obs-websocket must be on this PC (ws://127.0.0.1)');
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, 'obswebsocket.json', { handshakeTimeout: 3000, maxPayload: 256 * 1024 });
    this.ws = ws;
    // Per connection: Identify is sent once, Identified starts the poll timer once.
    let identifying = false;
    ws.on('message', (raw) => {
      const msg = parseObsMessage(String(raw));
      if (!msg || this.ws !== ws) return;
      if (msg.op === 0) {
        if (identifying) return;
        identifying = true;
        const auth = msg.d.authentication;
        if (auth && !this.password) {
          this.error = 'obs-websocket asks for a password; enter it in SwarmCast.';
          ws.close();
          return;
        }
        // No `authentication` in Hello means OBS has authentication off: nothing secret is sent then.
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(auth && this.password ? { authentication: obsAuth(this.password, auth.salt, auth.challenge) } : {}) } }));
      } else if (msg.op === 2) {
        if (!identifying || this.connected) return;
        this.connected = true;
        this.error = undefined;
        this.log.info('connected to obs-websocket');
        this.poll();
        this.timer = setInterval(() => this.poll(), this.intervalMs);
      } else if (msg.op === 7) {
        if (!this.connected || !msg.d.requestStatus.result) return;
        const cur = parseStreamStatus(msg.d.responseData);
        if (!cur) return;
        this.health = obsHealthFrom(this.prev, cur);
        this.prev = cur;
      }
    });
    ws.on('close', (code) => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.connected = false;
      this.health = undefined;
      this.prev = null;
      if (code === 4009) this.error = 'Wrong obs-websocket password.';
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 10_000);
    });
    ws.on('error', (err) => {
      this.error ??= `Cannot reach obs-websocket at ${this.url} (${(err as NodeJS.ErrnoException).code ?? err.message}). In OBS: Tools → WebSocket Server Settings → Enable.`;
    });
  }

  private poll(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ op: 6, d: { requestType: 'GetStreamStatus', requestId: String(this.nextId++) } }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    this.ws?.terminate();
    this.ws = null;
    this.connected = false;
    this.health = undefined;
  }
}
