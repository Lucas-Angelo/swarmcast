import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Server, { type AnnounceParams } from 'bittorrent-tracker/server';
import { computeInfoHash } from 'p2p-media-loader-core/server';
import { WebSocketServer, type WebSocket } from 'ws';
import { TRACKER_MAX_MESSAGE, variantStreamSwarmId } from '@swarmcast/shared';
import type { AccessControl, Session } from '../access/access.js';
import type { Logger } from '../core/logger.js';
import { TrackerChannel } from './channel.js';

type TrackerSocket = (WebSocket | TrackerChannel) & { peerId?: string; sessionId?: string; upgradeReq?: IncomingMessage | null };

/** Stream types p2p-media-loader uses: video (+muxed audio) is "main", alternate audio is "secondary". */
const STREAM_TYPES = ['main', 'secondary'] as const;

/** p2p-media-loader sends 5 offers by default; leave a little room. */
export const MAX_OFFERS_PER_ANNOUNCE = 8;

/**
 * The swarm id string the viewer's `streamSwarmIdBuilder` returns for a stream.
 * Must stay identical to the streamSwarmIdBuilder in apps/viewer/src/watch.ts.
 */
export function streamSwarmIdFor(swarmId: string, streamType: string): string {
  return `swarmcast-${swarmId}-${streamType}`;
}

/** Hex form of the infohash as bittorrent-tracker reports it (hex of the 20 ASCII chars). */
export function infoHashHexFor(swarmId: string, streamType: string): string {
  return Buffer.from(computeInfoHash(streamSwarmIdFor(swarmId, streamType)), 'latin1').toString('hex');
}

/** Infohash (hex) of one video variant's swarm, keyed by height (see variantStreamSwarmId). */
export function variantInfoHashHex(swarmId: string, height: number): string {
  return Buffer.from(computeInfoHash(variantStreamSwarmId(swarmId, 'main', height)), 'latin1').toString('hex');
}

/**
 * Embedded WebTorrent tracker, WebSocket only. It is the only signaling path between viewers,
 * so refusing a session here prevents it from forming new P2P connections.
 */
export class TrackerService {
  readonly server: Server;
  private readonly wss: WebSocketServer;
  private allowed = new Set<string>();
  private sockets = new Map<string, Set<TrackerSocket>>();
  private messageCounts = new WeakMap<object, { n: number; at: number }>();
  swarmId = '';

  constructor(
    private readonly access: AccessControl,
    private readonly log: Logger,
  ) {
    this.server = new Server({
      http: false,
      udp: false,
      ws: false,
      stats: false,
      // Clients re-announce every interval/5 seconds over WebSocket.
      interval: 60_000,
      filter: (infoHash, params, cb) => cb(this.check(infoHash, params)),
    });
    this.server.on('warning', (err: Error) => this.log.debug({ err: err.message }, 'tracker warning'));
    this.server.on('error', (err: Error) => this.log.warn({ err: err.message }, 'tracker error'));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: TRACKER_MAX_MESSAGE, perMessageDeflate: false, clientTracking: false });
  }

  private variantHeights: number[] = [];

  setSwarm(swarmId: string): void {
    this.swarmId = swarmId;
    this.variantHeights = [];
    this.rebuildAllowlist();
  }

  /**
   * Allow one swarm per served video variant (multi-quality ladder). The legacy per-type ids
   * stay allowed so a viewer build without per-variant swarm ids keeps working with a
   * single-variant stream.
   */
  setVariants(heights: number[]): void {
    const next = [...new Set(heights.map((h) => Math.max(0, Math.round(h))))].sort((a, b) => a - b);
    if (next.join(',') === this.variantHeights.join(',')) return;
    this.variantHeights = next;
    this.rebuildAllowlist();
  }

  private rebuildAllowlist(): void {
    if (!this.swarmId) {
      this.allowed = new Set();
      return;
    }
    this.allowed = new Set([
      ...STREAM_TYPES.map((t) => infoHashHexFor(this.swarmId, t)),
      // Height 0 = a variant without RESOLUTION/BANDWIDTH metadata.
      ...[0, ...this.variantHeights].map((h) => variantInfoHashHex(this.swarmId, h)),
    ]);
  }

  /** Infohashes (hex) currently accepted. */
  allowedInfoHashes(): string[] {
    return [...this.allowed];
  }

  private check(infoHash: string, params: AnnounceParams): Error | null {
    const socket = params.socket as TrackerSocket | undefined;
    if (!socket?.sessionId) return new Error('not authenticated');
    const session = this.access.sessions.get(socket.sessionId);
    if (!session) return new Error('session ended');
    if (!this.access.p2pAllowed(session)) return new Error('p2p not allowed');
    if (!this.allowed.has(infoHash)) return new Error('unknown stream');
    // Each offer reaches one random peer: capping offers per announce (plus the per-socket
    // message rate limit) limits how fast one member can learn other viewers' IPs. numwant is
    // capped with them: bittorrent-tracker hands the i-th peer it picks offers[i], and throws (an
    // uncaught TypeError) when it picks more peers than offers are left.
    if (Array.isArray(params.offers) && params.offers.length > MAX_OFFERS_PER_ANNOUNCE) {
      params.offers = params.offers.slice(0, MAX_OFFERS_PER_ANNOUNCE);
    }
    if (typeof params.numwant === 'number') params.numwant = Math.min(params.numwant, MAX_OFFERS_PER_ANNOUNCE);
    // Every message on this socket must use the peer id of its first announce,
    // otherwise a client could "stop" other peers or impersonate them.
    if (socket.peerId && params.peer_id !== socket.peerId) return new Error('peer id mismatch');
    if (!session.peerIds.has(params.peer_id)) {
      session.peerIds.add(params.peer_id);
    }
    return null;
  }

  /**
   * Handle an HTTP upgrade for /tracker. The caller already validated the session cookie.
   * The viewer page no longer opens it (it uses a channel inside /control, see openChannel);
   * it stays for tools and tests that speak the plain WebTorrent tracker protocol.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, session: Session): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws as TrackerSocket, req, session));
  }

  /**
   * A tracker channel inside a viewer's /control socket (packages/shared/src/mux.ts), so each
   * viewer holds one WebSocket through the quick tunnel instead of two. Null when the session
   * may not use P2P (the refusal /tracker answers with 403).
   */
  openChannel(carrier: WebSocket, id: number, req: IncomingMessage, session: Session): TrackerChannel | null {
    // Removed one by one, or on the streamer's own connection (its address would reach every
    // peer). The global switch alone is left to check(): announces are refused while it is off.
    if (!session.p2pAllowed || session.ownConnection || this.access.p2pChecking) return null;
    const channel = new TrackerChannel(id, carrier, req);
    this.attach(channel as TrackerSocket, req, session);
    return channel;
  }

  private attach(s: TrackerSocket, req: IncomingMessage, session: Session): void {
    s.upgradeReq = req;
    s.sessionId = session.id;
    let set = this.sockets.get(session.id);
    if (!set) this.sockets.set(session.id, (set = new Set()));
    set.add(s);
    s.on('close', () => set.delete(s));
    // Simple per-socket message rate limit: 60 messages / 10 s.
    s.on('message', () => {
      const now = Date.now();
      const c = this.messageCounts.get(s) ?? { n: 0, at: now };
      if (now - c.at > 10_000) {
        c.n = 0;
        c.at = now;
      }
      c.n += 1;
      this.messageCounts.set(s, c);
      if (c.n > 60) s.terminate();
    });
    this.server.onWebSocketConnection(s as WebSocket, { trustProxy: false });
  }

  /** Tracker connections open now (plain sockets and channels). */
  get socketCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  /** Plain /tracker WebSockets open now (each one is a request in flight through the tunnel; channels are not). */
  get plainSocketCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) for (const s of set) if (!(s instanceof TrackerChannel)) n += 1;
    return n;
  }

  /** Remove a session from every swarm and close its tracker sockets. */
  disconnectSession(sessionId: string): void {
    for (const s of this.sockets.get(sessionId) ?? []) s.terminate();
    this.sockets.delete(sessionId);
  }

  disconnectAll(): void {
    for (const id of [...this.sockets.keys()]) this.disconnectSession(id);
  }

  /** Number of peers announced in the current swarm (main stream). */
  peerCount(): number {
    let max = 0;
    for (const ih of this.allowed) {
      const swarm = this.server.torrents[ih];
      if (swarm) max = Math.max(max, swarm.peers.keys.length);
    }
    return max;
  }

  close(): void {
    this.disconnectAll();
    this.server.close();
  }
}
