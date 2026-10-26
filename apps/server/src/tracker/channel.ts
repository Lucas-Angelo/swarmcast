import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { encodeTrackerFrame } from '@swarmcast/shared';

/**
 * One tracker connection carried inside a viewer's /control WebSocket (packages/shared/src/mux.ts).
 * It looks like a `ws` WebSocket to bittorrent-tracker's server (`on('message' | 'close' | 'error')`,
 * `send(data, cb)`, `readyState`, `upgradeReq`, `terminate()`), so the tracker logic is the same
 * for a channel and for a plain /tracker socket.
 */
export class TrackerChannel extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  /** Set by bittorrent-tracker; it reads it on the first announce and then clears it. */
  upgradeReq: IncomingMessage | null;

  constructor(
    readonly id: number,
    private readonly carrier: WebSocket,
    upgradeReq: IncomingMessage,
  ) {
    super();
    this.upgradeReq = upgradeReq;
  }

  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    if (this.readyState !== 1 || this.carrier.readyState !== this.carrier.OPEN) {
      cb?.(new Error('tracker channel closed'));
      return;
    }
    this.carrier.send(encodeTrackerFrame({ op: 'data', id: this.id, payload: data.toString() }), cb);
  }

  /** A tracker message from the viewer. */
  deliver(payload: string): void {
    if (this.readyState === 1) this.emit('message', payload, false);
  }

  /** The viewer closed the channel, or its control socket went away. */
  remoteClosed(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }

  /** Close from our side: tell the viewer (its tracker client reconnects with back-off). */
  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    if (this.carrier.readyState === this.carrier.OPEN) this.carrier.send(encodeTrackerFrame({ op: 'close', id: this.id }));
    this.emit('close', 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}
