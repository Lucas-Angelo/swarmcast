import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudflareStandIn, standInArgs } from '../../src/tunnel/stand-in.js';
import { tempDir } from './helpers.js';

// SWARMCAST_TEST_CLOUDFLARE points quick tunnels at a local stand-in for Cloudflare (system tests
// only). It must never send a tunnel off this machine: anything but 127.0.0.1 is refused.

function caFile(): string {
  const file = path.join(tempDir(), 'ca.pem');
  fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');
  return file;
}

const env = (s: Record<string, unknown>) => ({ SWARMCAST_TEST_CLOUDFLARE: JSON.stringify(s) });

describe('cloudflareStandIn', () => {
  it('is null when the variable is not set (every real run)', () => {
    // Act
    const s = cloudflareStandIn({});
    // Assert
    expect(s).toBeNull();
  });

  it('gives cloudflared the stand-in service, edge and CA, over HTTP/2', () => {
    // Arrange
    const ca = caFile();
    // Act
    const s = cloudflareStandIn(env({ service: 'http://127.0.0.1:20001', edge: '127.0.0.1:20002', checks: '127.0.0.1:20003', ca }));
    // Assert
    expect(standInArgs(s!)).toEqual(['--quick-service', 'http://127.0.0.1:20001', '--edge', '127.0.0.1:20002', '--cacert', ca, '--protocol', 'http2', '--no-prechecks']);
  });

  it.each([
    ['a remote quick-tunnel service', { service: 'https://api.example.com', edge: '127.0.0.1:20002', checks: '127.0.0.1:20003' }],
    ['a remote edge', { service: 'http://127.0.0.1:20001', edge: '203.0.113.7:7844', checks: '127.0.0.1:20003' }],
    ['a remote public side', { service: 'http://127.0.0.1:20001', edge: '127.0.0.1:20002', checks: 'localhost.example.com:443' }],
  ])('refuses %s', (_what, s) => {
    // Arrange
    const ca = caFile();
    // Act
    const read = () => cloudflareStandIn(env({ ...s, ca }));
    // Assert
    expect(read).toThrow(/127\.0\.0\.1/);
  });

  it('refuses a value that is not JSON, with the same explanation', () => {
    // Act
    const read = () => cloudflareStandIn({ SWARMCAST_TEST_CLOUDFLARE: '127.0.0.1:20001' });
    // Assert
    expect(read).toThrow(/127\.0\.0\.1/);
  });

  it('refuses a CA file that does not exist', () => {
    // Act
    const read = () => cloudflareStandIn(env({ service: 'http://127.0.0.1:20001', edge: '127.0.0.1:20002', checks: '127.0.0.1:20003', ca: path.join(tempDir(), 'missing.pem') }));
    // Assert
    expect(read).toThrow(/CA file/);
  });
});
