// Unit tests for the site's browser logic (run by the repo's root `npm test`): which download the
// visitor's computer gets, the usage numbers from stats.json and the two languages. Numbers and
// sizes are formatted for an explicit language, so the result is the same on any machine locale.
import { describe, expect, it, vi } from 'vitest';
import { choicesFor, detectOs, formatSize } from '../../src/lib/download';
import { copy } from '../../src/lib/copy';
import { otherLangPath, pagePath, tr, ui } from '../../src/lib/i18n';
import { formatCount, parseSummary, usageLoader } from '../../src/lib/stats';

const RELEASES = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest';
const url = (n: string) => `https://github.com/Lucas-Angelo/swarmcast/releases/download/v0.2.0/${n}`;
const LATEST = {
  version: '0.2.0',
  assets: {
    'windows-x64': { name: 'SwarmCast_0.2.0_x64-setup.exe', url: url('SwarmCast_0.2.0_x64-setup.exe') },
    'macos-universal': { name: 'SwarmCast_0.2.0_universal.dmg', url: url('SwarmCast_0.2.0_universal.dmg') },
    'linux-appimage-x64': { name: 'SwarmCast_0.2.0_amd64.AppImage', url: url('SwarmCast_0.2.0_amd64.AppImage') },
  },
};
const NO_USAGE = { downloads: null, appsWeek: null, latest: null };

/** The shape of a value: the same keys and nesting, with the types of its leaves. */
const shape = (v: unknown): unknown => (Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);

describe('detectOs', () => {
  it.each([
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }, 'windows'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }, 'macos'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }, 'linux'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', platform: 'Linux armv8l' }, 'mobile'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' }, 'mobile'],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', platform: 'Linux x86_64' }, 'unknown'],
    [{ userAgent: '', userAgentData: { platform: 'Windows', mobile: false } }, 'windows'],
    [{ userAgent: '', userAgentData: { platform: 'Android', mobile: true } }, 'mobile'],
    [{}, 'unknown'],
  ])('%j -> %s (an iPad says "Mac" with touch points: mobile)', (nav, os) => {
    // Act
    const got = detectOs(nav);

    // Assert
    expect(got).toBe(os);
  });
});

describe('choicesFor', () => {
  it('links straight to the installer when the latest release has it', () => {
    // Act
    const c = choicesFor('windows', LATEST, RELEASES);

    // Assert
    expect(c).toEqual({
      primary: { key: 'windows', os: 'windows', href: url('SwarmCast_0.2.0_x64-setup.exe'), fileName: 'SwarmCast_0.2.0_x64-setup.exe', direct: true },
      alternatives: [],
    });
  });

  it('macOS: a universal dmg serves the Apple chip, Intel is the alternative', () => {
    // Act
    const mac = choicesFor('macos', LATEST, RELEASES);

    // Assert
    expect(mac.primary?.href).toBe(url('SwarmCast_0.2.0_universal.dmg'));
    expect(mac.alternatives.map((c) => c.key)).toEqual(['macos-x64']);
  });

  it('Linux: a missing .deb falls back to the releases page, the AppImage is direct', () => {
    // Act
    const linux = choicesFor('linux', LATEST, RELEASES);

    // Assert
    expect(linux.primary).toMatchObject({ key: 'linux-deb', href: RELEASES, direct: false });
    expect(linux.alternatives[0]).toMatchObject({ key: 'linux-appimage', direct: true });
  });

  it('without a latest release, the releases page', () => {
    // Act
    const c = choicesFor('windows', null, RELEASES);

    // Assert
    expect(c.primary).toMatchObject({ href: RELEASES, direct: false });
  });

  it('carries the file size when stats.json has it', () => {
    // Arrange
    const latest = { assets: { 'windows-x64': { name: 'a.exe', url: url('a.exe'), size: 9_123_456 } } };

    // Act
    const c = choicesFor('windows', latest, RELEASES);

    // Assert
    expect(c.primary?.size).toBe(9_123_456);
  });

  it('leaves out a size that is not a positive number', () => {
    // Arrange
    const latest = { assets: { 'windows-x64': { name: 'a.exe', url: url('a.exe'), size: -1 } } };

    // Act
    const c = choicesFor('windows', latest, RELEASES);

    // Assert
    expect(c.primary).not.toHaveProperty('size');
  });

  it.each([
    [9_123_456, 'en', '9.1 MB'],
    [9_123_456, 'pt-BR', '9,1 MB'],
    [80_000_000, 'en', '80 MB'],
  ] as const)('formats %s bytes in %s as %s', (bytes, lang, text) => {
    // Act
    const got = formatSize(bytes, lang);

    // Assert
    expect(got).toBe(text);
  });

  it('never links to a file outside github.com', () => {
    // Arrange
    const evil = { assets: { 'windows-x64': { name: 'x.exe', url: 'https://example.com/x.exe' } } };

    // Act
    const c = choicesFor('windows', evil, RELEASES);

    // Assert
    expect(c.primary?.href).toBe(RELEASES);
  });

  it.each(['mobile', 'unknown'] as const)('has no main button on a %s system', (os) => {
    // Act
    const c = choicesFor(os, LATEST, RELEASES);

    // Assert
    expect(c).toEqual({ primary: null, alternatives: [] });
  });
});

describe('stats summary', () => {
  it('reads well-formed numbers', () => {
    // Act
    const view = parseSummary({ version: 1, downloads: { about: 1230 }, apps: { week: 40 }, latest: { version: '0.2.0' } });

    // Assert
    expect(view).toEqual({ downloads: 1230, appsWeek: 40, latest: { version: '0.2.0' } });
  });

  it.each([
    ['zero downloads and no apps or release', { version: 1, downloads: { about: 0 }, apps: null, latest: null }],
    ['another summary version', { version: 2, downloads: { about: 5 } }],
    ['not an object', 'nope'],
    ['a number given as text', { version: 1, downloads: { about: '12' } }],
  ])('reads %s as no data', (_case, data) => {
    // Act
    const view = parseSummary(data);

    // Assert
    expect(view.downloads).toBeNull();
  });

  it.each([
    ['en', '1,230'],
    ['pt-BR', '1.230'],
  ] as const)('formats numbers in %s', (lang, text) => {
    // Act
    const got = formatCount(1230, lang);

    // Assert
    expect(got).toBe(text);
  });

  it('a failed fetch is "no data", never an error', async () => {
    // Arrange
    const load = usageLoader(vi.fn(async () => Promise.reject(new Error('offline'))));

    // Act
    const view = load('/swarmcast/stats.json');

    // Assert
    await expect(view).resolves.toEqual(NO_USAGE);
  });

  it('a 404 is "no data"', async () => {
    // Arrange
    const load = usageLoader(vi.fn(async () => new Response('Not found', { status: 404 })));

    // Act
    const view = await load('/swarmcast/stats.json');

    // Assert
    expect(view).toEqual(NO_USAGE);
  });

  it('fetches once, without cookies, for every part of the page that asks', async () => {
    // Arrange
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: 1, downloads: { about: 1230 } })));
    const load = usageLoader(fetchImpl);

    // Act
    const [a, b] = await Promise.all([load('/swarmcast/stats.json'), load('/swarmcast/stats.json')]);

    // Assert
    expect(a).toBe(b);
    expect(a.downloads).toBe(1230);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/swarmcast/stats.json', { credentials: 'omit', cache: 'no-cache' });
  });
});

describe('i18n', () => {
  it.each([
    ['en', 'install/windows', '/swarmcast/install/windows/'],
    ['pt-BR', '/live/p2p/', '/swarmcast/pt-br/live/p2p/'],
    ['pt-BR', undefined, '/swarmcast/pt-br/'],
    ['en', 'download#windows', '/swarmcast/download/#windows'],
  ] as const)('pagePath(%s, %s) is %s', (lang, slug, path) => {
    // Act
    const got = pagePath(lang, slug);

    // Assert
    expect(got).toBe(path);
  });

  it.each([
    ['/swarmcast/live/p2p/', { lang: 'pt-BR', href: '/swarmcast/pt-br/live/p2p/' }],
    ['/swarmcast/pt-br/live/p2p/', { lang: 'en', href: '/swarmcast/live/p2p/' }],
    ['/swarmcast/pt-br', { lang: 'en', href: '/swarmcast/' }],
    ['/swarmcast/', { lang: 'pt-BR', href: '/swarmcast/pt-br/' }],
  ])('the other language of %s', (path, other) => {
    // Act
    const got = otherLangPath(path);

    // Assert
    expect(got).toEqual(other);
  });

  it('has the same UI keys in both languages', () => {
    // Act
    const [pt, en] = [Object.keys(ui['pt-BR']).sort(), Object.keys(ui.en).sort()];

    // Assert
    expect(pt).toEqual(en);
  });

  it('fills the parameters of a UI string', () => {
    // Act
    const text = tr('pt-BR', 'dl.version', { version: '1.0' });

    // Assert
    expect(text).toBe('Versão 1.0');
  });

  it('has the same landing and download copy in both languages', () => {
    // Act
    const [pt, en] = [shape(copy['pt-BR']), shape(copy.en)];

    // Assert
    expect(pt).toEqual(en);
  });
});
