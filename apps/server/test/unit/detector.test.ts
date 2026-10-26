import { describe, expect, it } from 'vitest';
import { AttackDetector, type ThreatState } from '../../src/security/detector.js';

/** Detector on a fake clock, plus a helper that simulates N seconds of traffic. */
function setup(opts: ConstructorParameters<typeof AttackDetector>[0] = {}) {
  let now = 1_000_000;
  const d = new AttackDetector({ now: () => now, ...opts });
  const transitions: Array<[ThreatState, ThreatState]> = [];
  d.on('state', (to, from) => transitions.push([from, to]));
  const run = (seconds: number, perSecond: (s: number) => void, viewers: number | ((s: number) => number) = 0, saturation = 0): void => {
    for (let s = 0; s < seconds; s++) {
      perSecond(s);
      now += 1000;
      d.tick({ viewers: typeof viewers === 'number' ? viewers : viewers(s), saturation });
    }
  };
  return { d, run, transitions };
}

/** A normal viewer-load second: HLS requests from distinct IPs, a few joins, WebSocket reconnects. */
function busySecond(d: AttackDetector, viewers: number, s: number): void {
  for (let i = 0; i < viewers * 2; i++) d.request(`10.0.${Math.floor(i / 2 / 250)}.${Math.floor(i / 2) % 250}`);
  if (s % 2 === 0) d.record('joins', Math.ceil(viewers / 100));
  if (s % 10 === 0) d.record('upgrades', Math.ceil(viewers / 20));
  if (s % 30 === 0) d.record('badJoins'); // someone with last week's link
}

describe('attack detector', () => {
  it('a normal busy stream (400 viewers, steady HLS, joins, reconnects) does not trigger', () => {
    const { d, run, transitions } = setup();
    // Ramp up from 0 to 400 viewers over two minutes (a raid), then stay busy for 10 minutes.
    const ramp = (s: number): number => Math.round((400 * s) / 120);
    run(120, (s) => busySecond(d, ramp(s), s), ramp);
    d.connection(400 * 3);
    run(600, (s) => busySecond(d, 400, s), 400, 0.97);
    expect(transitions).toEqual([]);
    expect(d.state).toBe('normal');
    expect(d.baselines().requests).toBeGreaterThan(500);
  });

  it('a burst of real joins at the start of a stream is not an attack', () => {
    const { d, run, transitions } = setup();
    // 300 people open the link within a minute (5 per second), almost none fail.
    run(60, (s) => {
      d.record('joins', 5);
      busySecond(d, s * 5, s);
    }, (s) => s * 5);
    expect(transitions).toEqual([]);
  });

  it('a flood of invalid join links escalates to attack within seconds', () => {
    const { d, run, transitions } = setup();
    run(60, (s) => busySecond(d, 20, s), 20);
    run(8, () => {
      d.record('joins', 50);
      d.record('badJoins', 10);
      d.record('rateLimited', 40);
    }, 20);
    expect(d.state).toBe('attack');
    // normal → suspicious → attack, all within the flood's first seconds.
    expect(transitions).toEqual([
      ['normal', 'suspicious'],
      ['suspicious', 'attack'],
    ]);
    const top = d.report.signals[0]!;
    expect(['rateLimited', 'badJoins', 'joins']).toContain(top.signal);
    expect(top.level).toBe(2);
  });

  it('moderate anomalies go to suspicious first, and the upload limit being maxed corroborates an attack', () => {
    const a = setup();
    a.run(10, () => a.d.record('badJoins', 2), 5);
    expect(a.d.state).toBe('suspicious');
    const b = setup();
    b.run(10, () => b.d.record('badJoins', 2), 5, 1);
    expect(b.d.state).toBe('attack');
  });

  it('needs the level to persist before escalating (one spike is ignored)', () => {
    const { d, run } = setup({ windowS: 1 });
    run(1, () => d.record('rateLimited', 100));
    run(1, () => {});
    expect(d.state).toBe('normal');
  });

  it('hysteresis: stays elevated while traffic is still above the lower exit threshold, then steps down slowly', () => {
    const { d, run, transitions } = setup();
    run(8, () => d.record('rateLimited', 30));
    expect(d.state).toBe('attack');
    // Below the entry threshold (10/s) but above 60% of it: still an attack.
    run(120, () => d.record('rateLimited', 7));
    expect(d.state).toBe('attack');
    // Calm: attack → suspicious after 60 s, suspicious → normal after 120 s more.
    run(50, () => {});
    expect(d.state).toBe('attack');
    run(25, () => {});
    expect(d.state).toBe('suspicious');
    run(100, () => {});
    expect(d.state).toBe('suspicious');
    run(30, () => {});
    expect(d.state).toBe('normal');
    expect(transitions).toEqual([
      ['normal', 'attack'],
      ['attack', 'suspicious'],
      ['suspicious', 'normal'],
    ]);
  });

  it('does not learn attacks into the baseline, and reset() returns to normal', () => {
    const { d, run } = setup();
    run(60, (s) => busySecond(d, 10, s), 10);
    const before = d.baselines().badJoins;
    run(60, () => d.record('badJoins', 50), 10);
    expect(d.state).toBe('attack');
    expect(d.baselines().badJoins).toBe(before);
    d.reset(true);
    expect(d.state).toBe('normal');
    expect(d.baselines().badJoins).toBe(before);
    d.reset();
    expect(d.baselines().requests).toBe(0);
  });

  it('counts distinct client IPs over the window and open connections, and TLS errors in Direct mode', () => {
    const { d, run } = setup();
    run(8, (s) => {
      for (let i = 0; i < 100; i++) d.request(`198.51.${s}.${i}`);
    }, 5);
    expect(d.values().ips).toBe(800);
    expect(d.state).toBe('attack');
    const c = setup();
    c.d.connection(2000);
    c.run(5, () => {}, 10);
    expect(c.d.state).toBe('attack');
    expect(c.d.report.signals[0]!.signal).toBe('connections');
    const tls = setup();
    tls.run(6, () => tls.d.record('tlsErrors', 20));
    expect(tls.d.report.signals[0]!.signal).toBe('tlsErrors');
  });
});
