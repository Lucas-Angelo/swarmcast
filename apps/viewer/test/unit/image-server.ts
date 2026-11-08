// The page's own server for its images, in happy-dom (which loads no image by default, so an <img>
// would never fire load or error): every image request is answered here, with a real 1x1 PNG
// while the server is up and 502 once it is down, as a quick tunnel answers when SwarmCast stops.
// Restored after the test.
import { onTestFinished } from 'vitest';

/** A valid 1x1 PNG (happy-dom reads its size into naturalWidth / naturalHeight). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

interface HappyDomSettings {
  enableImageFileLoading: boolean;
  fetch: { interceptor: { beforeAsyncRequest?: (c: { request: { url: string } }) => Promise<unknown> } | null };
}
interface HappyDomWindow {
  happyDOM: { settings: HappyDomSettings };
  Response: new (body: Uint8Array | null, init: { status: number; headers?: Record<string, string> }) => unknown;
}

export interface ImageServer {
  /** false: every image request from now on fails (502). */
  up: boolean;
  /** Paths answered so far, with their status. */
  readonly answered: Array<{ path: string; status: number }>;
}

/** Answers the page's image requests until the test ends. */
export function imageServer(): ImageServer {
  const w = window as unknown as HappyDomWindow;
  const settings = w.happyDOM.settings;
  const before = { enableImageFileLoading: settings.enableImageFileLoading, interceptor: settings.fetch.interceptor };
  const server: ImageServer = { up: true, answered: [] };
  settings.enableImageFileLoading = true;
  settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request }) => {
      const status = server.up ? 200 : 502;
      server.answered.push({ path: new URL(request.url).pathname, status });
      return new w.Response(server.up ? new Uint8Array(PNG_1X1) : null, { status, headers: { 'content-type': 'image/png' } });
    },
  };
  onTestFinished(() => {
    settings.enableImageFileLoading = before.enableImageFileLoading;
    settings.fetch.interceptor = before.interceptor;
  });
  return server;
}
