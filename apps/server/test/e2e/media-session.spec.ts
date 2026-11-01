// Lock-screen and notification controls in real browsers (viewer: media-session.ts): the title is
// the streamer's name ("Live" without one), the picture their avatar as a data: URL read by the
// page itself (SwarmCast's own icon without one, from the page's origin), the playback state
// follows play and pause, and nothing breaks the page's CSP. Every engine of the suite has the
// Media Session API (Chrome 73, Firefox 82, Safari 15); the first assertion of each test says so,
// so an engine without it fails here instead of passing for nothing.
import type { Page } from '@playwright/test';
import { expect, makePng, test, uid, waitPlaying, type BrandingControl } from './fixtures.js';

interface SessionState {
  available: boolean;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string[];
  playbackState?: string;
}

/** navigator.mediaSession as the page set it. */
function mediaSession(page: Page): Promise<SessionState> {
  return page.evaluate(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata !== 'function') return { available: false };
    const m = navigator.mediaSession.metadata;
    return {
      available: true,
      ...(m ? { title: m.title, artist: m.artist, album: m.album, artwork: [...m.artwork].map((a) => a.src) } : {}),
      playbackState: navigator.mediaSession.playbackState,
    };
  });
}

/**
 * Records in `__cspViolations`, from the page's first script on, what the CSP refused to load
 * (img-src, connect-src, media-src): the picture's way in. (WebKit also reports a style-src-attr
 * refusal of its own when the quality menu adds an <option>, which has nothing to do with this.)
 */
const recordCsp = (): void => {
  const w = window as unknown as { __cspViolations: string[] };
  w.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    if (/^(img|connect|media)-src/.test(e.effectiveDirective)) w.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
  });
};
const cspViolations = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

const NAME = 'Ophelia Brightwater';

async function brandWithAvatar(branding: BrandingControl): Promise<void> {
  await branding.save({ enabled: true, name: NAME });
  await branding.upload('avatar', makePng(256, 256), 'image/png');
}

test('without a page of the streamer: "Live", SwarmCast\'s own icon; the state follows play and pause', { tag: '@ui' }, async ({ viewers, baseURL }) => {
  // Arrange
  const { page } = await viewers.join(uid('msstock'), { setup: async (c) => void (await c.addInitScript(recordCsp)) });

  // Act
  await waitPlaying(page);

  // Assert
  const s = await mediaSession(page);
  expect(s.available).toBe(true);
  expect(s).toMatchObject({ title: 'Live', artist: 'Live on SwarmCast', album: 'SwarmCast' });
  expect(s.artwork).toHaveLength(1);
  expect(s.artwork![0]).toMatch(new RegExp(`^${new URL(baseURL!).origin}/assets/favicon-512-[\\w-]+\\.png$`));
  await expect.poll(async () => (await mediaSession(page)).playbackState).toBe('playing');

  // Act
  await page.evaluate(() => document.querySelector('video')!.pause());

  // Assert
  await expect.poll(async () => (await mediaSession(page)).playbackState).toBe('paused');
  expect(await cspViolations(page)).toEqual([]);
});

test("with the streamer's page: their name and their avatar as a data: URL", { tag: '@ui' }, async ({ viewers, branding }) => {
  // Arrange
  await brandWithAvatar(branding);

  // Act
  const { page } = await viewers.join(uid('msbrand'), { setup: async (c) => void (await c.addInitScript(recordCsp)) });
  await waitPlaying(page);

  // Assert
  expect((await mediaSession(page)).available).toBe(true);
  await expect.poll(async () => (await mediaSession(page)).title).toBe(NAME);
  await expect.poll(async () => (await mediaSession(page)).artwork?.[0]?.slice(0, 22)).toBe('data:image/png;base64,');
  expect(await cspViolations(page)).toEqual([]);
});
