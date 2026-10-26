import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStateStore, MemoryStateStore, type LocalState } from '../../src/core/state.js';
import { cleanupStaleMapping, runCleanupCommand } from '../../src/direct/cleanup.js';
import type { PortMapper } from '../../src/direct/mapper.js';
import { MockIgd } from './mock-igd.js';

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

let igd: MockIgd;
let dir: string;

beforeEach(async () => {
  igd = new MockIgd('203.0.113.7');
  await igd.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmcast-cleanup-'));
});
afterEach(async () => {
  await igd.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function crashedState(externalPort = 40123): LocalState {
  return {
    lastDirectIp: '203.0.113.7',
    activeMapping: { kind: 'upnp', id: `${SERVICE}|http://127.0.0.1:${igd.httpPort}/ctl/IPConn`, externalPort, internalPort: externalPort, createdAt: 1 },
  };
}

function fakeMapper(over: Partial<PortMapper> = {}): PortMapper {
  return {
    kind: 'upnp',
    id: 'x',
    externalIp: async () => '203.0.113.7',
    map: async () => {},
    unmap: async () => {},
    hasMapping: async () => false,
    ...over,
  };
}

describe('swarmcast --cleanup', () => {
  it('with no data folder: nothing to do, exit 0, creates nothing', async () => {
    const lines: string[] = [];
    const missing = path.join(dir, 'not-installed');
    expect(await runCleanupCommand(missing, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['✓ No router port mapping to remove.']);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('removes the mapping saved in state.json through the router (real UPnP client, mock router)', async () => {
    igd.mappings.set(40123, { internalPort: 40123, client: '192.168.1.5', description: 'SwarmCast direct mode', lease: 3600 });
    const store = new FileStateStore(path.join(dir, 'state.json'));
    store.save(crashedState());
    const lines: string[] = [];
    expect(await runCleanupCommand(dir, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['✓ Removed the router port mapping (port 40123).']);
    expect(igd.mappings.size).toBe(0);
    expect(igd.calls).toContain('DeletePortMapping');
    expect(store.load().activeMapping).toBeNull();
    // Unrelated state is kept.
    expect(store.load().lastDirectIp).toBe('203.0.113.7');
  });

  it('fails (exit 1) and keeps the record when the router cannot be reached', async () => {
    const state = new MemoryStateStore(crashedState());
    const r = await cleanupStaleMapping(state, { mapperFromId: () => null, discoverMapper: async () => null });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/port 40123.*router settings/);
    expect(state.load().activeMapping).not.toBeNull();
  });

  it('fails when the router still reports the mapping afterwards', async () => {
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ hasMapping: async () => true });
    const r = await cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/did not confirm/);
  });

  it('reports a router error in the message', async () => {
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ unmap: async () => Promise.reject(new Error('DeletePortMapping failed: Action not authorized')) });
    const r = await cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Action not authorized/);
  });

  it('gives up after the timeout when the router never answers', async () => {
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ unmap: () => new Promise(() => {}) });
    const r = await cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null }, 50);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not answer in time/);
  });

  it('falls back to router discovery when the saved identifier is unusable', async () => {
    const state = new MemoryStateStore(crashedState());
    let unmapped = 0;
    const mapper = fakeMapper({ unmap: async () => void unmapped++ });
    const r = await cleanupStaleMapping(state, { mapperFromId: () => null, discoverMapper: async () => mapper });
    expect(r.ok).toBe(true);
    expect(unmapped).toBe(1);
    expect(state.load().activeMapping).toBeNull();
  });
});
