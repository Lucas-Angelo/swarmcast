import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseSystemCheck, type SystemCheck } from '@swarmcast/shared/system-check';
import { readSmallFile } from '../core/small-file.js';

// The schema moved to the shared package (the panel reads the same file); re-exported for one cycle.
export { parseSystemCheck, systemCheckSchema, type SystemCheck, type SystemCheckResult } from '@swarmcast/shared/system-check';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Largest system-check.json we read (it is a few hundred bytes in practice). */
const MAX_BYTES = 64 * 1024;

/** Read `<data>/system-check.json`; null when missing, too big or invalid. */
export function readSystemCheck(file: string): SystemCheck | null {
  const text = readSmallFile(file, MAX_BYTES);
  return text === null ? null : parseSystemCheck(text);
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
