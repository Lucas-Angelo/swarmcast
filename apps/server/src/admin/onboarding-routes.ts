import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LiveController } from '../core/live.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const bodySchema = z.object({ done: z.boolean() });

/**
 * First-run setup tutorial (admin panel only). Completion is stored in config.json, so it
 * survives browser changes.
 *   GET  /api/onboarding  { done }
 *   POST /api/onboarding  { done: boolean } → { done }
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  live: LiveController,
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  app.get('/api/onboarding', { preHandler: auth }, async () => ({ done: live.onboardingDone }));
  app.post('/api/onboarding', { preHandler: auth }, wrap((req) => {
    live.setOnboardingDone(bodySchema.parse(req.body).done);
    return { done: live.onboardingDone };
  }));
}
