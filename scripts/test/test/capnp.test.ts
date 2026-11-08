// The Cap'n Proto pieces of the local Cloudflare edge (scripts/test/lib/capnp.mjs), checked
// against the encoding spec (https://capnproto.org/encoding.html) without cloudflared: the stream
// framing split across reads, a Call as cloudflared's RegistrationServer client sends it, and the
// Returns the edge sends back (capnp.mjs, cloudflare.mjs) read by the same rules. local-cloudflare.test.ts proves the whole
// exchange with the real cloudflared; this file pins the byte layout, so a change here fails
// without a binary and says which field moved.
import { describe, expect, it } from 'vitest';
import { Builder, Msg, StructReader, exceptionMessage, readFrames, readRpc, returnMessage } from '../lib/capnp.mjs';
import { connectionDetailsReturn } from '../lib/cloudflare.mjs';

/** tunnelrpc.capnp `interface RegistrationServer`. */
const REGISTRATION_SERVER = 0xf71695ec7fe85497n;
const TUNNEL_ID = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

/**
 * rpc.capnp Message{call} of registerConnection(auth, tunnelId, connIndex, options), built by the
 * spec's rules: Message (1 data word, 1 pointer), Call (3, 3: questionId u32 @0 bytes 0-3,
 * methodId u16 bytes 4-5, interfaceId u64 bytes 8-15, target ptr 0, params ptr 1), Payload
 * (0, 2: content ptr 0), params (1, 3: connIndex u8 byte 0, auth ptr 0, tunnelId ptr 1).
 */
function registrationCall(questionId: number, connIndex: number, methodId = 0): Buffer {
  const b = new Builder();
  const call = b.root(1, 1).u16(0, Msg.call).struct(0, 3, 3).u32(0, questionId).u16(4, methodId);
  call.u32(8, Number(REGISTRATION_SERVER & 0xffffffffn)).u32(12, Number(REGISTRATION_SERVER >> 32n));
  const params = call.struct(1, 0, 2).struct(0, 1, 3);
  // connIndex: the Builder has no u8, so it is the low byte of a u16 at byte 0.
  params.data(1, TUNNEL_ID).u16(0, connIndex);
  return b.frame();
}

describe('capnp stream framing', () => {
  it('reads a message only once all its bytes arrived, and keeps what follows', () => {
    // Arrange
    const one = registrationCall(7, 2);
    const two = registrationCall(8, 3);
    const stream = Buffer.concat([one, two]);
    // Act
    const first = readFrames(stream.subarray(0, one.length - 1));
    const second = readFrames(Buffer.concat([first.rest, stream.subarray(one.length - 1, one.length + 5)]));
    const third = readFrames(Buffer.concat([second.rest, stream.subarray(one.length + 5)]));
    // Assert
    expect(first.messages).toHaveLength(0);
    expect(second.messages).toHaveLength(1);
    expect(second.rest).toHaveLength(5);
    expect(third.messages).toHaveLength(1);
    expect(third.rest).toHaveLength(0);
  });

  it('reads a frame of two segments (a segment table padded to a word)', () => {
    // Arrange: segment 0 holds the root pointer as a far pointer to a landing pad in segment 1.
    const header = Buffer.alloc(16);
    header.writeUInt32LE(1, 0); // two segments
    header.writeUInt32LE(1, 4); // segment 0: one word
    header.writeUInt32LE(3, 8); // segment 1: three words
    const seg0 = Buffer.alloc(8);
    seg0.writeUInt32LE((0 << 3) | 2, 0); // far pointer to word 0 of segment 1
    seg0.writeUInt32LE(1, 4);
    const seg1 = Buffer.alloc(24);
    seg1.writeUInt32LE(0 << 2, 0); // struct right after the pad: 1 data word, 1 pointer
    seg1.writeUInt32LE(1 | (1 << 16), 4);
    seg1.writeUInt16LE(Msg.finish, 8);
    // Act
    const { messages, rest } = readFrames(Buffer.concat([header, seg0, seg1]));
    // Assert
    expect(rest).toHaveLength(0);
    expect(messages[0]!.root()).toBeInstanceOf(StructReader);
    expect((messages[0]!.root() as StructReader).u16(0)).toBe(Msg.finish);
  });
});

describe('capnp RPC messages', () => {
  it("reads a registerConnection call: question, interface, method, tunnel id and connection index", () => {
    // Arrange
    const { messages } = readFrames(registrationCall(42, 3));
    // Act
    const rpc = readRpc(messages[0]!);
    // Assert
    expect(rpc).toMatchObject({ which: Msg.call, id: 42, interfaceId: REGISTRATION_SERVER, methodId: 0 });
    expect(rpc.params?.ptr(1)).toEqual(TUNNEL_ID);
    expect(rpc.params?.u8(0)).toBe(3);
  });

  it('reads the method of a call (unregisterConnection @1, updateLocalConfiguration @2)', () => {
    // Arrange
    const calls = [registrationCall(1, 0, 1), registrationCall(2, 0, 2)];
    // Act
    const methods = calls.map((c) => readRpc(readFrames(c).messages[0]!).methodId);
    // Assert
    expect(methods).toEqual([1, 2]);
  });

  it('writes the bootstrap Return as the capability the edge exports (capTable [senderHosted 0])', () => {
    // Arrange
    const { messages } = readFrames(returnMessage(5, { cap: true }));
    // Act
    const msg = messages[0]!.root() as StructReader;
    const ret = msg.ptr(0) as StructReader;
    const payload = ret.ptr(0) as StructReader;
    // Assert
    expect(msg.u16(0)).toBe(Msg.return);
    expect(ret.u32(0)).toBe(5);
    expect(ret.u16(6)).toBe(0); // results
    expect(ret.u32(4) & 1).toBe(0); // releaseParamCaps keeps its default (true)
    expect(payload.ptr(0)).toEqual({ cap: 0 });
  });

  it('writes registerConnection results as ConnectionResponse.connectionDetails { uuid, locationName }', () => {
    // Arrange
    const uuid = Buffer.alloc(16, 0xab);
    const reply = connectionDetailsReturn(9, uuid);
    // Act
    const ret = (readFrames(reply).messages[0]!.root() as StructReader).ptr(0) as StructReader;
    const response = ((ret.ptr(0) as StructReader).ptr(0) as StructReader).ptr(0) as StructReader;
    const details = response.ptr(0) as StructReader;
    // Assert
    expect(ret.u32(0)).toBe(9);
    expect(response.u16(0)).toBe(1); // union member 1: connectionDetails
    expect(details.ptr(0)).toEqual(uuid);
    expect(details.ptr(1)).toEqual(Buffer.from('LCL\0'));
  });

  it('writes an exception Return with its reason as NUL-terminated text', () => {
    // Arrange
    const reply = exceptionMessage(11, 'not implemented');
    // Act
    const ret = (readFrames(reply).messages[0]!.root() as StructReader).ptr(0) as StructReader;
    const exception = ret.ptr(0) as StructReader;
    // Assert
    expect(ret.u32(0)).toBe(11);
    expect(ret.u16(6)).toBe(1); // exception
    expect(exception.ptr(0)).toEqual(Buffer.from('not implemented\0'));
  });
});
