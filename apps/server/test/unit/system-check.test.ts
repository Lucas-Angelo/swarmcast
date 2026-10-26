import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { parseSystemCheck, readSystemCheck } from '../../src/admin/system-check-routes.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from './live-helpers.js';
import { silentLog } from './helpers.js';

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

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-syscheck-'));

describe('system-check.json parsing', () => {
  it('accepts the start scripts\' format and drops unknown fields', () => {
    const c = parseSystemCheck(JSON.stringify(SAMPLE));
    expect(c?.results).toHaveLength(4);
    expect(c?.belowMinimum).toEqual(['upload']);
    expect(c).not.toHaveProperty('extra');
  });

  it('defaults belowMinimum and keeps unknown result ids', () => {
    const c = parseSystemCheck(JSON.stringify({ ...SAMPLE, belowMinimum: undefined, results: [{ id: 'gpu', status: 'ok', value: 'M3' }] }));
    expect(c?.belowMinimum).toEqual([]);
    expect(c?.results[0]?.id).toBe('gpu');
  });

  it('rejects broken or foreign files', () => {
    expect(parseSystemCheck('not json')).toBeNull();
    expect(parseSystemCheck(JSON.stringify({ ...SAMPLE, version: 2 }))).toBeNull();
    expect(parseSystemCheck(JSON.stringify({ ...SAMPLE, results: [{ id: 'ram', status: 'great' }] }))).toBeNull();
    expect(parseSystemCheck(JSON.stringify({ ...SAMPLE, results: 'x' }))).toBeNull();
  });

  it('reads the file; missing or oversized files give null', () => {
    const dir = tmp();
    const f = path.join(dir, 'system-check.json');
    expect(readSystemCheck(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify(SAMPLE));
    expect(readSystemCheck(f)?.os).toBe('macOS 27.0');
    fs.writeFileSync(f, JSON.stringify({ ...SAMPLE, os: 'x'.repeat(70_000) }));
    expect(readSystemCheck(f)).toBeNull();
  });
});

describe('GET /api/system-check', () => {
  it('serves the file to the panel, 404 when there is none', async () => {
    const dir = tmp();
    const file = path.join(dir, 'system-check.json');
    const { live } = makeController({} as DirectMode);
    const app = await createAdminServer({
      port: 39398,
      adminDir: '/nonexistent',
      live,
      log: silentLog,
      token: 'tok',
      onQuit: vi.fn(),
      checkDirect: vi.fn(),
      cleanupStale: vi.fn(),
      systemCheckFile: file,
    });
    const headers = { host: '127.0.0.1:39398', cookie: `${ADMIN_COOKIE}=tok` };
    try {
      expect((await app.inject({ method: 'GET', url: '/api/system-check', headers })).statusCode).toBe(404);
      fs.writeFileSync(file, JSON.stringify(SAMPLE));
      const res = await app.inject({ method: 'GET', url: '/api/system-check', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().results[1]).toMatchObject({ id: 'ram', status: 'warn' });
      // Same auth as the rest of the admin API.
      expect((await app.inject({ method: 'GET', url: '/api/system-check', headers: { host: '127.0.0.1:39398' } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
