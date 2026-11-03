'use strict';
// SwarmCast never runs WebRTC in Node: the server imports bittorrent-tracker/server only, and
// viewers use their browser's own RTCPeerConnection. Anything that loads this stand-in is a bug.
throw new Error('node-datachannel is not installed: SwarmCast replaces it with a stand-in (apps/server/shims/node-datachannel), nothing may run WebRTC in Node');
