import { GIF_PROVIDERS, type GifProvider } from '@swarmcast/shared/chat';
import net from 'node:net';
import type { FastifyRequest } from 'fastify';

// Shared with the panel server, so they live in http/; re-exported for one cycle.
export { applySecurityHeaders, originMatchesHost } from '../http/security-headers.js';

/** Strict CSP for viewer pages: no inline scripts, connections only to ourselves (+ STUN for WebRTC). */
export function viewerCsp(host: string, secure: boolean, _stunServers: string[] = [], gif?: GifProvider): string {
  const wsScheme = secure ? 'wss' : 'ws';
  // GIFs (chat, opt-in): only while the streamer has them on, and only that provider's documented
  // hosts. Viewers' browsers still contact them only after each viewer agrees (consent in the page).
  const g = gif ? GIF_PROVIDERS[gif] : null;
  // STUN is not governed by connect-src (WebRTC ICE is outside CSP), and browsers reject
  // stun: URLs as invalid sources, so they are deliberately not listed.
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data:${g ? ` ${g.media.join(' ')}` : ''}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${wsScheme}://${host}${g ? ` ${g.api}` : ''}`,
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
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
