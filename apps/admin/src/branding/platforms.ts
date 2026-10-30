import type { BrandPlatform } from '@swarmcast/shared/branding';

/** Platform names shown next to a link in the panel (brand names, not translated). */
export const PLATFORM_NAMES: Record<Exclude<BrandPlatform, 'link' | 'mail'>, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  discord: 'Discord',
  github: 'GitHub',
  kofi: 'Ko-fi',
  patreon: 'Patreon',
  livepix: 'LivePix',
  paypal: 'PayPal',
  apoiase: 'Apoia.se',
};
