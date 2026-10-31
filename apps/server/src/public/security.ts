import { GIF_PROVIDERS, type GifProvider } from '@swarmcast/shared/chat';
import { createHash } from 'node:crypto';
import net from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Strict CSP for viewer pages: scripts only from ourselves, connections only to ourselves (+ STUN
 * for WebRTC). No inline script runs except those listed in `scriptHashes` by their hash
 * (inlineScriptHashes: the pages' startup guard), never 'unsafe-inline'.
 */
export function viewerCsp(host: string, secure: boolean, _stunServers: string[] = [], gif?: GifProvider, scriptHashes: readonly string[] = []): string {
  const wsScheme = secure ? 'wss' : 'ws';
  // GIFs (chat, opt-in): only while the streamer has them on, and only that provider's documented
  // hosts. Viewers' browsers still contact them only after each viewer agrees (consent in the page).
  const g = gif ? GIF_PROVIDERS[gif] : null;
  // STUN is not governed by connect-src (WebRTC ICE is outside CSP), and browsers reject
  // stun: URLs as invalid sources, so they are deliberately not listed.
  return [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes].join(' '),
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

/** An inline script: `<script>` with attributes but no src, and its text. */
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

/**
 * The CSP sources ('sha256-…') of the inline scripts in `pages`: the viewer pages' startup guard
 * (apps/viewer/join.html), taken from the pages as served, so the CSP always allows exactly the
 * script they carry. Hashed as the browser reads the text: the HTML parser turns CRLF and lone CR
 * into LF before the script sees it (a page saved with Windows line breaks).
 */
export function inlineScriptHashes(pages: readonly string[]): string[] {
  const hashes = new Set<string>();
  for (const html of pages) {
    for (const m of html.matchAll(INLINE_SCRIPT)) {
      const text = (m[1] ?? '').replace(/\r\n?/g, '\n');
      hashes.add(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
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
