// The viewer on a real phone browser (Chrome on Android, Mobile Safari on iOS), the checks the
// owner did by hand on a phone (docs/CHAT.md "Rendering checks", the real-phone check):
// - the live link, a nickname typed with Watch still in sight above the keyboard (the browser
//   scrolls it into view; the check waits for the keyboard and that scroll to settle), the browser check, the video starting muted by itself (browsers allow only muted
//   autoplay) and Unmute turning the sound on with a tap;
// - the chat under the player on a phone screen, a message from the phone reaching a second
//   viewer and back (a scripted viewer on /control, the e2e `bots` fixture: a desktop browser
//   playing the live next to the iOS Simulator slowed the simulator's taps to up to 6.8 s, which
//   iOS takes for long presses, Devices runs 41235159056 and 41240999682), and the
//   on-screen keyboard leaving the input and Send in sight: the visual viewport (what the
//   keyboard leaves) must contain them. A tap raises the keyboard; a mouse click does not.
// - the app sent to the background and brought back: the page went hidden (checked from its own
//   record: neither driver can read a page in the background) and plays again, behind the live
//   by about the time away, and Go live takes the viewer back to the live point.
// The on-screen keyboard is Android's part: the iOS Simulator under safaridriver never raises it
// and Send Keys inserts nothing there (ios.ts IosPhone.onScreenKeyboard and type() have the
// evidence), so on iOS the "in sight" checks hold with no keyboard over the page, tapToType checks
// that the tap reached the field as a finger's, and the text is put in the field as the keyboard would.
// The trip to the background runs on Android: under safaridriver the session ends as Safari leaves
// the screen (ios.ts IosPhone.background has the evidence).
// - the player's own controls instead of the browser's: no volume slider on a phone (and none
//   wherever the page cannot set the volume), picture-in-picture only where the browser has it, and full screen: the player
//   with its controls where an element can go full screen (Android, iOS 26), else iOS's own
//   player, after which the page's controls are back and the video plays on.
// Rotation is in rotate.spec.ts (Chrome and Safari answer it differently).
import { liveLink, uid, viewerByNick } from '../e2e/fixtures.js';
import { expect, liveMovesOn, test } from './fixtures.js';
import { box, chatShows, fullScreenState, goLive, inSight, isShown, joinOnPhone, lifecycle, ownMessage, playedSince, playerUi, recordLifecycle, tapControl, tapToType, videoState } from './phone.js';

/** Seconds of video played before a viewer counts as watching (as waitPlaying() in the e2e fixtures). */
const WATCHING_S = 1.5;
/** Seconds the video must play on (not paused) after a step for playback to count as going on. */
const PLAYS_ON_S = 3;
/**
 * Whole segments of live while the phone is in the background: 4 x 2 s, so 8 to 10 s of live
 * (liveMovesOn counts from the first new segment it sees). The page comes back behind by about the
 * time its video stood paused, and that must be more than the distance at which "Go live" offers
 * to jump (max(4 s, two segments): watch.ts setupGoLive), with room for the catch-up that starts
 * as playback goes on (the adaptive delay's 1.05x, while the check first waits for 3 s of
 * playback), yet less than the most the stable profile lets the player fall behind before hls.js
 * brings it back to the live point by itself (liveMaxLatencyDuration 36 s − liveSyncDuration 20 s
 * = 16 s, packages/shared PLAYER_LIVE_DELAYS).
 * The video stands paused for less than Chrome's window is away. With three segments counted from
 * the call (4 to 6 s of live), Chrome's window was hidden for 5.9 s in release-rehearsal run
 * 42382536965, but its main thread was busy for 1.2 s as it went ("Skipped 71 frames"), and the
 * page came back only 4 s behind: "Go live −4 s" for a moment, then "LIVE" as the catch-up began.
 * In 30 trips of that length with a record of the page (Devices runs 42385971521 and 42387936202)
 * it was hidden 4.4 to 6.5 s and read 5.0 to 8.4 s behind when the check passed; once hls.js moved
 * its live sync position back a second for a 50 ms stall just before the trip (it adds a second
 * per stall, up to a segment), which "behind" counts from: little room for a shorter pause.
 */
const AWAY_SEGMENTS = 4;
/** Go live lands within this many seconds of the live point (as in the e2e viewer spec). */
const AT_LIVE_S = 4;

test('a phone viewer joins with the link, Watch in sight while typing: the video starts muted by itself, Unmute turns the sound on, playback goes on', async ({ phone }) => {
  // Arrange
  const nick = uid('join');
  const link = await liveLink();
  // Act
  const joined = await joinOnPhone(phone, nick, link);
  // Assert
  expect(joined).toEqual({ nicknameInSight: true, watchInSight: true });
  await expect.poll(async () => (await videoState(phone)).played).toBeGreaterThan(WATCHING_S);
  expect(await videoState(phone)).toMatchObject({ muted: true, paused: false });
  await expect.poll(() => isShown(phone, '#unmute')).toBe(true);
  await expect.poll(async () => (await viewerByNick(nick))?.connected).toBe(true);
  // Act
  await phone.tap('#unmute');
  // Assert
  await expect.poll(async () => (await videoState(phone)).muted).toBe(false);
  const unmuted = await videoState(phone);
  await expect.poll(() => playedSince(phone, unmuted)).toBeGreaterThan(PLAYS_ON_S);
  expect(await isShown(phone, '#unmute')).toBe(false);
  expect(await phone.evaluate(() => document.getElementById('status')!.textContent)).toBe('Live');
});

test('the chat sits under the player; a message goes from the phone to another viewer and back; the keyboard leaves the input in sight', async ({ phone, bots }) => {
  // Arrange
  const link = await liveLink();
  await joinOnPhone(phone, uid('chatP'), link);
  const other = await bots.join(uid('chatD'), link);
  await expect.poll(() => isShown(phone, '[data-testid="chat"]')).toBe(true);
  const fromPhone = `oi do celular ${uid('m')}`;
  const fromOther = `oi do PC ${uid('r')}`;
  // Assert
  const player = await box(phone, '.player');
  const chat = await box(phone, '[data-testid="chat"]');
  expect(chat!.y).toBeGreaterThanOrEqual(player!.y + player!.height - 1);
  // Edge to edge, as wide as the page: the page's own width, not innerWidth, which is rounded to
  // a whole pixel (412 for a 412.19 px wide page on a 2.625× Android screen). Nothing scrolls sideways.
  const page = await phone.evaluate(() => ({ width: document.documentElement.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  expect(Math.abs(chat!.x)).toBeLessThan(0.5);
  expect(Math.abs(chat!.x + chat!.width - page.width)).toBeLessThan(0.5);
  expect(page.scrollWidth).toBeLessThanOrEqual(page.innerWidth);
  // Act
  await tapToType(phone, '[data-testid="chat-input"]');
  // Assert
  await expect.poll(() => inSight(phone, '[data-testid="chat-input"]')).toBe(true);
  expect(await inSight(phone, '[data-testid="chat-send"]')).toBe(true);
  // Act
  await phone.type('[data-testid="chat-input"]', fromPhone);
  await phone.tap('[data-testid="chat-send"]');
  // Assert
  await expect.poll(() => ownMessage(phone, fromPhone)).toBe('sent');
  await expect.poll(() => other.items().some((i) => i.k === 'm' && i.x === fromPhone)).toBe(true);
  // Act
  const answer = await other.answer(other.send(fromOther));
  // Assert
  expect(answer.s).toBeGreaterThan(0);
  await expect.poll(() => chatShows(phone, fromOther)).toBe(true);
});

test('back from the background the video plays again, behind the live; Go live returns to the live point', { tag: '@android' }, async ({ phone }) => {
  // Arrange
  await joinOnPhone(phone, uid('away'), await liveLink());
  await expect.poll(async () => (await videoState(phone)).played).toBeGreaterThan(WATCHING_S);
  await recordLifecycle(phone);
  // Act
  await phone.background();
  await liveMovesOn(AWAY_SEGMENTS);
  await phone.foreground();
  // Assert
  const record = await lifecycle(phone);
  expect(record, 'the page went to the background').toContain('hidden');
  expect(record.lastIndexOf('visible'), 'and came back').toBeGreaterThan(record.indexOf('hidden'));
  const back = await videoState(phone);
  await expect.poll(() => playedSince(phone, back)).toBeGreaterThan(PLAYS_ON_S);
  await expect.poll(async () => (await goLive(phone)).text).toMatch(/^Go live/);
  // Act
  await tapControl(phone, '#golive');
  // Assert
  await expect.poll(async () => (await goLive(phone)).text).toBe('LIVE');
  expect((await goLive(phone)).behind).toBeLessThan(AT_LIVE_S);
  expect((await videoState(phone)).paused).toBe(false);
});

test("the player's own controls: full screen is the player with them where the browser lets an element go full screen, else iOS's own player (then they are back); no volume slider on a phone", async ({ phone }) => {
  // Arrange
  await joinOnPhone(phone, uid('controls'), await liveLink());
  await expect.poll(async () => (await videoState(phone)).played).toBeGreaterThan(WATCHING_S);
  const ui = await playerUi(phone);
  // Assert
  expect(ui).toMatchObject({ nativeControls: false, bar: true, play: 'Pause' });
  expect(ui.volumeSlider, 'a volume slider only where the page can set the volume').toBe(ui.volumeApi);
  // On a phone's narrow screen the slider never shows: the device's buttons set the volume.
  expect(await isShown(phone, '[data-testid="volume"]')).toBe(false);
  expect(ui.pipButton, 'picture-in-picture only where the browser has it').toBe(ui.pipApi);
  // Android, and the iPhone from the iOS 26 runtime on, let an element go full screen (Devices
  // run 41510799608); older iPhones only the video, in iOS's own player.
  const expected = ui.elementFullscreen ? 'player' : 'ios-player';
  if (phone.platform === 'android') expect(expected).toBe('player');
  // Act
  await tapControl(phone, '[data-testid="fullscreen"]');
  // Assert
  await expect.poll(() => fullScreenState(phone)).toBe(expected);
  if (expected === 'player') {
    expect(await isShown(phone, '[data-testid="controls"]')).toBe(true);
    expect(await inSight(phone, '[data-testid="controls"]')).toBe(true);
  }
  const inFull = await videoState(phone);
  await expect.poll(() => playedSince(phone, inFull)).toBeGreaterThan(PLAYS_ON_S);
  // Act: out again: Android's system Back; on iOS, which has no Back, the page's own button (the
  // container) or the page leaving iOS's player (as its close button does)
  if (phone.platform === 'android') await phone.back();
  else if (expected === 'player') await tapControl(phone, '[data-testid="fullscreen"]');
  else await phone.evaluate(() => (document.querySelector('video') as HTMLVideoElement & { webkitExitFullscreen(): void }).webkitExitFullscreen());
  // Assert: the page's controls again, playing on, Go live there
  await expect.poll(() => fullScreenState(phone)).toBeNull();
  const back = await videoState(phone);
  await expect.poll(() => playedSince(phone, back)).toBeGreaterThan(PLAYS_ON_S);
  expect(await playerUi(phone)).toMatchObject({ bar: true, play: 'Pause' });
  expect(await isShown(phone, '#golive')).toBe(true);
});
