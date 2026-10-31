import { GIF_PROVIDERS, type GifProvider } from '@swarmcast/shared/chat';
import { STARTUP_GUARD } from '@swarmcast/shared/web/startup-guard';
import { createHash } from 'node:crypto';
import net from 'node:net';
import type { FastifyRequest } from 'fastify';

// Shared with the panel server, so they live in http/; re-exported for one cycle.
export { applySecurityHeaders, originMatchesHost } from '../http/security-headers.js';

/**
 * The CSP source of the viewer pages' one inline script, their startup guard: its SHA-256, as the
 * browser computes it from the text the viewer build wrote into the page (the same constant).
 */
export const STARTUP_GUARD_SOURCE = `'sha256-${createHash('sha256').update(STARTUP_GUARD, 'utf8').digest('base64')}'`;

/**
 * Strict CSP for viewer pages: scripts only from ourselves, connections only to ourselves (+ STUN
 * for WebRTC). No inline script runs but the startup guard, allowed by its hash; never
 * 'unsafe-inline'.
 */
export function viewerCsp(host: string, secure: boolean, _stunServers: string[] = [], gif?: GifProvider): string {
  const wsScheme = secure ? 'wss' : 'ws';
  // GIFs (chat, opt-in): only while the streamer has them on, and only that provider's documented
  // hosts. Viewers' browsers still contact them only after each viewer agrees (consent in the page).
  const g = gif ? GIF_PROVIDERS[gif] : null;
  // STUN is not governed by connect-src (WebRTC ICE is outside CSP), and browsers reject
  // stun: URLs as invalid sources, so they are deliberately not listed.
  return [
    "default-src 'none'",
    `script-src 'self' ${STARTUP_GUARD_SOURCE}`,
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
