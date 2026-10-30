import { EventEmitter, once } from 'node:events';
import { describe, expect, it, onTestFinished } from 'vitest';
import WS from 'ws';
import { CONTROL_MAX_MESSAGE, MAX_TRACKER_CHANNELS, encodeTrackerFrame, parseTrackerFrame } from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ControlChannel } from '../../src/control/control.js';
import type { TrackerChannel } from '../../src/tracker/channel.js';
import { TrackerService, infoHashHexFor } from '../../src/tracker/tracker.js';
import { TrackerMux, type ChannelSocket } from '../../../viewer/src/tracker-mux.js';
import { silentLog } from './helpers.js';
import { announceFrame, controlSocket, joinViewer, peerAscii, roundTrip, upgradeServer } from './helpers-b.js';

// The viewer's WebTorrent tracker connection rides inside its /control WebSocket as a channel
// (packages/shared/src/mux.ts): a quick tunnel counts every open WebSocket against its limit, so one
// socket per viewer instead of two doubles the audience it holds. A channel waits for the control
// socket, closes with it (1006), and p2p-media-loader opens a new one after a reconnect; tracker
// frames may be bigger than a control message. Per control socket: at most MAX_TRACKER_CHANNELS
// channels, a limited rate of channel opens (a loop of opens gets the socket terminated), control
// messages no bigger than CONTROL_MAX_MESSAGE (1009 otherwise).
//
// The viewer side is the page's own TrackerMux on a browser-style WebSocket (Node's global one).
// Waits: a browser WebSocket cannot ping, so to know the page has handled what the server sent, the
// server sends it one more message (a ping) and the test waits for that one (frames arrive in
// order). On the server side, the control channel's tracker host is wrapped to announce each channel
// it opens: the test then waits for that channel's own 'close' event.

type TrackerMessage = Record<string, unknown>;

/**
 * A live's control channel with its tracker, reachable on /control and /tracker. `opened()` resolves
 * with the next channel the server opens (the tracker counts it by then). Closed when the test finishes.
 */
async function signaling() {
  const access = new AccessControl();
  access.begin();
  const tracker = new TrackerService(access, silentLog);
  tracker.setSwarm(access.liveId);
  const control = new ControlChannel(access, silentLog);
  const channels = new EventEmitter<{ open: [TrackerChannel] }>();
  control.tracker = {
    openChannel: (carrier, id, req, session) => {
      const ch = tracker.openChannel(carrier, id, req, session);
      if (ch) channels.emit('open', ch);
      return ch;
    },
  };
  onTestFinished(() => {
    control.close();
    tracker.close();
  });
  const url = await upgradeServer(access, { control, tracker });
  const opened = async (): Promise<TrackerChannel> => (await once(channels, 'open'))[0] as TrackerChannel;
  return { access, tracker, control, url, opened, trackerUrl: `${url}/tracker`, mainSwarm: infoHashHexFor(access.liveId, 'main') };
}
type Signaling = Awaited<ReturnType<typeof signaling>>;

/**
 * A viewer as the page runs it: a browser-style WebSocket for /control (not open yet when this
 * returns, like a page that starts its player in parallel) plus the TrackerMux. `messages` are the
 * control messages (not tracker frames) it received; `caughtUp()` resolves once the page has handled
 * every frame the server sent it before the call.
 */
function viewer(e: Signaling, s: Session) {
  const mux = new TrackerMux();
  mux.trackerUrl = e.trackerUrl;
  const control = connectControl(e, s, mux);
  const messages: string[] = [];
  const arrived = new EventTarget();
  control.onmessage = (ev) => {
    const text = String(ev.data);
    if (mux.onFrame(text)) return;
    messages.push(text);
    arrived.dispatchEvent(new Event('message'));
  };
  const caughtUp = async (): Promise<void> => {
    const from = messages.length;
    e.control.send(s.id, { t: 'ping' });
    while (!messages.slice(from).some((m) => (JSON.parse(m) as { t: string }).t === 'ping')) await once(arrived, 'message');
  };
  return { mux, control, messages, caughtUp };
}

/** The page's /control socket for `s`, attached to `mux` once open and detached when it closes; closed when the test finishes. */
function connectControl(e: Signaling, s: Session, mux: TrackerMux): WebSocket {
  const control = new WebSocket(`${e.url}/control?sid=${s.id}`);
  control.onopen = () => mux.attach(control);
  control.onclose = () => mux.detach(control);
  onTestFinished(() => control.close());
  return control;
}

/**
 * A tracker "WebSocket" opened the way p2p-media-loader does (handlers set right after
 * construction). `messages` collects what it receives, parsed; `first(pred)` resolves with the first
 * message matching `pred`, received already or still to come.
 */
function channel(mux: TrackerMux, url: string) {
  const ch: ChannelSocket = mux.create(url);
  ch.binaryType = 'arraybuffer';
  const messages: TrackerMessage[] = [];
  const opened = new Promise<void>((r) => (ch.onopen = () => r()));
  const closed = new Promise<number>((r) => (ch.onclose = (ev) => r((ev as CloseEvent).code)));
  ch.onmessage = (ev) => messages.push(JSON.parse(String((ev as MessageEvent).data)) as TrackerMessage);
  const first = async (pred: (m: TrackerMessage) => boolean = () => true): Promise<TrackerMessage> => {
    for (;;) {
      const m = messages.find(pred);
      if (m) return m;
      await once(ch, 'message');
    }
  };
  return { ch, messages, opened, closed, first };
}

/** An announce with one WebRTC offer, as a viewer sends it to find peers. */
const offerAnnounce = (swarm: string, peer: number, offer: unknown): string => announceFrame(swarm, peer, { numwant: 5, offers: [{ offer_id: 'o1', offer }] });

describe('tracker frames (packages/shared/src/mux.ts)', () => {
  it.each([
    [{ op: 'open', id: 3 }, '~o3'],
    [{ op: 'close', id: 3 }, '~c3'],
    [{ op: 'data', id: 12, payload: '{"a":1}' }, '~d12 {"a":1}'],
  ] as const)('encodes %j as %s', (frame, text) => {
    // Act
    const encoded = encodeTrackerFrame(frame);
    // Assert
    expect(encoded).toBe(text);
  });

  it.each([
    { op: 'open', id: 1 },
    { op: 'close', id: 9_999_999 },
    { op: 'data', id: 7, payload: '' },
    { op: 'data', id: 7, payload: ' spaced ~d1 x' },
  ] as const)('parses what it encodes: %j', (frame) => {
    // Act
    const parsed = parseTrackerFrame(encodeTrackerFrame(frame));
    // Assert
    expect(parsed).toEqual(frame);
  });

  it.each(['~', '~x1', '~o0', '~o01', '~o1 ', '~c1x', '~d1', '~d1x', '~o12345678', '{"t":"pong"}', '~d-1 x'])('rejects %j', (bad) => {
    // Act
    const parsed = parseTrackerFrame(bad);
    // Assert
    expect(parsed).toBeNull();
  });
});

describe('tracker channels inside /control', () => {
  it('announces through a channel, and two viewers exchange an offer over their single sockets', async () => {
    // Arrange
    const e = await signaling();
    const a = viewer(e, joinViewer(e.access, 'a'));
    const b = viewer(e, joinViewer(e.access, 'b'));
    const ta = channel(a.mux, e.trackerUrl);
    const tb = channel(b.mux, e.trackerUrl);
    await Promise.all([ta.opened, tb.opened]);
    const offer = { type: 'offer', sdp: `v=0\r\na=ice-ufrag:abcd\r\n${'x'.repeat(CONTROL_MAX_MESSAGE)}` };
    // Act
    ta.ch.send(announceFrame(e.mainSwarm, 1, { numwant: 5 }));
    const reply = await ta.first();
    tb.ch.send(offerAnnounce(e.mainSwarm, 2, offer));
    const relayed = await ta.first((m) => m.offer !== undefined);
    // Assert
    expect(reply['failure reason']).toBeUndefined();
    expect(relayed.peer_id).toBe(peerAscii(2));
    expect((relayed.offer as { sdp: string }).sdp).toBe(offer.sdp);
    expect(e.tracker.peerCount()).toBe(2);
    expect(e.control.connectionCount).toBe(2);
    expect(e.tracker.plainSocketCount).toBe(0);
    expect(a.messages.some((m) => (JSON.parse(m) as { t: string }).t === 'hello')).toBe(true);
  });

  it('a channel created before the control socket is open waits for it, then opens on the server too', async () => {
    // Arrange
    const e = await signaling();
    const v = viewer(e, joinViewer(e.access, 'v'));
    const onServer = e.opened();
    // Act
    const t1 = channel(v.mux, e.trackerUrl);
    // Assert
    expect(t1.ch.readyState).toBe(0);
    await t1.opened;
    expect(t1.ch.readyState).toBe(1);
    await onServer;
    expect(e.tracker.socketCount).toBe(1);
  });

  it('a channel closes (1006) when its control socket drops, and the server forgets it', async () => {
    // Arrange
    const e = await signaling();
    const v = viewer(e, joinViewer(e.access, 'v'));
    const onServer = e.opened();
    const t1 = channel(v.mux, e.trackerUrl);
    const serverSide = await onServer;
    // Act
    v.control.close();
    // Assert
    expect(await t1.closed).toBe(1006);
    await once(serverSide, 'close');
    expect(e.tracker.socketCount).toBe(0);
  });

  it('after a drop, a new channel waits for the next control socket and opens on it', async () => {
    // Arrange
    const e = await signaling();
    const s = joinViewer(e.access, 'v');
    const v = viewer(e, s);
    const first = e.opened();
    const t1 = channel(v.mux, e.trackerUrl);
    const firstOnServer = await first;
    v.control.close();
    await Promise.all([t1.closed, once(firstOnServer, 'close')]);
    const second = e.opened();
    // Act
    const t2 = channel(v.mux, e.trackerUrl);
    const waiting = t2.ch.readyState;
    connectControl(e, s, v.mux).onmessage = (ev) => void v.mux.onFrame(String(ev.data));
    await t2.opened;
    // Assert
    expect(waiting).toBe(0);
    await second;
    expect(e.tracker.socketCount).toBe(1);
  });

  it('the viewer closing a channel removes its peer from the swarm; the control socket stays open', async () => {
    // Arrange
    const e = await signaling();
    const v = viewer(e, joinViewer(e.access, 'v'));
    const onServer = e.opened();
    const t = channel(v.mux, e.trackerUrl);
    await t.opened;
    t.ch.send(announceFrame(e.mainSwarm, 3));
    await t.first();
    const serverSide = await onServer;
    const before = e.tracker.peerCount();
    // Act
    t.ch.close();
    // Assert
    expect(before).toBe(1);
    expect(t.ch.readyState).toBe(3);
    await once(serverSide, 'close');
    expect(e.tracker.peerCount()).toBe(0);
    expect(v.control.readyState).toBe(1);
    expect(() => t.ch.send('x')).toThrow();
  });

  it('refuses a channel when the session may not use P2P: it opens locally, then the server closes it', async () => {
    // Arrange
    const e = await signaling();
    const denied = joinViewer(e.access, 'denied');
    e.access.setP2PAllowed(denied.id, false);
    const v = viewer(e, denied);
    // Act
    const t = channel(v.mux, e.trackerUrl);
    await t.opened;
    // Assert
    expect(await t.closed).toBe(1000);
    expect(v.mux.size).toBe(0);
  });

  it('closes the channels of a session whose P2P is revoked; the control socket stays open', async () => {
    // Arrange
    const e = await signaling();
    const ok = joinViewer(e.access, 'ok');
    const v = viewer(e, ok);
    const onServer = e.opened();
    const t = channel(v.mux, e.trackerUrl);
    await Promise.all([t.opened, onServer]);
    // Act
    e.tracker.disconnectSession(ok.id);
    // Assert
    expect(await t.closed).toBe(1000);
    expect(v.control.readyState).toBe(1);
  });

  it('applies the peer guard before the library sees a message', async () => {
    // Arrange
    const e = await signaling();
    const a = viewer(e, joinViewer(e.access, 'a'));
    a.mux.filter = (data) => !data.includes(peerAscii(66));
    const b = viewer(e, joinViewer(e.access, 'b'));
    const ta = channel(a.mux, e.trackerUrl);
    const tb = channel(b.mux, e.trackerUrl);
    await Promise.all([ta.opened, tb.opened]);
    ta.ch.send(announceFrame(e.mainSwarm, 5, { numwant: 5 }));
    await ta.first();
    // Act
    tb.ch.send(offerAnnounce(e.mainSwarm, 66, { type: 'offer', sdp: 'v=0' }));
    await tb.first();
    await a.caughtUp();
    // Assert
    expect(ta.messages.some((m) => m.offer !== undefined)).toBe(false);
  });

  it('limits channels per control socket, and refuses a duplicate channel id', async () => {
    // Arrange
    const e = await signaling();
    const c = await controlSocket(e.url, joinViewer(e.access, 'raw'));
    // Act
    for (let id = 1; id <= MAX_TRACKER_CHANNELS + 1; id++) c.ws.send(encodeTrackerFrame({ op: 'open', id }));
    c.ws.send(encodeTrackerFrame({ op: 'open', id: 1 }));
    await roundTrip(c.ws);
    // Assert
    expect(c.frames.filter((f) => f.startsWith('~c'))).toEqual([`~c${MAX_TRACKER_CHANNELS + 1}`, '~c1']);
  });

  it('ignores data for an unknown channel and malformed frames', async () => {
    // Arrange
    const e = await signaling();
    const c = await controlSocket(e.url, joinViewer(e.access, 'raw'));
    // Act
    c.ws.send('~d42 {}');
    c.ws.send('~zz');
    await roundTrip(c.ws);
    // Assert
    expect(c.ws.readyState).toBe(WS.OPEN);
  });

  it('closes the socket (1009) on an over-size control message, as maxPayload did before', async () => {
    // Arrange
    const e = await signaling();
    const c = await controlSocket(e.url, joinViewer(e.access, 'raw'));
    // Act
    c.ws.send(JSON.stringify({ t: 'pong', pad: 'x'.repeat(CONTROL_MAX_MESSAGE) }));
    // Assert
    expect(await c.closed).toBe(1009);
  });

  it('terminates a socket that opens channels in a loop', async () => {
    // Arrange
    const e = await signaling();
    const c = await controlSocket(e.url, joinViewer(e.access, 'raw'));
    // Act
    for (let id = 1; id <= 20; id++) {
      c.ws.send(encodeTrackerFrame({ op: 'open', id }));
      c.ws.send(encodeTrackerFrame({ op: 'close', id }));
    }
    // Assert
    expect(await c.closed).toBe(1006);
  });

  it('kicking a viewer closes its channel with the control socket', async () => {
    // Arrange
    const e = await signaling();
    const s = joinViewer(e.access, 'v');
    const v = viewer(e, s);
    const onServer = e.opened();
    const t = channel(v.mux, e.trackerUrl);
    await t.opened;
    const serverSide = await onServer;
    // Act
    e.control.kick(s.id);
    // Assert
    expect(await t.closed).toBe(1006);
    await once(serverSide, 'close');
    expect(e.tracker.socketCount).toBe(0);
  });
});
