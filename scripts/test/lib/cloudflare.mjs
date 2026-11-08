// A local stand-in for Cloudflare's quick tunnels, so the gating tests open a tunnel with the
// real cloudflared and SwarmCast's real tunnel code without reaching the internet (a test that
// depends on Cloudflare's free service fails when that service does: "ENOTFOUND
// trycloudflare.com", 530 pages, 429s). Everything listens on 127.0.0.1, port 0:
//
// - the quick-tunnel service (cloudflared --quick-service): POST /tunnel creates a tunnel and
//   answers as api.trycloudflare.com does (id, <words>.trycloudflare.com, secret);
// - the edge (cloudflared --edge, --cacert): TLS with the tunnel's HTTP/2 protocol, as
//   cloudflared's own edge-side code expects it (connection/http2.go): this side is the HTTP/2
//   client, the first stream is the control stream ("Cf-Cloudflared-Proxy-Connection-Upgrade:
//   control-stream") where cloudflared registers the connection over Cap'n Proto RPC
//   (tunnelrpc.capnp RegistrationServer, capnp.mjs), and every viewer request is then one stream
//   to cloudflared, its response headers serialized in Cf-Cloudflared-Response-Headers; a
//   WebSocket is a stream with the upgrade header "websocket" whose bytes are the socket's;
// - the public side: HTTPS for every <name>.trycloudflare.com of a tunnel, forwarded to one of
//   its registered connections with the headers Cloudflare adds (CF-Connecting-IP, CF-Ray…), or
//   Cloudflare's 530 page ("error 1033") when the tunnel has no connection; DNS-over-HTTPS at
//   https://127.0.0.1:<port>/dns-query (application/dns-json), which knows a name once its
//   tunnel has registered a connection, as Cloudflare's resolvers do a few seconds after
//   cloudflared prints it; the same over plain HTTP on a second port for the app's own checks
//   (`checks`), which then read no certificate;
// - an HTTP CONNECT proxy for browsers (contextOptions): *.trycloudflare.com:443 goes to the
//   public side, anything else is refused, so a page cannot reach the internet either.
//
// SwarmCast takes the stand-in from SWARMCAST_TEST_CLOUDFLARE (appEnv; apps/server/src/tunnel/
// stand-in.ts): its cloudflared gets --quick-service, --edge, --cacert and --protocol http2 (no
// QUIC here), and its reachability checks ask this DNS-over-HTTPS and public side (`checks`).
// What differs from the real service: HTTP/2 instead of QUIC between cloudflared and the edge,
// one edge address, and no delay before a name resolves. The scheduled real-service smoke
// (.github/workflows/real-services.yml) keeps the real Cloudflare covered.
//
// The edge side follows the cloudflared pinned in scripts/build/versions.json. A bump of that pin
// changes vendor/ and so runs local-cloudflare.test.ts (integration, every app change): a
// cloudflared that speaks the tunnel protocol differently fails there first, with the method or
// interface it asked for in its log (this edge answers anything else with an RPC exception).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';
import { Msg, exceptionMessage, readFrames, readRpc, returnMessage } from './capnp.mjs';

/** tunnelrpc.capnp `interface RegistrationServer`: registerConnection @0, unregisterConnection @1, updateLocalConfiguration @2. */
const REGISTRATION_SERVER = 0xf71695ec7fe85497n;
const UPGRADE = 'cf-cloudflared-proxy-connection-upgrade';
const RESPONSE_HEADERS = 'cf-cloudflared-response-headers';
/**
 * The edge's HTTP/2 receive windows (it receives the responses): the 64 KiB defaults would make
 * every 2 s video segment wait for dozens of WINDOW_UPDATE round trips through this process's
 * event loop, which the harness shares with Playwright; Cloudflare's edge does not throttle so.
 */
const EDGE_STREAM_WINDOW = 4 * 1024 * 1024;
const EDGE_SESSION_WINDOW = 32 * 1024 * 1024;
/** Request headers HTTP/2 refuses (connection-specific) or that the edge sets itself. */
const NOT_FORWARDED = new Set(['connection', 'upgrade', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'host', 'http2-settings']);
const QUICK_TUNNEL_HOST = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com$/;
const WORDS = ['quiet', 'river', 'amber', 'stone', 'maple', 'cedar', 'orbit', 'harbor', 'meadow', 'silver', 'copper', 'lantern', 'willow', 'summit', 'canyon', 'breeze'];
/** The airport code a connection "landed" at (cloudflared logs it). */
const LOCATION = 'LCL';

/**
 * Starts the stand-in. `dir` receives the CA certificate cloudflared and SwarmCast trust.
 * @param {{ dir: string, log?: (line: string) => void }} opts
 */
export async function startLocalCloudflare({ dir, log = () => {} }) {
  const pki = await certificates();
  fs.mkdirSync(dir, { recursive: true });
  const caFile = path.join(dir, 'local-cloudflare-ca.pem');
  fs.writeFileSync(caFile, pki.caPem);

  /** @type {Map<string, Tunnel>} by id */
  const tunnels = new Map();
  const byHost = (host) => [...tunnels.values()].find((t) => t.hostname === host);
  const closers = [];

  // ---- the quick-tunnel service ----
  const service = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/tunnel') {
        res.writeHead(404).end();
        return;
      }
      const t = newTunnel(tunnels);
      log(`local cloudflare: tunnel ${t.hostname} created`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, errors: [], result: { id: t.id, name: `qt-${t.id}`, hostname: t.hostname, account_tag: 'local', secret: t.secret } }));
    });
  });

  // ---- the edge: cloudflared's connections ----
  const edgeSockets = new Set();
  const edge = tls.createServer({ key: pki.keyPem, cert: pki.certPem, ALPNProtocols: ['h2'] }, (socket) => {
    edgeSockets.add(socket);
    socket.on('close', () => edgeSockets.delete(socket));
    socket.on('error', () => {});
    serveConnection(socket, tunnels, log);
  });

  // ---- the public side: viewers and DNS-over-HTTPS ----
  const publicSide = (req, res) => {
    const host = hostOf(req);
    if (net.isIP(host)) {
      dnsQuery(req, res, tunnels);
      return;
    }
    const conn = routeFor(byHost(host));
    if (!conn) {
      noTunnelPage(res, host);
      return;
    }
    forward(conn, req, res, host);
  };
  const web = https.createServer({ key: pki.keyPem, cert: pki.certPem }, publicSide);
  web.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const host = hostOf(req);
    const conn = routeFor(byHost(host));
    if (!conn) {
      socket.end(`HTTP/1.1 530 \r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nerror code: 1033`);
      return;
    }
    forwardWebSocket(conn, req, socket, head, host);
  });
  const webSockets = new Set();
  web.on('connection', (s) => {
    webSockets.add(s);
    s.on('close', () => webSockets.delete(s));
  });
  // The same public side over plain HTTP: the app's reachability checks (stand-in.ts).
  const checks = http.createServer(publicSide);
  const checkSockets = new Set();
  checks.on('connection', (s) => {
    checkSockets.add(s);
    s.on('close', () => checkSockets.delete(s));
  });

  // ---- the proxy browsers use for *.trycloudflare.com ----
  const proxySockets = new Set();
  const proxy = http.createServer((_req, res) => res.writeHead(403, { 'content-type': 'text/plain' }).end('local cloudflare proxy: CONNECT only'));
  proxy.on('connect', (req, client, head) => {
    client.on('error', () => {});
    const [host, port] = (req.url ?? '').split(':');
    const t = byHost(host ?? '');
    // A name Cloudflare's DNS does not have yet, or anything else: no such host for the browser.
    if (port !== '443' || !t || !t.known) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = net.connect(webPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    proxySockets.add(client);
    client.on('close', () => {
      proxySockets.delete(client);
      upstream.destroy();
    });
  });

  const servicePort = await listen(service);
  const edgePort = await listen(edge);
  const webPort = await listen(web);
  const proxyPort = await listen(proxy);
  const checksPort = await listen(checks);
  closers.push(
    () => close(proxy, proxySockets),
    () => close(checks, checkSockets),
    () => close(web, webSockets),
    () => close(edge, edgeSockets),
    () => close(service, new Set()),
  );

  const standIn = {
    service: `http://127.0.0.1:${servicePort}`,
    edge: `127.0.0.1:${edgePort}`,
    ca: caFile,
    checks: `127.0.0.1:${checksPort}`,
  };
  return {
    caFile,
    caPem: pki.caPem,
    /** The environment that points a SwarmCast process at the stand-in (apps/server/src/tunnel/stand-in.ts). */
    appEnv: { SWARMCAST_TEST_CLOUDFLARE: JSON.stringify(standIn) },
    /** Browser context options: *.trycloudflare.com through the stand-in, its certificate accepted. */
    contextOptions: { proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true },
    /** The tunnels created so far: { hostname, connections (registered now), known (in DNS), requests }. */
    tunnels: () => [...tunnels.values()].map((t) => ({ hostname: t.hostname, connections: t.connections.size, known: t.known, requests: t.requests })),
    /**
     * Cloudflare's edge stops sending a tunnel's requests to its connections while cloudflared
     * runs on (gate run 42164021587): from now on the address answers 530.
     */
    stopRouting(hostname) {
      const t = byHost(hostname);
      if (!t) throw new Error(`local cloudflare: no tunnel ${hostname}`);
      t.routed = false;
    },
    /** Where the public side listens (127.0.0.1:<port>): HTTPS for every tunnel's name, with the CA's certificate. */
    web: `127.0.0.1:${webPort}`,
    /**
     * A request to `url` (https://<name>.trycloudflare.com/...) through the public side, as a viewer
     * sends it: `{ status, headers, body }`, or null when the connection failed.
     * @param {string} url
     * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
     */
    request(url, { method = 'GET', headers = {}, body } = {}) {
      const u = new URL(url);
      return new Promise((resolve) => {
        const req = https.request(
          { method, host: '127.0.0.1', port: webPort, path: u.pathname + u.search, servername: u.hostname, ca: pki.caPem, headers: { host: u.host, ...headers }, agent: false, timeout: 8000 },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => (text += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            res.on('error', () => resolve(null));
          },
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
        req.end(body);
      });
    },
    /** GET <base>/healthz through the public side: its X-SwarmCast header ("ok" without one), null without a 200. */
    async healthz(base, headers = {}) {
      const res = await this.request(new URL('/healthz', base).href, { headers });
      return res?.status === 200 ? (res.headers['x-swarmcast'] ?? 'ok') : null;
    },
    async close() {
      for (const t of tunnels.values()) for (const c of t.connections) c.session.destroy();
      for (const c of closers) await c();
    },
  };
}

/**
 * @typedef {{ id: string, hostname: string, secret: string, connections: Set<Connection>, known: boolean, routed: boolean, requests: number }} Tunnel
 * @typedef {{ session: import('node:http2').ClientHttp2Session, tunnel: Tunnel, index: number, registered: boolean }} Connection
 */

function newTunnel(tunnels) {
  let hostname;
  do hostname = `${pick()}-${pick()}-${pick()}-${crypto.randomBytes(2).toString('hex')}.trycloudflare.com`;
  while ([...tunnels.values()].some((t) => t.hostname === hostname));
  const t = { id: crypto.randomUUID(), hostname, secret: crypto.randomBytes(32).toString('base64'), connections: new Set(), known: false, routed: true, requests: 0 };
  tunnels.set(t.id, t);
  return t;
}

const pick = () => WORDS[crypto.randomInt(WORDS.length)];

/** A registered connection of `t` to send a request to, or null (no tunnel, none registered, or no longer routed). */
function routeFor(t) {
  if (!t || !t.routed) return null;
  const live = [...t.connections].filter((c) => c.registered && !c.session.destroyed && !c.session.closed);
  if (live.length === 0) return null;
  t.requests += 1;
  return live[t.requests % live.length];
}

/**
 * One TLS connection from cloudflared: the edge is the HTTP/2 client. Opens the control stream
 * and answers cloudflared's registration RPCs on it.
 */
function serveConnection(socket, tunnels, log) {
  const session = http2.connect('https://h2.cftunnel.com', { createConnection: () => socket, settings: { initialWindowSize: EDGE_STREAM_WINDOW } });
  session.on('error', () => {});
  session.once('connect', () => session.setLocalWindowSize(EDGE_SESSION_WINDOW));
  /** @type {Connection} */
  const conn = { session, tunnel: null, index: -1, registered: false };
  const control = session.request({ ':method': 'GET', ':scheme': 'https', ':authority': 'h2.cftunnel.com', ':path': '/', [UPGRADE]: 'control-stream' }, { endStream: false });
  control.on('error', () => {});
  let pending = Buffer.alloc(0);
  control.on('data', (chunk) => {
    const { messages, rest } = readFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const m of messages) {
      const rpc = readRpc(m);
      const reply = answer(rpc, conn, tunnels, log);
      if (reply) control.write(reply);
      if (rpc.which === Msg.abort) session.destroy();
    }
  });
  session.on('close', () => {
    if (conn.tunnel) {
      conn.tunnel.connections.delete(conn);
      log(`local cloudflare: ${conn.tunnel.hostname} connection ${conn.index} closed`);
    }
  });
}

/** The answer to one RPC message on a control stream (null: none needed). */
function answer(rpc, conn, tunnels, log) {
  if (rpc.which === Msg.bootstrap) return returnMessage(rpc.id, { cap: true });
  if (rpc.which !== Msg.call) return null;
  if (rpc.interfaceId !== REGISTRATION_SERVER) return exceptionMessage(rpc.id, `local cloudflare: interface ${rpc.interfaceId.toString(16)} is not implemented`);
  if (rpc.methodId === 0) {
    const tunnelId = rpc.params?.ptr(1);
    const id = Buffer.isBuffer(tunnelId) && tunnelId.length === 16 ? formatUuid(tunnelId) : '';
    const t = tunnels.get(id);
    if (!t) return exceptionMessage(rpc.id, `local cloudflare: unknown tunnel ${id}`);
    conn.tunnel = t;
    conn.index = rpc.params?.u8(0) ?? 0;
    conn.registered = true;
    t.connections.add(conn);
    t.known = true;
    log(`local cloudflare: ${t.hostname} connection ${conn.index} registered`);
    return connectionDetailsReturn(rpc.id, crypto.randomBytes(16));
  }
  if (rpc.methodId === 1) {
    conn.registered = false;
    return returnMessage(rpc.id);
  }
  if (rpc.methodId === 2) return returnMessage(rpc.id);
  return exceptionMessage(rpc.id, `local cloudflare: method ${rpc.methodId} is not implemented`);
}

/**
 * The Return of a registerConnection that succeeded: (result :ConnectionResponse) with
 * result.connectionDetails (union member 1) = { uuid @0 :Data, locationName @1 :Text,
 * tunnelIsRemotelyManaged @2 :Bool (false) } (tunnelrpc.capnp).
 * @param {number} answerId
 * @param {Buffer} uuid
 */
export function connectionDetailsReturn(answerId, uuid) {
  return returnMessage(answerId, {
    dataWords: 0,
    ptrCount: 1,
    fill: (results) => results.struct(0, 1, 1).u16(0, 1).struct(0, 1, 2).data(0, uuid).text(1, LOCATION),
  });
}

function formatUuid(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function hostOf(req) {
  return (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
}

/** The request headers cloudflared gets for `req`: the viewer's, plus what Cloudflare's edge adds. */
function edgeHeaders(req, host) {
  const headers = { ':method': req.method, ':scheme': 'https', ':authority': host, ':path': req.url };
  for (const [k, v] of Object.entries(req.headers)) if (!NOT_FORWARDED.has(k) && v !== undefined) headers[k] = v;
  const ip = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  headers['cf-connecting-ip'] = ip;
  headers['x-forwarded-for'] = ip;
  headers['x-forwarded-proto'] = 'https';
  headers['cf-visitor'] = '{"scheme":"https"}';
  headers['cf-ray'] = `${crypto.randomBytes(8).toString('hex')}-${LOCATION}`;
  headers['cdn-loop'] = 'cloudflare';
  return headers;
}

/** The origin's response headers from cloudflared's serialized header (base64 name:value pairs, ";"-separated). */
function originHeaders(h2headers) {
  const out = {};
  const raw = h2headers[RESPONSE_HEADERS];
  for (const pair of (typeof raw === 'string' ? raw : '').split(';')) {
    if (!pair) continue;
    const [n, v] = pair.split(':');
    const name = Buffer.from(n ?? '', 'base64').toString('latin1');
    const value = Buffer.from(v ?? '', 'base64').toString('latin1');
    const prev = out[name];
    out[name] = prev === undefined ? value : [prev, value].flat();
  }
  return out;
}

function forward(conn, req, res, host) {
  const stream = conn.session.request(edgeHeaders(req, host), { endStream: false });
  stream.on('response', (h) => {
    const status = Number(h[':status']);
    const headers = originHeaders(h);
    res.writeHead(status, { ...headers, server: 'cloudflare', 'cf-ray': `${crypto.randomBytes(8).toString('hex')}-${LOCATION}` });
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', server: 'cloudflare' }).end('error code: 502');
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
  req.pipe(stream);
}

function forwardWebSocket(conn, req, socket, head, host) {
  const stream = conn.session.request({ ...edgeHeaders(req, host), [UPGRADE]: 'websocket' }, { endStream: false });
  stream.on('response', (h) => {
    const status = Number(h[':status']);
    const headers = originHeaders(h);
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} \r\nconnection: close\r\n\r\n`);
      stream.destroy();
      return;
    }
    const lines = Object.entries(headers).flatMap(([k, v]) => [v].flat().map((x) => `${k}: ${x}`));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) stream.write(head);
    stream.pipe(socket);
    socket.pipe(stream);
  });
  stream.on('error', () => socket.destroy());
  stream.on('close', () => socket.end());
  socket.on('close', () => stream.destroy());
}

/** Cloudflare's answer for a quick-tunnel address with no connection to its tunnel. */
function noTunnelPage(res, host) {
  res.writeHead(530, { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare', 'cf-ray': `${crypto.randomBytes(8).toString('hex')}-${LOCATION}` });
  res.end(`<!DOCTYPE html><title>${host} | 530: Argo Tunnel error</title><p>Cloudflare Tunnel error</p><p>error code: 1033</p>`);
}

/** DNS-over-HTTPS (JSON): A 127.0.0.1 for a known quick-tunnel name, NXDOMAIN otherwise. */
function dnsQuery(req, res, tunnels) {
  const u = new URL(req.url ?? '/', 'https://127.0.0.1');
  if (u.pathname !== '/dns-query') {
    res.writeHead(404).end();
    return;
  }
  const name = (u.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
  const t = QUICK_TUNNEL_HOST.test(name) ? [...tunnels.values()].find((x) => x.hostname === name && x.known) : undefined;
  res.writeHead(200, { 'content-type': 'application/dns-json' });
  res.end(JSON.stringify(t ? { Status: 0, Answer: [{ name, type: 1, TTL: 300, data: '127.0.0.1' }] } : { Status: 3 }));
}

/** A CA and one certificate for the edge (h2.cftunnel.com…), every *.trycloudflare.com and 127.0.0.1. */
async function certificates() {
  x509.cryptoProvider.set(crypto.webcrypto);
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const now = Date.now();
  const notBefore = new Date(now - 3600_000);
  const notAfter = new Date(now + 7 * 24 * 3600_000);
  const caKeys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomBytes(8).toString('hex'),
    name: 'CN=SwarmCast test: local Cloudflare CA',
    notBefore,
    notAfter,
    keys: caKeys,
    signingAlgorithm: alg,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
  });
  const keys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: crypto.randomBytes(8).toString('hex'),
    subject: 'CN=h2.cftunnel.com',
    issuer: ca.subject,
    notBefore,
    notAfter,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'h2.cftunnel.com' },
        { type: 'dns', value: 'quic.cftunnel.com' },
        { type: 'dns', value: '*.trycloudflare.com' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    caPem: ca.toString('pem'),
    certPem: cert.toString('pem'),
    keyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----\n`,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server, sockets) {
  for (const s of sockets) s.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}
