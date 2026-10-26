import net from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Strict CSP for viewer pages: no inline scripts, connections only to ourselves (+ STUN for WebRTC). */
export function viewerCsp(host: string, secure: boolean, _stunServers: string[] = []): string {
  const wsScheme = secure ? 'wss' : 'ws';
  // STUN is not governed by connect-src (WebRTC ICE is outside CSP), and browsers reject
  // stun: URLs as invalid sources, so they are deliberately not listed.
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${wsScheme}://${host}`,
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function applySecurityHeaders(reply: FastifyReply, csp: string, hsts: boolean): void {
  reply.header('Content-Security-Policy', csp);
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=(), fullscreen=(self), autoplay=(self), picture-in-picture=(self)',
  );
  if (hsts) reply.header('Strict-Transport-Security', 'max-age=31536000');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Client IP for rate limiting and bans. Only trusts CF-Connecting-IP when the request
 * comes from the local tunnel connector and the tunnel proxy is trusted. Never reads X-Forwarded-For.
 */
export function clientIp(req: FastifyRequest | { socket: { remoteAddress?: string }; headers: Record<string, unknown> }, trustTunnel: boolean): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (trustTunnel && LOOPBACK.has(remote)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && net.isIP(cf.trim())) return cf.trim();
  }
  return remote;
}

export function isMobileUserAgent(ua: string | undefined): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua ?? '');
}

/** Origin must match the Host the request was sent to (blocks cross-site WebSocket hijacking). */
export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
