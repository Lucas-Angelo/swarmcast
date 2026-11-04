// SwarmCast never runs WebRTC in Node: the server imports bittorrent-tracker/server only, and
// viewers use their browser's own RTCPeerConnection. Anything that loads this stand-in is a bug.
// The names webrtc-polyfill 1.2.2 imports are declared, so an import of it links and then fails
// here with this message instead of on a missing export.
throw new Error('node-datachannel is not installed: SwarmCast replaces it with a stand-in (apps/server/shims/node-datachannel), nothing may run WebRTC in Node');
export const PeerConnection = undefined;
export const RtcpReceivingSession = undefined;
export const Video = undefined;
export const Audio = undefined;
export const cleanup = undefined;
