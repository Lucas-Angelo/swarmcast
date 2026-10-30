import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileStateStore, MemoryStateStore, type LocalState } from '../../src/core/state.js';
import { cleanupStaleMapping, runCleanupCommand } from '../../src/direct/cleanup.js';
import type { PortMapper } from '../../src/direct/mapper.js';
import { tempDir } from './helpers.js';
import { mockRouter } from './helpers-b.js';

// `swarmcast --cleanup` (run by the uninstallers): removes a router port mapping that a crash
// left open, from state.json, through the router.

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const PORT = 40123;
/** cleanupStaleMapping's default wait for the router. */
const ROUTER_TIMEOUT_MS = 30_000;

/** What state.json holds after a crash in Direct mode: the mapping of `PORT` on the router at `controlUrl`. */
function crashedState(controlUrl = 'http://127.0.0.1:9/ctl/IPConn'): LocalState {
  return {
    lastDirectIp: '203.0.113.7',
    activeMapping: { kind: 'upnp', id: `${SERVICE}|${controlUrl}`, externalPort: PORT, internalPort: PORT, createdAt: 1 },
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
    // Arrange
    const lines: string[] = [];
    const missing = path.join(tempDir('swarmcast-cleanup-'), 'not-installed');
    // Act
    const code = await runCleanupCommand(missing, (l) => lines.push(l));
    // Assert
    expect(code).toBe(0);
    expect(lines).toEqual(['✓ No router port mapping to remove.']);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('removes the mapping saved in state.json through the router (real UPnP client, mock router), keeping the rest', async () => {
    // Arrange
    const igd = await mockRouter();
    igd.mappings.set(PORT, { internalPort: PORT, client: '192.168.1.5', description: 'SwarmCast direct mode', lease: 3600 });
    const dir = tempDir('swarmcast-cleanup-');
    const store = new FileStateStore(path.join(dir, 'state.json'));
    store.save(crashedState(`http://127.0.0.1:${igd.httpPort}/ctl/IPConn`));
    const lines: string[] = [];
    // Act
    const code = await runCleanupCommand(dir, (l) => lines.push(l));
    // Assert
    expect(code).toBe(0);
    expect(lines).toEqual([`✓ Removed the router port mapping (port ${PORT}).`]);
    expect(igd.mappings.size).toBe(0);
    expect(igd.calls).toContain('DeletePortMapping');
    expect(store.load().activeMapping).toBeNull();
    expect(store.load().lastDirectIp).toBe('203.0.113.7');
  });

  it('fails (exit 1) and keeps the record when the router cannot be reached', async () => {
    // Arrange
    const state = new MemoryStateStore(crashedState());
    // Act
    const r = await cleanupStaleMapping(state, { mapperFromId: () => null, discoverMapper: async () => null });
    // Assert
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(new RegExp(`port ${PORT}.*router settings`));
    expect(state.load().activeMapping).not.toBeNull();
  });

  it('fails when the router still reports the mapping afterwards', async () => {
    // Arrange
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ hasMapping: async () => true });
    // Act
    const r = await cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null });
    // Assert
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/did not confirm/);
  });

  it('reports a router error in the message', async () => {
    // Arrange
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ unmap: async () => Promise.reject(new Error('DeletePortMapping failed: Action not authorized')) });
    // Act
    const r = await cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null });
    // Assert
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Action not authorized/);
  });

  // The router's silence is the subject: fake timers stand in for the 30 s wait.
  it('gives up after the timeout when the router never answers', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const state = new MemoryStateStore(crashedState());
    const mapper = fakeMapper({ unmap: () => new Promise(() => {}) });
    let settled = false;
    // Act
    const result = cleanupStaleMapping(state, { mapperFromId: () => mapper, discoverMapper: async () => null }, ROUTER_TIMEOUT_MS);
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ROUTER_TIMEOUT_MS - 1);
    // Assert
    expect(settled).toBe(false);
    // Act
    await vi.advanceTimersByTimeAsync(1);
    // Assert
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not answer in time/);
    expect(state.load().activeMapping).not.toBeNull();
  });

  it('falls back to router discovery when the saved identifier is unusable', async () => {
    // Arrange
    const state = new MemoryStateStore(crashedState());
    let unmapped = 0;
    const mapper = fakeMapper({ unmap: async () => void unmapped++ });
    // Act
    const r = await cleanupStaleMapping(state, { mapperFromId: () => null, discoverMapper: async () => mapper });
    // Assert
    expect(r.ok).toBe(true);
    expect(unmapped).toBe(1);
    expect(state.load().activeMapping).toBeNull();
  });
});
