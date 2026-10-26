declare module 'bittorrent-tracker/server' {
  import { EventEmitter } from 'node:events';
  import type { WebSocket } from 'ws';

  export interface AnnounceParams {
    type: 'ws' | 'http' | 'udp';
    info_hash: string;
    peer_id: string;
    event?: string;
    socket: WebSocket & { peerId?: string; infoHashes?: string[]; [k: string]: unknown };
    headers?: Record<string, string>;
    offers?: unknown[];
    answer?: unknown;
    to_peer_id?: string;
    [k: string]: unknown;
  }

  export interface Swarm {
    announce(params: Record<string, unknown>, cb?: (err: Error | null) => void): void;
    peers: { keys: string[]; get(id: string): unknown };
  }

  export interface ServerOptions {
    http?: boolean | object;
    udp?: boolean | object;
    ws?: boolean | object;
    stats?: boolean;
    interval?: number;
    trustProxy?: boolean;
    filter?: (infoHash: string, params: AnnounceParams, cb: (err: Error | null) => void) => void;
  }

  export default class Server extends EventEmitter {
    constructor(opts?: ServerOptions);
    torrents: Record<string, Swarm>;
    onWebSocketConnection(socket: WebSocket, opts?: { trustProxy?: boolean }): void;
    close(cb?: () => void): void;
  }
}
