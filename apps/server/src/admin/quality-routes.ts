import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { qualitySettingsUpdateSchema } from '@swarmcast/shared';
import type { LiveController } from '../core/live.js';
import { CodedError } from '../core/messages.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Quality API (admin panel only): ladder + upload settings, encoder probe, ffmpeg install.
 *   GET  /api/quality                 QualityState (+ install progress)
 *   PUT  /api/quality                 QualitySettingsUpdate → QualityState
 *   POST /api/quality/probe           re-run the encoder test
 *   POST /api/quality/ffmpeg/install  download + verify the pinned ffmpeg (returns at once; poll GET)
 */
export function registerQualityRoutes(
  app: FastifyInstance,
  live: LiveController,
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  const q = live.quality;
  const state = () => ({ ...q.state(), install: q.install });
  app.get('/api/quality', { preHandler: auth }, async () => state());
  app.put('/api/quality', { preHandler: auth }, wrap((req) => {
    q.updateSettings(qualitySettingsUpdateSchema.parse(req.body));
    return state();
  }));
  app.post('/api/quality/probe', { preHandler: auth }, wrap(async () => {
    if (live.phase === 'live') throw new CodedError('err.quality.probeLive');
    await q.probe(true);
    return state();
  }));
  app.post('/api/quality/ffmpeg/install', { preHandler: auth }, wrap(() => {
    void q.installFfmpeg().catch(() => {});
    return state();
  }));
}
