import { describe, expect, it } from 'vitest';
import { AttackDetector, type ThreatState } from '../../src/security/detector.js';
import { manualClock } from './helpers.js';

// The attack detector (security/detector.ts) on a manual clock: signals per second against
// baselines it learns while calm, with hysteresis on the way down.

/** Detector on a manual clock, plus `run`, which simulates N seconds of traffic. */
function setup(opts: ConstructorParameters<typeof AttackDetector>[0] = {}) {
  const clock = manualClock();
  const d = new AttackDetector({ now: clock.now, ...opts });
  const transitions: Array<[ThreatState, ThreatState]> = [];
  d.on('state', (to, from) => transitions.push([from, to]));
  const run = (seconds: number, perSecond: (s: number) => void, viewers: number | ((s: number) => number) = 0, saturation = 0): void => {
    for (let s = 0; s < seconds; s++) {
      perSecond(s);
      clock.advance(1000);
      d.tick({ viewers: typeof viewers === 'number' ? viewers : viewers(s), saturation });
    }
  };
  return { d, run, transitions };
}

/**
 * A normal viewer-load second: HLS requests from distinct IPs, a few joins, WebSocket reconnects,
 * and every 30 s someone with last week's link.
 */
function busySecond(d: AttackDetector, viewers: number, s: number): void {
  for (let i = 0; i < viewers * 2; i++) d.request(`10.0.${Math.floor(i / 2 / 250)}.${Math.floor(i / 2) % 250}`);
  if (s % 2 === 0) d.record('joins', Math.ceil(viewers / 100));
  if (s % 10 === 0) d.record('upgrades', Math.ceil(viewers / 20));
  if (s % 30 === 0) d.record('badJoins');
}

/** A flood of invalid join links: 50 joins, 10 bad links and 40 rate-limited requests a second. */
function badLinkFlood(d: AttackDetector): () => void {
  return () => {
    d.record('joins', 50);
    d.record('badJoins', 10);
    d.record('rateLimited', 40);
  };
}

describe('attack detector', () => {
  // A raid: from 0 to 400 viewers over two minutes, then busy for 10 minutes with the upload limit
  // nearly maxed.
  it('a normal busy stream (400 viewers, steady HLS, joins, reconnects) does not trigger', () => {
    // Arrange
    const { d, run, transitions } = setup();
    const ramp = (s: number): number => Math.round((400 * s) / 120);
    // Act
    run(120, (s) => busySecond(d, ramp(s), s), ramp);
    d.connection(400 * 3);
    run(600, (s) => busySecond(d, 400, s), 400, 0.97);
    // Assert
    expect(transitions).toEqual([]);
    expect(d.state).toBe('normal');
    expect(d.baselines().requests).toBeGreaterThan(500);
  });

  it('a burst of real joins at the start of a stream is not an attack: 300 people open the link within a minute', () => {
    // Arrange
    const { d, run, transitions } = setup();
    // Act
    run(
      60,
      (s) => {
        d.record('joins', 5);
        busySecond(d, s * 5, s);
      },
      (s) => s * 5,
    );
    // Assert
    expect(transitions).toEqual([]);
  });

  it('a flood of invalid join links escalates to attack within its first seconds', () => {
    // Arrange
    const { d, run, transitions } = setup();
    run(60, (s) => busySecond(d, 20, s), 20);
    // Act
    run(8, badLinkFlood(d), 20);
    // Assert
    expect(d.state).toBe('attack');
    expect(transitions).toEqual([
      ['normal', 'suspicious'],
      ['suspicious', 'attack'],
    ]);
    const top = d.report.signals[0]!;
    expect(['rateLimited', 'badJoins', 'joins']).toContain(top.signal);
    expect(top.level).toBe(2);
  });

  it('moderate anomalies go to suspicious first', () => {
    // Arrange
    const { d, run } = setup();
    // Act
    run(10, () => d.record('badJoins', 2), 5);
    // Assert
    expect(d.state).toBe('suspicious');
  });

  it('the upload limit being maxed corroborates an attack', () => {
    // Arrange
    const { d, run } = setup();
    // Act
    run(10, () => d.record('badJoins', 2), 5, 1);
    // Assert
    expect(d.state).toBe('attack');
  });

  it('needs the level to persist before escalating (one spike is ignored)', () => {
    // Arrange
    const { d, run } = setup({ windowS: 1 });
    // Act
    run(1, () => d.record('rateLimited', 100));
    run(1, () => {});
    // Assert
    expect(d.state).toBe('normal');
  });

  // The entry threshold is 10 rate-limited requests a second; the exit one is 60 % of it. Calm:
  // attack → suspicious after 60 s, suspicious → normal after 120 s more.
  it('hysteresis: stays elevated while traffic is still above the lower exit threshold, then steps down slowly', () => {
    // Arrange
    const { d, run, transitions } = setup();
    // Act
    run(8, () => d.record('rateLimited', 30));
    // Assert
    expect(d.state).toBe('attack');
    // Act
    run(120, () => d.record('rateLimited', 7));
    // Assert
    expect(d.state).toBe('attack');
    // Act
    run(50, () => {});
    // Assert
    expect(d.state).toBe('attack');
    // Act
    run(25, () => {});
    // Assert
    expect(d.state).toBe('suspicious');
    // Act
    run(100, () => {});
    // Assert
    expect(d.state).toBe('suspicious');
    // Act
    run(30, () => {});
    // Assert
    expect(d.state).toBe('normal');
    expect(transitions).toEqual([
      ['normal', 'attack'],
      ['attack', 'suspicious'],
      ['suspicious', 'normal'],
    ]);
  });

  it('does not learn attacks into the baseline; reset(true) returns to normal and keeps baselines, reset() forgets them', () => {
    // Arrange
    const { d, run } = setup();
    run(60, (s) => busySecond(d, 10, s), 10);
    const before = d.baselines().badJoins;
    // Act
    run(60, () => d.record('badJoins', 50), 10);
    // Assert
    expect(d.state).toBe('attack');
    expect(d.baselines().badJoins).toBe(before);
    // Act
    d.reset(true);
    // Assert
    expect(d.state).toBe('normal');
    expect(d.baselines().badJoins).toBe(before);
    // Act
    d.reset();
    // Assert
    expect(d.baselines().requests).toBe(0);
  });

  it('counts distinct client IPs over the window', () => {
    // Arrange
    const { d, run } = setup();
    // Act
    run(8, (s) => {
      for (let i = 0; i < 100; i++) d.request(`198.51.${s}.${i}`);
    }, 5);
    // Assert
    expect(d.values().ips).toBe(800);
    expect(d.state).toBe('attack');
  });

  it('counts open connections', () => {
    // Arrange
    const { d, run } = setup();
    // Act
    d.connection(2000);
    run(5, () => {}, 10);
    // Assert
    expect(d.state).toBe('attack');
    expect(d.report.signals[0]!.signal).toBe('connections');
  });

  it('counts TLS errors (Direct mode)', () => {
    // Arrange
    const { d, run } = setup();
    // Act
    run(6, () => d.record('tlsErrors', 20));
    // Assert
    expect(d.report.signals[0]!.signal).toBe('tlsErrors');
  });
});
