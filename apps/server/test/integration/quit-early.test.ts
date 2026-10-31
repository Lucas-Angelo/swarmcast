import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { isListening } from '../../src/core/ports.js';
import { SelfSignedIssuer } from '../../src/direct/certs.js';
import { allocAppPorts, hangingServer, SCRIPT_MODE, ServerProcess, signIn, stopTracked, tmpDir, until, writeConfig, type HangingServer, type Panel, type Ports } from './helpers.js';

// Quitting early: the start scripts restart SwarmCast when it exits with a non-zero code within
// 10 s (start-windows.ps1). A user who quits right after the panel opened (the panel's Quit,
// while the live and the blocklists are still starting) must get a clean exit 0, or the script
// would start SwarmCast again. Each test quits at one moment of the start-up, reached for sure:
// the slow steps (the tunnel's reachability check, a blocklist download) wait on a local server
// that never answers, and the test quits once that server has the request.

afterEach(stopTracked);

/** SwarmCast in script mode with `config` over testConfig(), signed in like the browser. */
async function startSignedIn(o: { args?: string[]; config?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<{ server: ServerProcess; panel: Panel; ports: Ports }> {
  const ports = await allocAppPorts();
  const dataDir = tmpDir();
  writeConfig(dataDir, ports, o.config);
  const server = new ServerProcess({ args: o.args ?? SCRIPT_MODE, dataDir, env: o.env });
  const [, loginUrl] = await server.logLine(/^Panel: (http:\/\/\S+\/auth\/\S+)/, 'the panel address');
  return { server, panel: await signIn(loginUrl!), ports };
}

/** A server that never answers, closed after the test. */
async function hangingFor(o: Parameters<typeof hangingServer>[0] = {}): Promise<HangingServer> {
  const hang = await hangingServer(o);
  onTestFinished(() => hang.close());
  return hang;
}

/** Resolves once `hang` has a request for `p` (fails at once if the server exits first). */
function requested(hang: HangingServer, p: string, server: ServerProcess): Promise<void> {
  return until(() => hang.requests.includes(p), { timeoutMs: 30_000, what: `a request for ${p}`, abortOn: [server.proc], on: [[hang.server, 'request']], detail: () => `requests ${JSON.stringify(hang.requests)}; last output: ${server.proc.tail(10)}` });
}

/** The panel's Quit: its answer, and how the process ended. */
async function quit(server: ServerProcess, panel: Panel): Promise<{ status: number; code: number | null; signal: NodeJS.Signals | null }> {
  const res = await panel.api('/api/app/quit', { method: 'POST', body: '{}' });
  const { code, signal } = await server.proc.exited;
  return { status: res.status, code, signal };
}

/** Quit was answered, the exit was clean (code 0, the "Off" line), and none of its ports is in use. */
async function expectCleanExit(server: ServerProcess, ports: Ports, result: Awaited<ReturnType<typeof quit>>): Promise<void> {
  expect(result, server.proc.tail(20)).toEqual({ status: 200, code: 0, signal: null });
  expect(server.logLines.join('\n')).toContain('Off: nothing on your computer is reachable');
  for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
}

describe('quitting right after start-up', () => {
  it('Quit the moment the panel is ready (the live just starting) exits with code 0 and leaves nothing behind', async () => {
    // Arrange
    const { server, panel, ports } = await startSignedIn();
    // Act
    const result = await quit(server, panel);
    // Assert
    await expectCleanExit(server, ports, result);
  });

  it('Quit while the live waits for the tunnel to answer exits with code 0 and leaves nothing behind', async () => {
    // Arrange
    const hang = await hangingFor();
    const { server, panel, ports } = await startSignedIn({ args: ['--no-open', '--no-tray'], config: { tunnel: { provider: 'external', externalUrl: hang.url } } });
    await requested(hang, '/healthz', server);
    // Act
    const result = await quit(server, panel);
    // Assert
    await expectCleanExit(server, ports, result);
  });

  it('Quit while a blocklist download hangs exits with code 0 and leaves nothing behind', async () => {
    // Arrange
    const tls = await new SelfSignedIssuer().issue('127.0.0.1');
    const ca = path.join(tmpDir(), 'blocklist-ca.pem');
    fs.writeFileSync(ca, tls.certPem);
    const hang = await hangingFor({ tls });
    const { server, panel, ports } = await startSignedIn({ config: { security: { blocklists: [], extraBlocklistUrls: [`${hang.url}/blocklist.txt`] } }, env: { NODE_EXTRA_CA_CERTS: ca } });
    await requested(hang, '/blocklist.txt', server);
    // Act
    const result = await quit(server, panel);
    // Assert
    await expectCleanExit(server, ports, result);
  });

  it('Quit once the live waits for OBS exits with code 0 and leaves nothing behind', async () => {
    // Arrange
    const { server, panel, ports } = await startSignedIn();
    await until(async () => ((await (await panel.api('/api/state')).json()) as { phase: string }).phase === 'waiting-obs', { timeoutMs: 30_000, what: 'the live to wait for OBS', abortOn: [server.proc] });
    // Act
    const result = await quit(server, panel);
    // Assert
    await expectCleanExit(server, ports, result);
  });
});
