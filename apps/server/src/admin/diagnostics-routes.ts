import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { diagnosticsSettingsSchema, logExportRequestSchema } from '@swarmcast/shared';
import { CodedError } from '../core/messages.js';
import type { Diagnostics } from '../diagnostics/diagnostics.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Exports per minute (each one reads up to 14 days of logs and writes a ZIP). */
export const EXPORT_RATE_LIMIT = { max: 4, timeWindow: '1 minute' } as const;

/**
 * Diagnostics (admin panel only). Same auth and CSRF rules as every admin route (per-run token
 * cookie, Host/Origin checks, JSON bodies only; see server.ts).
 *   GET  /api/diagnostics                 { logRetentionDays }
 *   PUT  /api/diagnostics                 { logRetentionDays: 3..90 } → settings
 *   POST /api/diagnostics/export          { includeFullIps? } → LogExportResult (rate-limited)
 *   POST /api/diagnostics/reveal          { path } → { ok } (only a ZIP this run exported)
 */
export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  diagnostics: Diagnostics | undefined,
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  if (!diagnostics) return;
  const d = diagnostics;
  app.get('/api/diagnostics', { preHandler: auth }, async () => d.settings());
  app.put('/api/diagnostics', { preHandler: auth }, wrap((req) => d.updateSettings(diagnosticsSettingsSchema.parse(req.body))));
  app.post(
    '/api/diagnostics/export',
    { preHandler: auth, config: { rateLimit: EXPORT_RATE_LIMIT } },
    wrap(async (req) => {
      const body = logExportRequestSchema.parse(req.body ?? {});
      try {
        return await d.exportLogs({ includeFullIps: body.includeFullIps });
      } catch (err) {
        throw new CodedError('err.diagnostics.export', { error: (err as Error).message });
      }
    }),
  );
  app.post('/api/diagnostics/reveal', { preHandler: auth }, wrap((req) => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(req.body);
    return { ok: d.reveal(path) };
  }));
}
