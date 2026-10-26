import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CONTROL_MAX_MESSAGE, HASH_FAILURE_THRESHOLD, clientMessageSchema, type ServerMessage } from '@swarmcast/shared';
import type { AccessControl, Session } from '../access/access.js';
import type { Logger } from '../core/logger.js';

type ControlSocket = WebSocket & { sessionId: string; alive: boolean; msgs: { n: number; at: number } };

/**
 * Control channel: server → viewer orders (kick, P2P revoke, block peers, end) and
 * viewer → server reports (stats, hash failures). WebSocket, because quick tunnels
 * do not support Server-Sent Events.
 */
export class ControlChannel {
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
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_MESSAGE, perMessageDeflate: false, clientTracking: false });
    this.pingTimer = setInterval(() => this.heartbeat(), 20_000);
    this.pingTimer.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, session: Session): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const s = ws as ControlSocket;
      s.sessionId = session.id;
      s.alive = true;
      s.msgs = { n: 0, at: Date.now() };
      let set = this.conns.get(session.id);
      if (!set) this.conns.set(session.id, (set = new Set()));
      set.add(s);
      session.connections = set.size;
      if (set.size === 1) this.onPresence(session, true);
      s.on('pong', () => (s.alive = true));
      s.on('close', () => {
        set.delete(s);
        const current = this.access.sessions.get(session.id);
        if (current) current.connections = set.size;
        if (set.size === 0) this.onPresence(session, false);
      });
      s.on('message', (data, isBinary) => this.onMessage(s, data.toString(), isBinary));
      this.sendTo(s, {
        t: 'hello',
        sessionId: session.id,
        nickname: session.nickname,
        p2pAllowed: session.p2pAllowed,
        blockedPeers: [...this.blockedPeers],
        viewerCount: this.viewerCount(),
      });
    });
  }

  private onMessage(s: ControlSocket, text: string, isBinary: boolean): void {
    const now = Date.now();
    if (now - s.msgs.at > 10_000) s.msgs = { n: 0, at: now };
    if (++s.msgs.n > 30 || isBinary) {
      s.terminate();
      return;
    }
    const session = this.access.sessions.get(s.sessionId);
    if (!session) {
      s.close(4001, 'session ended');
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
        session.p2pEnabled = msg.p2pEnabled && session.p2pAllowed;
        session.device = msg.device;
        session.stats = {
          httpBytes: msg.httpBytes,
          p2pDownBytes: msg.p2pDownBytes,
          p2pUpBytes: msg.p2pUpBytes,
          peers: msg.peers,
        };
        session.http429 = msg.http429;
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
      s.close(4003, 'kicked');
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
        s.close(reason === 'ended' ? 4000 : 4002, reason);
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
