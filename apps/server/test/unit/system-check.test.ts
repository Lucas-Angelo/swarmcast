import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { parseSystemCheck, readSystemCheck } from '../../src/admin/system-check-routes.js';
import { silentLog } from './helpers.js';
import { directOff, tempDir } from './helpers-b.js';
import { makeController } from './live-helpers.js';

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

/** The panel's configured port: only what its Host header must say. Nothing listens on it (inject() only). */
const PANEL_PORT = 39398;
const PANEL_HOST = `127.0.0.1:${PANEL_PORT}`;

/** Where the start scripts write the file, in a temp data folder of this test (not written yet). */
const systemCheckFile = (): string => path.join(tempDir('sc-syscheck-'), 'system-check.json');

/** The admin panel server reading `file`, closed when the test finishes. */
async function panel(file: string): Promise<FastifyInstance> {
  const { live } = makeController(directOff());
  const app = await createAdminServer({ port: PANEL_PORT, adminDir: '/nonexistent', live, log: silentLog, token: 'tok', onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn(), systemCheckFile: file });
  onTestFinished(() => app.close());
  return app;
}

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
  const signedIn = { host: PANEL_HOST, cookie: `${ADMIN_COOKIE}=tok` };

  it('is 404 when the start script wrote none', async () => {
    // Arrange
    const app = await panel(systemCheckFile());
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: signedIn });
    // Assert
    expect(res.statusCode).toBe(404);
  });

  it('serves the file to the panel', async () => {
    // Arrange
    const file = systemCheckFile();
    const app = await panel(file);
    fs.writeFileSync(file, JSON.stringify(SAMPLE));
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: signedIn });
    // Assert
    expect(res.statusCode).toBe(200);
    expect(res.json().results[1]).toMatchObject({ id: 'ram', status: 'warn' });
  });

  it('needs the same login as the rest of the admin API', async () => {
    // Arrange
    const file = systemCheckFile();
    const app = await panel(file);
    fs.writeFileSync(file, JSON.stringify(SAMPLE));
    // Act
    const res = await app.inject({ method: 'GET', url: '/api/system-check', headers: { host: PANEL_HOST } });
    // Assert
    expect(res.statusCode).toBe(401);
  });
});
