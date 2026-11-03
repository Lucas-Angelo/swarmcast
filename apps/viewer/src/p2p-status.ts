/**
 * "Connecting to other viewers…" under the P2P switch (docs/QUALITY.md "Many people at once"):
 * finding peers takes a few seconds after P2P is turned on (the tracker's answer, then WebRTC
 * offers and STUN). Until the first peer connects the line says so, instead of "0 peers"; after
 * CONNECTING_MS without any (nobody else has P2P on) it shows the usual counters.
 */
export const CONNECTING_MS = 30_000;

export interface P2PConnectState {
  /** P2P is on for this viewer (and allowed). */
  enabled: boolean;
  peers: number;
  /** When it was last turned on (performance.now()), null while off. */
  onAt: number | null;
  /** A peer connected since it was turned on. */
  connectedOnce: boolean;
}

/** True while the line should say "Connecting to other viewers…". */
export function p2pConnecting(s: P2PConnectState, now: number): boolean {
  return s.enabled && s.peers === 0 && !s.connectedOnce && s.onAt !== null && now - s.onAt < CONNECTING_MS;
}
