import { describe, expect, it } from 'vitest';
import { clientIp, originMatchesHost, viewerCsp } from '../../src/public/security.js';
import { scrub } from '../../src/core/logger.js';

describe('client IP', () => {
  const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers });
  it('trusts CF-Connecting-IP only from the local tunnel connector when enabled', () => {
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), true)).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), false)).toBe('127.0.0.1');
    expect(clientIp(req('198.51.100.1', { 'cf-connecting-ip': '203.0.113.9' }), true)).toBe('198.51.100.1');
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }), true)).toBe('127.0.0.1');
  });
  it('never uses X-Forwarded-For', () => {
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), true)).toBe('127.0.0.1');
  });
});

describe('CSP', () => {
  it('has no inline scripts and only self + wss connections', () => {
    const csp = viewerCsp('abc.trycloudflare.com', true, ['stun:stun.cloudflare.com:3478']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self' wss://abc.trycloudflare.com;");
    expect(csp).not.toContain('stun:');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('origin check', () => {
  it('requires Origin to match Host', () => {
    expect(originMatchesHost('https://a.trycloudflare.com', 'a.trycloudflare.com')).toBe(true);
    expect(originMatchesHost('https://evil.example', 'a.trycloudflare.com')).toBe(false);
    expect(originMatchesHost(undefined, 'a')).toBe(false);
  });
});

describe('log scrubbing', () => {
  it('removes link secrets, admin tokens and stream keys', () => {
    const s = scrub('GET /join/abcDEF123_- and /auth/tok_en and key sc_ABCDEFGHJKLMNPQRSTUV');
    expect(s).not.toContain('abcDEF123');
    expect(s).not.toContain('tok_en');
    expect(s).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  });
});
