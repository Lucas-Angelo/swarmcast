// The iOS Simulator's Web Inspector daemon (webinspectord), asked over its own socket which
// applications have connected to it. The Mac's side of a simulator's Web Inspector is a Unix
// socket (the simulator's RWI_LISTEN_SOCKET) that launchd hands to webinspectord, starting it on
// the first connection; safaridriver, Safari's Develop menu and ios-webkit-debug-proxy are its
// clients. Each message is a binary property list behind its length (4 bytes, big-endian):
// `{ __selector, __argument }`. A client names itself (`_rpc_reportIdentifier:`) and asks for the
// list (`_rpc_getConnectedApplications:`); webinspectord answers with
// `_rpc_reportConnectedApplicationList:` and then tells it of each application that connects
// (`_rpc_applicationConnected:`) or goes (`_rpc_applicationDisconnected:`). These names and keys
// are WebKit's (Source/JavaScriptCore/inspector/remote/RemoteInspectorConstants.h).
import { EventEmitter } from 'node:events';
import net from 'node:net';

/** A property list value, as far as Web Inspector messages use them. */
export type Plist = string | number | boolean | null | Buffer | Date | Plist[] | { [key: string]: Plist };

/** Seconds from 1970 to 2001-01-01, the epoch of a binary property list's dates. */
const PLIST_EPOCH_S = 978_307_200;

/** Bytes for an unsigned integer up to `max`: 1, 2, 4 or 8. */
function widthFor(max: number): 1 | 2 | 4 | 8 {
  if (max < 0x100) return 1;
  if (max < 0x10000) return 2;
  if (max < 0x100000000) return 4;
  return 8;
}

function writeUInt(n: number, width: 1 | 2 | 4 | 8): Buffer {
  const b = Buffer.alloc(width);
  if (width === 8) b.writeBigUInt64BE(BigInt(n));
  else b.writeUIntBE(n, 0, width);
  return b;
}

/** A marker byte with its 4-bit length, followed by an integer object when the length does not fit. */
function head(type: number, length: number): Buffer {
  if (length < 15) return Buffer.from([(type << 4) | length]);
  const width = widthFor(length);
  return Buffer.concat([Buffer.from([(type << 4) | 0x0f, 0x10 | Math.log2(width)]), writeUInt(length, width)]);
}

/**
 * Encodes a binary property list ("bplist00") of dictionaries, arrays, strings, booleans and
 * integers: what a Web Inspector client sends.
 */
export function encodePlist(top: Plist): Buffer {
  const objects: Buffer[] = [];
  // Every object is written once, its children before it is known: refs are filled in afterwards.
  const pending: Array<{ index: number; type: number; refs: number[] }> = [];
  const add = (v: Plist): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    if (v === null) objects[index] = Buffer.from([0x00]);
    else if (typeof v === 'boolean') objects[index] = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) throw new Error(`encodePlist: only whole numbers of 0 or more, not ${v}`);
      const width = widthFor(v);
      objects[index] = Buffer.concat([Buffer.from([0x10 | Math.log2(width)]), writeUInt(v, width)]);
    } else if (typeof v === 'string') {
      // ASCII as bytes, anything else as UTF-16 (big-endian), as Apple's writer does.
      if (/^\p{ASCII}*$/u.test(v)) objects[index] = Buffer.concat([head(0x5, v.length), Buffer.from(v, 'ascii')]);
      else objects[index] = Buffer.concat([head(0x6, v.length), Buffer.from(v, 'utf16le').swap16()]);
    } else if (Array.isArray(v)) pending.push({ index, type: 0xa, refs: v.map(add) });
    else if (Buffer.isBuffer(v) || v instanceof Date) throw new Error('encodePlist: no data or dates');
    else {
      const keys = Object.keys(v);
      const keyRefs = keys.map((k) => add(k));
      pending.push({ index, type: 0xd, refs: [...keyRefs, ...keys.map((k) => add(v[k]!))] });
    }
    return index;
  };
  add(top);
  const refWidth = widthFor(objects.length - 1);
  for (const p of pending) {
    const count = p.type === 0xd ? p.refs.length / 2 : p.refs.length;
    objects[p.index] = Buffer.concat([head(p.type, count), ...p.refs.map((r) => writeUInt(r, refWidth))]);
  }
  const offsets: number[] = [];
  let at = 8;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const offsetWidth = widthFor(at);
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetWidth;
  trailer[7] = refWidth;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([Buffer.from('bplist00', 'ascii'), ...objects, ...offsets.map((o) => writeUInt(o, offsetWidth)), trailer]);
}

/** Decodes a binary property list ("bplist00"); throws on anything else. */
export function decodePlist(buf: Buffer): Plist {
  if (buf.length < 40 || buf.toString('ascii', 0, 8) !== 'bplist00') throw new Error('not a binary property list');
  const t = buf.length - 32;
  const offsetWidth = buf[t + 6]!;
  const refWidth = buf[t + 7]!;
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const table = Number(buf.readBigUInt64BE(t + 24));
  const uint = (at: number, width: number): number => {
    if (at + width > buf.length) throw new Error('property list cut short');
    return width === 8 ? Number(buf.readBigUInt64BE(at)) : buf.readUIntBE(at, width);
  };
  const read = (ref: number, depth: number): Plist => {
    if (ref >= count || depth > 64) throw new Error(`property list object ${ref} out of range`);
    const at = uint(table + ref * offsetWidth, offsetWidth);
    const marker = buf[at]!;
    const type = marker >> 4;
    let length = marker & 0x0f;
    let body = at + 1;
    if (length === 0x0f && type !== 0x0 && type !== 0x1 && type !== 0x2 && type !== 0x3) {
      const width = 1 << (buf[body]! & 0x0f);
      length = uint(body + 1, width);
      body += 1 + width;
    }
    switch (type) {
      case 0x0:
        if (length === 0x8) return false;
        if (length === 0x9) return true;
        return null;
      case 0x1: {
        const width = 1 << length;
        return width === 8 ? Number(buf.readBigInt64BE(body)) : uint(body, width);
      }
      case 0x2:
        return length === 2 ? buf.readFloatBE(body) : buf.readDoubleBE(body);
      case 0x3:
        return new Date((buf.readDoubleBE(body) + PLIST_EPOCH_S) * 1000);
      case 0x4:
        return Buffer.from(buf.subarray(body, body + length));
      case 0x5:
        return buf.toString('ascii', body, body + length);
      case 0x6:
        return Buffer.from(buf.subarray(body, body + length * 2)).swap16().toString('utf16le');
      case 0x8:
        return uint(body, length + 1);
      case 0xa:
      case 0xb:
      case 0xc:
        // Arrays, ordered sets and sets alike.
        return Array.from({ length }, (_, i) => read(uint(body + i * refWidth, refWidth), depth + 1));
      case 0xd: {
        const dict: { [key: string]: Plist } = {};
        for (let i = 0; i < length; i++) {
          const key = read(uint(body + i * refWidth, refWidth), depth + 1);
          if (typeof key !== 'string') throw new Error('property list dictionary key is not a string');
          dict[key] = read(uint(body + (length + i) * refWidth, refWidth), depth + 1);
        }
        return dict;
      }
      default:
        throw new Error(`property list object type 0x${type.toString(16)} not supported`);
    }
  };
  return read(top, 0);
}

/** One Web Inspector message as it goes over the socket: its length, then its property list. */
export function frame(selector: string, argument: { [key: string]: Plist }): Buffer {
  const body = encodePlist({ __selector: selector, __argument: argument });
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** Splits what came so far into whole messages; returns them and what is left of the next one. */
export function unframe(buf: Buffer): { messages: Plist[]; rest: Buffer } {
  const messages: Plist[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const length = buf.readUInt32BE(at);
    if (buf.length - at - 4 < length) break;
    messages.push(decodePlist(buf.subarray(at + 4, at + 4 + length)));
    at += 4 + length;
  }
  return { messages, rest: buf.subarray(at) };
}

function dict(v: Plist | undefined): { [key: string]: Plist } | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date) ? v : null;
}

/**
 * The applications a Web Inspector daemon lists as connected (by their identifier, "PID:123"),
 * kept up to date from its messages. Emits 'change' after each message.
 */
export class InspectorApps extends EventEmitter {
  /** Application identifier → bundle identifier. */
  private readonly apps = new Map<string, string>();
  /** Every selector received, in order of first arrival (for a timeout's message). */
  private readonly selectors: string[] = [];

  /** Takes one message from webinspectord. */
  take(message: Plist): void {
    const m = dict(message);
    const selector = typeof m?.__selector === 'string' ? m.__selector : '(no selector)';
    if (!this.selectors.includes(selector)) this.selectors.push(selector);
    const argument = dict(m?.__argument);
    const app = (v: Plist | undefined): [string, string] | null => {
      const a = dict(v);
      const id = a?.WIRApplicationIdentifierKey;
      return typeof id === 'string' ? [id, typeof a?.WIRApplicationBundleIdentifierKey === 'string' ? a.WIRApplicationBundleIdentifierKey : '(no bundle)'] : null;
    };
    if (selector === '_rpc_reportConnectedApplicationList:') {
      this.apps.clear();
      for (const v of Object.values(dict(argument?.WIRApplicationDictionaryKey) ?? {})) {
        const a = app(v);
        if (a) this.apps.set(...a);
      }
    } else if (selector === '_rpc_applicationConnected:' || selector === '_rpc_applicationUpdated:') {
      const a = app(argument ?? null);
      if (a) this.apps.set(...a);
    } else if (selector === '_rpc_applicationDisconnected:') {
      const a = app(argument ?? null);
      if (a) this.apps.delete(a[0]);
    }
    this.emit('change');
  }

  has(bundle: string): boolean {
    return [...this.apps.values()].includes(bundle);
  }

  /** What webinspectord said so far, for a timeout's message. */
  describe(): string {
    if (this.selectors.length === 0) return 'webinspectord has not answered';
    const apps = [...this.apps].map(([id, bundle]) => `${bundle} (${id})`);
    return `webinspectord sent ${this.selectors.join(', ')}; connected: ${apps.join(', ') || 'none'}`;
  }
}

/**
 * A client of a simulator's Web Inspector: connecting starts webinspectord (launchd), and the
 * connection keeps it running until close(). Every message is read for as long as it is open, so
 * that webinspectord never waits on this client.
 */
export class WebInspectorClient {
  readonly apps = new InspectorApps();
  /** Why the connection ended or could not be read; null while it works. */
  private ended: string | null = null;

  private constructor(private readonly socket: net.Socket) {
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      if (this.ended) return;
      try {
        const { messages, rest } = unframe(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const m of messages) this.apps.take(m);
      } catch (e) {
        this.end(`a message from webinspectord could not be read: ${(e as Error).message}`);
      }
    });
    socket.on('error', (e) => this.end(`the connection failed: ${e.message}`));
    socket.on('close', () => this.end('webinspectord closed the connection'));
  }

  private end(why: string): void {
    this.ended ??= why;
    this.apps.emit('change');
  }

  /** Connects to `socketPath` (the simulator's RWI_LISTEN_SOCKET), names itself and asks for the connected applications. */
  static async connect(socketPath: string, id: string): Promise<WebInspectorClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.createConnection(socketPath, () => {
        c.off('error', reject);
        resolve(c);
      });
      c.once('error', reject);
    });
    const client = new WebInspectorClient(socket);
    socket.write(frame('_rpc_reportIdentifier:', { WIRConnectionIdentifierKey: id }));
    socket.write(frame('_rpc_getConnectedApplications:', { WIRConnectionIdentifierKey: id }));
    return client;
  }

  /** Whether `bundle` is connected; throws once the connection has ended (nothing more will come). */
  connected(bundle: string): boolean {
    if (this.apps.has(bundle)) return true;
    if (this.ended) throw new Error(`${this.ended} (${this.apps.describe()})`);
    return false;
  }

  close(): void {
    this.ended ??= 'closed';
    this.socket.destroy();
  }
}
