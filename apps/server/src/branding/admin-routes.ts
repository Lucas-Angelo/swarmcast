import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BRAND_SLOTS, BRAND_UPLOAD_MAX, brandSlotSchema, brandingIssue, brandingTextSchema, deriveTheme, type AdminBrandingState, type BrandSlot } from '@swarmcast/shared/branding';
import type { MessageKey } from '@swarmcast/shared/i18n';
import { comparisonKey } from '@swarmcast/shared/chat/skeleton';
import { CodedError } from '../core/messages.js';
import { BrandingStore } from './store.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Raw image types accepted on PUT /api/branding/image/:slot (none is CORS-safelisted). */
export const BRAND_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const BRAND_IMAGE_ROUTE = /^\/api\/branding\/image\/[a-z0-9]+$/;

/**
 * Panel API of "Your page" (plan §5.3), behind the panel login and the Host/Origin checks.
 *   GET    /api/branding                 config, derived theme, image URLs, the public payload
 *   PUT    /api/branding                 text, links, support, theme, preview (JSON)
 *   PUT    /api/branding/image/:slot     raw image/png|jpeg|webp body, the slot's exact size
 *   DELETE /api/branding/image/:slot     remove it (and its variants)
 *   GET    /api/branding/file/:sha.:ext  the stored bytes, for the panel's preview
 *   POST   /api/branding/reset           back to the SwarmCast defaults
 */
export function registerBrandingAdminRoutes(
  app: FastifyInstance,
  d: { store: BrandingStore; changed: () => void },
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  const state = (): AdminBrandingState => {
    const pub = d.store.publicBranding({ base: '/api/branding/file/' });
    const b = d.store.branding;
    const images: AdminBrandingState['images'] = {};
    for (const slot of Object.keys(BRAND_SLOTS) as BrandSlot[]) {
      const url = BrandingStore.url(b.images[slot], '/api/branding/file/');
      if (url) images[slot] = url;
    }
    return { branding: b, derived: deriveTheme(b.theme), images, public: pub ?? { rev: b.rev, tags: [], links: [], theme: { preset: b.theme.preset, corners: b.theme.corners }, showCredit: b.showCredit }, disk: d.store.disk() };
  };

  app.get('/api/branding', { preHandler: auth }, async () => state());

  app.put('/api/branding', { preHandler: auth }, wrap((req) => {
    const parsed = brandingTextSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = brandingIssue(parsed.error);
      if (issue) throw Object.assign(new CodedError(issue.code, issue.params), { field: issue.path.join('.') });
      throw parsed.error;
    }
    const t = parsed.data;
    // Tags unique by look-alike key.
    const seen = new Set<string>();
    for (const tag of t.tags) {
      const k = comparisonKey(tag);
      if (seen.has(k)) throw new CodedError('brand.err.tagDup');
      seen.add(k);
    }
    if (t.support.enabled && !(t.support.mode === 'pix' ? t.support.pix : t.support.url)) throw new CodedError('brand.err.support');
    d.store.saveText(t);
    d.changed();
    return state();
  }));

  // Raw image bodies: a parser registered in this scope only, so no other route accepts them.
  void app.register(async (scope) => {
    scope.addContentTypeParser([...BRAND_IMAGE_TYPES], { parseAs: 'buffer', bodyLimit: BRAND_UPLOAD_MAX }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { slot: string } }>('/api/branding/image/:slot', { preHandler: auth, bodyLimit: BRAND_UPLOAD_MAX }, wrap((req) => {
      const slot = brandSlotSchema.parse((req.params as { slot: string }).slot);
      if (!Buffer.isBuffer(req.body)) throw new CodedError('img.type');
      const r = d.store.putImage(slot, req.body);
      if (!r.ok) throw new CodedError(r.code as MessageKey, r.params);
      d.changed();
      return { ref: r.ref, state: state() };
    }));
  });

  app.delete<{ Params: { slot: string } }>('/api/branding/image/:slot', { preHandler: auth }, wrap((req) => {
    d.store.removeImage(brandSlotSchema.parse((req.params as { slot: string }).slot));
    d.changed();
    return state();
  }));

  app.get<{ Params: { file: string } }>('/api/branding/file/:file', { preHandler: auth }, async (req, reply) => {
    const m = /^([0-9a-f]{64})\.(png|jpg|webp)$/.exec(req.params.file);
    const f = m ? d.store.file(m[1]!) : undefined;
    if (!f) return reply.code(404).send({ error: 'Not found' });
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type(f.mime).send(f.bytes);
  });

  app.post('/api/branding/reset', { preHandler: auth }, wrap(() => {
    d.store.reset();
    d.changed();
    return state();
  }));
}
