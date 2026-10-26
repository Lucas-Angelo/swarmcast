import pino from 'pino';
import { resolvePaths } from '../core/paths.js';
import { FileStateStore, type StateStore } from '../core/state.js';
import { DirectMode, type DirectDeps } from './direct.js';
import { defaultGateway } from './mapper.js';
import { NatPmpGateway } from './natpmp.js';
import { UpnpGateway, discoverUpnp } from './upnp.js';

/** How SwarmCast finds the router (UPnP first, then NAT-PMP) and rebuilds it from a saved id. */
export function routerDeps(): Pick<DirectDeps, 'discoverMapper' | 'mapperFromId'> {
  return {
    discoverMapper: async () => {
      const upnp = await discoverUpnp().catch(() => null);
      if (upnp) return upnp;
      const gw = await defaultGateway();
      if (!gw) return null;
      const pmp = new NatPmpGateway(gw);
      try {
        await pmp.externalIp();
        return pmp;
      } catch {
        return null;
      }
    },
    mapperFromId: (kind, id) => {
      try {
        if (kind === 'upnp') return UpnpGateway.fromId(id);
        const [host, port] = id.split(':');
        return host ? new NatPmpGateway(host, Number(port) || 5351) : null;
      } catch {
        return null;
      }
    },
  };
}

export interface CleanupResult {
  ok: boolean;
  /** One line of plain English for the uninstaller's window. */
  message: string;
}

function unavailable(): never {
  throw new Error('not available in --cleanup');
}

/**
 * Remove a router port mapping that a crash left open (saved in state.json), using
 * DirectMode.cleanupStale(). Needs only the state file and the router: no admin server,
 * no secrets, nothing is created in the data folder.
 */
export async function cleanupStaleMapping(
  state: StateStore,
  deps: Pick<DirectDeps, 'discoverMapper' | 'mapperFromId'> = routerDeps(),
  timeoutMs = 30_000,
): Promise<CleanupResult> {
  const mapping = state.load().activeMapping;
  if (!mapping) return { ok: true, message: 'No router port mapping to remove.' };
  const port = mapping.externalPort;
  const direct = new DirectMode({
    log: pino({ level: 'silent' }),
    state,
    ...deps,
    publicIps: unavailable,
    localAddress: unavailable,
    localAddresses: unavailable,
    issuer: { issue: unavailable } as unknown as DirectDeps['issuer'],
    startServer: unavailable,
  });
  const failed = (why: string): CleanupResult => ({
    ok: false,
    message: `Could not remove the router port mapping (port ${port}): ${why}. If it is still open, remove it in your router settings.`,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const removed = await Promise.race([direct.cleanupStale(), timeout]);
    if (removed === 'timeout') return failed('the router did not answer in time');
    if (!removed) return failed('the router did not confirm it');
    return { ok: true, message: `Removed the router port mapping (port ${port}).` };
  } catch (err) {
    return failed((err as Error).message || String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** `swarmcast --cleanup [--data-dir DIR]`: prints one line, returns the exit code. */
export async function runCleanupCommand(dataDir?: string, print: (line: string) => void = console.log): Promise<number> {
  const paths = resolvePaths(dataDir);
  const result = await cleanupStaleMapping(new FileStateStore(paths.stateFile));
  print(`${result.ok ? '✓' : '✗'} ${result.message}`);
  return result.ok ? 0 : 1;
}
