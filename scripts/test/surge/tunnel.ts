// The quick tunnel's concurrency limit, emulated for the surge bench (bench.ts forks this file).
// docs/ARCHITECTURE.md "Quick tunnel limit (measured 2026-10-26)": a quick tunnel holds at most 200
// requests in flight; every open WebSocket takes one slot for its whole life, and an HTTP request
// takes one until its response body ends (slow downloads count). Past the limit Cloudflare's edge
// answers 429 with an empty body and no Retry-After, and the request never reaches the origin.
// The edge also adds a round trip: each request waits `rttMs` / 2 before it is forwarded.
//
//   parent → { type: 'start', target, limit, rttMs }  answer { type: 'ready', port }
//   every 250 ms → { type: 'tick', inFlight, peak, ws, refused, served, uplinkBytes }
// With `uplinkMbps`, everything toward viewers (pages, assets, video, WebSocket frames) also
// shares one uplink of that speed: what the server's own upload cap leaves out (the pages and
// their scripts) competes with the video there, as on the streamer's home connection.
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { BandwidthLimiter } from '../../../apps/server/src/hls/throttle.js';

interface Start {
  type: 'start';
  target: number;
  limit: number;
  rttMs: number;
  /** The streamer's whole uplink (Mbps): every byte toward viewers shares it, in arrival order. */
  uplinkMbps: number;
}

/** The uplink: one FIFO byte queue shared by every response and WebSocket toward viewers. */
let uplink: BandwidthLimiter | null = null;
let uplinkBytes = 0;
const shaped = (): Transform =>
  new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (!uplink) return cb(null, chunk);
      uplink.take(chunk.length).then(
        () => {
          uplinkBytes += chunk.length;
          cb(null, chunk);
        },
        (err: Error) => cb(err),
      );
    },
  });

let inFlight = 0;
let peak = 0;
let ws = 0;
let refused = 0;
let served = 0;

const take = (): boolean => {
  if (inFlight >= limit) {
    refused += 1;
    return false;
  }
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  return true;
};
let limit = 200;

process.on('message', (m: Start) => {
  if (m.type !== 'start') return;
  limit = m.limit;
  if (m.uplinkMbps > 0) uplink = BandwidthLimiter.fromMbps(m.uplinkMbps);
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const half = Math.max(0, m.rttMs / 2);
  const server = http.createServer((req, res) => {
    if (!take()) {
      res.writeHead(429, { server: 'cloudflare', 'content-length': '0' }).end();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight -= 1;
      served += 1;
    };
    res.once('finish', release);
    res.once('close', release);
    setTimeout(() => {
      const up = http.request({ host: '127.0.0.1', port: m.target, method: req.method, path: req.url, headers: req.headers, agent }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(shaped()).pipe(res);
      });
      up.once('error', () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.pipe(up);
    }, half);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!take()) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nserver: cloudflare\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    ws += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight -= 1;
      ws -= 1;
    };
    socket.once('close', release);
    socket.on('error', () => socket.destroy());
    setTimeout(() => {
      const up = net.connect(m.target, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(shaped()).pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      up.once('close', () => socket.destroy());
      socket.once('close', () => up.destroy());
    }, half);
  });
  server.listen(0, '127.0.0.1', () => {
    process.send?.({ type: 'ready', port: (server.address() as AddressInfo).port });
    setInterval(() => {
      process.send?.({ type: 'tick', inFlight, peak, ws, refused, served, uplinkBytes });
      peak = inFlight;
    }, 250);
  });
});
process.on('disconnect', () => process.exit(0));
