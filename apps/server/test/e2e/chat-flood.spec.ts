// The video-first gate of the chat (chat plan §6.6 and §10.5, chat-flood.spec.ts @media): one
// real viewer plays the stream while scripted viewers flood the chat at the highest rate their
// sockets allow. Compared with a calm stretch of the same live, the player must not stall more,
// the HLS answers must not get slower beyond a small margin, and a kick must still arrive within
// a second. The full bench (more viewers, more scenarios) is scripts/test/chat/bench.ts.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import WebSocket from 'ws';
import type { Page } from '@playwright/test';
import type { AdminChatState, ChatSettings, ServerMessage } from '@swarmcast/shared';
import { admin, adminApi, expect, join, liveLink, startStallMonitor, stallReport, test, uid, unmute, viewerByNick, waitPlaying } from './fixtures.js';

const BOTS = 24;
const SECONDS = 20;

/** A scripted viewer: joins like a browser (link → ticket → /api/join), then holds /control. */
class Bot {
  private cookies = new Map<string, string>();
  ws: WebSocket | null = null;
  kickedAt = 0;
  constructor(
    readonly base: string,
    readonly nickname: string,
  ) {}
  private header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(p.startsWith('http') ? p : this.base + p, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: this.header() } });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0]!;
      const eq = pair.indexOf('=');
      const v = pair.slice(eq + 1).trim();
      if (v) this.cookies.set(pair.slice(0, eq).trim(), v);
      else this.cookies.delete(pair.slice(0, eq).trim());
    }
    return res;
  }
  async join(link: string): Promise<void> {
    expect((await this.fetch(link)).status).toBe(303);
    const ch = (await (await this.fetch('/api/join/challenge')).json()) as { required: boolean; challenge?: Challenge };
    const pow = ch.required ? { challenge: ch.challenge!, solution: await solveChallenge({ challenge: ch.challenge!, deriveKey }) } : undefined;
    const r = await this.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname: this.nickname, pow } : { nickname: this.nickname }) });
    expect(r.status, await r.clone().text()).toBe(200);
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/control`, { origin: this.base, headers: { cookie: this.header() } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (d) => {
        const text = String(d);
        if (text.startsWith('~')) return;
        const m = JSON.parse(text) as ServerMessage;
        if (m.t === 'hello') resolve();
        if (m.t === 'kicked') this.kickedAt = Date.now();
      });
    });
  }
  close(): void {
    this.ws?.terminate();
  }
}

/** HLS answers (segments and playlists) the page saw since the last call, ms each. */
async function hlsTimings(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out = performance
      .getEntriesByType('resource')
      .filter((e) => new URL(e.name).pathname.startsWith('/hls/'))
      .map((e) => (e as PerformanceResourceTiming).responseEnd - (e as PerformanceResourceTiming).requestStart);
    performance.clearResourceTimings();
    return out;
  });
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0;
};

test('a chat flood never slows the video down, and a kick still arrives within a second', { tag: '@media' }, async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'one engine is enough for the server side');
  test.setTimeout(180_000);
  const link = await liveLink();
  const v = await join(browser, uid('flood'));
  const bots: Bot[] = [];
  const before = (await adminApi<AdminChatState>('GET', '/api/chat')).settings;
  try {
    await v.page.evaluate(() => performance.setResourceTimingBufferSize(5000));
    await waitPlaying(v.page, 3);
    await unmute(v.page);

    // Calm: the same live, no chat.
    await hlsTimings(v.page);
    await startStallMonitor(v.page);
    await v.page.waitForTimeout(SECONDS * 1000);
    const calm = { stall: await stallReport(v.page), hls: await hlsTimings(v.page) };

    // Flood: slow mode off, so every frame a bot may send is a real message attempt.
    await adminApi('PUT', '/api/chat/settings', { ...before, slowModeS: 0 } satisfies ChatSettings);
    const prefix = uid('b').slice(0, 14);
    for (let i = 0; i < BOTS; i++) bots.push(new Bot(baseURL!, `${prefix}${i}`));
    for (const b of bots) await b.join(link);
    await startStallMonitor(v.page);
    let flooding = true;
    let n = 0;
    const flood = Promise.all(
      bots.map(async (b, i) => {
        while (flooding) {
          if (b.ws?.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ t: 'chat.send', n: ++n, text: `flood ${i} ${n} kkkkkk 🔥` }));
          // 1.8 frames a second: just under the 20-per-10-s line that terminates a socket.
          await new Promise((r) => setTimeout(r, 555));
        }
      }),
    );
    await v.page.waitForTimeout((SECONDS / 2) * 1000);
    // A kick in the middle of the flood.
    const target = bots[0]!;
    const row = await viewerByNick(target.nickname);
    expect(row, 'the kicked bot is listed').toBeTruthy();
    const kickAt = Date.now();
    await admin(`/api/viewers/${row!.sessionId}/kick`);
    await expect.poll(() => target.kickedAt, { timeout: 5_000 }).toBeGreaterThan(0);
    const kickMs = target.kickedAt - kickAt;
    await v.page.waitForTimeout((SECONDS / 2) * 1000);
    flooding = false;
    await flood;
    const busy = { stall: await stallReport(v.page), hls: await hlsTimings(v.page) };
    const chat = await adminApi<AdminChatState>('GET', '/api/chat');

    const report = { calm: { maxStallMs: calm.stall.maxStallMs, playedS: calm.stall.playedS, hlsP95: p95(calm.hls), hls: calm.hls.length }, flood: { maxStallMs: busy.stall.maxStallMs, playedS: busy.stall.playedS, hlsP95: p95(busy.hls), hls: busy.hls.length }, kickMs, sent: n, counters: chat.counters };
    console.log(`chat-flood: ${JSON.stringify(report)}`);
    await test.info().attach('chat-flood.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

    // The flood really happened, and the chat held it at its global limit.
    expect(n).toBeGreaterThan(BOTS * SECONDS);
    // The video: it kept playing, no stall beyond the calm stretch's own (plus one segment of
    // timer noise), and the HLS answers stayed within 20 % (+ 50 ms for loopback jitter).
    expect(busy.stall.playedS).toBeGreaterThan(SECONDS * 0.8);
    expect(busy.stall.maxStallMs).toBeLessThanOrEqual(Math.max(calm.stall.maxStallMs, 1000) + 1000);
    expect(busy.hls.length).toBeGreaterThan(5);
    expect(p95(busy.hls)).toBeLessThanOrEqual(p95(calm.hls) * 1.2 + 50);
    // Control messages jump ahead of chat.
    expect(kickMs).toBeLessThanOrEqual(1000);
  } finally {
    for (const b of bots) b.close();
    await adminApi('PUT', '/api/chat/settings', before);
    // The flood switched the chat's protection on; the next test starts calm.
    await adminApi('POST', '/api/chat/protect', { mode: 'off' });
    await v.context.close();
  }
});
