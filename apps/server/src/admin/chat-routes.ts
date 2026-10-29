import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { chatAdminSendSchema, chatDeleteSchema, chatMuteSchema, chatProtectRequestSchema, chatSetColorSchema, chatUnmuteSchema, type MessageKey } from '@swarmcast/shared';
import type { LiveController } from '../core/live.js';
import { CodedError } from '../core/messages.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Chat API (admin panel only, behind the panel login and the Host/Origin checks of server.ts;
 * bodies validated by zod). docs/CHAT.md.
 *   GET  /api/chat           settings, effective settings, ring, sessions, counters
 *   PUT  /api/chat/settings  chat settings → saved to config.json, pushed to viewers
 *   POST /api/chat/send      {text} | {gif}: a message as the streamer
 *   POST /api/chat/delete    {seqs}
 *   POST /api/chat/clear
 *   POST /api/chat/mute      {sessionId, minutes | null (until the end of this live)}
 *   POST /api/chat/unmute    {sessionId}
 *   PUT  /api/chat/color     {sessionId, color | null, lock}
 *   POST /api/chat/protect   {mode: off | slow | lockdown}
 */
export function registerChatRoutes(
  app: FastifyInstance,
  live: LiveController,
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  const chat = live.chat;
  const need = (ok: boolean): { ok: true } => {
    if (!ok) throw new CodedError('admin.chat.err.noSession');
    return { ok: true };
  };
  app.get('/api/chat', { preHandler: auth }, async () => chat.adminState());
  app.put('/api/chat/settings', { preHandler: auth }, wrap((req) => {
    const settings = live.updateChatSettings(req.body);
    return { settings, effective: chat.effective.public };
  }));
  app.post('/api/chat/send', { preHandler: auth }, wrap((req) => {
    const r = chat.sendAsStreamer(chatAdminSendSchema.parse(req.body));
    if (!r.ok) throw new CodedError(r.code as MessageKey, r.params);
    return r;
  }));
  app.post('/api/chat/delete', { preHandler: auth }, wrap((req) => ({ ok: true, removed: chat.delete(chatDeleteSchema.parse(req.body).seqs) })));
  app.post('/api/chat/clear', { preHandler: auth }, wrap(() => {
    chat.clear();
    return { ok: true };
  }));
  app.post('/api/chat/mute', { preHandler: auth }, wrap((req) => {
    const b = chatMuteSchema.parse(req.body);
    return need(chat.mute(b.sessionId, b.minutes));
  }));
  app.post('/api/chat/unmute', { preHandler: auth }, wrap((req) => need(chat.unmute(chatUnmuteSchema.parse(req.body).sessionId))));
  app.put('/api/chat/color', { preHandler: auth }, wrap((req) => {
    const b = chatSetColorSchema.parse(req.body);
    return need(chat.setColor(b.sessionId, b.color, b.lock));
  }));
  app.post('/api/chat/protect', { preHandler: auth }, wrap((req) => {
    chat.setProtect(chatProtectRequestSchema.parse(req.body).mode);
    return { ok: true, protect: chat.protection };
  }));
}
