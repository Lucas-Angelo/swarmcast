// Keeping the screen on while the stream plays (wake-lock.ts): held while playing, let go on pause
// and at the end screen or when something blocks it (audio-only), asked for again when the page
// is visible again (the browser lets go by itself while it is hidden), and silent where the API is
// missing or refuses. navigator.wakeLock and the document are fakes the test drives.
import { describe, expect, it } from 'vitest';
import { createScreenAwake, type ScreenAwake, type WakeLockLike, type WakeLockSentinelLike } from '../../src/wake-lock.js';

/** A WakeLockSentinel: `release()` by the page, `systemRelease()` as the browser does when the page is hidden. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: Array<() => void> = [];
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener);
  }
  release(): Promise<void> {
    this.systemRelease();
    return Promise.resolve();
  }
  systemRelease(): void {
    if (this.released) return;
    this.released = true;
    for (const l of this.listeners) l();
  }
}

/** navigator.wakeLock: grants (or refuses) each request; `pending` holds requests not settled yet when `manual`. */
class FakeWakeLock implements WakeLockLike {
  readonly sentinels: FakeSentinel[] = [];
  requests = 0;
  refuse: Error | null = null;
  manual = false;
  readonly pending: Array<{ grant: () => void }> = [];
  request(type: 'screen'): Promise<WakeLockSentinelLike> {
    expect(type).toBe('screen');
    this.requests += 1;
    if (this.refuse) return Promise.reject(this.refuse);
    const s = new FakeSentinel();
    this.sentinels.push(s);
    if (!this.manual) return Promise.resolve(s);
    return new Promise((resolve) => this.pending.push({ grant: () => resolve(s) }));
  }
  /** Sentinels still held. */
  get held(): number {
    return this.sentinels.filter((s) => !s.released).length;
  }
}

/** The document: its visibility, and `set()` fires visibilitychange like a browser. */
class FakeDoc {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners: Array<() => void> = [];
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.push(listener);
  }
  set(v: DocumentVisibilityState): void {
    this.visibilityState = v;
    for (const l of this.listeners) l();
  }
}

/** Lets the fake's promises settle (request().then). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(o: { supported?: boolean } = {}): { awake: ScreenAwake; lock: FakeWakeLock; doc: FakeDoc; logs: string[] } {
  const lock = new FakeWakeLock();
  const doc = new FakeDoc();
  const logs: string[] = [];
  const awake = createScreenAwake({ wakeLock: o.supported === false ? undefined : lock, doc, debug: (m) => logs.push(m) });
  return { awake, lock, doc, logs };
}

describe('screen wake lock', () => {
  it('asks for nothing before the stream plays', async () => {
    // Arrange
    const { awake, lock } = setup();
    // Act
    await settle();
    // Assert
    expect(lock.requests).toBe(0);
    expect(awake.state).toBe('off');
  });

  it('holds the screen while playing', async () => {
    // Arrange
    const { awake, lock } = setup();
    // Act
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(lock.held).toBe(1);
    expect(awake.state).toBe('held');
  });

  it('asks only once while already held or on its way', async () => {
    // Arrange
    const { awake, lock } = setup();
    // Act
    awake.setPlaying(true);
    awake.setPlaying(true);
    await settle();
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(lock.requests).toBe(1);
  });

  it('lets go when the viewer pauses, and holds again on play', async () => {
    // Arrange
    const { awake, lock } = setup();
    awake.setPlaying(true);
    await settle();
    // Act
    awake.setPlaying(false);
    await settle();
    // Assert
    expect(lock.held).toBe(0);
    expect(awake.state).toBe('off');

    // Act
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(lock.held).toBe(1);
    expect(lock.requests).toBe(2);
  });

  it('asks again once the page is visible again after the browser let go while it was hidden', async () => {
    // Arrange
    const { awake, lock, doc } = setup();
    awake.setPlaying(true);
    await settle();
    // Act: the phone locks; the browser releases the lock and hides the page.
    lock.sentinels[0]!.systemRelease();
    doc.set('hidden');
    await settle();
    // Assert
    expect(awake.state).toBe('off');
    expect(lock.requests).toBe(1);

    // Act
    doc.set('visible');
    await settle();
    // Assert
    expect(lock.held).toBe(1);
    expect(lock.requests).toBe(2);
    expect(awake.state).toBe('held');
  });

  it('does not ask again on visibility while paused', async () => {
    // Arrange
    const { awake, lock, doc } = setup();
    awake.setPlaying(true);
    await settle();
    awake.setPlaying(false);
    // Act
    doc.set('hidden');
    doc.set('visible');
    await settle();
    // Assert
    expect(lock.requests).toBe(1);
    expect(lock.held).toBe(0);
  });

  it('does not ask while the page is hidden, even if playing starts then', async () => {
    // Arrange
    const { awake, lock, doc } = setup();
    doc.set('hidden');
    // Act
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(lock.requests).toBe(0);
  });

  it('gives the lock straight back when the viewer paused while it was on its way', async () => {
    // Arrange
    const { awake, lock } = setup();
    lock.manual = true;
    awake.setPlaying(true);
    expect(awake.state).toBe('requesting');
    // Act
    awake.setPlaying(false);
    lock.pending[0]!.grant();
    await settle();
    // Assert
    expect(lock.held).toBe(0);
    expect(awake.state).toBe('off');
  });

  it('lets go while blocked (audio-only, the end screen) and holds again once the block is lifted', async () => {
    // Arrange
    const { awake, lock } = setup();
    awake.setPlaying(true);
    await settle();
    // Act
    awake.block('audio-only', true);
    await settle();
    // Assert
    expect(lock.held).toBe(0);

    // Act: a second reason, then only the first lifted: still blocked.
    awake.block('ended', true);
    awake.block('audio-only', false);
    await settle();
    // Assert
    expect(lock.held).toBe(0);

    // Act
    awake.block('ended', false);
    await settle();
    // Assert
    expect(lock.held).toBe(1);
  });

  it('stays silent where the browser has no wake lock', async () => {
    // Arrange
    const { awake, doc } = setup({ supported: false });
    // Act
    awake.setPlaying(true);
    doc.set('hidden');
    doc.set('visible');
    awake.block('ended', true);
    await settle();
    // Assert
    expect(awake.state).toBe('unsupported');
  });

  it('swallows a refusal (battery saver) and asks again at the next play', async () => {
    // Arrange
    const { awake, lock, logs } = setup();
    lock.refuse = Object.assign(new Error('battery saver'), { name: 'NotAllowedError' });
    // Act
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(awake.state).toBe('off');
    expect(logs.join(' ')).toContain('NotAllowedError');

    // Act
    lock.refuse = null;
    awake.setPlaying(false);
    awake.setPlaying(true);
    await settle();
    // Assert
    expect(lock.held).toBe(1);
    expect(lock.requests).toBe(2);
  });
});
