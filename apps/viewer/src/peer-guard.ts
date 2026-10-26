/**
 * PeerGuard: lets the server order every viewer to drop a specific peer.
 *
 * p2p-media-loader has no public "disconnect peer" API, so we observe signaling:
 * - the tracker WebSocket tells us which peer_id sent which SDP (offer/answer);
 * - RTCPeerConnection.setRemoteDescription tells us which connection got that SDP.
 * Matching the ICE ufrag of both links a peer id to its RTCPeerConnection, which we
 * can close. Signaling messages from blocked peers are swallowed before the library
 * sees them. The server also refuses blocked sessions on the tracker, so this only
 * needs to handle connections that already existed.
 *
 * Installed before the player starts (import './peer-guard-install' first).
 */

import { trackerMux } from './tracker-mux.js';

export function asciiToHex(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += (s.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
  return out;
}

export function iceUfrag(sdp: string | undefined): string | null {
  if (!sdp) return null;
  const m = /a=ice-ufrag:(\S+)/.exec(sdp);
  return m ? m[1]! : null;
}

class Guard {
  private blocked = new Set<string>();
  private ufragToPeer = new Map<string, string>();
  private connections = new Map<RTCPeerConnection, string | null>();

  isBlocked(peerHex: string): boolean {
    return this.blocked.has(peerHex);
  }

  /** Inspect a tracker message. Returns false when it must be dropped. */
  onTrackerMessage(data: unknown): boolean {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return true;
    let msg: { peer_id?: unknown; offer?: { sdp?: string }; answer?: { sdp?: string } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return true;
    }
    if (typeof msg.peer_id !== 'string') return true;
    const peerHex = asciiToHex(msg.peer_id);
    if (this.blocked.has(peerHex)) return false;
    const ufrag = iceUfrag(msg.offer?.sdp ?? msg.answer?.sdp);
    if (ufrag) this.ufragToPeer.set(ufrag, peerHex);
    return true;
  }

  register(pc: RTCPeerConnection): void {
    if (this.connections.has(pc)) return;
    this.connections.set(pc, null);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') this.connections.delete(pc);
    });
  }

  onRemoteDescription(pc: RTCPeerConnection, sdp: string | undefined): boolean {
    const ufrag = iceUfrag(sdp);
    const peer = ufrag ? (this.ufragToPeer.get(ufrag) ?? null) : null;
    this.connections.set(pc, peer);
    if (peer && this.blocked.has(peer)) {
      pc.close();
      this.connections.delete(pc);
      return false;
    }
    return true;
  }

  block(peerHexes: string[]): number {
    let closed = 0;
    for (const p of peerHexes) this.blocked.add(p);
    for (const [pc, peer] of this.connections) {
      if (peer && this.blocked.has(peer)) {
        pc.close();
        this.connections.delete(pc);
        closed++;
      }
    }
    return closed;
  }

  unblock(peerHexes: string[]): void {
    for (const p of peerHexes) this.blocked.delete(p);
  }

  /** Close every connection (used when the streamer revokes our own P2P). */
  closeAll(): void {
    for (const pc of this.connections.keys()) pc.close();
    this.connections.clear();
  }
}

export const peerGuard = new Guard();

let installed = false;

export function installPeerGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Patch the prototype (not the constructor) so it works no matter when the
  // library captured window.RTCPeerConnection.
  const proto = window.RTCPeerConnection?.prototype;
  if (proto) {
    const original = proto.setRemoteDescription;
    proto.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit, ...rest: unknown[]) {
      peerGuard.register(this);
      if (!peerGuard.onRemoteDescription(this, desc?.sdp)) return Promise.reject(new Error('peer blocked'));
      return (original as (...a: unknown[]) => Promise<void>).call(this, desc, ...rest);
    } as typeof proto.setRemoteDescription;
  }
  // Tracker connections become channels inside the /control socket (tracker-mux.ts): one
  // WebSocket per viewer through the quick tunnel. Every tracker message passes the guard first.
  trackerMux.filter = (data) => peerGuard.onTrackerMessage(data);
  const NativeWS = window.WebSocket;
  class MuxedWebSocket extends NativeWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (trackerMux.handles(String(url))) {
        // A derived constructor may return another object instead of calling super().
        return trackerMux.create(String(url)) as unknown as MuxedWebSocket;
      }
      super(url, protocols);
    }
  }
  window.WebSocket = MuxedWebSocket as typeof WebSocket;
}
