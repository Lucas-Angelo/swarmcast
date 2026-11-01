import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { ServerMessage, ShareLinkResponse } from '@swarmcast/shared';
import { CookieJar } from '../../../../scripts/test/lib/cookie-jar.mjs';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import { SHARE_PER_SESSION_PER_MIN } from '../../src/public/server.js';
import { captureLog, FakeControlSocket } from './helpers.js';
import { joinViewer } from './helpers-b.js';
import { inactiveDirect, makeController, startController } from './live-helpers.js';

// The watch page's Share button (GET /api/share, panel "Viewers can share the link") against the
// real public server of a live. The answer holds the link secret, so it goes only to a viewer who
// joined with the current link while the streamer allows sharing: "Generate new link" keeps
// current viewers watching, and none of them may be handed the new link (they may be the ones it
// leaked to). Refusals look like any unknown path (404); kicked viewers have no session (401).
// The secret never reaches the logs. The pushes that show or hide the button (hello, {t:'share'})
// are read from the control channel.

afterEach(() => {
  vi.restoreAllMocks();
});

/** A started live without the browser check (browser-check.test.ts covers it), logging into `log`. */
async function live(log = captureLog().log): Promise<LiveController> {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  config.security.requireBrowserCheck = false;
  return (await startController(inactiveDirect(), { config, log })).live;
}

/** One browser (its own cookie jar) on `live`'s public server. */
class Viewer {
  readonly jar = new CookieJar();
  constructor(private readonly live: LiveController) {}

  fetch(p: string, init: RequestInit = {}): Promise<Response> {
    return this.jar.fetch(`http://127.0.0.1:${this.live.publicPort}${p}`, init);
  }

  /** Opens `link` (the live link of now by default), picks a nickname and joins. */
  async join(nickname: string, link = this.live.liveLink!): Promise<this> {
    expect((await this.fetch(new URL(link).pathname)).status).toBe(303);
    const res = await this.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
    expect(res.status, await res.clone().text()).toBe(200);
    return this;
  }

  share(): Promise<Response> {
    return this.fetch('/api/share');
  }
}

const sessionOf = (l: LiveController, nickname: string) => [...l.access.sessions.values()].find((s) => s.nickname === nickname)!;

describe('GET /api/share', () => {
  it('gives a viewer who joined with the current link that link, never cached', async () => {
    // Arrange
    const l = await live();
    const ana = await new Viewer(l).join('Ana');
    // Act
    const res = await ana.share();
    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as ShareLinkResponse;
    expect(body).toEqual({ url: l.liveLink });
    expect(body.url).toBe(`http://127.0.0.1:${l.publicPort}/join/${l.access.currentSecret}`);
  });

  it('after "Generate new link" refuses viewers who joined with the old link, who keep watching', async () => {
    // Arrange
    const l = await live();
    const ana = await new Viewer(l).join('Ana');
    const oldLink = l.liveLink!;
    // Act
    const newLink = l.rotateLink()!;
    const refused = await ana.share();
    const config = await ana.fetch('/api/config');
    // Assert
    expect(newLink).not.toBe(oldLink);
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain(l.access.currentSecret);
    expect(config.status).toBe(200);
  });

  it('gives the new link to a viewer who joined with it', async () => {
    // Arrange
    const l = await live();
    await new Viewer(l).join('Ana');
    const newLink = l.rotateLink()!;
    const bia = await new Viewer(l).join('Bia', newLink);
    // Act
    const res = await bia.share();
    // Assert
    expect(res.status).toBe(200);
    expect(((await res.json()) as ShareLinkResponse).url).toBe(newLink);
  });

  it('refuses a kicked viewer (no session any more)', async () => {
    // Arrange
    const l = await live();
    const ana = await new Viewer(l).join('Ana');
    // Act
    l.kick(sessionOf(l, 'Ana').id);
    const res = await ana.share();
    // Assert
    expect(res.status).toBe(401);
  });

  it('refuses a browser that never joined', async () => {
    // Arrange
    const l = await live();
    // Act
    const res = await new Viewer(l).share();
    // Assert
    expect(res.status).toBe(401);
  });

  it('refuses everyone while the streamer turned sharing off, and answers again once it is back on', async () => {
    // Arrange
    const l = await live();
    const ana = await new Viewer(l).join('Ana');
    // Act
    l.updateSettings({ ...l.snapshot().settings, allowViewerShare: false });
    const off = await ana.share();
    l.updateSettings({ ...l.snapshot().settings, allowViewerShare: true });
    const on = await ana.share();
    // Assert
    expect(off.status).toBe(404);
    expect(on.status).toBe(200);
  });

  it(`answers ${SHARE_PER_SESSION_PER_MIN} times a minute per viewer, then 429; another viewer is not affected`, async () => {
    // Arrange
    const l = await live();
    const ana = await new Viewer(l).join('Ana');
    const bia = await new Viewer(l).join('Bia');
    const statuses: number[] = [];
    // Act
    for (let i = 0; i < SHARE_PER_SESSION_PER_MIN + 1; i++) statuses.push((await ana.share()).status);
    const other = await bia.share();
    // Assert
    expect(statuses.slice(0, SHARE_PER_SESSION_PER_MIN)).toEqual(Array<number>(SHARE_PER_SESSION_PER_MIN).fill(200));
    expect(statuses.at(-1)).toBe(429);
    expect(other.status).toBe(200);
  });

  it('never writes the link secret to the log', async () => {
    // Arrange
    const { log, lines } = captureLog('trace');
    const l = await live(log);
    const ana = await new Viewer(l).join('Ana');
    // Act
    for (let i = 0; i < SHARE_PER_SESSION_PER_MIN + 1; i++) await ana.share();
    l.rotateLink();
    await ana.share();
    // Assert
    expect(lines().length).toBeGreaterThan(0);
    const text = JSON.stringify(lines());
    expect(text).not.toContain(l.access.currentSecret);
  });
});

describe('the Share button follows the server (hello, {t:"share"})', () => {
  /** A live that began, Ana in it, and every message it sent to viewers one by one. */
  function begun() {
    const { live } = makeController();
    const send = vi.spyOn(live.control, 'send');
    live.access.begin();
    const ana = joinViewer(live.access, 'ana');
    return { live, ana, sent: (): Array<[string, ServerMessage]> => send.mock.calls.map(([id, m]) => [id, m]) };
  }
  const shares = (sent: Array<[string, ServerMessage]>) => sent.flatMap(([id, m]) => (m.t === 'share' ? [[id, m.allowed] as const] : []));

  it('allows a viewer of the current link by default', () => {
    // Arrange
    const { live, ana } = begun();
    // Act
    const allowed = live.access.canShare(ana);
    // Assert
    expect(allowed).toBe(true);
  });

  it('tells everyone watching that they can no longer share after "Generate new link"', () => {
    // Arrange
    const { live, ana, sent } = begun();
    // Act
    live.rotateLink();
    // Assert
    expect(shares(sent())).toEqual([[ana.id, false]]);
    expect(live.access.canShare(ana)).toBe(false);
  });

  it('tells viewers when the streamer turns sharing off and on, only when it changes', () => {
    // Arrange
    const { live, ana, sent } = begun();
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: false });
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: false });
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: true });
    // Assert
    expect(shares(sent())).toEqual([
      [ana.id, false],
      [ana.id, true],
    ]);
  });

  it('keeps an old-link viewer refused when sharing is turned back on', () => {
    // Arrange
    const { live, ana, sent } = begun();
    live.rotateLink();
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: false });
    // Act
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: true });
    // Assert
    expect(shares(sent()).at(-1)).toEqual([ana.id, false]);
  });

  it('is on by default and saved with the settings', () => {
    // Arrange
    const saved: boolean[] = [];
    const { live } = makeController(inactiveDirect(), { saveConfig: (c) => void saved.push(c.allowViewerShare) });
    // Act
    const before = live.snapshot().settings.allowViewerShare;
    live.updateSettings({ ...live.snapshot().settings, allowViewerShare: false });
    // Assert
    expect(before).toBe(true);
    expect(saved).toEqual([false]);
    expect(live.snapshot().settings.allowViewerShare).toBe(false);
  });

  it("puts the viewer's permission in hello: allowed with the current link, not after a new one", () => {
    // Arrange
    const { live, ana } = begun();
    const hello = (): ServerMessage => {
      const sock = new FakeControlSocket();
      live.control.attach(sock as unknown as WebSocket, ana, { url: '/control' } as IncomingMessage);
      return JSON.parse(sock.sent[0]!) as ServerMessage;
    };
    // Act
    const before = hello();
    live.rotateLink();
    const after = hello();
    // Assert
    expect(before).toMatchObject({ t: 'hello', shareAllowed: true });
    expect(after).toMatchObject({ t: 'hello', shareAllowed: false });
  });
});
