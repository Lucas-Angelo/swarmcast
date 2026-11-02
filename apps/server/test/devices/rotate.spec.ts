// The phone turned sideways while the live plays, and back upright. Sideways, style.css takes the
// header away and makes the player as tall as the screen ("Phone held sideways"); upright, the
// phone layout comes back with the chat under the player. The video plays on through every turn.
// The browsers used to answer the turn differently: Chrome on an Android phone showed the video
// full screen by itself ("rotate to fullscreen", which Blink does only for a video with the
// browser's own controls, media_controls_rotate_to_fullscreen_delegate.cc). The page has its own
// controls now (viewer player-controls.ts), so both browsers show the sideways layout at once;
// on Android the viewer's full-screen button then fills the screen with the player and its
// controls, and Back leaves it. Mobile Safari keeps the video in the page (playsinline).
import { liveLink, uid } from '../e2e/fixtures.js';
import { expect, test } from './fixtures.js';
import { box, fullScreenState, isShown, joinOnPhone, playedSince, tapControl, videoState, viewport, type Phone } from './phone.js';

/** Seconds of video played before a viewer counts as watching (as waitPlaying() in the e2e fixtures). */
const WATCHING_S = 1.5;
/** Seconds the video must play on (not paused) after each turn. */
const PLAYS_ON_S = 2;
/** Sideways the player is at least this share of the page's height (it is 100dvh in style.css). */
const PLAYER_HEIGHT_SHARE = 0.9;

async function watching(phone: Phone): Promise<void> {
  await joinOnPhone(phone, uid('turn'), await liveLink());
  await expect.poll(async () => (await videoState(phone)).played).toBeGreaterThan(WATCHING_S);
}

/** The page's sideways layout: no header, the player in sight from top to bottom and nearly as tall as the page. */
async function sidewaysLayout(phone: Phone): Promise<boolean> {
  const view = await viewport(phone);
  const player = await box(phone, '.player');
  const header = await isShown(phone, '.site-head');
  return view.landscape && !header && !!player && player.y >= -1 && player.y + player.height <= view.innerHeight + 1 && player.height >= PLAYER_HEIGHT_SHARE * view.innerHeight;
}

async function chatUnderPlayer(phone: Phone): Promise<boolean> {
  const player = await box(phone, '.player');
  const chat = await box(phone, '[data-testid="chat"]');
  return !!player && !!chat && chat.y >= player.y + player.height - 1;
}

async function playsOn(phone: Phone): Promise<void> {
  const from = await videoState(phone);
  await expect.poll(() => playedSince(phone, from)).toBeGreaterThan(PLAYS_ON_S);
}

test('Chrome: turned sideways the page lays the player across the screen and plays on; its full-screen button fills the screen with the player, Back leaves it; upright the chat is under the player', { tag: '@android' }, async ({ phone }) => {
  // Arrange
  await watching(phone);
  // Act
  await phone.rotate('landscape');
  // Assert: no full screen by itself, the sideways layout
  await expect.poll(() => sidewaysLayout(phone)).toBe(true);
  expect(await fullScreenState(phone)).toBeNull();
  await playsOn(phone);
  // Act
  await tapControl(phone, '[data-testid="fullscreen"]');
  // Assert
  await expect.poll(() => fullScreenState(phone)).toBe('player');
  expect(await isShown(phone, '[data-testid="controls"]')).toBe(true);
  await playsOn(phone);
  // Act
  await phone.back();
  // Assert
  await expect.poll(() => fullScreenState(phone)).toBeNull();
  await expect.poll(() => sidewaysLayout(phone)).toBe(true);
  await playsOn(phone);
  // Act
  await phone.rotate('portrait');
  // Assert
  await expect.poll(async () => (await viewport(phone)).landscape).toBe(false);
  await expect.poll(() => chatUnderPlayer(phone)).toBe(true);
  await playsOn(phone);
});

test('Safari: turned sideways the page lays the player across the screen and plays on; upright the chat is under the player', { tag: '@ios' }, async ({ phone }) => {
  // Arrange
  await watching(phone);
  // Act
  await phone.rotate('landscape');
  // Assert
  await expect.poll(() => sidewaysLayout(phone)).toBe(true);
  expect(await fullScreenState(phone)).toBeNull();
  await playsOn(phone);
  // Act
  await phone.rotate('portrait');
  // Assert
  await expect.poll(async () => (await viewport(phone)).landscape).toBe(false);
  await expect.poll(() => chatUnderPlayer(phone)).toBe(true);
  await playsOn(phone);
});
