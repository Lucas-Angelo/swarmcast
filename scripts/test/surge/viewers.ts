// Protocol-level viewers for the surge bench, in their own process so their work never counts as
// server CPU (bench.ts forks several of these). Each one joins like the browser (link → ticket
// cookie → join page and its assets → browser check → /api/join → watch page → /api/config →
// signed manifest → /control) behind its own address (CF-Connecting-IP from 198.18.0.0/15), then
// plays the live like hls.js does with the Stable profile (apps/viewer/src/player-config.ts):
//
// - start 20 s behind the live edge (liveSyncDuration), one fragment at a time, buffer ahead up to
//   30 s (maxBufferLength) or the live edge; the live playlist reloaded every target duration;
// - ABR: two EWMAs of the measured throughput (half-lives 4 and 12 s of media, the lower one
//   wins, first estimate 2 Mbps), keep a level while estimate × 0.8 ≥ its bitrate, switch up only
//   when estimate × 0.6 ≥ the higher one (abrBandWidthFactor / abrBandWidthUpFactor);
// - playback: the playhead moves at 1× after the first fragment; reaching the end of the buffer is
//   a stall (until the next fragment arrives); more than 36 s behind live jumps back to 20 s
//   (liveMaxLatencyDuration);
// - retries like RETRY_POLICY: 429 / 5xx / network errors back off 1, 2, 4, 8 s (8 tries);
// - "P2P on": a tracker channel inside /control (packages/shared/src/mux.ts), announces with 5
//   offers per swarm as p2p-media-loader does, answers every offer it gets. No media flows over
//   P2P here (no WebRTC in Node): this measures what P2P signalling costs the server.
//
//   parent → { type: 'init', base, link }
//   parent → { type: 'join', viewers: [{ id, cohort }], spreadMs }
//   parent → { type: 'p2p', ids, spreadMs }
//   parent → { type: 'report' }   answer { type: 'report', viewers }
//   parent → { type: 'stop' }     close everything, answer { type: 'stopped' }
import crypto from 'node:crypto';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { computeInfoHash } from 'p2p-media-loader-core/server';
import WebSocket from 'ws';
import { variantStreamSwarmId } from '@swarmcast/shared';
import { CookieJar } from '../lib/cookie-jar.mjs';

export interface LoadRecord {
  /** When the request started (Date.now()). */
  at: number;
  /** Until the whole body arrived (or the request failed), ms. */
  ms: number;
  /** Until the response headers arrived, ms. */
  ttfbMs: number;
  kind: 'segment' | 'playlist' | 'init' | 'manifest';
  status: number;
  bytes: number;
  height: number;
}

export interface ViewerReport {
  id: number;
  cohort: string;
  /** Join started (Date.now()). */
  joinAt: number;
  /** Each step of the join flow, ms. */
  steps: Record<string, number>;
  joined: boolean;
  joinError?: string;
  /** First fragment buffered (Date.now()), when it happened. */
  firstFrameAt?: number;
  /** Stalls after the first frame: [start, end] (Date.now(); end undefined while it lasts). */
  stalls: Array<[number, number | undefined]>;
  /** Jumps back to the live edge (liveMaxLatencyDuration) and fragments that left the window. */
  jumps: number;
  loads: LoadRecord[];
  /** Bytes of the pages and their assets (not through the server's upload limiter). */
  assetBytes: number;
  /** Seconds played per rendition height. */
  levelSeconds: Record<string, number>;
  /** P2P signalling: when it was turned on, its first tracker answer, offers in and answers out. */
  p2p?: { onAt: number; firstAnswerAt?: number; refused: boolean; offersIn: number; answersOut: number; announces: number; maxFramesPer10s: number };
  /** Close code of /control when the server closed it. */
  controlClosed?: number;
  controlReconnects: number;
  /** Segment downloads aborted after 3 s without a byte (p2p-media-loader), then tried again. */
  aborts: number;
}

interface Variant {
  height: number;
  bps: number;
  uri: string;
}

const LIVE_SYNC_S = 20;
const LIVE_MAX_S = 36;
const MAX_BUFFER_S = 30;
const SEG_S = 2;
const BW_FACTOR = 0.8;
const BW_UP_FACTOR = 0.6;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];
const NO_BYTES_ABORT_MS = 3000;

let base = '';
let link = '';
const viewers = new Map<number, SimViewer>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseVariants(text: string): Variant[] {
  const out: Variant[] = [];
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
    const bps = Number(/BANDWIDTH=(\d+)/.exec(l)?.[1] ?? 0);
    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(l)?.[1] ?? 0);
    const uri = lines[i + 1] ?? '';
    if (uri && !uri.startsWith('#')) out.push({ height, bps, uri });
  }
  return out.sort((a, b) => a.bps - b.bps);
}

interface MediaList {
  first: number;
  uris: string[];
  init?: string;
}

function parseMedia(text: string): MediaList {
  const seq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0);
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
  const uris = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return { first: seq, uris, ...(init ? { init } : {}) };
}

/** hls.js' EwmaBandWidthEstimator: each sample weighs its media duration; half-life in seconds. */
class Ewma {
  private estimate = 0;
  private total = 0;
  constructor(private readonly halfLife: number) {}
  sample(weight: number, value: number): void {
    const a = Math.pow(Math.exp(Math.log(0.5) / this.halfLife), weight);
    this.estimate = value * (1 - a) + a * this.estimate;
    this.total += weight;
  }
  get value(): number {
    const zero = 1 - Math.pow(Math.exp(Math.log(0.5) / this.halfLife), this.total);
    return zero > 0 ? this.estimate / zero : this.estimate;
  }
  get samples(): number {
    return this.total;
  }
}

class SimViewer {
  readonly r: ViewerReport;
  private readonly jar: CookieJar;
  private readonly ip: string;
  private running = true;
  private control: WebSocket | null = null;
  private variants: Variant[] = [];
  private level = 0;
  private lists = new Map<number, MediaList & { at: number }>();
  private inits = new Set<number>();
  private nextSeq = -1;
  /** Media time (seq × 2 s). */
  private playhead = 0;
  private bufferedEnd = 0;
  private stalled = false;
  private fast = new Ewma(4);
  private slow = new Ewma(12);
  private swarmId = '';
  private peerId = crypto.randomBytes(10).toString('hex');
  private framesSent: number[] = [];
  private p2pOn = false;
  private announced = new Set<number>();

  constructor(
    readonly id: number,
    cohort: string,
  ) {
    this.ip = `198.18.${(id >> 8) & 255}.${id & 255}`;
    this.jar = new CookieJar(base, { headers: { 'cf-connecting-ip': this.ip } });
    this.r = { id, cohort, joinAt: 0, steps: {}, joined: false, stalls: [], jumps: 0, loads: [], assetBytes: 0, levelSeconds: {}, controlReconnects: 0, aborts: 0 };
  }

  private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      this.r.steps[name] = Math.round(performance.now() - t);
    }
  }

  /**
   * A GET with the player's retry policy: 429, 5xx and network errors back off; 4xx is final.
   * Segments go through p2p-media-loader's HTTP loader, which aborts a download that receives no
   * bytes for 3 s (httpNotReceivingBytesTimeoutMs, from the request's start) and tries again at
   * once (httpErrorRetries 3); `aborts` counts those.
   */
  private async get(path: string, kind: LoadRecord['kind'], height = 0, need?: () => number): Promise<{ status: number; body: Buffer }> {
    let quick = 0;
    for (let attempt = 0; ; attempt++) {
      const at = Date.now();
      const t = performance.now();
      let status = 0;
      let ttfb = 0;
      let body = Buffer.alloc(0);
      const ac = new AbortController();
      let watchdog: NodeJS.Timeout | undefined;
      const arm = (): void => {
        if (kind !== 'segment') return;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ac.abort(), NO_BYTES_ABORT_MS);
      };
      try {
        arm();
        // The watch page says how soon it needs a segment (X-SC-Need, apps/viewer/src/need-header.ts).
        const res = await this.jar.fetch(path, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(20_000)]), ...(need ? { headers: { 'x-sc-need': need().toFixed(1) } } : {}) });
        status = res.status;
        ttfb = performance.now() - t;
        const parts: Buffer[] = [];
        if (res.body) {
          for await (const chunk of res.body) {
            parts.push(Buffer.from(chunk as Uint8Array));
            arm();
          }
        }
        body = Buffer.concat(parts);
      } catch {
        status = ac.signal.aborted ? -1 : 0;
      } finally {
        clearTimeout(watchdog);
      }
      this.r.loads.push({ at, ms: Math.round(performance.now() - t), ttfbMs: Math.round(ttfb), kind, status, bytes: body.length, height });
      if (status >= 200 && status < 400) return { status, body };
      if (status === -1) this.r.aborts += 1;
      if (!this.running || (status >= 400 && status < 500 && status !== 429)) return { status, body };
      if (status === -1 && quick < 3) {
        quick += 1;
        continue;
      }
      if (attempt >= RETRY_DELAYS_MS.length) return { status, body };
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }

  /** Assets a page loads from our origin (scripts, styles, the font): fetched once, as a fresh browser does. */
  private seenAssets = new Set<string>();
  private async page(path: string): Promise<number> {
    const res = await this.jar.fetch(path);
    const html = await res.text();
    this.r.assetBytes += html.length;
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!).filter((a) => !this.seenAssets.has(a));
    await Promise.all(
      assets.map(async (a) => {
        this.seenAssets.add(a);
        const r = await this.jar.fetch(a);
        this.r.assetBytes += (await r.arrayBuffer()).byteLength;
      }),
    );
    return res.status;
  }

  async join(): Promise<void> {
    this.r.joinAt = Date.now();
    try {
      const s1 = await this.step('link', async () => (await this.jar.fetch(link)).status);
      if (s1 !== 303) throw new Error(`link ${s1}`);
      await this.step('joinPage', () => this.page('/join'));
      const ch = await this.step('challenge', async () => (await (await this.jar.fetch('/api/join/challenge')).json()) as { required: boolean; challenge?: Challenge });
      const pow = ch.required ? await this.step('solve', async () => ({ challenge: ch.challenge!, solution: await solveChallenge({ challenge: ch.challenge!, deriveKey }) })) : undefined;
      const nickname = `v${this.id}`;
      const res = await this.step('join', async () => {
        const r = await this.jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname, pow } : { nickname }) });
        await r.arrayBuffer();
        return r.status;
      });
      if (res !== 200) throw new Error(`join ${res}`);
      await this.step('watchPage', () => this.page('/watch'));
      const cfg = await this.step('config', async () => (await (await this.jar.fetch('/api/config')).json()) as { swarmId: string });
      this.swarmId = cfg.swarmId;
      await this.step('manifest', () => this.get('/hls/manifest.json', 'manifest'));
      this.r.joined = true;
      // The watch page loads the player and opens /control at the same time.
      void this.openControl();
      await this.play();
    } catch (err) {
      this.r.joinError = (err as Error).message;
    }
  }

  private openControl(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: this.jar.header(), 'cf-connecting-ip': this.ip } });
      this.control = ws;
      ws.on('open', () => {
        if (this.p2pOn) this.openTracker();
        resolve();
      });
      ws.on('message', (d) => this.onControl(String(d)));
      ws.on('error', () => {});
      ws.on('close', (code) => {
        if (!this.running) return;
        if (code !== 1000 && code !== 1005) this.r.controlClosed = code;
        this.control = null;
        this.announced.clear();
        // The watch page reconnects with back-off (1, 2, 4… s).
        this.r.controlReconnects += 1;
        setTimeout(() => void this.openControl(), Math.min(15_000, 1000 * 2 ** Math.min(this.r.controlReconnects, 4)));
        resolve();
      });
      setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'stats', p2pEnabled: this.p2pOn, httpBytes: 0, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0, http429: 0, device: 'desktop' }));
      }, 5000).unref();
    });
  }

  private send(frame: string): void {
    if (this.control?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    this.framesSent.push(now);
    while (this.framesSent.length > 0 && now - this.framesSent[0]! > 10_000) this.framesSent.shift();
    if (this.r.p2p) this.r.p2p.maxFramesPer10s = Math.max(this.r.p2p.maxFramesPer10s, this.framesSent.length);
    this.control.send(frame);
  }

  private onControl(text: string): void {
    if (!text.startsWith('~')) return;
    const p2p = this.r.p2p;
    if (!p2p) return;
    if (text.startsWith('~c1')) {
      p2p.refused = true;
      return;
    }
    if (!text.startsWith('~d1 ')) return;
    let msg: { action?: string; offer?: unknown; offer_id?: string; peer_id?: string; info_hash?: string; interval?: number; answer?: unknown };
    try {
      msg = JSON.parse(text.slice(4)) as typeof msg;
    } catch {
      return;
    }
    if (msg.action !== 'announce') return;
    if (msg.offer && msg.offer_id && msg.peer_id) {
      p2p.offersIn += 1;
      p2p.answersOut += 1;
      this.send(`~d1 ${JSON.stringify({ action: 'announce', info_hash: msg.info_hash, peer_id: this.peerId, to_peer_id: msg.peer_id, answer: { type: 'answer', sdp: fakeSdp() }, offer_id: msg.offer_id })}`);
      return;
    }
    if (msg.answer) return;
    if (p2p.firstAnswerAt === undefined) p2p.firstAnswerAt = Date.now();
  }

  /** p2p-media-loader's tracker client: one channel, announces for the swarm of the level playing. */
  private openTracker(): void {
    this.send('~o1');
    this.announce();
  }

  private announce(): void {
    const height = this.variants[this.level]?.height ?? 0;
    if (!this.p2pOn || this.announced.has(height) || !this.r.p2p) return;
    this.announced.add(height);
    this.r.p2p.announces += 1;
    const offers = Array.from({ length: 5 }, () => ({ offer: { type: 'offer', sdp: fakeSdp() }, offer_id: crypto.randomBytes(10).toString('latin1') }));
    this.send(
      `~d1 ${JSON.stringify({ action: 'announce', info_hash: computeInfoHash(variantStreamSwarmId(this.swarmId, 'main', height)), peer_id: this.peerId, numwant: 5, uploaded: 0, downloaded: 0, event: 'started', offers })}`,
    );
  }

  enableP2P(): void {
    if (this.p2pOn) return;
    this.p2pOn = true;
    this.r.p2p = { onAt: Date.now(), refused: false, offersIn: 0, answersOut: 0, announces: 0, maxFramesPer10s: 0 };
    if (this.control?.readyState === WebSocket.OPEN) this.openTracker();
  }

  private async loadList(level: number): Promise<MediaList | null> {
    const v = this.variants[level]!;
    const res = await this.get(`/hls/${v.uri}`, 'playlist', v.height);
    if (res.status !== 200) return null;
    const list = { ...parseMedia(res.body.toString()), at: Date.now() };
    this.lists.set(level, list);
    return list;
  }

  /** capLevelToPlayerSize: two viewers in three have a player of 720p or less (a laptop window, a phone). */
  private get maxHeight(): number {
    return this.id % 3 === 0 ? 1080 : 720;
  }

  private pickLevel(): number {
    const est = Math.min(this.fast.value, this.slow.value) || 2_000_000;
    const cur = this.variants[this.level]!;
    let best = 0;
    for (let i = 0; i < this.variants.length; i++) {
      const v = this.variants[i]!;
      if (v.height > this.maxHeight) continue;
      const factor = v.bps > cur.bps ? BW_UP_FACTOR : BW_FACTOR;
      if (v.bps <= est * factor) best = i;
    }
    return best;
  }

  private async play(): Promise<void> {
    const mv = await this.get('/hls/index.m3u8', 'playlist');
    if (mv.status !== 200) throw new Error(`index ${mv.status}`);
    this.variants = parseVariants(mv.body.toString());
    if (this.variants.length === 0) throw new Error('no variants');
    // First level: the highest that fits 2 Mbps × 0.8 (abrEwmaDefaultEstimate).
    this.level = 0;
    this.variants.forEach((v, i) => {
      if (v.bps <= 2_000_000 * BW_FACTOR) this.level = i;
    });
    let list = await this.loadList(this.level);
    if (!list) throw new Error('level playlist');
    this.announce();
    const liveEdgeSeq = list.first + list.uris.length;
    this.nextSeq = Math.max(list.first, liveEdgeSeq - LIVE_SYNC_S / SEG_S);
    this.playhead = this.nextSeq * SEG_S;
    this.bufferedEnd = this.playhead;

    // Live playlist reloads, every target duration.
    const reloader = setInterval(() => void this.loadList(this.level), SEG_S * 1000);
    // Playback clock.
    let last = performance.now();
    const clock = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (this.r.firstFrameAt === undefined) return;
      const l = this.lists.get(this.level);
      const edge = l ? (l.first + l.uris.length) * SEG_S + (Date.now() - l.at) / 1000 : this.playhead;
      if (edge - this.playhead > LIVE_MAX_S) {
        // hls.js seeks back to the live sync point and drops what it had.
        this.r.jumps += 1;
        this.playhead = edge - LIVE_SYNC_S;
        this.bufferedEnd = this.playhead;
        this.nextSeq = Math.floor(this.playhead / SEG_S);
        if (this.stalled) this.endStall();
        return;
      }
      if (this.stalled) return;
      const h = String(this.variants[this.level]?.height ?? 0);
      this.r.levelSeconds[h] = (this.r.levelSeconds[h] ?? 0) + dt;
      this.playhead += dt;
      if (this.playhead >= this.bufferedEnd) {
        this.playhead = this.bufferedEnd;
        this.stalled = true;
        this.r.stalls.push([Date.now(), undefined]);
      }
    }, 100);

    try {
      while (this.running) {
        list = this.lists.get(this.level) ?? list;
        const v = this.variants[this.level]!;
        if (!this.inits.has(this.level) && list.init) {
          const r = await this.get(`/hls/${list.init}`, 'init', v.height, () => 0);
          if (r.status === 200) this.inits.add(this.level);
        }
        if (this.nextSeq < list.first) {
          // Fell out of the window (hls.js: a gap, then a seek to the live sync point).
          this.r.jumps += 1;
          this.nextSeq = list.first + Math.max(0, list.uris.length - LIVE_SYNC_S / SEG_S);
          this.playhead = this.nextSeq * SEG_S;
          this.bufferedEnd = this.playhead;
        }
        const idx = this.nextSeq - list.first;
        if (idx >= list.uris.length || this.bufferedEnd - this.playhead >= MAX_BUFFER_S) {
          await sleep(100);
          continue;
        }
        const t = performance.now();
        const seq = this.nextSeq;
        const res = await this.get(`/hls/${list.uris[idx]}`, 'segment', v.height, () => (this.r.firstFrameAt === undefined ? 0 : Math.max(0, seq * SEG_S - this.playhead)));
        const secs = (performance.now() - t) / 1000;
        if (res.status === 200) {
          const bps = (res.body.length * 8) / Math.max(0.001, secs);
          this.fast.sample(SEG_S, bps);
          this.slow.sample(SEG_S, bps);
          this.bufferedEnd = Math.max(this.bufferedEnd, (this.nextSeq + 1) * SEG_S);
          if (this.r.firstFrameAt === undefined) {
            this.r.firstFrameAt = Date.now();
            last = performance.now();
          }
          if (this.stalled && this.bufferedEnd > this.playhead) this.endStall();
        }
        this.nextSeq += 1;
        const next = this.pickLevel();
        if (next !== this.level) {
          this.level = next;
          const l = this.lists.get(next);
          if (!l || Date.now() - l.at > SEG_S * 1000) await this.loadList(next);
          this.announce();
        }
      }
    } finally {
      clearInterval(reloader);
      clearInterval(clock);
    }
  }

  private endStall(): void {
    this.stalled = false;
    const s = this.r.stalls.at(-1);
    if (s && s[1] === undefined) s[1] = Date.now();
  }

  stop(): void {
    this.running = false;
    this.control?.terminate();
  }
}

/** An SDP about the size of a real offer from p2p-media-loader (one data channel, a few candidates). */
function fakeSdp(): string {
  const r = crypto.randomBytes(24).toString('base64');
  return `v=0\r\no=- ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:${r.slice(0, 4)}\r\na=ice-pwd:${r.slice(4, 28)}\r\na=ice-options:trickle\r\na=fingerprint:sha-256 ${crypto.randomBytes(32).toString('hex').replace(/(..)/g, '$1:').slice(0, -1).toUpperCase()}\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n`;
}

process.on('message', async (m: { type: string; base?: string; link?: string; viewers?: Array<{ id: number; cohort: string }>; ids?: number[]; spreadMs?: number }) => {
  switch (m.type) {
    case 'init':
      base = m.base!;
      link = m.link!;
      process.send?.({ type: 'ready' });
      break;
    case 'join':
      for (const v of m.viewers ?? []) {
        const sv = new SimViewer(v.id, v.cohort);
        viewers.set(v.id, sv);
        setTimeout(() => void sv.join(), Math.random() * (m.spreadMs ?? 0));
      }
      break;
    case 'p2p':
      for (const id of m.ids ?? []) setTimeout(() => viewers.get(id)?.enableP2P(), Math.random() * (m.spreadMs ?? 0));
      break;
    case 'report':
      process.send?.({ type: 'report', viewers: [...viewers.values()].map((v) => v.r) });
      break;
    case 'stop':
      for (const v of viewers.values()) v.stop();
      process.send?.({ type: 'stopped' });
      setTimeout(() => process.exit(0), 100);
      break;
  }
});
process.on('disconnect', () => process.exit(0));
