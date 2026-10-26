import { describe, expect, it, vi } from 'vitest';
import type { SecuritySettings } from '@swarmcast/shared';
import { ReactionPolicy, type ReactionActions } from '../../src/security/reactions.js';

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

function setup(mode: 'secure' | 'direct', over: Partial<SecuritySettings> = {}, backToSecure: () => Promise<void> = async () => {}) {
  let current = mode;
  const calls: string[] = [];
  const a: ReactionActions = {
    mode: () => current,
    setTightened: vi.fn((on: boolean) => void calls.push(`tighten:${on}`)),
    setAutoPow: vi.fn((l: number) => void calls.push(`pow:${l}`)),
    rotateLink: vi.fn(() => void calls.push('rotate')),
    backToSecure: vi.fn(async () => {
      calls.push('backToSecure');
      await backToSecure();
      current = 'secure';
    }),
    stopAll: vi.fn(async () => {
      calls.push('stop');
      return true;
    }),
    report: vi.fn((code: string) => void calls.push(`report:${code}`)),
  };
  const settings = { ...DEFAULTS, ...over };
  const p = new ReactionPolicy(() => settings, a);
  return { p, a, calls, settings };
}

describe('automatic reactions', () => {
  it('Secure mode: suspicious → light check; attack → tighter limits + strong check; no new link by default; normal → undo', async () => {
    const { p, calls } = setup('secure');
    await p.onThreat('suspicious', 'normal', 'attack.reason.badJoins');
    expect(calls).toEqual(['pow:1']);
    await p.onThreat('attack', 'suspicious', 'attack.reason.badJoins');
    expect(calls).toEqual(['pow:1', 'tighten:true', 'pow:2']);
    await p.onThreat('suspicious', 'attack', 'attack.reason.badJoins');
    expect(calls.at(-1)).toBe('pow:1');
    await p.onThreat('normal', 'suspicious', 'attack.reason.badJoins');
    expect(calls.slice(-2)).toEqual(['tighten:false', 'pow:0']);
    expect(calls).not.toContain('rotate');
    expect(calls).not.toContain('stop');
  });

  it('Secure mode: "auto new link" rotates once per attack and tells the streamer', async () => {
    const { p, calls } = setup('secure', { autoNewLink: true });
    await p.onThreat('attack', 'normal', 'attack.reason.joins');
    await p.onThreat('suspicious', 'attack', 'attack.reason.joins');
    await p.onThreat('attack', 'suspicious', 'attack.reason.joins');
    expect(calls.filter((c) => c === 'rotate')).toHaveLength(1);
    expect(calls).toContain('report:react.newLink');
    await p.onThreat('normal', 'suspicious', 'attack.reason.joins');
    await p.onThreat('attack', 'normal', 'attack.reason.joins');
    expect(calls.filter((c) => c === 'rotate')).toHaveLength(2);
  });

  it('respects switched-off reactions', async () => {
    const { p, calls } = setup('secure', { autoTighten: false, autoBrowserCheck: false });
    await p.onThreat('attack', 'normal', 'attack.reason.requests');
    expect(calls).toEqual([]);
  });

  it('Direct mode: first attack signs → back to Secure mode (never the other way), with an explanation', async () => {
    const { p, a, calls } = setup('direct');
    await p.onThreat('suspicious', 'normal', 'attack.reason.tlsErrors');
    expect(calls).toEqual(['backToSecure', 'report:react.backToSecure']);
    expect(a.stopAll).not.toHaveBeenCalled();
    // Now in Secure mode: a later attack uses the Secure-mode reactions.
    await p.onThreat('attack', 'suspicious', 'attack.reason.tlsErrors');
    expect(calls.slice(2)).toEqual(['tighten:true', 'pow:2']);
  });

  it('Direct mode: if going back fails → Stop everything (default) and explain', async () => {
    const { p, a, calls } = setup('direct', {}, async () => {
      throw new Error('tunnel did not answer');
    });
    await p.onThreat('attack', 'normal', 'attack.reason.connections');
    expect(calls).toEqual(['backToSecure', 'stop', 'report:react.backToSecureFailedStopped']);
    expect((a.report as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ error: 'tunnel did not answer' });
  });

  it('Direct mode: failure without auto-stop only warns; with both off it only warns', async () => {
    const a = setup('direct', { autoStopIfDirectFails: false }, async () => {
      throw new Error('x');
    });
    await a.p.onThreat('suspicious', 'normal', 'attack.reason.connections');
    expect(a.calls).toEqual(['backToSecure', 'report:react.backToSecureFailed']);
    const b = setup('direct', { autoSecureFromDirect: false });
    await b.p.onThreat('attack', 'normal', 'attack.reason.connections');
    expect(b.calls).toEqual(['report:react.directNoAction']);
  });

  it('"Turn everything off if an attack is detected" stops in both modes and wins over the rest', async () => {
    const s = setup('secure', { stopOnAttack: true, autoNewLink: true });
    await s.p.onThreat('suspicious', 'normal', 'attack.reason.requests');
    expect(s.calls).toEqual(['pow:1']);
    await s.p.onThreat('attack', 'suspicious', 'attack.reason.requests');
    expect(s.calls).toEqual(['pow:1', 'stop', 'report:react.stopped']);
    const d = setup('direct', { stopOnAttack: true });
    await d.p.onThreat('suspicious', 'normal', 'attack.reason.requests');
    expect(d.calls).toEqual(['stop', 'report:react.stopped']);
  });

  it('does not start a second drastic reaction while one is running', async () => {
    let release!: () => void;
    const { p, a } = setup('direct', {}, () => new Promise<void>((r) => (release = r)));
    const first = p.onThreat('suspicious', 'normal', 'attack.reason.requests');
    await p.onThreat('attack', 'suspicious', 'attack.reason.requests');
    release();
    await first;
    expect(a.backToSecure).toHaveBeenCalledTimes(1);
  });
});
