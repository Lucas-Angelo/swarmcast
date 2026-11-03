// "Connecting to other viewers…" under the P2P switch (p2p-status.ts).
import { describe, expect, it } from 'vitest';
import { CONNECTING_MS, p2pConnecting } from '../../src/p2p-status.js';

const on = { enabled: true, peers: 0, onAt: 1_000, connectedOnce: false };

describe('p2pConnecting', () => {
  it('says "connecting" from the moment P2P is on until the first peer', () => {
    expect(p2pConnecting(on, 1_000)).toBe(true);
    expect(p2pConnecting(on, 1_000 + CONNECTING_MS - 1)).toBe(true);
    expect(p2pConnecting({ ...on, peers: 1 }, 2_000)).toBe(false);
  });

  it('stops after CONNECTING_MS without peers (nobody else has P2P on), and after the first peer even if it leaves', () => {
    expect(p2pConnecting(on, 1_000 + CONNECTING_MS)).toBe(false);
    expect(p2pConnecting({ ...on, connectedOnce: true }, 2_000)).toBe(false);
  });

  it('never while P2P is off', () => {
    expect(p2pConnecting({ ...on, enabled: false }, 2_000)).toBe(false);
    expect(p2pConnecting({ ...on, onAt: null }, 2_000)).toBe(false);
  });
});
