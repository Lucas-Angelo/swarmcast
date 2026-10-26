import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Largest system-check.json we read (it is a few hundred bytes in practice). */
const MAX_BYTES = 64 * 1024;

const value = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]).optional();

/**
 * Result of the start script's system check, written to `<data>/system-check.json` (English values).
 * Unknown result ids are kept (the panel shows them with their raw id); unknown fields are dropped.
 */
export const systemCheckSchema = z.object({
  version: z.literal(1),
  at: z.union([z.string().max(64), z.number()]),
  os: z.string().max(100),
  arch: z.string().max(40),
  results: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        status: z.enum(['ok', 'warn', 'fail', 'skipped']),
        value,
        min: value,
        recommended: value,
        detail: z.string().max(500).optional(),
      }),
    )
    .max(50),
  uploadMbps: z.number().nullable().optional(),
  downloadMbps: z.number().nullable().optional(),
  viewerEstimate: z.number().nullable().optional(),
  belowMinimum: z.array(z.string().max(40)).max(50).default([]),
});

export type SystemCheck = z.infer<typeof systemCheckSchema>;

/** Parse the file's text; null when it is not a valid system check. */
export function parseSystemCheck(text: string): SystemCheck | null {
  try {
    const r = systemCheckSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Read `<data>/system-check.json`; null when missing, too big or invalid. */
export function readSystemCheck(file: string): SystemCheck | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return parseSystemCheck(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Installer system check (admin panel only), shown in the setup tutorial's "Your PC check" step.
 *   GET /api/system-check  SystemCheck, or 404 when the start script did not write one
 */
export function registerSystemCheckRoutes(app: FastifyInstance, file: string | undefined, auth: Handler): void {
  app.get('/api/system-check', { preHandler: auth }, async (_req, reply) => {
    const data = file ? readSystemCheck(file) : null;
    if (!data) return reply.code(404).send({ error: 'No system check available.' });
    return data;
  });
}
