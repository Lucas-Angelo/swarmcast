// Picks the right download for the visitor's computer. Pure functions (unit-tested in
// site/test/unit); the DownloadButton component runs them in the browser.

export type Os = 'windows' | 'macos' | 'linux' | 'mobile' | 'unknown';
export type ChoiceKey = 'windows' | 'macos-arm64' | 'macos-x64' | 'linux-deb' | 'linux-appimage';

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean } | undefined;
}

/** Desktop OS from the browser. Phones and tablets (also iPads that say "Mac") are 'mobile'. */
export function detectOs(nav: NavigatorLike): Os {
  const ua = nav.userAgent ?? '';
  const platform = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''}`;
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(ua)) return /CrOS/i.test(ua) ? 'unknown' : 'mobile';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? 'mobile' : 'macos';
  if (/Linux|X11|BSD/i.test(platform) || /Linux|X11/i.test(ua)) return 'linux';
  return 'unknown';
}

export interface LatestRelease {
  tag?: string;
  version?: string;
  url?: string;
  assets?: Record<string, { name: string; url: string; size?: number } | undefined>;
}

export interface Choice {
  key: ChoiceKey;
  os: 'windows' | 'macos' | 'linux';
  /** Direct file URL when the latest release has it, else the releases page. */
  href: string;
  fileName?: string;
  direct: boolean;
}

/** Which asset slots (from scripts/stats/stats.mjs classifyAsset) serve each choice, best first. */
const SLOTS: Record<ChoiceKey, string[]> = {
  windows: ['windows-x64'],
  'macos-arm64': ['macos-arm64', 'macos-universal'],
  'macos-x64': ['macos-x64', 'macos-universal'],
  'linux-deb': ['linux-deb-x64'],
  'linux-appimage': ['linux-appimage-x64'],
};

const OS_OF: Record<ChoiceKey, Choice['os']> = {
  windows: 'windows',
  'macos-arm64': 'macos',
  'macos-x64': 'macos',
  'linux-deb': 'linux',
  'linux-appimage': 'linux',
};

export function choice(key: ChoiceKey, latest: LatestRelease | null | undefined, releasesUrl: string): Choice {
  for (const slot of SLOTS[key]) {
    const a = latest?.assets?.[slot];
    if (a?.url && /^https:\/\/github\.com\//.test(a.url)) return { key, os: OS_OF[key], href: a.url, fileName: a.name, direct: true };
  }
  return { key, os: OS_OF[key], href: releasesUrl, direct: false };
}

/** The main button and the alternatives shown under it for this OS. */
export function choicesFor(os: Os, latest: LatestRelease | null | undefined, releasesUrl: string): { primary: Choice | null; alternatives: Choice[] } {
  const c = (k: ChoiceKey) => choice(k, latest, releasesUrl);
  switch (os) {
    case 'windows':
      return { primary: c('windows'), alternatives: [] };
    case 'macos':
      return { primary: c('macos-arm64'), alternatives: [c('macos-x64')] };
    case 'linux':
      return { primary: c('linux-deb'), alternatives: [c('linux-appimage')] };
    default:
      return { primary: null, alternatives: [] };
  }
}
