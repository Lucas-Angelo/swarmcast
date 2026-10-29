import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { defaultConfig } from '../../src/core/config.js';
import { AccessControl } from '../../src/access/access.js';
import { HlsOrigin } from '../../src/hls/origin.js';
import { BandwidthLimiter } from '../../src/hls/throttle.js';
import { QualityManager } from '../../src/quality/manager.js';
import { ObsWebsocketClient, obsAuth, obsHealthFrom, type ObsStreamStatus } from '../../src/quality/signals.js';
import { TrackerService, variantInfoHashHex } from '../../src/tracker/tracker.js';
import { silentLog } from './helpers.js';

describe('obs-websocket', () => {
  let wss: WebSocketServer | null = null;
  afterEach(() => {
    wss?.close();
    wss = null;
  });

  it('computes the v5 authentication string (protocol.md example)', () => {
    expect(obsAuth('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=')).toBe(
      '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
    );
  });

  it('turns two GetStreamStatus samples into congestion, drop % and bitrate', () => {
    const a: ObsStreamStatus = { outputActive: true, outputReconnecting: false, outputCongestion: 0.02, outputBytes: 1_000_000, outputSkippedFrames: 10, outputTotalFrames: 1000, outputDuration: 10_000 };
    const b: ObsStreamStatus = { ...a, outputCongestion: 0.3, outputBytes: 2_500_000, outputSkippedFrames: 16, outputTotalFrames: 1060, outputDuration: 12_000 };
    const h = obsHealthFrom(a, b);
    expect(h.congestion).toBe(0.3);
    expect(h.droppedPercent).toBeCloseTo(10, 5);
    expect(h.kbps).toBe(6000);
  });

  it('authenticates against a fake obs-websocket and polls GetStreamStatus', async () => {
    const salt = crypto.randomBytes(16).toString('base64');
    const challenge = crypto.randomBytes(16).toString('base64');
    let frames = 0;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'obswebsocket.json' });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.0', rpcVersion: 1, authentication: { salt, challenge } } }));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { op: number; d: { authentication?: string; requestId?: string; requestType?: string } };
        if (m.op === 1) {
          if (m.d.authentication !== obsAuth('pw', salt, challenge)) return ws.close(4009);
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        } else if (m.op === 6 && m.d.requestType === 'GetStreamStatus') {
          frames += 60;
          ws.send(
            JSON.stringify({
              op: 7,
              d: {
                requestType: 'GetStreamStatus',
                requestId: m.d.requestId,
                requestStatus: { result: true, code: 100 },
                responseData: { outputActive: true, outputReconnecting: false, outputCongestion: 0.5, outputBytes: frames * 25_000, outputSkippedFrames: frames / 20, outputTotalFrames: frames, outputDuration: (frames / 30) * 1000, outputTimecode: '' },
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    const c = new ObsWebsocketClient(`ws://127.0.0.1:${port}`, 'pw', silentLog, 50);
    c.start();
    await expect.poll(() => c.health?.droppedPercent, { timeout: 5000 }).toBeCloseTo(5, 5);
    expect(c.connected).toBe(true);
    expect(c.health?.congestion).toBe(0.5);
    expect(c.health?.kbps).toBe(6000);
    c.stop();
    expect(() => new ObsWebsocketClient('ws://192.168.1.2:4455', undefined, silentLog)).toThrow();
  });

  it('only accepts a loopback obs-websocket URL', () => {
    for (const url of ['ws://127.0.0.1.evil.example:4455', 'ws://localhost.evil.example:4455', 'wss://example.com:4455', 'ws://10.0.0.2:4455', 'http://127.0.0.1:4455', 'ws+unix:/tmp/obs.sock']) {
      expect(() => new ObsWebsocketClient(url, 'pw', silentLog), url).toThrow();
    }
    for (const url of ['ws://127.0.0.1:4455', 'ws://localhost:4455', 'ws://[::1]:4455']) expect(() => new ObsWebsocketClient(url, 'pw', silentLog), url).not.toThrow();
  });

  /** A process on the obs-websocket port that is not (a well-behaved) OBS. */
  async function fakeObs(onConnection: (ws: import('ws').WebSocket) => void): Promise<string> {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'obswebsocket.json' });
    wss.on('connection', onConnection);
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    return `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  }

  it('survives malformed messages from whatever listens on the port (no crash, no health)', async () => {
    const bad = ['null', '42', '"x"', '[]', '{"op":0}', '{"op":0,"d":null}', '{"op":0,"d":{"authentication":{"salt":1,"challenge":null}}}', '{"op":2}', '{"op":7}', '{"op":7,"d":null}', '{"op":7,"d":{"requestStatus":{"result":true}}}'];
    let gotIdentify = false;
    const url = await fakeObs((ws) => {
      for (const m of bad) ws.send(m);
      ws.on('message', () => (gotIdentify = true));
      setTimeout(() => ws.close(), 300);
    });
    const thrown: unknown[] = [];
    const onUncaught = (err: unknown): void => void thrown.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const c = new ObsWebsocketClient(url, 'pw', silentLog, 50);
      c.start();
      await new Promise((r) => setTimeout(r, 500));
      c.stop();
      expect(thrown).toEqual([]);
      expect(gotIdentify).toBe(false);
      expect(c.health).toBeUndefined();
      expect(c.connected).toBe(false);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('ignores stream numbers that are not finite, non-negative numbers', async () => {
    const url = await fakeObs((ws) => {
      ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { op: number; d: { requestId?: string } };
        if (m.op === 1) ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        else if (m.op === 6) {
          const responseData = { outputActive: true, outputReconnecting: false, outputCongestion: '<b>9</b>', outputBytes: 1e308, outputSkippedFrames: -5, outputTotalFrames: 'x', outputDuration: 1 };
          ws.send(JSON.stringify({ op: 7, d: { requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
        }
      });
    });
    const c = new ObsWebsocketClient(url, undefined, silentLog, 30);
    c.start();
    await expect.poll(() => c.connected, { timeout: 5000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.health).toBeUndefined();
    c.stop();
  });

  it('a repeated Identified message does not start a second poll timer', async () => {
    let polls = 0;
    const url = await fakeObs((ws) => {
      ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { op: number };
        if (m.op === 1) for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        else if (m.op === 6) polls++;
      });
    });
    const c = new ObsWebsocketClient(url, undefined, silentLog, 100);
    c.start();
    await expect.poll(() => c.connected, { timeout: 5000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    c.stop();
    // One poll on Identified plus about one per 100 ms: never 20 timers' worth.
    expect(polls).toBeLessThanOrEqual(7);
  });
});

describe('QualityManager wiring', () => {
  function make(mode: 'auto' | 'manual', rtt: () => number) {
    const config = defaultConfig();
    config.uploadLimitMbps = 50;
    config.quality.upload.mode = mode;
    config.alsoStreamingElsewhere = true;
    let t = 0;
    const limiter = new BandwidthLimiter(1_000_000, () => t);
    const tracker = new TrackerService(new AccessControl(), silentLog);
    const origin = new HlsOrigin('http://127.0.0.1:9/', silentLog);
    const q = new QualityManager({
      config,
      saveConfig: () => {},
      origin,
      limiter,
      tracker,
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
      now: () => t,
      rttProbe: async () => rtt(),
      tickMs: 1_000_000,
    });
    return { q, limiter, tracker, advance: (ms: number) => (t += ms) };
  }

  it('manual mode enforces her limit; auto mode starts at 60 % of the ceiling and ignores latency spikes while idle', async () => {
    const manual = make('manual', () => 30);
    manual.q.onLiveStart();
    expect(manual.limiter.mbps).toBe(50);
    await manual.q.onLiveStop();

    let rttMs = 30;
    const auto = make('auto', () => rttMs);
    auto.q.onLiveStart();
    // Ceiling: 40 × 0.85 − 6 × 1.25 (assumed 6 Mbps other stream) = 26.5 → start at 15.9.
    expect(auto.q.state().upload.ceilingMbps).toBe(26.5);
    expect(auto.limiter.mbps).toBeCloseTo(15.9, 1);
    for (let i = 0; i < 4; i++) {
      auto.advance(2000);
      await auto.q.tick();
      await new Promise((r) => setTimeout(r, 5));
    }
    rttMs = 400;
    for (let i = 0; i < 3; i++) {
      auto.advance(2000);
      await auto.q.tick();
      await new Promise((r) => setTimeout(r, 5));
    }
    // Nothing is being sent, so the RTT spike is not ours: no false "upload too low".
    const st = auto.q.state().upload;
    expect(st.lastBackoff).toBeUndefined();
    expect(auto.limiter.mbps).toBeCloseTo(15.9, 1);
    await auto.q.onLiveStop();
  });

  it('allowlists one swarm per height for the served variants', () => {
    const { tracker } = make('manual', () => 30);
    tracker.setSwarm('live1');
    tracker.setVariants([1080, 720, 480]);
    const allowed = new Set(tracker.allowedInfoHashes());
    for (const h of [0, 480, 720, 1080]) expect(allowed.has(variantInfoHashHex('live1', h))).toBe(true);
    expect(allowed.has(variantInfoHashHex('live1', 360))).toBe(false);
    expect(allowed.size).toBe(2 + 4);
  });
});
