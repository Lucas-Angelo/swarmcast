import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { AccessControl } from '../../src/access/access.js';
import { defaultConfig } from '../../src/core/config.js';
import { HlsOrigin } from '../../src/hls/origin.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { QualityManager } from '../../src/quality/manager.js';
import { ObsWebsocketClient, obsAuth, obsHealthFrom, parseObsMessage, parseStreamStatus, type ObsStreamStatus } from '../../src/quality/signals.js';
import { TrackerService } from '../../src/tracker/tracker.js';
import { silentLog } from './helpers.js';
import { nextJson, roundTrip } from './helpers-b.js';

// Congestion signals of the adaptive upload cap. The obs-websocket client (opt-in, loopback only)
// logs in to OBS with the v5 challenge-response and polls GetStreamStatus. Whatever listens on
// that port (OBS, an older OBS, another program) is not trusted: every message is checked before
// use and anything else is ignored, without a crash. The fake OBS below is a real WebSocket server
// on 127.0.0.1, port 0; the poll timer is faked, and a ping round trip (roundTrip) tells when the
// client has handled everything sent to it.
//
// The quality manager wires the signals into the controller. Auto mode starts at 60 % of the
// ceiling: here 40 Mbps measured × 0.85 (15 % headroom) − 6 Mbps × 1.25 (the stream she also sends
// elsewhere, 6 Mbps assumed) = 26.5 Mbps, so 15.9 Mbps. RTT growth while nothing is being sent is
// not ours: it must never cause a false "upload too low".

/** How often the client polls GetStreamStatus (its default). */
const POLL_MS = 2000;

afterEach(() => {
  vi.useRealTimers();
});

/** A program on the obs-websocket port: `client` resolves with the server side of the client's connection. Closed when the test finishes. */
async function fakeObs(): Promise<{ url: string; client: Promise<WebSocket> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'obswebsocket.json' });
  onTestFinished(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  await once(wss, 'listening');
  const client = once(wss, 'connection').then(([ws]) => ws as WebSocket);
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, client };
}

/** A started client, stopped when the test finishes. */
function obsClient(url: string, password: string | undefined): ObsWebsocketClient {
  const c = new ObsWebsocketClient(url, password, silentLog, POLL_MS);
  c.start();
  onTestFinished(() => c.stop());
  return c;
}

/** Every message the client sends to `obs`, parsed, from now on. */
function sentBy(obs: WebSocket): Array<{ op: number; d: Record<string, unknown> }> {
  const got: Array<{ op: number; d: Record<string, unknown> }> = [];
  obs.on('message', (raw) => got.push(JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> }));
  return got;
}

/** OBS's side of the login: Hello (asking for a password when `auth` is given), the client's Identify, then Identified. Resolves with the Identify. */
async function handshake(obs: WebSocket, auth?: { salt: string; challenge: string }): Promise<{ op: number; d: { authentication?: string } }> {
  obs.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.0', rpcVersion: 1, ...(auth ? { authentication: auth } : {}) } }));
  const identify = await nextJson<{ op: number; d: { authentication?: string } }>(obs);
  obs.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
  return identify;
}

/** Waits for the client's next GetStreamStatus request and answers it with `responseData`. */
async function answerPoll(obs: WebSocket, responseData: unknown): Promise<void> {
  const req = await nextJson<{ op: number; d: { requestId: string; requestType: string } }>(obs);
  if (req.op !== 6 || req.d.requestType !== 'GetStreamStatus') throw new Error(`expected a GetStreamStatus request, got ${JSON.stringify(req)}`);
  obs.send(JSON.stringify({ op: 7, d: { requestType: 'GetStreamStatus', requestId: req.d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
}

/** GetStreamStatus after `frames` frames at 30 fps: 25 kB a frame (6000 kbps), 1 frame in 20 dropped (5 %), congestion 0.5. */
function streamStatus(frames: number): ObsStreamStatus & { outputTimecode: string } {
  return { outputActive: true, outputReconnecting: false, outputCongestion: 0.5, outputBytes: frames * 25_000, outputSkippedFrames: frames / 20, outputTotalFrames: frames, outputDuration: (frames / 30) * 1000, outputTimecode: '' };
}

describe('obs-websocket', () => {
  it('computes the v5 authentication string (protocol.md example)', () => {
    // Act
    const auth = obsAuth('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=');
    // Assert
    expect(auth).toBe('1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
  });

  it('turns two GetStreamStatus samples into congestion, drop % and bitrate', () => {
    // Arrange
    const a: ObsStreamStatus = { outputActive: true, outputReconnecting: false, outputCongestion: 0.02, outputBytes: 1_000_000, outputSkippedFrames: 10, outputTotalFrames: 1000, outputDuration: 10_000 };
    const b: ObsStreamStatus = { ...a, outputCongestion: 0.3, outputBytes: 2_500_000, outputSkippedFrames: 16, outputTotalFrames: 1060, outputDuration: 12_000 };
    // Act
    const h = obsHealthFrom(a, b);
    // Assert
    expect(h.congestion).toBe(0.3);
    expect(h.droppedPercent).toBeCloseTo(10, 5);
    expect(h.kbps).toBe(6000);
  });

  it('authenticates against a fake obs-websocket and polls GetStreamStatus', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const auth = { salt: crypto.randomBytes(16).toString('base64'), challenge: crypto.randomBytes(16).toString('base64') };
    const obs = await fakeObs();
    const c = obsClient(obs.url, 'pw');
    const server = await obs.client;
    // Act
    const identify = await handshake(server, auth);
    await answerPoll(server, streamStatus(60));
    vi.advanceTimersByTime(POLL_MS);
    await answerPoll(server, streamStatus(120));
    await roundTrip(server);
    // Assert
    expect(identify.d.authentication).toBe(obsAuth('pw', auth.salt, auth.challenge));
    expect(c.connected).toBe(true);
    expect(c.health).toEqual({ congestion: 0.5, reconnecting: false, active: true, droppedPercent: 5, kbps: 6000 });
  });

  it.each(['ws://127.0.0.1.evil.example:4455', 'ws://localhost.evil.example:4455', 'wss://example.com:4455', 'ws://10.0.0.2:4455', 'ws://192.168.1.2:4455', 'http://127.0.0.1:4455', 'ws+unix:/tmp/obs.sock'])('refuses %s (only a loopback obs-websocket)', (url) => {
    // Act
    const make = () => new ObsWebsocketClient(url, 'pw', silentLog);
    // Assert
    expect(make).toThrow();
  });

  it.each(['ws://127.0.0.1:4455', 'ws://localhost:4455', 'ws://[::1]:4455'])('accepts %s', (url) => {
    // Act
    const make = () => new ObsWebsocketClient(url, 'pw', silentLog);
    // Assert
    expect(make).not.toThrow();
  });

  /** Text that is not an obs-websocket message this client handles. */
  const NOT_MESSAGES = ['null', '42', '"x"', '[]', '{"op":0}', '{"op":0,"d":null}', '{"op":0,"d":{"authentication":{"salt":1,"challenge":null}}}', '{"op":2}', '{"op":7}', '{"op":7,"d":null}', 'not json'];
  /** A RequestResponse that carries no stream numbers. */
  const NO_NUMBERS = '{"op":7,"d":{"requestStatus":{"result":true}}}';
  /** What whatever listens on the port may send instead of OBS's messages. */
  const MALFORMED = [...NOT_MESSAGES, NO_NUMBERS];

  it.each(NOT_MESSAGES)('does not take %s for a message', (raw) => {
    // Act
    const msg = parseObsMessage(raw);
    // Assert
    expect(msg).toBeNull();
  });

  it('finds no stream status in a RequestResponse without stream numbers', () => {
    // Arrange
    const msg = parseObsMessage(NO_NUMBERS);
    // Act
    const status = msg?.op === 7 ? parseStreamStatus(msg.d.responseData) : 'not a RequestResponse';
    // Assert
    expect(status).toBeNull();
  });

  it('survives malformed messages from whatever listens on the port (no crash, no answer, no health)', async () => {
    // Arrange
    const thrown: unknown[] = [];
    const onUncaught = (err: unknown): void => void thrown.push(err);
    process.on('uncaughtException', onUncaught);
    onTestFinished(() => void process.off('uncaughtException', onUncaught));
    const obs = await fakeObs();
    const c = obsClient(obs.url, 'pw');
    const server = await obs.client;
    const sent = sentBy(server);
    // Act
    for (const m of MALFORMED) server.send(m);
    await roundTrip(server);
    // Assert
    expect(thrown).toEqual([]);
    expect(sent).toEqual([]);
    expect(c.health).toBeUndefined();
    expect(c.connected).toBe(false);
  });

  it('still logs in to a real Hello after malformed messages', async () => {
    // Arrange
    const obs = await fakeObs();
    const c = obsClient(obs.url, undefined);
    const server = await obs.client;
    for (const m of MALFORMED) server.send(m);
    // Act
    const identify = await handshake(server);
    await roundTrip(server);
    // Assert
    expect(identify.op).toBe(1);
    expect(c.connected).toBe(true);
  });

  /** A GetStreamStatus answer with sane numbers. */
  const SANE = streamStatus(60);

  it.each([
    ['congestion as markup', { outputCongestion: '<b>9</b>' }],
    ['congestion above 1', { outputCongestion: 1.5 }],
    ['negative dropped frames', { outputSkippedFrames: -5 }],
    ['a frame count that is not a number', { outputTotalFrames: 'x' }],
    ['an infinite byte count', { outputBytes: Number.POSITIVE_INFINITY }],
    ['a duration that is not a number', { outputDuration: Number.NaN }],
    ['no byte count', { outputBytes: null }],
  ])('ignores stream numbers that are not finite, non-negative numbers: %s', (_what, bad) => {
    // Act
    const status = parseStreamStatus({ ...SANE, ...bad });
    // Assert
    expect(status).toBeNull();
  });

  it('takes sane stream numbers, and a missing congestion as 0', () => {
    // Act
    const status = parseStreamStatus({ ...SANE, outputCongestion: null });
    // Assert
    expect(status).toMatchObject({ outputCongestion: 0, outputTotalFrames: 60 });
  });

  it('a GetStreamStatus answer with broken numbers gives no health', async () => {
    // Arrange
    const obs = await fakeObs();
    const c = obsClient(obs.url, undefined);
    const server = await obs.client;
    await handshake(server);
    // Act
    await answerPoll(server, { outputActive: true, outputReconnecting: false, outputCongestion: '<b>9</b>', outputBytes: 1e308, outputSkippedFrames: -5, outputTotalFrames: 'x', outputDuration: 1 });
    await roundTrip(server);
    // Assert
    expect(c.connected).toBe(true);
    expect(c.health).toBeUndefined();
  });

  it('a repeated Identified message does not start a second poll timer', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const obs = await fakeObs();
    obsClient(obs.url, undefined);
    const server = await obs.client;
    const sent = sentBy(server);
    await handshake(server);
    for (let i = 0; i < 19; i++) server.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    await roundTrip(server);
    // Act
    vi.advanceTimersByTime(5 * POLL_MS);
    await roundTrip(server);
    // Assert
    expect(sent.filter((m) => m.op === 6)).toHaveLength(1 + 5);
  });
});

describe('QualityManager wiring', () => {
  /** One controller step every 2 s (the manager's default). */
  const TICK_MS = 2000;
  const BASE_RTT_MS = 30;
  const SPIKE_RTT_MS = 400;

  /** A manager with a 50 Mbps limit, a 40 Mbps speed test, her stream to another platform on, and `rtt()` as the RTT probe. Stopped when the test finishes. */
  function manager(mode: 'auto' | 'manual', rtt: () => number) {
    const config = defaultConfig();
    config.uploadLimitMbps = 50;
    config.quality.upload.mode = mode;
    config.alsoStreamingElsewhere = true;
    const limiter = new BandwidthLimiter(1_000_000);
    const q = new QualityManager({
      config,
      saveConfig: () => {},
      origin: new HlsOrigin('http://127.0.0.1:9/', silentLog),
      limiter,
      tracker: new TrackerService(new AccessControl(), silentLog),
      log: silentLog,
      reaper: null,
      binDir: '/nonexistent',
      dataDir: '/nonexistent',
      runDir: '/nonexistent',
      rtmpReadUrl: 'rtmp://127.0.0.1:9/live/k',
      mediamtxHlsUrl: 'http://127.0.0.1:9/live/k/',
      streamKey: 'sc_testtesttest',
      speedTest: () => ({ at: 0, downloadMbps: 100, uploadMbps: 40, latencyMs: 10, source: 'test' }),
      warn: () => {},
      rttProbe: async () => rtt(),
    });
    onTestFinished(() => q.onLiveStop());
    return { q, limiter };
  }

  it('manual mode enforces her limit', () => {
    // Arrange
    const { q, limiter } = manager('manual', () => BASE_RTT_MS);
    // Act
    q.onLiveStart();
    // Assert
    expect(limiter.mbps).toBe(50);
  });

  it('auto mode starts at 60 % of the ceiling', () => {
    // Arrange
    const { q, limiter } = manager('auto', () => BASE_RTT_MS);
    // Act
    q.onLiveStart();
    // Assert
    expect(q.state().upload.ceilingMbps).toBe(26.5);
    expect(limiter.mbps).toBeCloseTo(15.9, 1);
  });

  it('auto mode ignores latency spikes while idle: the spike is measured, the cap is not cut', async () => {
    // Arrange
    vi.useFakeTimers();
    let rttMs = BASE_RTT_MS;
    const { q, limiter } = manager('auto', () => rttMs);
    q.onLiveStart();
    await vi.advanceTimersByTimeAsync(4 * TICK_MS);
    // Act
    rttMs = SPIKE_RTT_MS;
    await vi.advanceTimersByTimeAsync(3 * TICK_MS);
    // Assert
    const st = q.state().upload;
    expect(st.signals.queueDelayMs).toBe(SPIKE_RTT_MS - BASE_RTT_MS);
    expect(st.lastBackoff).toBeUndefined();
    expect(limiter.mbps).toBeCloseTo(15.9, 1);
  });
});
