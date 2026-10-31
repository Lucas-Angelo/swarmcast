import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { afterTrayExit, decodeTrayEvent, encodeTrayCommand, sameTrayState, startTray, TRAY_EXIT_NO_TRAY, trayStateFor } from '../../src/tray/tray.js';
import { captureLog, tempDir } from './helpers.js';

// The tray helper (a small native program) and SwarmCast talk in JSON lines: SwarmCast sends the
// icon state, the helper sends "ready" and menu clicks. Starting and waiting for OBS share the
// yellow "waiting" icon; stopping is yellow too, with Stop still enabled.

describe('trayStateFor', () => {
  it('off: gray, can start, cannot stop', () => {
    // Act
    const state = trayStateFor('off', 0);
    // Assert
    expect(state).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false });
  });

  it.each(['starting', 'waiting-obs'] as const)('%s: yellow, waiting for OBS', (phase) => {
    // Act
    const state = trayStateFor(phase, 0);
    // Assert
    expect(state).toEqual({ type: 'state', state: 'waiting', tooltip: 'SwarmCast: waiting for OBS', canStart: false, canStop: true });
  });

  it('live: green with the viewer count', () => {
    // Act
    const state = trayStateFor('live', 3);
    // Assert
    expect(state).toEqual({ type: 'state', state: 'live', tooltip: 'SwarmCast: live · 3 viewers', canStart: false, canStop: true });
  });

  it.each([
    [1, 'SwarmCast: live · 1 viewer'],
    [0, 'SwarmCast: live · 0 viewers'],
  ])('live with %i viewer(s): "%s"', (viewers, tooltip) => {
    // Act
    const state = trayStateFor('live', viewers);
    // Assert
    expect(state.tooltip).toBe(tooltip);
  });

  it('stopping: yellow, start disabled, stop still enabled', () => {
    // Act
    const state = trayStateFor('stopping', 5);
    // Assert
    expect(state).toMatchObject({ state: 'waiting', canStart: false, canStop: true });
  });
});

describe('sameTrayState', () => {
  it('nothing sent yet is never the same', () => {
    // Act
    const same = sameTrayState(null, trayStateFor('live', 2));
    // Assert
    expect(same).toBe(false);
  });

  it.each([
    ['the same live count', trayStateFor('live', 2), trayStateFor('live', 2), true],
    ['another viewer count', trayStateFor('live', 2), trayStateFor('live', 3), false],
    ['starting and waiting for OBS (same icon and text)', trayStateFor('starting', 0), trayStateFor('waiting-obs', 0), true],
    ['waiting for OBS and stopping (other text)', trayStateFor('waiting-obs', 0), trayStateFor('stopping', 0), false],
    ['another Start button state', trayStateFor('off', 0), { ...trayStateFor('off', 0), canStart: false }, false],
  ])('%s', (_what, a, b, expected) => {
    // Act
    const same = sameTrayState(a, b);
    // Assert
    expect(same).toBe(expected);
  });
});

describe('encodeTrayCommand', () => {
  it('writes one JSON object per line', () => {
    // Act
    const line = encodeTrayCommand(trayStateFor('off', 0));
    // Assert
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false });
  });

  it('writes quit as one line too', () => {
    // Act
    const line = encodeTrayCommand({ type: 'quit' });
    // Assert
    expect(line).toBe('{"type":"quit"}\n');
  });

  it('escapes newlines inside strings so a message stays on one line', () => {
    // Act
    const line = encodeTrayCommand({ ...trayStateFor('off', 0), tooltip: 'a\nb' });
    // Assert
    expect(line.split('\n')).toHaveLength(2);
  });
});

describe('decodeTrayEvent', () => {
  it('accepts ready', () => {
    // Act
    const event = decodeTrayEvent('{"type":"ready"}');
    // Assert
    expect(event).toEqual({ type: 'ready' });
  });

  it.each(['open', 'start', 'stop', 'quit'])('accepts the %s menu click', (id) => {
    // Act
    const event = decodeTrayEvent(JSON.stringify({ type: 'click', id }));
    // Assert
    expect(event).toEqual({ type: 'click', id });
  });

  it.each(['', 'not json', 'null', '42', '"ready"', '[]', '{}', '{"type":"click"}', '{"type":"click","id":"format-disk"}', '{"type":"click","id":1}', '{"type":"state"}'])('rejects %j', (line) => {
    // Act
    const event = decodeTrayEvent(line);
    // Assert
    expect(event).toBeNull();
  });
});

describe('afterTrayExit', () => {
  it.each([
    ['a crash (exit 2) is answered with one restart', 2, 0, 'restart'],
    ['a second exit leaves the panel only', 2, 1, 'panel-only'],
    ['a kill by a signal (no exit code) is answered with one restart', null, 0, 'restart'],
    ['"no tray on this desktop" (exit 3) is never restarted', TRAY_EXIT_NO_TRAY, 0, 'no-tray'],
  ] as const)('%s', (_what, code, restarts, expected) => {
    // Act
    const next = afterTrayExit(code, restarts);
    // Assert
    expect(next).toBe(expected);
  });
});

/** What the real helper prints on a display without a session bus (apps/tray/session.go). */
const NO_BUS = 'no D-Bus session bus (exec: "dbus-launch": executable file not found in $PATH): running without a tray icon';

describe('startTray', () => {
  // The stand-in helper is a shell script, so POSIX only; Windows' helper never exits with 3.
  it.skipIf(process.platform === 'win32')('a helper that finds no tray on this desktop is not started again: its reason is logged, the panel goes on', async () => {
    // Arrange
    vi.stubEnv('DISPLAY', ':99');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const binDir = tempDir('sc-tray-');
    const starts = path.join(binDir, 'starts');
    fs.writeFileSync(path.join(binDir, 'swarmcast-tray'), `#!/bin/sh\necho start >> '${starts}'\necho '${NO_BUS}' >&2\nexit ${TRAY_EXIT_NO_TRAY}\n`, { mode: 0o755 });
    const { log, lines } = captureLog('info');
    const app = { log, live: Object.assign(new EventEmitter(), { phase: 'off' }), paths: { binDir }, close: async () => {} } as unknown as App;
    const trayLines = (): Array<[unknown, unknown]> => lines().filter((l) => /tray/.test(String(l.msg))).map((l) => [l.msg, l.line]);
    // Act
    const tray = startTray(app);
    onTestFinished(() => tray?.close());
    await expect.poll(() => trayLines().length, { timeout: 10_000 }).toBe(2);
    // Assert
    expect(trayLines()).toEqual(
      expect.arrayContaining([
        ['tray helper stderr', NO_BUS],
        ['no tray icon on this desktop, panel only', undefined],
      ]),
    );
    expect(fs.readFileSync(starts, 'utf8')).toBe('start\n');
  });
});
