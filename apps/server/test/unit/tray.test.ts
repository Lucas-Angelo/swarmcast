import { describe, expect, it } from 'vitest';
import { decodeTrayEvent, encodeTrayCommand, sameTrayState, trayStateFor } from '../../src/tray/tray.js';

describe('trayStateFor', () => {
  it('off: gray, can start, cannot stop', () => {
    expect(trayStateFor('off', 0)).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false });
  });

  it('starting and waiting-obs: yellow, waiting for OBS', () => {
    for (const phase of ['starting', 'waiting-obs'] as const) {
      expect(trayStateFor(phase, 0)).toEqual({
        type: 'state',
        state: 'waiting',
        tooltip: 'SwarmCast: waiting for OBS',
        canStart: false,
        canStop: true,
      });
    }
  });

  it('live: green with the viewer count', () => {
    expect(trayStateFor('live', 3)).toEqual({ type: 'state', state: 'live', tooltip: 'SwarmCast: live · 3 viewers', canStart: false, canStop: true });
    expect(trayStateFor('live', 1).tooltip).toBe('SwarmCast: live · 1 viewer');
    expect(trayStateFor('live', 0).tooltip).toBe('SwarmCast: live · 0 viewers');
  });

  it('stopping: yellow, start disabled, stop still enabled', () => {
    expect(trayStateFor('stopping', 5)).toMatchObject({ state: 'waiting', canStart: false, canStop: true });
  });
});

describe('sameTrayState', () => {
  it('detects changes in any visible field', () => {
    const a = trayStateFor('live', 2);
    expect(sameTrayState(null, a)).toBe(false);
    expect(sameTrayState(a, trayStateFor('live', 2))).toBe(true);
    expect(sameTrayState(a, trayStateFor('live', 3))).toBe(false);
    expect(sameTrayState(trayStateFor('starting', 0), trayStateFor('waiting-obs', 0))).toBe(true);
    expect(sameTrayState(trayStateFor('waiting-obs', 0), trayStateFor('stopping', 0))).toBe(false);
    expect(sameTrayState(trayStateFor('off', 0), { ...trayStateFor('off', 0), canStart: false })).toBe(false);
  });
});

describe('encodeTrayCommand', () => {
  it('writes one JSON object per line', () => {
    const line = encodeTrayCommand(trayStateFor('off', 0));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ type: 'state', state: 'off', tooltip: 'SwarmCast: off', canStart: true, canStop: false });
    expect(encodeTrayCommand({ type: 'quit' })).toBe('{"type":"quit"}\n');
  });

  it('escapes newlines inside strings so a message stays on one line', () => {
    const line = encodeTrayCommand({ ...trayStateFor('off', 0), tooltip: 'a\nb' });
    expect(line.split('\n')).toHaveLength(2);
  });
});

describe('decodeTrayEvent', () => {
  it('accepts ready and the four menu clicks', () => {
    expect(decodeTrayEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    for (const id of ['open', 'start', 'stop', 'quit']) {
      expect(decodeTrayEvent(JSON.stringify({ type: 'click', id }))).toEqual({ type: 'click', id });
    }
  });

  it('rejects anything else', () => {
    for (const line of ['', 'not json', 'null', '42', '"ready"', '[]', '{}', '{"type":"click"}', '{"type":"click","id":"format-disk"}', '{"type":"click","id":1}', '{"type":"state"}']) {
      expect(decodeTrayEvent(line)).toBeNull();
    }
  });
});
