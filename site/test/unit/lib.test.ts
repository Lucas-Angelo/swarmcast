// Unit tests for the site's browser logic (run by the repo's root `npm test`).
import { describe, expect, it, vi } from 'vitest';
import { choicesFor, detectOs, formatSize } from '../../src/lib/download';
import { copy } from '../../src/lib/copy';
import { otherLangPath, pagePath, tr, ui } from '../../src/lib/i18n';
import { formatCount, loadUsage, parseSummary } from '../../src/lib/stats';

const RELEASES = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest';
const url = (n: string) => `https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/${n}`;

describe('detectOs', () => {
  it.each([
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }, 'windows'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }, 'macos'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'], // iPadOS
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }, 'linux'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', platform: 'Linux armv8l' }, 'mobile'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' }, 'mobile'],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', platform: 'Linux x86_64' }, 'unknown'],
    [{ userAgent: '', userAgentData: { platform: 'Windows', mobile: false } }, 'windows'],
    [{ userAgent: '', userAgentData: { platform: 'Android', mobile: true } }, 'mobile'],
    [{}, 'unknown'],
  ])('%j -> %s', (nav, os) => {
    expect(detectOs(nav)).toBe(os);
  });
});

describe('choicesFor', () => {
  const latest = {
    version: '0.2.0',
    assets: {
      'windows-x64': { name: 'SwarmCast_0.2.0_x64-setup.exe', url: url('SwarmCast_0.2.0_x64-setup.exe') },
      'macos-universal': { name: 'SwarmCast_0.2.0_universal.dmg', url: url('SwarmCast_0.2.0_universal.dmg') },
      'linux-appimage-x64': { name: 'SwarmCast_0.2.0_amd64.AppImage', url: url('SwarmCast_0.2.0_amd64.AppImage') },
    },
  };

  it('links straight to the installer when the latest release has it', () => {
    expect(choicesFor('windows', latest, RELEASES)).toEqual({
      primary: { key: 'windows', os: 'windows', href: url('SwarmCast_0.2.0_x64-setup.exe'), fileName: 'SwarmCast_0.2.0_x64-setup.exe', direct: true },
      alternatives: [],
    });
  });

  it('falls back to the releases page per missing file, and to a universal dmg on macOS', () => {
    const mac = choicesFor('macos', latest, RELEASES);
    expect(mac.primary?.href).toBe(url('SwarmCast_0.2.0_universal.dmg'));
    expect(mac.alternatives.map((c) => c.key)).toEqual(['macos-x64']);
    const linux = choicesFor('linux', latest, RELEASES);
    expect(linux.primary).toMatchObject({ key: 'linux-deb', href: RELEASES, direct: false });
    expect(linux.alternatives[0]).toMatchObject({ key: 'linux-appimage', direct: true });
    expect(choicesFor('windows', null, RELEASES).primary).toMatchObject({ href: RELEASES, direct: false });
  });

  it('carries the file size when stats.json has it', () => {
    const sized = { assets: { 'windows-x64': { name: 'a.exe', url: url('a.exe'), size: 9_123_456 } } };
    expect(choicesFor('windows', sized, RELEASES).primary?.size).toBe(9_123_456);
    const bad = { assets: { 'windows-x64': { name: 'a.exe', url: url('a.exe'), size: -1 } } };
    expect(choicesFor('windows', bad, RELEASES).primary).not.toHaveProperty('size');
  });

  it('formats sizes per language', () => {
    expect(formatSize(9_123_456, 'en')).toBe('9.1 MB');
    expect(formatSize(9_123_456, 'pt-BR')).toBe('9,1 MB');
    expect(formatSize(80_000_000, 'en')).toBe('80 MB');
  });

  it('never links to a file outside github.com', () => {
    const evil = { assets: { 'windows-x64': { name: 'x.exe', url: 'https://example.com/x.exe' } } };
    expect(choicesFor('windows', evil, RELEASES).primary?.href).toBe(RELEASES);
  });

  it('has no main button on phones or unknown systems', () => {
    expect(choicesFor('mobile', latest, RELEASES)).toEqual({ primary: null, alternatives: [] });
    expect(choicesFor('unknown', latest, RELEASES).primary).toBeNull();
  });
});

describe('stats summary', () => {
  it('reads only well-formed numbers', () => {
    expect(parseSummary({ version: 1, downloads: { about: 1230 }, apps: { week: 40 }, latest: { version: '0.2.0' } })).toEqual({
      downloads: 1230,
      appsWeek: 40,
      latest: { version: '0.2.0' },
    });
    expect(parseSummary({ version: 1, downloads: { about: 0 }, apps: null, latest: null })).toEqual({ downloads: null, appsWeek: null, latest: null });
    expect(parseSummary({ version: 2, downloads: { about: 5 } }).downloads).toBeNull();
    expect(parseSummary('nope').downloads).toBeNull();
    expect(parseSummary({ version: 1, downloads: { about: '12' } }).downloads).toBeNull();
  });

  it('formats numbers per language', () => {
    expect(formatCount(1230, 'en')).toBe('1,230');
    expect(formatCount(1230, 'pt-BR')).toBe('1.230');
  });

  it('loads once and never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(loadUsage('/swarmcast/stats.json', fetchImpl as unknown as typeof fetch)).resolves.toEqual({ downloads: null, appsWeek: null, latest: null });
    await loadUsage('/swarmcast/stats.json', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('i18n', () => {
  it('builds page paths and the other-language path', () => {
    expect(pagePath('en', 'install/windows')).toBe('/swarmcast/install/windows/');
    expect(pagePath('pt-BR', '/live/p2p/')).toBe('/swarmcast/pt-br/live/p2p/');
    expect(pagePath('pt-BR')).toBe('/swarmcast/pt-br/');
    expect(pagePath('en', 'download#windows')).toBe('/swarmcast/download/#windows');
    expect(otherLangPath('/swarmcast/live/p2p/')).toEqual({ lang: 'pt-BR', href: '/swarmcast/pt-br/live/p2p/' });
    expect(otherLangPath('/swarmcast/pt-br/live/p2p/')).toEqual({ lang: 'en', href: '/swarmcast/live/p2p/' });
    expect(otherLangPath('/swarmcast/pt-br')).toEqual({ lang: 'en', href: '/swarmcast/' });
    expect(otherLangPath('/swarmcast/')).toEqual({ lang: 'pt-BR', href: '/swarmcast/pt-br/' });
  });

  it('has the same UI keys in both languages', () => {
    expect(Object.keys(ui['pt-BR']).sort()).toEqual(Object.keys(ui.en).sort());
    expect(tr('pt-BR', 'dl.version', { version: '1.0' })).toBe('Versão 1.0');
  });

  it('has the same landing and download copy in both languages', () => {
    const shape = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;
    expect(shape(copy['pt-BR'])).toEqual(shape(copy.en));
  });
});
