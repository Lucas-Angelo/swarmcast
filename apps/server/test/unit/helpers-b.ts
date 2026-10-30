// Shared fixtures of the server unit tests (part B): test doubles, object mothers and resources
// that clean up after themselves. Every resource made here is closed or deleted when the test that
// made it finishes (Vitest's onTestFinished, newest first), so a helper must be called from a test
// body, never from a beforeEach hook.
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import pino from 'pino';
import { onTestFinished } from 'vitest';
import WebSocket from 'ws';
import { defaultQualitySettings, type QualitySettings, type Rung, type SourceInfo, type TranscoderStatus } from '@swarmcast/shared';
import type { AccessControl, Session } from '../../src/access/access.js';
import type { ControlChannel } from '../../src/control/control.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { UpnpGateway, parseDeviceDescription } from '../../src/direct/upnp.js';
import { Transcoder, type TranscoderOptions } from '../../src/quality/transcoder.js';
import type { TrackerService } from '../../src/tracker/tracker.js';
import { silentLog } from './helpers.js';
import { MockIgd } from './mock-igd.js';

// ---- files ----

/** A new, empty folder in the system temp folder, deleted when the test finishes. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- logs ----

/** One line of a captured log, parsed (pino writes JSON). */
export type LogLine = Record<string, unknown> & { level: number; msg: string };

/** A logger at debug level that keeps what it writes: `lines()` gives every line so far, parsed. */
export function captureLog(): { log: pino.Logger; lines: () => LogLine[] } {
  const out: string[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => void out.push(line) });
  return { log, lines: () => out.map((l) => JSON.parse(l) as LogLine) };
}

// ---- the live controller's collaborators ----

/**
 * Direct mode as a LiveController in a logic test sees it: off, no router, no HTTPS server.
 * `enable` and `disable` replace what switching it on and off does (tests of the reactions).
 */
export function directOff(over: Partial<Pick<DirectMode, 'enable' | 'disable'>> = {}): DirectMode {
  return { noteViewer: () => {}, snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null, ...over } as unknown as DirectMode;
}

/** What clientIp() reads of a request: the address of the socket it came on, and its headers. */
export function requestFrom(remoteAddress: string, headers: Record<string, string> = {}): { socket: { remoteAddress: string }; headers: Record<string, string> } {
  return { socket: { remoteAddress }, headers };
}

/** A viewer who joined from a desktop browser of its own (`device-<nickname>`), from a documentation address. */
export function joinViewer(access: AccessControl, nickname: string, over: Partial<Pick<Session, 'device' | 'deviceId' | 'ip'>> = {}): Session {
  return access.createSession({ nickname, deviceId: `device-${nickname}`, device: 'desktop', ip: '198.51.100.20', ...over });
}

// ---- Direct mode's router ----

/** A mock UPnP router (MockIgd) on 127.0.0.1 with public address `externalIp`, stopped when the test finishes. */
export async function mockRouter(externalIp = '203.0.113.7'): Promise<MockIgd> {
  const igd = new MockIgd(externalIp);
  await igd.start();
  onTestFinished(() => igd.stop());
  return igd;
}

/**
 * The mock router as Direct mode finds it, from its description URL. SSDP discovery collects
 * answers for a whole window (every time); only a test of discovery itself needs that.
 */
export async function gatewayOf(igd: MockIgd): Promise<UpnpGateway | null> {
  const location = `http://127.0.0.1:${igd.httpPort}/desc.xml`;
  const service = parseDeviceDescription(await (await fetch(location)).text(), location);
  return service ? new UpnpGateway(service, location) : null;
}

// ---- ports ----

/**
 * A port on 127.0.0.1 that accepts every connection and drops it at once, so a probe of it fails
 * right away on every OS (a refused loopback connection takes about 2 s on Windows, which retries
 * the SYN). Closed when the test finishes.
 */
export async function droppingPort(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

// ---- WebSockets ----

/** Where upgrades go: /control and /tracker, the two WebSocket paths of the public server. */
export interface UpgradeRoutes {
  control?: Pick<ControlChannel, 'handleUpgrade'>;
  tracker?: Pick<TrackerService, 'handleUpgrade'>;
}

/**
 * An HTTP server on 127.0.0.1 (port 0: the OS picks a free one at listen time) that hands /control
 * and /tracker upgrades to `routes` with the session named by `?sid=`. The public server finds the
 * session from its cookie instead; here the session is simply trusted, an unknown one gets its
 * socket destroyed. Resolves with the server's ws:// base URL; the server and every socket on it
 * are closed when the test finishes.
 */
export async function upgradeServer(access: AccessControl, routes: UpgradeRoutes): Promise<string> {
  const server = http.createServer();
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://test');
    const session = access.sessions.get(url.searchParams.get('sid') ?? '');
    const route = url.pathname === '/control' ? routes.control : url.pathname === '/tracker' ? routes.tracker : undefined;
    if (!session || !route) return socket.destroy();
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    route.handleUpgrade(req, socket, head, session);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    for (const s of upgraded) s.destroy();
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A client socket (the `ws` package, which can ping) and every text frame it received so far. */
export interface TestSocket {
  ws: WebSocket;
  frames: string[];
  /** The close code, once the socket closed. */
  closed: Promise<number>;
}

/**
 * Opens a client WebSocket and resolves once it is open; it is terminated when the test finishes.
 * Frames are collected from the start: the server may send its first one together with the
 * handshake answer.
 */
export async function openSocket(url: string): Promise<TestSocket> {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  ws.on('message', (data) => frames.push(String(data)));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  onTestFinished(() => ws.terminate());
  await once(ws, 'open');
  return { ws, frames, closed };
}

/** A viewer's /control socket, resolved once the server's hello (always its first frame) is in. */
export async function controlSocket(url: string, session: Session): Promise<TestSocket> {
  const s = await openSocket(`${url}/control?sid=${session.id}`);
  if (s.frames.length === 0) await once(s.ws, 'message');
  return s;
}

/** A plain WebTorrent tracker socket on /tracker for `session`. */
export function trackerSocket(url: string, session: Session): Promise<TestSocket> {
  return openSocket(`${url}/tracker?sid=${session.id}`);
}

/**
 * Resolves once both ends are in step. A WebSocket handles frames in the order they arrive and
 * answers a ping only after the frames ahead of it, so when the pong is here the peer has handled
 * every frame this socket sent before the ping, and every frame the peer sent before the ping
 * reached it has been received (and its 'message' listeners have run) here.
 */
export async function roundTrip(ws: WebSocket): Promise<void> {
  const pong = once(ws, 'pong');
  ws.ping();
  await pong;
}

/** The next text frame `ws` receives, parsed as JSON. */
export async function nextJson<T = Record<string, unknown>>(ws: WebSocket): Promise<T> {
  const [data] = (await once(ws, 'message')) as [WebSocket.RawData];
  return JSON.parse(String(data)) as T;
}

// ---- WebTorrent tracker ----

/** A p2p-media-loader peer id: 20 ASCII characters. */
export const peerAscii = (n: number): string => `-PM0400-${String(n).padStart(12, '0')}`;

/** The same peer id as bittorrent-tracker reports it (and as sessions record it): hex. */
export const peerHex = (n: number): string => Buffer.from(peerAscii(n), 'latin1').toString('hex');

/** An announce of `peer` on the swarm `infoHashHex`, as p2p-media-loader sends it (binary info_hash). */
export function announceFrame(infoHashHex: string, peer: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ action: 'announce', info_hash: Buffer.from(infoHashHex, 'hex').toString('latin1'), peer_id: peerAscii(peer), numwant: 0, offers: [], event: 'started', ...extra });
}

// ---- HLS ----

/**
 * A live media playlist as MediaMTX and the ffmpeg ladder write it: `count` fMP4 segments of
 * `segmentS` seconds named `<run>_<n>.m4s` from `from` on, after the init segment `<run>_init.mp4`.
 * `sequence` is the media sequence number (default `from`: it restarts at 0 with a new run).
 */
export function mediaPlaylist(run: string, from: number, count: number, o: { segmentS?: number; sequence?: number; targetDurationS?: number } = {}): string {
  const segmentS = o.segmentS ?? 2;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${o.targetDurationS ?? Math.ceil(segmentS)}`,
    `#EXT-X-MEDIA-SEQUENCE:${o.sequence ?? from}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${run}_init.mp4"`,
  ];
  for (let i = from; i < from + count; i++) lines.push(`#EXTINF:${segmentS.toFixed(6)},`, `${run}_${i}.m4s`);
  return lines.join('\n');
}

// ---- quality ----

/** What OBS usually sends: 1080p30 at 6 Mbps, with audio. */
export const SOURCE_1080P: SourceInfo = { width: 1920, height: 1080, fps: 30, kbps: 6000, hasAudio: true };

/** The quality settings of a new install, changed by `patch`. */
export function qualitySettings(patch: (s: QualitySettings) => void = () => {}): QualitySettings {
  const s = defaultQualitySettings();
  patch(s);
  return s;
}

// ---- the ffmpeg ladder ----

/** The ladder the Transcoder tests run: the copied 1080p source and one encoded 480p rendition. */
export const LADDER_RUNGS: Rung[] = [
  { name: 'v1080', height: 1080, width: 1920, fps: 30, kbps: 6000, source: true },
  { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1500, source: false },
];

/** A stand-in for ffmpeg that ignores its arguments and runs until killed (a POSIX shell script). */
export function sleepingFfmpeg(): string {
  const bin = path.join(tempDir('sc-fake-ffmpeg-'), 'ffmpeg');
  fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  return bin;
}

/** A Transcoder with a work folder of its own, stopped when the test finishes (before the folder goes). */
export function transcoderWith(ffmpeg: string, o: Partial<TranscoderOptions> = {}): Transcoder {
  const t = new Transcoder({ ffmpeg, inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir: tempDir('sc-ladder-'), reaper: null, log: silentLog, ...o });
  onTestFinished(() => t.stop());
  return t;
}

/** Resolves the next time `t` reports `status`. */
export function statusReached(t: Transcoder, status: TranscoderStatus): Promise<void> {
  return new Promise((resolve) => {
    const onStatus = (s: TranscoderStatus): void => {
      if (s !== status) return;
      t.off('status', onStatus);
      resolve();
    };
    t.on('status', onStatus);
  });
}
