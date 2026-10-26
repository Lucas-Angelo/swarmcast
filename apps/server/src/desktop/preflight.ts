import { isPortFree } from '../core/ports.js';
import { StartupError } from './protocol.js';

/** True when a SwarmCast admin panel answers on 127.0.0.1:port (its "not authorized" page). */
export async function swarmcastAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const text = (await res.text()).slice(0, 2000);
    return res.status === 401 && text.includes('SwarmCast');
  } catch {
    return false;
  }
}

/**
 * Desktop mode refuses to start next to another SwarmCast (a start script in a terminal, or
 * a copy started by hand) instead of running a second panel that cannot go live: the shell
 * shows the `fatal` message. The start scripts keep their behaviour (panel on the next free
 * port, the live start explains the busy port).
 */
export async function desktopPreflight(ports: { admin: number; rtmp: number }): Promise<void> {
  if (await swarmcastAnswers(ports.admin)) {
    throw new StartupError(
      'already-running',
      'SwarmCast is already running on this computer (maybe in a terminal window). Close it (tray icon → Quit, or Ctrl+C in its window) and open SwarmCast again.',
    );
  }
  if (!(await isPortFree(ports.rtmp))) {
    throw new StartupError(
      'ports-busy',
      `Port ${ports.rtmp} (where OBS sends the video) is used by another program. Is SwarmCast already running? Close it (tray icon → Quit) or the other program, and open SwarmCast again.`,
    );
  }
}
