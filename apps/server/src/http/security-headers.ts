import type { FastifyReply } from 'fastify';

/**
 * HTTP plumbing both servers share: the viewer server (public/server.ts) and the panel
 * (admin/server.ts) send the same security headers, each with its own CSP, and check WebSocket
 * Origins the same way.
 */

/** Every answer's security headers with the server's own `csp`; `hsts` when it is reached over HTTPS. */
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

/** Origin must match the Host the request was sent to (blocks cross-site WebSocket hijacking). */
export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
