import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {
  BROWSER_CHECK_TTL_S,
  DEVICE_COOKIE,
  SEGMENT_DURATION_S,
  SESSION_COOKIE,
  SESSION_TTL_S,
  TICKET_COOKIE,
  VERIFIED_COOKIE,
  JOIN_TICKET_TTL_S,
  joinRequestSchema,
  nicknameError,
  type ApiErrorBody,
  type JoinChallengeResponse,
  type MessageKey,
  type ViewerConfig,
} from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { isPreviewAgent, previewPage } from '../branding/og.js';
import { registerBrandingPublicRoutes } from '../branding/public-routes.js';
import type { BrandingStore } from '../branding/store.js';
import type { AccessControl, Session } from '../access/access.js';
import type { ControlChannel } from '../control/control.js';
import type { HlsOrigin } from '../hls/origin.js';
import type { ManifestSigner } from '../hls/manifest.js';
import type { BandwidthLimiter } from '../hls/throttle.js';
import { SAFE_NAME } from '../hls/playlist.js';
import type { TrackerService } from '../tracker/tracker.js';
import type { Logger } from '../core/logger.js';
import { scrub } from '../core/logger.js';
import type { PublicSecurity } from '../security/shield.js';
import { resettableRateLimits } from './rate-limit-store.js';
import { applySecurityHeaders, clientIp, isMobileUserAgent, originMatchesHost, viewerCsp } from './security.js';

/** Viewer-facing HTTP requests: in progress now, the highest count in the last window, served in total. */
export interface HttpStats {
  inFlight: number;
  served: number;
  /** Highest `inFlight` since `peakAt` (a window of PEAK_WINDOW_MS). */
  peak: number;
  peakAt: number;
}

/** Peaks are short (segment downloads start together), so the panel looks at the last ~10 s. */
export const PEAK_WINDOW_MS = 10_000;

export function notePeak(s: HttpStats, now = Date.now()): void {
  if (now - s.peakAt > PEAK_WINDOW_MS) {
    s.peak = s.inFlight;
    s.peakAt = now;
  } else if (s.inFlight > s.peak) s.peak = s.inFlight;
}

/** Highest HTTP in-flight count of the current or the previous window. */
export function recentPeak(s: HttpStats, now = Date.now()): number {
  return now - s.peakAt <= 2 * PEAK_WINDOW_MS ? Math.max(s.peak, s.inFlight) : s.inFlight;
}

export interface PublicDeps {
  access: AccessControl;
  origin: HlsOrigin;
  signer: ManifestSigner;
  tracker: TrackerService;
  control: ControlChannel;
  limiter: BandwidthLimiter;
  viewerDir: string;
  log: Logger;
  stunServers: () => string[];
  /** Swarm id of the current live (used by viewers' streamSwarmIdBuilder). */
  swarmId: () => string;
  /** Admission limits (read on every join so panel/config changes apply immediately). */
  limits: () => { maxViewers: number; maxSessionsPerDevice: number };
  /** Called for every viewer-facing request, for in-flight/limit statistics. */
  stats: HttpStats;
  /** Attack detection feed, public blocklists and the join proof-of-work. */
  security: PublicSecurity;
  /**
   * A known session made a request from `ip` (its client address as clientIp() reads it). The
   * live checks whether that is the streamer's own connection (P2P privacy) before the request
   * goes on, so a /tracker or /control upgrade already sees the outcome.
   */
  clientSeen?: (session: Session, ip: string) => void;
  /** Names nobody may join with besides the built-in reserved ones (the streamer's chat name). */
  reservedNames?: () => string[];
  // ---- branding: deps ----
  /** "Your page" (docs/BRANDING.md); its routes are registered only when present. */
  branding?: BrandingStore;
  /** Serve the light version of the page (no banner): attack or a saturated uplink. */
  brandingLite?: () => boolean;
  // ---- end branding: deps ----
}

export interface PublicServerOptions {
  /** "secure" = behind the tunnel on 127.0.0.1; "direct" = exposed on the public IP. */
  mode: 'secure' | 'direct';
  /** Cookies get the Secure attribute (always true except plain-HTTP local testing). */
  secureCookies: boolean;
  /** Trust CF-Connecting-IP from the local tunnel connector. */
  trustTunnel: boolean;
  /**
   * Direct mode TLS. `key`/`cert` are the default certificate: browsers never send SNI when the
   * address is a bare IP (https://203.0.113.7:port), so an SNI callback alone would fail every
   * handshake.
   */
  https?: {
    key: string;
    cert: string;
    SNICallback: (servername: string, cb: (err: Error | null, ctx?: import('node:tls').SecureContext) => void) => void;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    viewer?: Session;
  }
}

const INVALID_STATUS = 404;

/**
 * Join rate limits per client IP. Generous on purpose: mobile carriers put many subscribers
 * behind one public IP (CGNAT), and most of them join in the first minutes of a stream. The
 * attack shield divides these automatically when it detects abuse.
 */
const JOIN_LINK_PER_IP_PER_MIN = 120;
const JOIN_CHALLENGE_PER_IP_PER_MIN = 120;
const JOIN_PER_IP_PER_MIN = 60;

/** Viewer API error body: English `error` plus a stable `code` the page translates. */
function apiError(code: MessageKey): ApiErrorBody {
  return { error: translate('en', code), code };
}

export async function createPublicServer(deps: PublicDeps, opts: PublicServerOptions): Promise<FastifyInstance> {
  const { access, origin, signer, log } = deps;
  const direct = opts.mode === 'direct';
  // The watch page's test-only URL flags work only for a server started with this (E2E harness).
  const testHooks = process.env.SWARMCAST_TEST_HOOKS === '1';

  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 4 * 1024,
    forceCloseConnections: true,
    // Bound slow or abusive clients (slowloris, connection reuse floods).
    maxRequestsPerSocket: direct ? 200 : 2000,
    // Short timeouts; much shorter in direct mode where the server faces the internet.
    connectionTimeout: direct ? 15_000 : 60_000,
    keepAliveTimeout: direct ? 5_000 : 30_000,
    requestTimeout: direct ? 15_000 : 60_000,
    // handshakeTimeout: Node's default (120 s) is generous to slow-handshake attackers.
    ...(opts.https ? { https: { key: opts.https.key, cert: opts.https.cert, SNICallback: opts.https.SNICallback, minVersion: 'TLSv1.2' as const, handshakeTimeout: 10_000 } } : {}),
  } as Parameters<typeof Fastify>[0]) as unknown as FastifyInstance;

  // Headers must arrive quickly; Node's default (60 s) is generous for a slowloris.
  app.server.headersTimeout = direct ? 8_000 : 15_000;
  const pages = loadPages(deps.viewerDir);
  const ip = (req: FastifyRequest): string => clientIp(req, opts.trustTunnel && !direct);
  const sec = deps.security;
  app.server.on('connection', (socket: Duplex) => {
    sec.connection(1);
    socket.once('close', () => sec.connection(-1));
  });
  if (opts.https) app.server.on('tlsClientError', () => sec.tlsError());
  // Connections refused because of maxConnections (Direct mode) count like our own 429s.
  app.server.on('drop', () => sec.rateLimited());
  const cookieBase = { path: '/', httpOnly: true, secure: opts.secureCookies, sameSite: 'lax' as const };

  await app.register(cookie);
  const limits = resettableRateLimits();
  app.decorate('resetRateLimits', limits.reset);
  await app.register(rateLimit, {
    store: limits.Store,
    global: true,
    max: direct ? 300 : 900,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.cookies?.[SESSION_COOKIE]?.slice(-24) ?? ip(req),
    errorResponseBuilder: () => {
      sec.rateLimited();
      return { statusCode: 429, error: 'Too Many Requests', message: 'Slow down.', code: 'viewer.err.tooMany' };
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    deps.stats.inFlight += 1;
    notePeak(deps.stats);
    sec.request(ip(req));
    const host = req.headers.host ?? '';
    applySecurityHeaders(reply, viewerCsp(host, opts.secureCookies, deps.stunServers()), opts.secureCookies);
    reply.header('Cache-Control', 'private, no-store');
  });
  app.addHook('onResponse', async () => {
    deps.stats.inFlight -= 1;
    deps.stats.served += 1;
  });
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.warn({ err: (err as Error).message, url: scrub(req.url) }, 'public request failed');
    reply.code(status).send(apiError(status === 429 ? 'viewer.err.tooMany' : 'viewer.err.failed'));
  });

  /** Resolve the viewer session from the cookie, renewing it when half-expired. */
  async function sessionOf(req: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
    const res = await access.verifySessionToken(req.cookies[SESSION_COOKIE]);
    if (!res) return null;
    if (res.renew) {
      reply.setCookie(SESSION_COOKIE, await access.issueSessionToken(res.session), { ...cookieBase, maxAge: SESSION_TTL_S });
    }
    const addr = ip(req);
    if (direct) res.session.ip = addr;
    deps.clientSeen?.(res.session, addr);
    return res.session;
  }

  const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const s = await sessionOf(req, reply);
    if (!s) {
      reply.code(401).send(apiError('viewer.err.sessionInvalid'));
      return reply;
    }
    req.viewer = s;
  };

  const sendInvalid = (reply: FastifyReply, status = INVALID_STATUS): FastifyReply =>
    reply.code(status).type('text/html; charset=utf-8').send(pages.invalid);
  /** The IP is on a public blocklist: the invalid page with an explanation instead. */
  const sendBlocked = (reply: FastifyReply): FastifyReply => {
    sec.joinFailed();
    return reply.code(403).header('X-SwarmCast-Refused', 'blocklist').type('text/html; charset=utf-8').send(pages.blocked);
  };
  const blockedJson = (reply: FastifyReply): FastifyReply => {
    sec.joinFailed();
    return reply.code(403).send(apiError('viewer.err.blocked'));
  };

  // ---- health (used to confirm the tunnel reaches this process) ----
  app.get('/healthz', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    // ---- branding: no live status for strangers ----
    // Only our own checks (X-SwarmCast-Probe, derived from this live's key) learn which live is on
    // or that it is off. Anyone else gets a constant marker, so polling the address never tells
    // when the streamer is live (docs/BRANDING.md, threat T10).
    const probe = req.headers['x-swarmcast-probe'];
    const own = access.checkProbeToken(typeof probe === 'string' ? probe : undefined);
    reply.header('X-SwarmCast', own ? (access.live ? access.liveId : 'off') : '1');
    return { ok: true };
  });

  // ---- join flow ----
  app.get<{ Params: { secret: string } }>(
    '/join/:secret',
    { config: { rateLimit: { max: () => sec.joinRateMax(JOIN_LINK_PER_IP_PER_MIN), timeWindow: '1 minute', keyGenerator: ip } } },
    async (req, reply) => {
      sec.joinAttempt();
      if (sec.blocked(ip(req))) return sendBlocked(reply);
      const deviceId = req.cookies[DEVICE_COOKIE];
      if (!access.checkSecret(req.params.secret)) {
        sec.joinFailed();
        return sendInvalid(reply);
      }
      // ---- branding: link previews ----
      // A messaging app building a preview gets a small Open Graph page: no cookie, no ticket.
      if (deps.branding && isPreviewAgent(req.headers['user-agent'])) {
        const b = deps.branding.branding;
        const card = b.images.card;
        const base = `${opts.secureCookies ? 'https' : 'http'}://${req.headers.host ?? ''}`;
        const token = access.previewToken();
        const ext = card ? ({ png: 'png', jpeg: 'jpg', webp: 'webp' } as const)[card.type] : 'jpg';
        return reply.type('text/html; charset=utf-8').send(
          previewPage({
            branding: b,
            url: `${base}${req.url.split('?')[0]}`,
            ...(card && token ? { imageUrl: `${base}/p/${token}/card.${ext}`, imageType: { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[card.type] } : {}),
            acceptLanguage: typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : undefined,
          }),
        );
      }
      // ---- end branding ----
      if (access.isBanned(deviceId)) {
        sec.joinFailed();
        return sendInvalid(reply, 403);
      }
      if (!deviceId || !/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) {
        reply.setCookie(DEVICE_COOKIE, crypto.randomBytes(16).toString('base64url'), { ...cookieBase, maxAge: 400 * 24 * 3600 });
      }
      reply.setCookie(TICKET_COOKIE, await access.issueTicket(), { ...cookieBase, maxAge: JOIN_TICKET_TTL_S });
      // Drop the secret from the address bar (and history) right away.
      return reply.redirect('/join', 303);
    },
  );

  app.get('/join', async (req, reply) => {
    if (await sessionOf(req, reply)) return reply.redirect('/watch', 303);
    if (!(await access.verifyTicket(req.cookies[TICKET_COOKIE]))) return sendInvalid(reply);
    return reply.type('text/html; charset=utf-8').send(pages.join);
  });

  /** This browser already passed the check at the level required now (signed cookie, bound to the device cookie). */
  const verified = (req: FastifyRequest): boolean => sec.isVerified(req.cookies[VERIFIED_COOKIE], req.cookies[DEVICE_COOKIE]);

  // Proof-of-work challenge for the join page (only when the browser check is on and this browser
  // has not passed it yet, or passed a lower level than the one asked for now).
  app.get('/api/join/challenge', { config: { rateLimit: { max: () => sec.joinRateMax(JOIN_CHALLENGE_PER_IP_PER_MIN), timeWindow: '1 minute', keyGenerator: ip } } }, async (req, reply) => {
    if (sec.blocked(ip(req))) return blockedJson(reply);
    if (!(await access.verifyTicket(req.cookies[TICKET_COOKIE]))) return reply.code(403).send(apiError('viewer.err.linkInvalid'));
    const body: JoinChallengeResponse = sec.powLevel() > 0 && !verified(req) ? { required: true, challenge: await sec.issuePow() } : { required: false };
    return body;
  });

  app.post('/api/join', { config: { rateLimit: { max: () => sec.joinRateMax(JOIN_PER_IP_PER_MIN), timeWindow: '1 minute', keyGenerator: ip } } }, async (req, reply) => {
    sec.joinAttempt();
    if (sec.blocked(ip(req))) return blockedJson(reply);
    if (!(await access.verifyTicket(req.cookies[TICKET_COOKIE]))) {
      sec.joinFailed();
      return reply.code(403).send(apiError('viewer.err.linkInvalid'));
    }
    const deviceId = req.cookies[DEVICE_COOKIE];
    if (!deviceId || access.isBanned(deviceId)) {
      sec.joinFailed();
      return reply.code(403).send(apiError('viewer.err.linkInvalid'));
    }
    const parsed = joinRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const e = nicknameError(parsed.error.issues[0]?.message);
      return reply.code(400).send({ error: e.text, code: e.code, ...(e.params ? { params: e.params } : {}) } satisfies ApiErrorBody);
    }
    // Nicknames are visible to everyone in the chat: no look-alikes of "Streamer" or of
    // someone watching (confusable skeletons, docs/CHAT.md).
    const nameProblem = access.nicknameProblem(parsed.data.nickname, deviceId, deps.reservedNames?.() ?? []);
    if (nameProblem === 'reserved') return reply.code(400).send(apiError('nickname.reserved'));
    if (nameProblem === 'taken') {
      const params = { suggestion: access.suggestNickname(parsed.data.nickname, deviceId) };
      return reply.code(400).send({ error: translate('en', 'nickname.taken', params), code: 'nickname.taken', params } satisfies ApiErrorBody);
    }
    // The link/ticket and ban checks above always run first; the verified cookie only skips the proof-of-work.
    if (sec.powLevel() > 0 && !verified(req)) {
      const { verdict, level } = await sec.verifyPow((req.body as { pow?: unknown } | null)?.pow);
      if (verdict !== 'ok') {
        sec.joinFailed();
        // A fresh challenge comes with the refusal, so the page can solve it and retry.
        return reply.code(403).send({ ...apiError('viewer.err.checkRequired'), pow: await sec.issuePow() });
      }
      // Remember this browser (set even if the stream turns out to be full, so a retry needs no new proof).
      reply.setCookie(VERIFIED_COOKIE, sec.issueVerified(deviceId, level ?? 1), { ...cookieBase, maxAge: BROWSER_CHECK_TTL_S });
    }
    if (access.admit(deviceId, deps.limits().maxViewers, deps.limits().maxSessionsPerDevice) === 'full') {
      sec.joinFailed();
      return reply.code(503).header('Retry-After', '30').send(apiError('viewer.err.full'));
    }
    const session = access.createSession({
      nickname: parsed.data.nickname,
      deviceId,
      device: isMobileUserAgent(req.headers['user-agent']) ? 'mobile' : 'desktop',
      ip: ip(req),
    });
    reply.setCookie(SESSION_COOKIE, await access.issueSessionToken(session), { ...cookieBase, maxAge: SESSION_TTL_S });
    reply.clearCookie(TICKET_COOKIE, cookieBase);
    log.info({ viewer: session.nickname }, 'viewer joined');
    return { ok: true, redirect: '/watch' };
  });

  app.get('/watch', async (req, reply) => {
    if (!(await sessionOf(req, reply))) return sendInvalid(reply);
    return reply.type('text/html; charset=utf-8').send(pages.watch);
  });

  app.get('/', async (_req, reply) => sendInvalid(reply));

  // ---- viewer API ----
  app.get('/api/config', { preHandler: requireSession }, async (req): Promise<ViewerConfig> => {
    const s = req.viewer!;
    const host = req.headers.host ?? '';
    const ws = opts.secureCookies ? 'wss' : 'ws';
    return {
      sessionId: s.id,
      nickname: s.nickname,
      manifestPublicKey: signer.publicKeyRaw,
      playlistUrl: '/hls/index.m3u8',
      manifestUrl: '/hls/manifest.json',
      trackerUrl: `${ws}://${host}/tracker`,
      controlUrl: `${ws}://${host}/control`,
      stunServers: deps.stunServers(),
      swarmId: deps.swarmId(),
      p2pAllowed: access.p2pAllowed(s),
      ...(access.p2pBlock(s) ? { p2pBlock: access.p2pBlock(s) } : {}),
      segmentDurationS: SEGMENT_DURATION_S,
      ...(testHooks ? { testHooks: true as const } : {}),
    };
  });

  app.post('/api/session/refresh', { preHandler: requireSession }, async () => ({ ok: true }));

  app.post('/api/leave', { preHandler: requireSession }, async (req, reply) => {
    access.sessions.delete(req.viewer!.id);
    reply.clearCookie(SESSION_COOKIE, cookieBase);
    return { ok: true };
  });

  // ---- HLS ----
  app.get('/hls/manifest.json', { preHandler: requireSession }, async (_req, reply) => {
    const jws = await signer.sign(access.liveId, origin.version, origin.segmentHashes());
    return reply.type('application/jose').send(jws);
  });

  app.get<{ Params: { file: string } }>('/hls/:file', { preHandler: requireSession }, async (req, reply) => {
    const name = req.params.file;
    if (!SAFE_NAME.test(name)) return reply.code(404).send(apiError('viewer.err.notFound'));
    if (name.endsWith('.m3u8')) {
      const pl = origin.getPlaylist(name);
      // 503 + Retry-After (not 404): players retry 5xx, so viewers who join before OBS
      // starts (or while it reconnects) pick the stream up as soon as it exists.
      if (!pl) return reply.code(503).header('Retry-After', '2').send(apiError('viewer.err.notStarted'));
      return reply.type('application/vnd.apple.mpegurl').send(pl);
    }
    const f = origin.getFile(name);
    if (!f) return reply.code(404).send(apiError('viewer.err.notFound'));
    // Segments are immutable; "private" keeps the tunnel/CDN from caching them.
    reply.header('Cache-Control', 'private, max-age=120, immutable');
    reply.header('Content-Length', f.data.length);
    reply.type(f.contentType);
    return reply.send(deps.limiter.stream(f.data));
  });

  // ---- static assets of the viewer app (no secrets in them) ----
  await app.register(fastifyStatic, {
    root: path.join(deps.viewerDir, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    index: false,
    setHeaders: (reply) => void reply.header('Cache-Control', 'public, max-age=31536000, immutable'),
  });

  // ---- branding: viewer routes ----
  if (deps.branding) {
    const store = deps.branding;
    // The preview card: anyone holding the current link's preview token (it dies with "New link").
    app.get<{ Params: { token: string; file: string } }>('/p/:token/:file', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: ip } } }, async (req, reply) => {
      const b = store.branding;
      const card = b.images.card;
      const ext = card ? ({ png: 'png', jpeg: 'jpg', webp: 'webp' } as const)[card.type] : '';
      if (!card || !b.enabled || !b.preview.enabled || req.params.file !== `card.${ext}` || !access.checkPreviewToken(req.params.token)) return sendInvalid(reply);
      const f = store.file(card.sha);
      if (!f) return sendInvalid(reply);
      reply.header('Cache-Control', 'private, max-age=600');
      reply.header('Content-Length', f.bytes.length);
      reply.type(f.mime);
      return reply.send(deps.limiter.stream(f.bytes));
    });
    registerBrandingPublicRoutes(app, {
      store: deps.branding,
      limiter: deps.limiter,
      member: async (req, reply) => (await access.verifyTicket(req.cookies[TICKET_COOKIE])) || (await sessionOf(req, reply)) !== null,
      liveId: () => access.liveId,
      lite: () => deps.brandingLite?.() ?? false,
      notFound: (reply) => sendInvalid(reply),
    });
  }
  // ---- end branding ----

  app.setNotFoundHandler((_req, reply) => sendInvalid(reply));

  // ---- WebSockets: /control and /tracker ----
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const reject = (code: number, msg: string): void => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    sec.upgrade();
    const addr = clientIp(req, opts.trustTunnel && !direct);
    if (sec.blocked(addr)) return reject(403, 'Forbidden');
    if (url.pathname !== '/control' && url.pathname !== '/tracker') return reject(404, 'Not Found');
    if (!originMatchesHost(req.headers.origin, req.headers.host)) return reject(403, 'Forbidden');
    const cookies = app.parseCookie(req.headers.cookie ?? '');
    const res = await access.verifySessionToken(cookies[SESSION_COOKIE]);
    if (!res) return reject(401, 'Unauthorized');
    deps.clientSeen?.(res.session, addr);
    if (url.pathname === '/control') {
      deps.control.handleUpgrade(req, socket, head, res.session);
    } else {
      if (!access.p2pAllowed(res.session)) return reject(403, 'Forbidden');
      deps.tracker.handleUpgrade(req, socket, head, res.session);
    }
  }

  return app;
}

interface Pages {
  join: string;
  watch: string;
  invalid: string;
  /** The invalid page explaining a public-blocklist refusal. */
  blocked: string;
}

function loadPages(dir: string): Pages {
  const read = (name: string, fallback: string): string => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return fallback;
    }
  };
  const invalid =
    '<!doctype html><meta charset="utf-8"><title>SwarmCast</title><p>This stream link is no longer valid. Ask the streamer for the current link.</p>';
  const invalidPage = read('invalid.html', invalid);
  const blockedText = translate('en', 'viewer.err.blocked');
  // Same page, other message key (the page translates it on load).
  const blocked = invalidPage.includes('data-i18n="viewer.err.linkInvalid"')
    ? invalidPage.replace(/data-i18n="viewer\.err\.linkInvalid">[^<]*</, `data-i18n="viewer.err.blocked">${blockedText}<`)
    : invalidPage.replace(/<p>[^<]*<\/p>/, `<p>${blockedText}</p>`);
  return {
    join: read('join.html', invalid),
    watch: read('watch.html', invalid),
    invalid: invalidPage,
    blocked,
  };
}

export type { HttpServer };
