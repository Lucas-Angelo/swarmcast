import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desktopAutostartSchema, type DesktopInfoResponse } from '@swarmcast/shared';
import { CodedError } from '../core/messages.js';
import type { DesktopBridge } from '../desktop/bridge.js';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Desktop app (admin panel only; docs/DESKTOP.md). In script mode GET answers `{ desktop: false }`
 * and the others fail, so the panel hides its "Desktop app" section.
 *   GET  /api/desktop                  DesktopInfo (autostart read back from the OS)
 *   PUT  /api/desktop/autostart        { enabled } → DesktopInfo
 *   POST /api/desktop/update/check     asks the shell to look for an update → DesktopInfo
 *   POST /api/desktop/update/install   asks the shell to install it (stops the live) → DesktopInfo
 */
export function registerDesktopRoutes(
  app: FastifyInstance,
  desktop: DesktopBridge | undefined,
  auth: Handler,
  wrap: <T>(fn: (req: FastifyRequest) => Promise<T> | T) => Handler,
): void {
  const need = (): DesktopBridge => {
    if (!desktop) throw new CodedError('err.desktop.only');
    return desktop;
  };
  app.get('/api/desktop', { preHandler: auth }, async (): Promise<DesktopInfoResponse> => (desktop ? desktop.info(true) : { desktop: false }));
  app.put('/api/desktop/autostart', { preHandler: auth }, wrap(async (req) => {
    const d = need();
    const { enabled } = desktopAutostartSchema.parse(req.body);
    try {
      return await d.setAutostart(enabled);
    } catch (err) {
      if (err instanceof CodedError) throw err;
      throw new CodedError('err.desktop.autostart', { error: (err as Error).message });
    }
  }));
  app.post('/api/desktop/update/check', { preHandler: auth }, wrap(async () => {
    const d = need();
    d.requestUpdateCheck();
    return d.info();
  }));
  app.post('/api/desktop/update/install', { preHandler: auth }, wrap(async () => {
    const d = need();
    d.requestUpdateInstall();
    return d.info();
  }));
}
