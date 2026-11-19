import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { decodePlist, encodePlist, frame, InspectorApps, unframe, WebInspectorClient, type Plist } from '../devices/web-inspector.js';

// The Web Inspector client of the iOS device suite (apps/server/test/devices/web-inspector.ts):
// binary property lists as Apple writes them, the length-prefixed messages, and the connected
// applications it keeps, against a fake webinspectord on a local socket. The iOS device tests run
// it against a simulator's webinspectord on macOS 26 only (devices.yml); this runs everywhere.

/**
 * `_rpc_reportConnectedApplicationList:` with Safari and SpringBoard (a non-ASCII name, a
 * 3-byte integer, shared objects), written by Apple's encoder (`plutil -convert binary1`).
 */
const APPLE_APP_LIST = Buffer.from(
  'YnBsaXN0MDDSAQIDGVpfX2FyZ3VtZW50Wl9fc2VsZWN0b3LRBAVfEBtXSVJBcHBsaWNhdGlvbkRpY3Rpb25hcnlLZXnSBgcIFFhQSUQ6ODk4NlhQSUQ6NjAwNtYJCgsMDQ4GDxAREhNfEBtXSVJBcHBsaWNhdGlvbklkZW50aWZpZXJLZXlfEBhXSVJJc0FwcGxpY2F0aW9uUHJveHlLZXlfEBVXSVJBcHBsaWNhdGlvbk5hbWVLZXlfEBhXSVJJc0FwcGxpY2F0aW9uUmVhZHlLZXlfECFXSVJBcHBsaWNhdGlvbkJ1bmRsZUlkZW50aWZpZXJLZXlfEBlXSVJJc0FwcGxpY2F0aW9uQWN0aXZlS2V5CFZTYWZhcmkJXxAWY29tLmFwcGxlLm1vYmlsZXNhZmFyaRAB1QkKCw0OBw8WFxgIbxAPAMkAYwByAGEAbgAgAGQgGQBhAGMAYwB1AGUAaQBsXxAVY29tLmFwcGxlLnNwcmluZ2JvYXJkEgABEXBfECRfcnBjX3JlcG9ydENvbm5lY3RlZEFwcGxpY2F0aW9uTGlzdDoACAANABgAIwAmAEQASQBSAFsAaACGAKEAuQDUAPgBFAEVARwBHQE2ATgBQwFEAWUBfQGCAAAAAAAAAgEAAAAAAAAAGgAAAAAAAAAAAAAAAAAAAak=',
  'base64',
);

function app(pid: number, bundle: string): { [key: string]: Plist } {
  return { WIRApplicationIdentifierKey: `PID:${pid}`, WIRApplicationBundleIdentifierKey: bundle, WIRIsApplicationProxyKey: false };
}

/** A local socket path for this OS (a named pipe on Windows). */
function socketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\swarmcast-wi-${randomUUID()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 's');
}

/** A fake webinspectord: records every message it gets, and hands the test its side of the connection. */
async function fakeDaemon(): Promise<{ path: string; received: Plist[]; peer: Promise<net.Socket> }> {
  const where = socketPath();
  const received: Plist[] = [];
  let accepted!: (s: net.Socket) => void;
  const peer = new Promise<net.Socket>((resolve) => (accepted = resolve));
  const server = net.createServer((s) => {
    let pending: Buffer = Buffer.alloc(0);
    s.on('data', (chunk: Buffer) => {
      const { messages, rest } = unframe(Buffer.concat([pending, chunk]));
      pending = rest;
      received.push(...messages);
    });
    accepted(s);
  });
  await new Promise<void>((resolve) => server.listen(where, resolve));
  onTestFinished(async () => {
    (await peer.catch(() => null))?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { path: where, received, peer };
}

describe('the device suite Web Inspector client', () => {
  it("reads Apple's binary property lists", () => {
    // Act
    const message = decodePlist(APPLE_APP_LIST);
    // Assert
    expect(message).toEqual({
      __selector: '_rpc_reportConnectedApplicationList:',
      __argument: {
        WIRApplicationDictionaryKey: {
          'PID:8986': {
            WIRApplicationIdentifierKey: 'PID:8986',
            WIRApplicationBundleIdentifierKey: 'com.apple.mobilesafari',
            WIRApplicationNameKey: 'Safari',
            WIRIsApplicationProxyKey: false,
            WIRIsApplicationActiveKey: 1,
            WIRIsApplicationReadyKey: true,
          },
          'PID:6006': {
            WIRApplicationIdentifierKey: 'PID:6006',
            WIRApplicationBundleIdentifierKey: 'com.apple.springboard',
            WIRApplicationNameKey: 'Écran d’accueil',
            WIRIsApplicationProxyKey: false,
            WIRIsApplicationActiveKey: 70000,
          },
        },
      },
    });
  });

  it('writes binary property lists it reads back the same, long and non-ASCII strings and big numbers included', () => {
    // Arrange
    const message: Plist = { __selector: '_rpc_reportIdentifier:', __argument: { WIRConnectionIdentifierKey: randomUUID(), name: 'Écran d’accueil', list: [1, 300, 70_000, 5_000_000_000, true, false, null], long: 'x'.repeat(300) } };
    // Act
    const back = decodePlist(encodePlist(message));
    // Assert
    expect(back).toEqual(message);
  });

  it('splits a stream into whole messages, whatever the chunks', () => {
    // Arrange
    const stream = Buffer.concat([frame('_rpc_a:', { k: 'one' }), frame('_rpc_b:', { k: 'two' })]);
    const cut = 7;
    // Act
    const first = unframe(stream.subarray(0, cut));
    const second = unframe(Buffer.concat([first.rest, stream.subarray(cut)]));
    // Assert
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([
      { __selector: '_rpc_a:', __argument: { k: 'one' } },
      { __selector: '_rpc_b:', __argument: { k: 'two' } },
    ]);
    expect(second.rest.length).toBe(0);
  });

  it('keeps the connected applications from the list, the connections and the disconnections', () => {
    // Arrange
    const apps = new InspectorApps();
    // Act
    apps.take(decodePlist(APPLE_APP_LIST));
    apps.take({ __selector: '_rpc_applicationDisconnected:', __argument: app(8986, 'com.apple.mobilesafari') });
    const afterSafariLeft = apps.has('com.apple.mobilesafari');
    apps.take({ __selector: '_rpc_applicationConnected:', __argument: app(9100, 'com.apple.mobilesafari') });
    // Assert
    expect(afterSafariLeft).toBe(false);
    expect(apps.has('com.apple.mobilesafari')).toBe(true);
    expect(apps.describe()).toBe('webinspectord sent _rpc_reportConnectedApplicationList:, _rpc_applicationDisconnected:, _rpc_applicationConnected:; connected: com.apple.springboard (PID:6006), com.apple.mobilesafari (PID:9100)');
  });

  it('names itself, asks for the list, and learns of Safari when it connects', async () => {
    // Arrange
    const daemon = await fakeDaemon();
    const client = await WebInspectorClient.connect(daemon.path, 'c1');
    onTestFinished(() => client.close());
    const peer = await daemon.peer;
    await until(() => daemon.received.length === 2, { timeoutMs: 5_000, what: 'the two first messages', detail: () => JSON.stringify(daemon.received) });
    peer.write(frame('_rpc_reportConnectedApplicationList:', { WIRApplicationDictionaryKey: { 'PID:6006': app(6006, 'com.apple.springboard') } }));
    await until(() => client.apps.describe().includes('springboard'), { timeoutMs: 5_000, what: 'the list read', on: [[client.apps, 'change']] });
    const before = client.connected('com.apple.mobilesafari');
    // Act
    peer.write(frame('_rpc_applicationConnected:', app(8986, 'com.apple.mobilesafari')));
    await until(() => client.connected('com.apple.mobilesafari'), { timeoutMs: 5_000, what: 'Safari connected', on: [[client.apps, 'change']] });
    // Assert
    expect(daemon.received).toEqual([
      { __selector: '_rpc_reportIdentifier:', __argument: { WIRConnectionIdentifierKey: 'c1' } },
      { __selector: '_rpc_getConnectedApplications:', __argument: { WIRConnectionIdentifierKey: 'c1' } },
    ]);
    expect(before).toBe(false);
  });

  it('fails the check once webinspectord closes the connection, with what it had said', async () => {
    // Arrange
    const daemon = await fakeDaemon();
    const client = await WebInspectorClient.connect(daemon.path, 'c1');
    onTestFinished(() => client.close());
    const peer = await daemon.peer;
    // Act
    peer.end(frame('_rpc_reportConnectedApplicationList:', { WIRApplicationDictionaryKey: {} }));
    const waited = until(() => client.connected('com.apple.mobilesafari'), { timeoutMs: 5_000, what: 'Safari connected', on: [[client.apps, 'change']] });
    // Assert
    await expect(waited).rejects.toThrow('webinspectord closed the connection (webinspectord sent _rpc_reportConnectedApplicationList:; connected: none)');
  });
});
