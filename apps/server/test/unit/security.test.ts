import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scrub } from '../../src/core/logger.js';
import { STARTUP_GUARD } from '@swarmcast/shared/web/startup-guard';
import { clientIp, originMatchesHost, STARTUP_GUARD_SOURCE, viewerCsp } from '../../src/public/security.js';
import { requestFrom } from './helpers-b.js';

// Headers and helpers the public server relies on: whose IP a request is (CF-Connecting-IP only
// from the local tunnel connector, never X-Forwarded-For), the viewer pages' CSP, the Origin check
// of WebSocket upgrades, and the log scrubbing of link secrets, admin tokens and stream keys.

describe('client IP', () => {
  it.each([
    ['the header, from the tunnel connector when the tunnel is trusted', requestFrom('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), true, '203.0.113.9'],
    ['the socket address when the tunnel is not trusted', requestFrom('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), false, '127.0.0.1'],
    ['the socket address of a request that did not come from the connector', requestFrom('198.51.100.1', { 'cf-connecting-ip': '203.0.113.9' }), true, '198.51.100.1'],
    ['the socket address when the header is not an IP', requestFrom('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }), true, '127.0.0.1'],
    ['never X-Forwarded-For', requestFrom('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), true, '127.0.0.1'],
  ])('is %s', (_what, req, trustTunnel, expected) => {
    // Act
    const ip = clientIp(req, trustTunnel);
    // Assert
    expect(ip).toBe(expected);
  });
});

describe('CSP', () => {
  it('has no inline scripts and only self + wss connections', () => {
    // Act
    const csp = viewerCsp('abc.trycloudflare.com', true, ['stun:stun.cloudflare.com:3478']);
    // Assert
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self' wss://abc.trycloudflare.com;");
    expect(csp).not.toContain('stun:');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows the pages' startup guard by its hash, as browsers compute it, and no other inline script", () => {
    // Arrange
    const hash = `'sha256-${createHash('sha256').update(STARTUP_GUARD, 'utf8').digest('base64')}'`;
    // Act
    const csp = viewerCsp('abc.trycloudflare.com', true, []);
    // Assert
    expect(STARTUP_GUARD_SOURCE).toBe(hash);
    expect(csp).toContain(`script-src 'self' ${hash};`);
    expect(csp).not.toContain('unsafe-inline');
  });
});

describe('origin check', () => {
  it.each([
    ['the page of that host', 'https://a.trycloudflare.com', 'a.trycloudflare.com', true],
    ['another site', 'https://evil.example', 'a.trycloudflare.com', false],
    ['no Origin header', undefined, 'a', false],
  ])('requires Origin to match Host: %s', (_what, origin, host, expected) => {
    // Act
    const ok = originMatchesHost(origin, host);
    // Assert
    expect(ok).toBe(expected);
  });
});

describe('log scrubbing', () => {
  it('removes link secrets, admin tokens and stream keys', () => {
    // Act
    const s = scrub('GET /join/abcDEF123_- and /auth/tok_en and key sc_ABCDEFGHJKLMNPQRSTUV');
    // Assert
    expect(s).not.toContain('abcDEF123');
    expect(s).not.toContain('tok_en');
    expect(s).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  });
});
