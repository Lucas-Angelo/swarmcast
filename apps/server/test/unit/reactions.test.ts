import { describe, expect, it } from 'vitest';
import type { MessageKey, MessageParams, SecuritySettings } from '@swarmcast/shared';
import type { ThreatState } from '../../src/security/detector.js';
import { ReactionPolicy, type ReactionActions } from '../../src/security/reactions.js';

// The automatic reactions to the attack detector's states. Secure mode (floods hit Cloudflare,
// not the PC): suspicious turns on the light browser check; an attack tightens the admission
// limits and turns on the strong check (and, only when switched on, rotates the link once per
// attack); calming down to suspicious lightens the check but keeps the limits tight; normal undoes
// everything. Direct mode (the home IP is exposed): the first signs go back to Secure mode, never
// the other way; if that fails, "Stop everything" (or only a warning when that is switched off).
// "Turn everything off if an attack is detected" wins over the rest in both modes.

/** The settings a new install has, except the browser check that is off here. */
const DEFAULTS: SecuritySettings = {
  blockKnownBadIps: true,
  requireBrowserCheck: false,
  autoTighten: true,
  autoBrowserCheck: true,
  autoNewLink: false,
  autoSecureFromDirect: true,
  autoStopIfDirectFails: true,
  stopOnAttack: false,
};

/**
 * The policy with the live controller's side as a journal: every action lands in `calls`, in
 * order (`report:<code>` for the explanations, whose params are in `reports`). `goTo` walks the
 * detector through states, starting from normal, and resolves with the calls those steps caused.
 */
function setup(mode: 'secure' | 'direct', over: Partial<SecuritySettings> = {}, backToSecure: () => Promise<void> = async () => {}) {
  let current = mode;
  let state: ThreatState = 'normal';
  const calls: string[] = [];
  const reports: Array<{ code: MessageKey; params?: MessageParams }> = [];
  const actions: ReactionActions = {
    mode: () => current,
    setTightened: (on) => void calls.push(`tighten:${on}`),
    setAutoPow: (level) => void calls.push(`pow:${level}`),
    rotateLink: () => void calls.push('rotate'),
    backToSecure: async () => {
      calls.push('backToSecure');
      await backToSecure();
      current = 'secure';
    },
    stopAll: async () => {
      calls.push('stop');
      return true;
    },
    report: (code, params) => {
      calls.push(`report:${code}`);
      reports.push({ code, ...(params ? { params } : {}) });
    },
  };
  const p = new ReactionPolicy(() => ({ ...DEFAULTS, ...over }), actions);
  const goTo = async (...states: ThreatState[]): Promise<string[]> => {
    const from = calls.length;
    for (const to of states) {
      await p.onThreat(to, state, 'attack.reason.badJoins');
      state = to;
    }
    return calls.slice(from);
  };
  return { p, calls, reports, goTo };
}

describe('automatic reactions in Secure mode', () => {
  it('suspicious turns on the light browser check', async () => {
    // Arrange
    const s = setup('secure');
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['pow:1']);
  });

  it('an attack tightens the limits and turns on the strong check', async () => {
    // Arrange
    const s = setup('secure');
    await s.goTo('suspicious');
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual(['tighten:true', 'pow:2']);
  });

  it('calming down to suspicious lightens the check and keeps the limits tight', async () => {
    // Arrange
    const s = setup('secure');
    await s.goTo('suspicious', 'attack');
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['pow:1']);
  });

  it('normal undoes everything', async () => {
    // Arrange
    const s = setup('secure');
    await s.goTo('suspicious', 'attack', 'suspicious');
    // Act
    const calls = await s.goTo('normal');
    // Assert
    expect(calls).toEqual(['tighten:false', 'pow:0']);
  });

  it('neither rotates the link nor stops by default', async () => {
    // Arrange
    const s = setup('secure');
    // Act
    const calls = await s.goTo('suspicious', 'attack', 'suspicious', 'normal');
    // Assert
    expect(calls).not.toContain('rotate');
    expect(calls).not.toContain('stop');
  });

  it('"auto new link" rotates once per attack and tells the streamer', async () => {
    // Arrange
    const s = setup('secure', { autoNewLink: true });
    // Act
    const calls = await s.goTo('attack', 'suspicious', 'attack');
    // Assert
    expect(calls.filter((c) => c === 'rotate')).toHaveLength(1);
    expect(calls).toContain('report:react.newLink');
  });

  it('"auto new link" rotates again on the next attack after calm', async () => {
    // Arrange
    const s = setup('secure', { autoNewLink: true });
    await s.goTo('attack', 'suspicious', 'attack', 'normal');
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toContain('rotate');
  });

  it('respects switched-off reactions', async () => {
    // Arrange
    const s = setup('secure', { autoTighten: false, autoBrowserCheck: false });
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual([]);
  });
});

describe('automatic reactions in Direct mode', () => {
  it('the first attack signs go back to Secure mode, with an explanation', async () => {
    // Arrange
    const s = setup('direct');
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['backToSecure', 'report:react.backToSecure']);
  });

  it('never the other way: a later attack gets the Secure-mode reactions', async () => {
    // Arrange
    const s = setup('direct');
    await s.goTo('suspicious');
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual(['tighten:true', 'pow:2']);
  });

  it('if going back fails: Stop everything (default) and explain why', async () => {
    // Arrange
    const s = setup('direct', {}, async () => {
      throw new Error('tunnel did not answer');
    });
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual(['backToSecure', 'stop', 'report:react.backToSecureFailedStopped']);
    expect(s.reports[0]?.params).toMatchObject({ error: 'tunnel did not answer' });
  });

  it('if going back fails without the automatic stop: only a warning', async () => {
    // Arrange
    const s = setup('direct', { autoStopIfDirectFails: false }, async () => {
      throw new Error('x');
    });
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['backToSecure', 'report:react.backToSecureFailed']);
  });

  it('with going back to Secure mode switched off: only a warning', async () => {
    // Arrange
    const s = setup('direct', { autoSecureFromDirect: false });
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual(['report:react.directNoAction']);
  });

  it('does not start a second drastic reaction while one is running', async () => {
    // Arrange
    let release!: () => void;
    const s = setup('direct', {}, () => new Promise<void>((r) => (release = r)));
    const first = s.p.onThreat('suspicious', 'normal', 'attack.reason.requests');
    // Act
    await s.p.onThreat('attack', 'suspicious', 'attack.reason.requests');
    release();
    await first;
    // Assert
    expect(s.calls.filter((c) => c === 'backToSecure')).toHaveLength(1);
  });
});

describe('"Turn everything off if an attack is detected"', () => {
  it('in Secure mode: suspicious still only turns on the light check', async () => {
    // Arrange
    const s = setup('secure', { stopOnAttack: true, autoNewLink: true });
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['pow:1']);
  });

  it('in Secure mode: an attack stops everything, instead of every other reaction', async () => {
    // Arrange
    const s = setup('secure', { stopOnAttack: true, autoNewLink: true });
    await s.goTo('suspicious');
    // Act
    const calls = await s.goTo('attack');
    // Assert
    expect(calls).toEqual(['stop', 'report:react.stopped']);
  });

  it('in Direct mode: the first signs stop everything', async () => {
    // Arrange
    const s = setup('direct', { stopOnAttack: true });
    // Act
    const calls = await s.goTo('suspicious');
    // Assert
    expect(calls).toEqual(['stop', 'report:react.stopped']);
  });
});
