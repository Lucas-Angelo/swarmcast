import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSystemCheck, readSystemCheck } from '../../src/admin/system-check-routes.js';
import { tempDir } from './helpers.js';
import { makeController, panelServer } from './live-helpers.js';

// <data>/system-check.json, written by the start scripts (and the desktop app's first run), as
// the panel reads it: unknown result ids are kept, unknown fields dropped, broken, foreign or
// oversized files ignored. GET /api/system-check serves it with the same login as the rest of the
// admin API, through Fastify's inject() (the network is not the subject here).

const SAMPLE = {
  version: 1,
  at: '2026-10-25T18:00:00Z',
  os: 'macOS 27.0',
  arch: 'arm64',
  results: [
    { id: 'os', status: 'ok', value: 'macOS 27.0', min: 'macOS 12' },
    { id: 'ram', status: 'warn', value: '6 GB', min: '4 GB', recommended: '8 GB' },
    { id: 'upload', status: 'fail', value: '3 Mbps', min: '5 Mbps', recommended: '20 Mbps', detail: 'measured with Cloudflare' },
    { id: 'obs', status: 'skipped' },
  ],
  uploadMbps: 3,
  downloadMbps: 120,
  viewerEstimate: 1,
  belowMinimum: ['upload'],
  extra: 'ignored',
};

/** Where the start scripts write the file, in a temp data folder of this test (not written yet). */
const systemCheckFile = (): string => path.join(tempDir('sc-syscheck-'), 'system-check.json');

/** The admin panel server reading `file` (inject() only), closed when the test finishes. */
const panel = (file: string) => panelServer({ live: makeController().live, systemCheckFile: file });

describe('system-check.json parsing', () => {
  it('accepts the start scripts\' format and drops unknown fields', () => {
    // Act
    const c = parseSystemCheck(JSON.stringify(SAMPLE));
    // Assert
    expect(c?.results).toHaveLength(4);
    expect(c?.belowMinimum).toEqual(['upload']);
    expect(c).not.toHaveProperty('extra');
  });

  it('defaults belowMinimum and keeps unknown result ids', () => {
    // Act
    const c = parseSystemCheck(JSON.stringify({ ...SAMPLE, belowMinimum: undefined, results: [{ id: 'gpu', status: 'ok', value: 'M3' }] }));
    // Assert
    expect(c?.belowMinimum).toEqual([]);
    expect(c?.results[0]?.id).toBe('gpu');
  });

  it.each([
    ['not JSON', 'not json'],
    ['another format version', JSON.stringify({ ...SAMPLE, version: 2 })],
    ['an unknown status', JSON.stringify({ ...SAMPLE, results: [{ id: 'ram', status: 'great' }] })],
    ['results that are not a list', JSON.stringify({ ...SAMPLE, results: 'x' })],
  ])('rejects a broken or foreign file: %s', (_what, text) => {
    // Act
    const c = parseSystemCheck(text);
    // Assert
    expect(c).toBeNull();
  });

  it('reads the file', () => {
    // Arrange
    const f = systemCheckFile();
    fs.writeFileSync(f, JSON.stringify(SAMPLE));
    // Act
    const c = readSystemCheck(f);
    // Assert
    expect(c?.os).toBe('macOS 27.0');
  });

  it('a missing file gives null', () => {
    // Act
    const c = readSystemCheck(systemCheckFile());
    // Assert
    expect(c).toBeNull();
  });

  it('an oversized file gives null', () => {
    // Arrange
    const f = systemCheckFile();
    fs.writeFileSync(f, JSON.stringify({ ...SAMPLE, os: 'x'.repeat(70_000) }));
    // Act
    const c = readSystemCheck(f);
    // Assert
    expect(c).toBeNull();
  });
});

describe('GET /api/system-check', () => {
  it('is 404 when the start script wrote none', async () => {
    // Arrange
    const { app, headers } = await panel(systemCheckFile());
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: headers.get });
    // Assert
    expect(res.statusCode).toBe(404);
  });

  it('serves the file to the panel', async () => {
    // Arrange
    const file = systemCheckFile();
    const { app, headers } = await panel(file);
    fs.writeFileSync(file, JSON.stringify(SAMPLE));
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: headers.get });
    // Assert
    expect(res.statusCode).toBe(200);
    expect(res.json().results[1]).toMatchObject({ id: 'ram', status: 'warn' });
  });

  it('needs the same login as the rest of the admin API', async () => {
    // Arrange
    const file = systemCheckFile();
    const { app, headers } = await panel(file);
    fs.writeFileSync(file, JSON.stringify(SAMPLE));
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: { host: headers.host } });
    // Assert
    expect(res.statusCode).toBe(401);
  });
});
