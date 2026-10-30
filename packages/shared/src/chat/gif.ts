import type { GifProvider } from './schemas.js';

/**
 * GIF providers (docs/CHAT.md, plan §3.3 and §5.6; user decision: KLIPY with the streamer's own
 * key, off by default, every viewer agrees before their browser contacts it). Viewers' browsers
 * talk to the provider directly; nothing goes through the streamer. The viewer CSP lists these
 * hosts only while GIFs are on.
 */
export const GIF_PROVIDERS: Record<GifProvider, { api: string; media: readonly string[]; attribution: string }> = {
  klipy: {
    // docs.klipy.com/network-requirements: API endpoint and media delivery hosts.
    api: 'https://api.klipy.com',
    media: ['https://static.klipy.com', 'https://static1.klipy.com', 'https://static2.klipy.com'],
    attribution: 'Search KLIPY',
  },
  giphy: {
    api: 'https://api.giphy.com',
    media: ['https://media.giphy.com', 'https://media0.giphy.com', 'https://media1.giphy.com', 'https://media2.giphy.com', 'https://media3.giphy.com', 'https://media4.giphy.com', 'https://i.giphy.com'],
    attribution: 'Powered by GIPHY',
  },
};

/** Content-filter value each provider expects for our rating setting. */
export function gifRatingParam(provider: GifProvider, rating: 'g' | 'pg' | 'pg-13'): { name: string; value: string } {
  if (provider === 'giphy') return { name: 'rating', value: rating };
  return { name: 'content_filter', value: rating === 'g' ? 'high' : rating === 'pg' ? 'medium' : 'low' };
}
