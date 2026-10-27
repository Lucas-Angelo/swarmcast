import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WS from 'ws';
import { CONTROL_MAX_MESSAGE, MAX_TRACKER_CHANNELS, encodeTrackerFrame, parseTrackerFrame } from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ControlChannel } from '../../src/control/control.js';
import { TrackerService, infoHashHexFor } from '../../src/tracker/tracker.js';
import { TrackerMux, type ChannelSocket } from '../../../viewer/src/tracker-mux.js';
import { silentLog } from './helpers.js';

const toBinary = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');
const peerAscii = (n: number): string => `-PM0400-${String(n).padStart(12, '0')}`;
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Env {
  server: http.Server;
  url: string;
  access: AccessControl;
  tracker: TrackerService;
  control: ControlChannel;
  session(nick?: string): Session;
}
const envs: Env[] = [];
const sockets: Array<{ close(): void }> = [];

async function setup(): Promise<Env> {
  const access = new AccessControl();
  access.begin();
  const tracker = new TrackerService(access, silentLog);
  tracker.setSwarm(access.liveId);
  const control = new ControlChannel(access, silentLog);
  control.tracker = tracker;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const sid = new URL(req.url!, 'http://x').searchParams.get('sid')!;
    const s = access.sessions.get(sid);
    if (!s) return socket.destroy();
    control.handleUpgrade(req, socket, head, s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  let n = 0;
  const env: Env = {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    access,
    tracker,
    control,
    session: (nick = `v${++n}`) => access.createSession({ nickname: nick, deviceId: `d-${nick}`, device: 'desktop', ip: 'ip' }),
  };
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const e of envs.splice(0)) {
    e.control.close();
    e.tracker.close();
    await new Promise((r) => e.server.close(r));
  }
});

/** A raw control socket (ws), collecting every text frame it receives. */
async function rawControl(e: Env, s: Session): Promise<{ ws: WS; frames: string[]; closed: Promise<number> }> {
  const ws = new WS(`${e.url}/control?sid=${s.id}`);
  sockets.push(ws);
  const frames: string[] = [];
  ws.on('message', (d) => frames.push(d.toString()));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise((r) => ws.on('open', r));
  await tick();
  return { ws, frames, closed };
}

/** A viewer as the page runs it: a browser-style WebSocket for /control plus the TrackerMux. */
async function viewer(e: Env, s: Session): Promise<{ mux: TrackerMux; control: WebSocket; control_messages: string[] }> {
  const mux = new TrackerMux();
  mux.trackerUrl = `${e.url}/tracker`;
  const control = new WebSocket(`${e.url}/control?sid=${s.id}`);
  sockets.push(control);
  const control_messages: string[] = [];
  control.onopen = () => mux.attach(control);
  control.onmessage = (ev) => {
    const text = String(ev.data);
    if (!mux.onFrame(text)) control_messages.push(text);
  };
  control.onclose = () => mux.detach(control);
  return { mux, control, control_messages };
}

/** Open a tracker "WebSocket" the way p2p-media-loader does (handlers set right after construction). */
function trackerSocket(mux: TrackerMux, url: string): { ch: ChannelSocket; messages: Array<Record<string, unknown>>; opened: Promise<void>; closed: Promise<number> } {
  const ch = mux.create(url);
  ch.binaryType = 'arraybuffer';
  const messages: Array<Record<string, unknown>> = [];
  const opened = new Promise<void>((r) => (ch.onopen = () => r()));
  const closed = new Promise<number>((r) => (ch.onclose = (ev) => r((ev as CloseEvent).code)));
  ch.onmessage = (ev) => messages.push(JSON.parse(String((ev as MessageEvent).data)) as Record<string, unknown>);
  return { ch, messages, opened, closed };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(20);
  }
}

describe('tracker frames (packages/shared/src/mux.ts)', () => {
  it('encodes and parses', () => {
    expect(encodeTrackerFrame({ op: 'open', id: 3 })).toBe('~o3');
    expect(encodeTrackerFrame({ op: 'close', id: 3 })).toBe('~c3');
    expect(encodeTrackerFrame({ op: 'data', id: 12, payload: '{"a":1}' })).toBe('~d12 {"a":1}');
    for (const f of [
      { op: 'open', id: 1 },
      { op: 'close', id: 9_999_999 },
      { op: 'data', id: 7, payload: '' },
      { op: 'data', id: 7, payload: ' spaced ~d1 x' },
    ] as const) {
      expect(parseTrackerFrame(encodeTrackerFrame(f))).toEqual(f);
    }
    for (const bad of ['~', '~x1', '~o0', '~o01', '~o1 ', '~c1x', '~d1', '~d1x', '~o12345678', '{"t":"pong"}', '~d-1 x']) {
      expect(parseTrackerFrame(bad)).toBeNull();
    }
  });
});

describe('tracker channels inside /control', () => {
  it('announces through a channel, and two viewers exchange an offer over their single sockets', async () => {
    const e = await setup();
    const ih = toBinary(infoHashHexFor(e.access.liveId, 'main'));
    const a = await viewer(e, e.session());
    const b = await viewer(e, e.session());
    const ta = trackerSocket(a.mux, `${e.url}/tracker`);
    const tb = trackerSocket(b.mux, `${e.url}/tracker`);
    await Promise.all([ta.opened, tb.opened]);

    ta.ch.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(1), numwant: 5, offers: [], event: 'started' }));
    await until(() => ta.messages.length > 0);
    expect(ta.messages[0]!['failure reason']).toBeUndefined();
    expect(e.tracker.peerCount()).toBe(1);

    // B announces with an offer: the tracker relays it to A, through A's control socket.
    const offer = { type: 'offer', sdp: `v=0\r\na=ice-ufrag:abcd\r\n${'x'.repeat(CONTROL_MAX_MESSAGE)}` };
    tb.ch.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(2), numwant: 5, offers: [{ offer_id: 'o1', offer }], event: 'started' }));
    await until(() => ta.messages.some((m) => m.offer !== undefined));
    const relayed = ta.messages.find((m) => m.offer !== undefined)!;
    expect(relayed.peer_id).toBe(peerAscii(2));
    expect((relayed.offer as { sdp: string }).sdp).toBe(offer.sdp); // bigger than a control message: fine on a channel
    expect(e.tracker.peerCount()).toBe(2);

    // One WebSocket per viewer; the tracker's plain-socket count stays 0.
    expect(e.control.connectionCount).toBe(2);
    expect(e.tracker.plainSocketCount).toBe(0);
    // Control messages still arrive as before (hello).
    expect(a.control_messages.some((m) => (JSON.parse(m) as { t: string }).t === 'hello')).toBe(true);
  });

  it('waits for the control socket, closes with it, and reopens after a reconnect', async () => {
    const e = await setup();
    const s = e.session();
    const v = await viewer(e, s);
    // Created before the control socket is open (the player starts in parallel): it waits.
    const t1 = trackerSocket(v.mux, `${e.url}/tracker`);
    expect(t1.ch.readyState).toBe(0);
    await t1.opened;
    expect(t1.ch.readyState).toBe(1);
    await until(() => e.tracker.socketCount === 1);

    // The control socket drops: the channel closes (1006) and the server forgets it.
    v.control.close();
    expect(await t1.closed).toBe(1006);
    await until(() => e.tracker.socketCount === 0);

    // p2p-media-loader reconnects: the new channel waits for the next control socket.
    const t2 = trackerSocket(v.mux, `${e.url}/tracker`);
    await tick(100);
    expect(t2.ch.readyState).toBe(0);
    const again = new WebSocket(`${e.url}/control?sid=${s.id}`);
    sockets.push(again);
    again.onopen = () => v.mux.attach(again);
    again.onmessage = (ev) => void v.mux.onFrame(String(ev.data));
    await t2.opened;
    await until(() => e.tracker.socketCount === 1);
  });

  it('the viewer closing a channel removes its peer from the swarm', async () => {
    const e = await setup();
    const v = await viewer(e, e.session());
    const t = trackerSocket(v.mux, `${e.url}/tracker`);
    await t.opened;
    t.ch.send(JSON.stringify({ action: 'announce', info_hash: toBinary(infoHashHexFor(e.access.liveId, 'main')), peer_id: peerAscii(3), numwant: 0, offers: [], event: 'started' }));
    await until(() => t.messages.length > 0);
    expect(e.tracker.peerCount()).toBe(1);
    t.ch.close();
    expect(t.ch.readyState).toBe(3);
    await until(() => e.tracker.peerCount() === 0);
    // The control socket itself stays open.
    expect(v.control.readyState).toBe(1);
    expect(() => t.ch.send('x')).toThrow();
  });

  it('refuses a channel when the session may not use P2P, and closes channels when P2P is revoked', async () => {
    const e = await setup();
    const denied = e.session();
    e.access.setP2PAllowed(denied.id, false);
    const v = await viewer(e, denied);
    const t = trackerSocket(v.mux, `${e.url}/tracker`);
    await t.opened; // opens locally, then the server closes it
    expect(await t.closed).toBe(1000);
    expect(v.mux.size).toBe(0);

    const ok = e.session();
    const w = await viewer(e, ok);
    const t2 = trackerSocket(w.mux, `${e.url}/tracker`);
    await t2.opened;
    await until(() => e.tracker.socketCount === 1);
    e.tracker.disconnectSession(ok.id);
    expect(await t2.closed).toBe(1000);
    expect(w.control.readyState).toBe(1);
  });

  it('applies the peer guard before the library sees a message', async () => {
    const e = await setup();
    const ih = toBinary(infoHashHexFor(e.access.liveId, 'main'));
    const a = await viewer(e, e.session());
    a.mux.filter = (data) => !data.includes(peerAscii(66));
    const b = await viewer(e, e.session());
    const ta = trackerSocket(a.mux, `${e.url}/tracker`);
    const tb = trackerSocket(b.mux, `${e.url}/tracker`);
    await Promise.all([ta.opened, tb.opened]);
    ta.ch.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(5), numwant: 5, offers: [], event: 'started' }));
    await until(() => ta.messages.length > 0);
    tb.ch.send(JSON.stringify({ action: 'announce', info_hash: ih, peer_id: peerAscii(66), numwant: 5, offers: [{ offer_id: 'o', offer: { type: 'offer', sdp: 'v=0' } }], event: 'started' }));
    await until(() => tb.messages.length > 0);
    await tick(150);
    expect(ta.messages.some((m) => m.offer !== undefined)).toBe(false);
  });

  it('limits channels and channel opens per socket, and keeps control messages small', async () => {
    const e = await setup();
    const c = await rawControl(e, e.session());
    for (let id = 1; id <= MAX_TRACKER_CHANNELS + 1; id++) c.ws.send(encodeTrackerFrame({ op: 'open', id }));
    c.ws.send(encodeTrackerFrame({ op: 'open', id: 1 })); // duplicate id
    await tick(100);
    const closes = c.frames.filter((f) => f.startsWith('~c'));
    expect(closes).toEqual([`~c${MAX_TRACKER_CHANNELS + 1}`, '~c1']);
    // Data for an unknown channel and malformed frames are ignored.
    c.ws.send('~d42 {}');
    c.ws.send('~zz');
    await tick(50);
    expect(c.ws.readyState).toBe(WS.OPEN);

    // An over-size control message closes the socket (1009), as maxPayload did before.
    c.ws.send(JSON.stringify({ t: 'pong', pad: 'x'.repeat(CONTROL_MAX_MESSAGE) }));
    expect(await c.closed).toBe(1009);

    // Opening channels in a loop gets the socket terminated.
    const d = await rawControl(e, e.session());
    for (let id = 1; id <= 20; id++) {
      d.ws.send(encodeTrackerFrame({ op: 'open', id }));
      d.ws.send(encodeTrackerFrame({ op: 'close', id }));
    }
    expect(await d.closed).toBe(1006);
  });

  it('kicking a viewer closes its channel with the control socket', async () => {
    const e = await setup();
    const s = e.session();
    const v = await viewer(e, s);
    const t = trackerSocket(v.mux, `${e.url}/tracker`);
    await t.opened;
    await until(() => e.tracker.socketCount === 1);
    e.control.kick(s.id);
    expect(await t.closed).toBe(1006);
    await until(() => e.tracker.socketCount === 0);
  });
});
