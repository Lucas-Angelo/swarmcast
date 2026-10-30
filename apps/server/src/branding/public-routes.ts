import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BandwidthLimiter } from '../hls/throttle.js';
import type { BrandingStore } from './store.js';

export interface BrandingPublicDeps {
  store: BrandingStore;
  limiter: BandwidthLimiter;
  /** The request carries a valid join ticket or session cookie (the stream's members only). */
  member: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  /** Id of the current live (part of the ETag, so a new live never reuses a cached answer). */
  liveId: () => string;
  /** Under attack or a saturated uplink: the page skips the banner. */
  lite: () => boolean;
  /** The stock "not found / link not valid" answer. */
  notFound: (reply: FastifyReply) => FastifyReply;
}

const FILE = /^([0-9a-f]{64})\.(png|jpg|webp)$/;

/**
 * Viewer routes of "Your page" (plan §5.4). Everything is behind the join ticket or the session:
 * a hostname scanner never learns whose stream it is. `private` on every answer: Cloudflare caches
 * .png/.jpg/.webp/.css by extension and ignores cookies in its cache key, so `public` would bypass
 * the gate. Images go through the upload limiter like video.
 */
export function registerBrandingPublicRoutes(app: FastifyInstance, d: BrandingPublicDeps): void {
  app.get('/api/brand', async (req, reply) => {
    if (!(await d.member(req, reply))) return d.notFound(reply);
    const lite = d.lite();
    const host = req.headers.host ?? '';
    const body = d.store.publicBranding({ ownHost: host, lite });
    const etag = `"b${body?.rev ?? 'off'}-${d.liveId()}${lite ? '-l' : ''}"`;
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body ?? { off: true };
  });

  app.get('/brand/theme.css', async (req, reply) => {
    reply.type('text/css; charset=utf-8');
    reply.header('Cache-Control', 'private, no-cache');
    // Never break the page: strangers and unbranded streams get an empty stylesheet.
    if (!(await d.member(req, reply))) return reply.send('/* */\n');
    const css = d.store.themeCss() || '/* */\n';
    const etag = `"t${css.length}-${hash(css)}"`;
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(css);
  });

  app.get<{ Params: { file: string } }>('/brand/:file', async (req, reply) => {
    const m = FILE.exec(req.params.file);
    if (!m || !(await d.member(req, reply))) return d.notFound(reply);
    const f = d.store.file(m[1]!);
    // The extension in the URL must match what the bytes are; the type is never taken from the URL.
    if (!f || (f.type === 'jpeg' ? 'jpg' : f.type) !== m[2]) return d.notFound(reply);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('Content-Length', f.bytes.length);
    reply.type(f.mime);
    return reply.send(d.limiter.stream(f.bytes));
  });
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}
