import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CHAT_FRAME_MAX_BYTES,
  CHAT_FRAME_PREFIX,
  CHAT_MAX_FRAMES_PER_10S,
  CHAT_REACT_FRAME_PREFIX,
  CHAT_REACT_FRAMES_MAX_PER_10S,
  CHAT_REACT_FRAMES_PER_10S,
  CONTROL_CLOSE,
  CONTROL_MAX_MESSAGE,
  HASH_FAILURE_THRESHOLD,
  MAX_TRACKER_CHANNELS,
  TRACKER_MAX_MESSAGE,
  clientMessageSchema,
  encodeTrackerFrame,
  isTrackerFrame,
  parseTrackerFrame,
  type ServerMessage,
} from '@swarmcast/shared';
import type { AccessControl, Session } from '../access/access.js';
import type { Logger } from '../core/logger.js';
import type { TrackerChannel } from '../tracker/channel.js';
import type { ChatHost, ChatHub } from '../chat/hub.js';

type ControlSocket = WebSocket & {
  sessionId: string;
  alive: boolean;
  msgs: { n: number; at: number };
  /** All frames (control + tracker) in the current 10 s window. */
  frames: { n: number; at: number };
  /** Tracker channel opens in the current minute. */
  opens: { n: number; at: number };
  /** Chat frames in the current 10 s window (their own budget: chat never costs the control one). */
  chatFrames: { n: number; at: number };
  /** Reaction frames in the current 10 s window (their own budget: reactions never cost the chat one). */
  reactFrames: { n: number; at: number };
  upgradeReq: IncomingMessage;
  channels: Map<number, TrackerChannel>;
};

/** Where tracker channels go (TrackerService). */
export interface TrackerChannelHost {
  openChannel(carrier: WebSocket, id: number, req: IncomingMessage, session: Session): TrackerChannel | null;
}

/** Frames of any kind per control socket per 10 s (30 control + 2 × 60 tracker, with room). */
const MAX_FRAMES_PER_10S = 200;
/** Tracker channel opens per control socket per minute (p2p-media-loader reconnects with back-off). */
const MAX_CHANNEL_OPENS_PER_MIN = 12;
/** Raw bytes that start every chat frame (the viewer serialises `t` first). */
const CHAT_PREFIX = Buffer.from(CHAT_FRAME_PREFIX);
const REACT_PREFIX = Buffer.from(CHAT_REACT_FRAME_PREFIX);

const startsWith = (data: Buffer, prefix: Buffer): boolean => data.length >= prefix.length && data.subarray(0, prefix.length).equals(prefix);

/**
 * What a raw viewer frame is, from its first bytes only (nothing is decoded): a reaction frame
 * (`{"t":"chat.react"`), another chat frame (`{"t":"chat.`), or neither (null).
 */
export function chatFrameKind(data: Buffer): 'react' | 'chat' | null {
  if (!startsWith(data, CHAT_PREFIX)) return null;
  return startsWith(data, REACT_PREFIX) ? 'react' : 'chat';
}

/**
 * Control channel: server → viewer orders (kick, P2P revoke, block peers, end) and
 * viewer → server reports (stats, hash failures). WebSocket, because quick tunnels
 * do not support Server-Sent Events.
 *
 * It also carries the viewer's WebTorrent tracker connection as a channel
 * (packages/shared/src/mux.ts): a quick tunnel counts every open WebSocket against its
 * 200-requests-in-flight limit, so one socket per viewer instead of two doubles the audience
 * it can hold.
 */
export class ControlChannel implements ChatHost {
  /** Set by the live: tracker channels are refused until then. */
  tracker: TrackerChannelHost | null = null;
  /** Set by the live: chat frames are ignored until then. */
  chat: ChatHub | null = null;
  /** Revision of the streamer's page (undefined while branding is off), sent in hello. */
  brandRev: () => number | undefined = () => undefined;
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, Set<ControlSocket>>();
  /** Peer ids every viewer must refuse to talk to. */
  readonly blockedPeers = new Set<string>();
  private pingTimer: NodeJS.Timeout;
  onHashFailure: (reporter: Session, accused: Session | undefined, autoRemoved: boolean) => void = () => {};
  /** A viewer's first control connection opened (true) or its last one closed (false). */
  onPresence: (session: Session, connected: boolean) => void = () => {};
  /** Number sent in "hello" (null when the streamer hides the viewer count). */
  viewerCount: () => number | null = () => null;

  constructor(
    private readonly access: AccessControl,
    private readonly log: Logger,
    /** Clock of the per-socket frame budgets (tests inject one). */
    private readonly now: () => number = Date.now,
  ) {
    // Tracker frames (WebRTC offers) are bigger than control messages; control frames are
    // still held to CONTROL_MAX_MESSAGE in onMessage.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: TRACKER_MAX_MESSAGE + 16, perMessageDeflate: false, clientTracking: false });
    this.pingTimer = setInterval(() => this.heartbeat(), 20_000);
    this.pingTimer.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, session: Session): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, session, req));
  }

  /**
   * Take over an accepted WebSocket of `session`: its frame budgets, the hello, and its message
   * and close handling. handleUpgrade calls it for every upgrade; tests hand it a fake socket and
   * drive it through the socket's own events.
   */
  attach(ws: WebSocket, session: Session, req: IncomingMessage): void {
    const s = ws as ControlSocket;
    const at = this.now();
    s.sessionId = session.id;
    s.alive = true;
    s.msgs = { n: 0, at };
    s.frames = { n: 0, at };
    s.opens = { n: 0, at };
    s.chatFrames = { n: 0, at };
    s.reactFrames = { n: 0, at };
    s.upgradeReq = req;
    s.channels = new Map();
    let set = this.conns.get(session.id);
    if (!set) this.conns.set(session.id, (set = new Set()));
    set.add(s);
    session.connections = set.size;
    if (set.size === 1) this.onPresence(session, true);
    s.on('pong', () => (s.alive = true));
    s.on('close', () => {
      for (const ch of s.channels.values()) ch.remoteClosed();
      s.channels.clear();
      set.delete(s);
      const current = this.access.sessions.get(session.id);
      if (current) current.connections = set.size;
      if (set.size === 0) this.onPresence(session, false);
    });
    s.on('message', (data, isBinary) => this.onMessage(s, toBuffer(data), isBinary));
    const block = this.access.p2pBlock(session);
    // A reconnecting page says which chat items it already has: it then gets only the delta.
    const after = new URL(req.url ?? '/', 'http://x').searchParams.get('chatAfter');
    const chat = this.chat?.snapshot(session, after && /^\d{1,15}$/.test(after) ? { after: Number(after) } : {});
    const hello = JSON.stringify({
      t: 'hello',
      sessionId: session.id,
      nickname: session.nickname,
      p2pAllowed: this.access.p2pAllowed(session),
      p2pForAll: this.access.p2pForAll,
      ...(block ? { p2pBlock: block } : {}),
      blockedPeers: [...this.blockedPeers],
      viewerCount: this.viewerCount(),
      ...(chat ? { chat } : {}),
      ...(this.brandRev() !== undefined ? { brandRev: this.brandRev() } : {}),
    } satisfies ServerMessage);
    if (s.readyState === s.OPEN) s.send(hello);
    // The history in hello counts against the chat's upload budget.
    if (chat) this.chat?.helloSent(s, chat, hello.length);
  }

  private onMessage(s: ControlSocket, frame: Buffer | string, isBinary: boolean): void {
    const data = typeof frame === 'string' ? Buffer.from(frame) : frame;
    const now = this.now();
    if (now - s.frames.at > 10_000) s.frames = { n: 0, at: now };
    if (++s.frames.n > MAX_FRAMES_PER_10S || isBinary) {
      s.terminate();
      return;
    }
    // Chat frames: their own budget, the raw size checked before the bytes are even decoded.
    const chatKind = chatFrameKind(data);
    if (chatKind === 'react') {
      this.onReactFrame(s, data, now);
      return;
    }
    if (chatKind === 'chat') {
      this.onChatFrame(s, data, now);
      return;
    }
    const session = this.access.sessions.get(s.sessionId);
    if (!session) {
      s.close(CONTROL_CLOSE.sessionEnded, 'session ended');
      return;
    }
    const text = data.toString();
    if (isTrackerFrame(text)) {
      this.onTrackerFrame(s, text, session, now);
      return;
    }
    if (text.length > CONTROL_MAX_MESSAGE) {
      s.close(1009, 'message too big');
      return;
    }
    if (now - s.msgs.at > 10_000) s.msgs = { n: 0, at: now };
    if (++s.msgs.n > 30) {
      s.terminate();
      return;
    }
    let parsed;
    try {
      parsed = clientMessageSchema.safeParse(JSON.parse(text));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;
    session.lastSeenAt = now;
    switch (msg.t) {
      case 'stats':
        session.p2pEnabled = msg.p2pEnabled && this.access.p2pAllowed(session);
        session.device = msg.device;
        session.stats = {
          httpBytes: msg.httpBytes,
          p2pDownBytes: msg.p2pDownBytes,
          p2pUpBytes: msg.p2pUpBytes,
          peers: msg.peers,
        };
        session.http429 = msg.http429;
        session.delayS = msg.delayS ?? null;
        break;
      case 'hash-fail': {
        const accused = msg.peerId ? this.access.sessionByPeerId(msg.peerId) : undefined;
        let autoRemoved = false;
        if (accused && accused.id !== session.id) {
          accused.hashFailures += 1;
          if (accused.hashFailures >= HASH_FAILURE_THRESHOLD && accused.p2pAllowed) {
            this.access.setP2PAllowed(accused.id, false, true);
            autoRemoved = true;
          }
        }
        this.log.warn({ reporter: session.nickname, accused: accused?.nickname, segment: msg.segment }, 'P2P segment failed hash check');
        this.onHashFailure(session, accused, autoRemoved);
        break;
      }
      case 'pong':
        break;
    }
  }

  private onChatFrame(s: ControlSocket, data: Buffer, now: number): void {
    if (!s.chatFrames || now - s.chatFrames.at > 10_000) s.chatFrames = { n: 0, at: now };
    // 4× what the chat UI can send: only scripts get here, and they lose the socket.
    if (++s.chatFrames.n > CHAT_MAX_FRAMES_PER_10S) {
      this.chat?.terminated();
      s.terminate();
      return;
    }
    const chat = this.chat;
    if (!chat) return;
    if (data.length > CHAT_FRAME_MAX_BYTES) {
      chat.tooBig(s);
      return;
    }
    const session = this.access.sessions.get(s.sessionId);
    if (!session) {
      s.close(CONTROL_CLOSE.sessionEnded, 'session ended');
      return;
    }
    session.lastSeenAt = now;
    chat.frame(session, s, data.toString());
  }

  /**
   * Reaction frames (reserved for 0.5.0): a budget of their own, so a viewer who taps reactions
   * while chatting never reaches the chat budget that terminates the socket (and its P2P channel).
   * Past CHAT_REACT_FRAMES_PER_10S they are ignored; past CHAT_REACT_FRAMES_MAX_PER_10S (scripts
   * only) the socket is terminated. Oversized ones are ignored before decoding (no reply: a
   * reaction is fire-and-forget).
   */
  private onReactFrame(s: ControlSocket, data: Buffer, now: number): void {
    if (!s.reactFrames || now - s.reactFrames.at > 10_000) s.reactFrames = { n: 0, at: now };
    const n = ++s.reactFrames.n;
    if (n > CHAT_REACT_FRAMES_MAX_PER_10S) {
      this.chat?.terminated();
      s.terminate();
      return;
    }
    const chat = this.chat;
    if (!chat || n > CHAT_REACT_FRAMES_PER_10S || data.length > CHAT_FRAME_MAX_BYTES) return;
    const session = this.access.sessions.get(s.sessionId);
    if (!session) {
      s.close(CONTROL_CLOSE.sessionEnded, 'session ended');
      return;
    }
    session.lastSeenAt = now;
    chat.frame(session, s, data.toString());
  }

  /** ChatHost: every open viewer socket. */
  *sockets(): IterableIterator<ControlSocket> {
    for (const set of this.conns.values()) yield* set;
  }

  /** ChatHost: the sockets of one session. */
  socketsOf(sessionId: string): Iterable<ControlSocket> {
    return this.conns.get(sessionId) ?? [];
  }

  private onTrackerFrame(s: ControlSocket, text: string, session: Session, now: number): void {
    const frame = parseTrackerFrame(text);
    if (!frame) return;
    if (frame.op === 'data') {
      s.channels.get(frame.id)?.deliver(frame.payload);
      return;
    }
    if (frame.op === 'close') {
      const ch = s.channels.get(frame.id);
      s.channels.delete(frame.id);
      ch?.remoteClosed();
      return;
    }
    // open
    if (now - s.opens.at > 60_000) s.opens = { n: 0, at: now };
    if (++s.opens.n > MAX_CHANNEL_OPENS_PER_MIN) {
      s.terminate();
      return;
    }
    const refuse = (): void => {
      if (s.readyState === s.OPEN) s.send(encodeTrackerFrame({ op: 'close', id: frame.id }));
    };
    if (s.channels.has(frame.id) || s.channels.size >= MAX_TRACKER_CHANNELS || !this.tracker) return refuse();
    const ch = this.tracker.openChannel(s, frame.id, s.upgradeReq, session);
    if (!ch) return refuse();
    s.channels.set(frame.id, ch);
    // Closed from our side (P2P revoked, rate limit, live reset): forget it.
    ch.once('close', () => {
      if (s.channels.get(frame.id) === ch) s.channels.delete(frame.id);
    });
  }

  private sendTo(s: WebSocket, msg: ServerMessage): void {
    if (s.readyState === s.OPEN) s.send(JSON.stringify(msg));
  }

  send(sessionId: string, msg: ServerMessage): void {
    for (const s of this.conns.get(sessionId) ?? []) this.sendTo(s, msg);
  }

  broadcast(msg: ServerMessage): void {
    for (const set of this.conns.values()) for (const s of set) this.sendTo(s, msg);
  }

  /** Tell the viewer it was kicked, then close its control sockets. */
  kick(sessionId: string): void {
    for (const s of this.conns.get(sessionId) ?? []) {
      this.sendTo(s, { t: 'kicked' });
      s.close(CONTROL_CLOSE.kicked, 'kicked');
    }
    this.conns.delete(sessionId);
  }

  blockPeers(peerIds: string[]): void {
    if (peerIds.length === 0) return;
    for (const p of peerIds) this.blockedPeers.add(p);
    this.broadcast({ t: 'block-peers', peerIds });
  }

  unblockPeers(peerIds: string[]): void {
    if (peerIds.length === 0) return;
    for (const p of peerIds) this.blockedPeers.delete(p);
    this.broadcast({ t: 'unblock-peers', peerIds });
  }

  /** Close every viewer connection, optionally telling them the live ended. */
  closeAll(reason: 'ended' | 'disconnected'): void {
    for (const set of this.conns.values()) {
      for (const s of set) {
        if (reason === 'ended') this.sendTo(s, { t: 'ended' });
        s.close(reason === 'ended' ? CONTROL_CLOSE.ended : CONTROL_CLOSE.disconnected, reason);
      }
    }
    this.conns.clear();
    this.blockedPeers.clear();
  }

  get connectionCount(): number {
    let n = 0;
    for (const set of this.conns.values()) n += set.size;
    return n;
  }

  private heartbeat(): void {
    for (const set of this.conns.values()) {
      for (const s of set) {
        if (!s.alive) {
          s.terminate();
          continue;
        }
        s.alive = false;
        s.ping();
      }
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.closeAll('ended');
  }
}

/** `ws` hands text frames as a Buffer (or fragments); make it one Buffer without copying when possible. */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
