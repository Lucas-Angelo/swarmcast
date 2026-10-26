import crypto from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  ADMIN_COOKIE,
  directEnableSchema,
  securitySettingsSchema,
  settingsSchema,
  type AdminDesktopMessage,
  type AdminLogMessage,
  type ApiErrorBody,
  type DirectCheckResponse,
} from '@swarmcast/shared';
import type { CheckResult } from '../direct/direct.js';
import type { DesktopBridge } from '../desktop/bridge.js';
import type { Diagnostics } from '../diagnostics/diagnostics.js';
import type { LiveController } from '../core/live.js';
import type { Logger } from '../core/logger.js';
import { codeOf, coded } from '../core/messages.js';
import { applySecurityHeaders } from '../public/security.js';
import { registerDesktopRoutes } from './desktop-routes.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import { gateHead, notAuthorizedPage, signedInPage } from './gate.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerQualityRoutes } from './quality-routes.js';
import { registerSystemCheckRoutes } from './system-check-routes.js';

export interface AdminOptions {
  port: number;
  adminDir: string;
  live: LiveController;
  log: Logger;
  /** Per-run secret; the app opens http://127.0.0.1:<port>/auth/<token> in the browser. */
  token: string;
  onQuit: () => void;
  checkDirect: () => Promise<CheckResult>;
  cleanupStale: () => Promise<boolean>;
  /** <data>/system-check.json written by the start scripts (shown in the setup tutorial). */
  systemCheckFile?: string;
  /** Desktop mode only (`--desktop`): autostart, updates, first-run check. */
  desktop?: DesktopBridge;
  /** Log retention setting and "Export logs" (diagnostics-routes.ts). */
  diagnostics?: Diagnostics;
}

/**
 * Admin panel + API. Listens on 127.0.0.1 only, on a different port from the public server,
 * so it can never be reached through the tunnel. Rejects foreign Host/Origin headers
 * (DNS rebinding, CSRF) and requires a per-run token cookie.
 */
export async function createAdminServer(o: AdminOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, forceCloseConnections: true });
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const tokenHash = crypto.createHash('sha256').update(o.token).digest();
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    // Self-hosted brand fonts (Inter, Fredoka) bundled into /assets.
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${o.port} ws://localhost:${o.port}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  // Stylesheet + favicon of the sign-in and "not authorized" pages (gate.ts), read once.
  const gate = gateHead(o.adminDir);

  const tokenOk = (t: string | undefined): boolean =>
    !!t && t.length < 200 && crypto.timingSafeEqual(crypto.createHash('sha256').update(t).digest(), tokenHash);

  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.addHook('onRequest', async (req, reply) => {
    applySecurityHeaders(reply, csp, false);
    reply.header('Cache-Control', 'no-store');
    if (!allowedHosts.has(req.headers.host ?? '')) {
      return reply.code(421).send('Wrong host');
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send('Forbidden origin');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!origin) return reply.code(403).send('Missing origin');
      // JSON only: a cross-site form cannot send it without a CORS preflight (which we never allow).
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return reply.code(415).send('JSON required');
    }
  });

  // SWARMCAST_LOG_LEVEL=debug: one line per panel request (the login token is never logged).
  const logPath = (url: string): string => (url.startsWith('/auth/') ? '/auth/…' : url.split('?')[0]!);
  app.addHook('onResponse', async (req, reply) => {
    o.log.debug({ method: req.method, path: logPath(req.url), status: reply.statusCode }, 'panel request');
  });

  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!tokenOk(req.cookies[ADMIN_COOKIE])) {
      const c = coded('err.notAuthorized');
      reply.code(401).send({ error: c.text, code: c.code } satisfies ApiErrorBody);
      return reply;
    }
  };

  app.get<{ Params: { token: string } }>('/auth/:token', async (req, reply) => {
    if (!tokenOk(req.params.token)) return reply.code(401).type('text/html; charset=utf-8').send(notAuthorizedPage(req.headers['accept-language'], gate));
    reply.setCookie(ADMIN_COOKIE, req.params.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: false });
    // Also set for every admin response (onRequest); repeated here because this page must never be
    // cached or leak its URL (the token) as a referrer.
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(signedInPage(req.headers['accept-language'], gate));
  });

  await app.register(fastifyStatic, { root: o.adminDir, prefix: '/', index: false, wildcard: false, serve: false });
  app.get('/', async (req, reply) => {
    if (!tokenOk(req.cookies[ADMIN_COOKIE])) return reply.code(401).type('text/html; charset=utf-8').send(notAuthorizedPage(req.headers['accept-language'], gate));
    // Never cached: after an update, the window or tab must load the new index.html, whose
    // hashed /assets names point at the new code. (Without cacheControl: false, the static
    // plugin would replace the no-store set in onRequest with its own `public, max-age=0`.)
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html', o.adminDir, { cacheControl: false });
  });
  // Vite gives every file in /assets a content hash, so its URL never changes meaning.
  app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
    return reply.sendFile(path.posix.join('assets', req.params['*']), o.adminDir, { maxAge: '365d', immutable: true });
  });

  const L = o.live;
  const wrap =
    <T>(fn: (req: FastifyRequest) => Promise<T> | T) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message, ...codeOf(err) } satisfies ApiErrorBody);
      }
    };

  app.get('/api/state', { preHandler: auth }, async () => L.snapshot());
  app.post('/api/live/start', { preHandler: auth }, wrap(async () => {
    await L.start();
    return L.snapshot();
  }));
  app.post('/api/live/stop', { preHandler: auth }, wrap(async () => ({ verified: await L.stop() })));
  app.post('/api/link/rotate', { preHandler: auth }, wrap(() => ({ liveLink: L.rotateLink() })));
  app.post('/api/viewers/disconnect-all', { preHandler: auth }, wrap(() => {
    L.disconnectAll();
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/viewers/:id/kick', { preHandler: auth }, wrap((req) => ({ ok: L.kick((req.params as { id: string }).id) })));
  app.post<{ Params: { id: string } }>('/api/viewers/:id/p2p', { preHandler: auth }, wrap((req) => {
    const body = z.object({ allowed: z.boolean() }).parse(req.body);
    return { ok: L.setP2P((req.params as { id: string }).id, body.allowed) };
  }));
  app.post('/api/bans/clear', { preHandler: auth }, wrap(() => {
    L.clearBans();
    return { ok: true };
  }));
  app.put('/api/settings', { preHandler: auth }, wrap((req) => {
    L.updateSettings(settingsSchema.parse(req.body));
    return L.snapshot().settings;
  }));
  app.put('/api/security', { preHandler: auth }, wrap((req) => {
    L.updateSecurity(securitySettingsSchema.parse(req.body));
    return L.snapshot().security;
  }));
  app.post('/api/security/clear', { preHandler: auth }, wrap(() => {
    L.clearAttackAlert();
    return { ok: true };
  }));
  app.post('/api/speedtest', { preHandler: auth }, wrap(async () => ({ result: await L.runSpeedTest() })));
  app.post('/api/direct/check', { preHandler: auth }, wrap(async () => {
    const r = await o.checkDirect();
    const body: DirectCheckResponse = {
      ok: r.ok,
      message: r.message,
      code: r.code,
      ...(r.params ? { params: r.params } : {}),
      needsManualForward: r.ok ? r.needsManualForward : false,
      ...(r.ok ? {} : { reason: r.reason }),
    };
    return body;
  }));
  app.post('/api/direct/enable', { preHandler: auth }, wrap(async (req) => {
    const body = directEnableSchema.parse(req.body);
    return { liveLink: await L.enableDirect({ manualPortForward: body.manualPortForward }) };
  }));
  app.post('/api/direct/disable', { preHandler: auth }, wrap(async () => ({ liveLink: await L.disableDirect() })));
  app.post('/api/direct/cleanup-stale', { preHandler: auth }, wrap(async () => ({ ok: await o.cleanupStale() })));
  app.get('/api/activity', { preHandler: auth }, async () => L.activity.list());
  app.post('/api/activity/clear', { preHandler: auth }, wrap(() => {
    L.activity.clear();
    return { ok: true };
  }));
  registerQualityRoutes(app, L, auth, wrap);
  registerOnboardingRoutes(app, L, auth, wrap);
  registerSystemCheckRoutes(app, o.systemCheckFile, auth);
  registerDesktopRoutes(app, o.desktop, auth, wrap);
  registerDiagnosticsRoutes(app, o.diagnostics, auth, wrap);
  app.post('/api/app/quit', { preHandler: auth }, wrap(() => {
    setTimeout(o.onQuit, 100);
    return { ok: true };
  }));

  // Live state push over WebSocket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    const cookies = app.parseCookie(req.headers.cookie ?? '');
    if (
      new URL(req.url ?? '/', 'http://x').pathname !== '/ws' ||
      !allowedHosts.has(req.headers.host ?? '') ||
      !allowedOrigins.has(req.headers.origin ?? '') ||
      !tokenOk(cookies[ADMIN_COOKIE])
    ) {
      o.log.debug('panel WebSocket refused');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    o.log.debug('panel WebSocket connected');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify(L.snapshot()));
      ws.send(JSON.stringify({ type: 'log', reset: true, entries: L.activity.list() } satisfies AdminLogMessage));
      if (o.desktop) ws.send(JSON.stringify({ type: 'desktop', ...o.desktop.snapshot() } satisfies AdminDesktopMessage));
    });
  });
  let pending: NodeJS.Timeout | null = null;
  const push = (): void => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const data = JSON.stringify(L.snapshot());
      for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(data);
    }, 250);
  };
  L.on('state', push);
  // Activity entries go out right away, as their own message type (the state message is unchanged).
  const broadcast = (msg: AdminLogMessage | AdminDesktopMessage): void => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(data);
  };
  const onEntry = (entry: AdminLogMessage['entries'][number]): void => broadcast({ type: 'log', reset: false, entries: [entry] });
  const onClear = (): void => broadcast({ type: 'log', reset: true, entries: [] });
  L.activity.on('entry', onEntry);
  L.activity.on('clear', onClear);
  // Desktop app state (update status from the shell, autostart, first-run check) as its own message.
  const onDesktop = (): void => {
    if (o.desktop) broadcast({ type: 'desktop', ...o.desktop.snapshot() });
  };
  o.desktop?.on('changed', onDesktop);
  app.addHook('onClose', async () => {
    L.off('state', push);
    L.activity.off('entry', onEntry);
    L.activity.off('clear', onClear);
    o.desktop?.off('changed', onDesktop);
    for (const c of wss.clients) c.terminate();
    wss.close();
  });

  return app;
}
