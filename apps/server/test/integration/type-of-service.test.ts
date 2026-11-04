import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isListening } from '../../src/core/ports.js';
import { allocAppPorts, BROWSER_MODE, ServerProcess, signIn, stopTracked, tmpDir, writeConfig } from './helpers.js';

// The built server, with every new connection its fetch() opens answering "EINVAL" to the type
// of service, as macOS does on a connection the other side has just reset (what stopped the
// desktop app in CI while it stopped the live: src/core/type-of-service.ts). The preload makes
// that happen on each connection, right where undici reports it connected; without the guard
// the server dies on the first one ("uncaught exception", exit code 1). The fetches here are the
// HLS origin's polls of MediaMTX, which start with the live.

afterEach(stopTracked);

/** Loaded with --import into the server: refuses the type of service on each new fetch() connection. */
const REFUSE_TYPE_OF_SERVICE = `
import diagnostics from 'node:diagnostics_channel';
import os from 'node:os';
let n = 0;
diagnostics.subscribe('undici:client:connected', ({ socket }) => {
  if (socket._handle) socket._handle.setTypeOfService = () => -os.constants.errno.EINVAL;
  process.stdout.write('test: type of service refused on connection ' + ++n + '\\n');
});
`;

describe('a connection reset under fetch() (type of service refused)', () => {
  it('the live still polls MediaMTX, and Quit exits with code 0 leaving nothing behind', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const dataDir = tmpDir();
    writeConfig(dataDir, ports);
    const preload = path.join(tmpDir('sc-preload-'), 'refuse-type-of-service.mjs');
    fs.writeFileSync(preload, REFUSE_TYPE_OF_SERVICE);
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
    const server = new ServerProcess({ args: BROWSER_MODE, dataDir, env: { NODE_OPTIONS: nodeOptions } });
    const [, loginUrl] = await server.logLine(/^Panel: (http:\/\/\S+\/auth\/\S+)/, 'the panel address');
    const panel = await signIn(loginUrl!);
    // Act
    await server.logLine(/^test: type of service refused on connection 1$/, 'a fetch() connection of the server');
    const state = await (await panel.api('/api/state')).json();
    const res = await panel.api('/api/app/quit', { method: 'POST', body: '{}' });
    const { code, signal } = await server.proc.exited;
    // Assert
    expect(state.phase, server.proc.tail(20)).not.toBe('off');
    expect({ status: res.status, code, signal }, server.proc.tail(20)).toEqual({ status: 200, code: 0, signal: null });
    expect(server.logLines.join('\n')).not.toContain('uncaught exception');
    expect(server.logLines.join('\n')).toContain('Off: nothing on your computer is reachable');
    for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
  });
});
