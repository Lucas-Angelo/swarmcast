'use strict';
// Only toString(buffer) is used by bittorrent-tracker (lib/server/parse-udp.js).
const net = require('node:net');

function toString(buf, offset = 0, length) {
  length = length ?? buf.length - offset;
  if (length === 4) return Array.from(buf.subarray(offset, offset + 4)).join('.');
  if (length === 16) {
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(offset + i).toString(16));
    return parts.join(':');
  }
  throw new Error('invalid IP buffer length');
}

module.exports = { toString, isV4Format: net.isIPv4, isV6Format: net.isIPv6 };
