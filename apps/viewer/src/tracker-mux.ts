/**
 * The WebTorrent tracker connection, carried inside the /control WebSocket.
 *
 * A Cloudflare quick tunnel allows 200 requests in flight and counts every open WebSocket as
 * one (measured 2026-10-26, docs/ARCHITECTURE.md). p2p-media-loader opens its own socket to the
 * tracker, so a viewer used to hold two. Now `new WebSocket(trackerUrl)` returns a ChannelSocket
 * (see peer-guard.ts), a WebSocket look-alike whose frames travel on the control socket
 * (protocol in packages/shared/src/mux.ts). One socket per viewer doubles the audience a quick
 * tunnel holds.
 *
 * Lifecycle: a channel opens when the control socket is (or becomes) open, and closes when the
 * server closes it or the control socket drops; p2p-media-loader then reconnects with its own
 * back-off and gets a new channel, which waits for the control socket to come back.
 */
import { encodeTrackerFrame, parseTrackerFrame, isTrackerFrame } from '@swarmcast/shared';

type Handler = ((this: ChannelSocket, ev: Event) => unknown) | null;

export class ChannelSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;
  /** The open frame was sent (the server knows this channel). */
  announced = false;

  constructor(
    readonly url: string,
    readonly id: number,
    private readonly mux: TrackerMux,
  ) {
    super();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    if (typeof data !== 'string') {
      if (data instanceof Blob) throw new TypeError('tracker channel: Blob frames are not supported');
      data = new TextDecoder().decode(data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : new Uint8Array(data));
    }
    this.mux.sendData(this.id, data);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.mux.closeFromViewer(this);
    this.closed(1000);
  }

  /** @internal */
  opened(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.fire(new Event('open'));
  }

  /** @internal */
  message(payload: string): void {
    if (this.readyState !== 1) return;
    this.fire(new MessageEvent('message', { data: payload }));
  }

  /** @internal */
  closed(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire(new CloseEvent('close', { code, wasClean: code === 1000 }));
  }

  private fire(ev: Event): void {
    this.dispatchEvent(ev);
    const handler = ev.type === 'open' ? this.onopen : ev.type === 'message' ? this.onmessage : ev.type === 'close' ? this.onclose : this.onerror;
    handler?.call(this, ev);
  }
}

export class TrackerMux {
  /** URLs starting with this are tracker connections (set from /api/config). */
  trackerUrl = '';
  /** Return false to drop an incoming tracker message (the peer guard). */
  filter: (data: string) => boolean = () => true;
  private socket: WebSocket | null = null;
  private readonly channels = new Map<number, ChannelSocket>();
  private nextId = 1;

  handles(url: string): boolean {
    return this.trackerUrl !== '' && url.startsWith(this.trackerUrl);
  }

  /** A new tracker "WebSocket" for p2p-media-loader. */
  create(url: string): ChannelSocket {
    const ch = new ChannelSocket(url, this.nextId++, this);
    this.channels.set(ch.id, ch);
    // Opened asynchronously, like a real socket, after the caller has set its handlers.
    if (this.isOpen()) queueMicrotask(() => this.announce(ch));
    return ch;
  }

  /** The control socket is open: pending channels open on it. */
  attach(ws: WebSocket): void {
    this.socket = ws;
    for (const ch of this.channels.values()) this.announce(ch);
  }

  /** The control socket closed: every open channel closes (pending ones keep waiting). */
  detach(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    for (const ch of [...this.channels.values()]) {
      if (!ch.announced) continue;
      this.channels.delete(ch.id);
      ch.closed(1006);
    }
  }

  /** Handle a frame from the control socket; false when it is not a tracker frame. */
  onFrame(text: string): boolean {
    if (!isTrackerFrame(text)) return false;
    const frame = parseTrackerFrame(text);
    if (!frame) return true;
    const ch = this.channels.get(frame.id);
    if (!ch) return true;
    if (frame.op === 'data') {
      if (this.filter(frame.payload)) ch.message(frame.payload);
    } else if (frame.op === 'close') {
      this.channels.delete(frame.id);
      ch.closed(1000);
    }
    return true;
  }

  /** Channels known now (open or waiting); for tests. */
  get size(): number {
    return this.channels.size;
  }

  /** Channels open now (window.__swarmcast.trackerChannels, for the e2e tests). */
  get openCount(): number {
    let n = 0;
    for (const ch of this.channels.values()) if (ch.readyState === 1) n += 1;
    return n;
  }

  /** @internal */
  sendData(id: number, payload: string): void {
    if (this.isOpen()) this.socket!.send(encodeTrackerFrame({ op: 'data', id, payload }));
  }

  /** @internal */
  closeFromViewer(ch: ChannelSocket): void {
    this.channels.delete(ch.id);
    if (ch.announced && this.isOpen()) this.socket!.send(encodeTrackerFrame({ op: 'close', id: ch.id }));
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  private announce(ch: ChannelSocket): void {
    if (ch.announced || ch.readyState !== 0 || !this.isOpen() || this.channels.get(ch.id) !== ch) return;
    ch.announced = true;
    this.socket!.send(encodeTrackerFrame({ op: 'open', id: ch.id }));
    ch.opened();
  }
}

export const trackerMux = new TrackerMux();
