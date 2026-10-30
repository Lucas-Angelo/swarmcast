// The emoji picker's data, one lazy chunk per language (built by scripts/emoji-data.mjs).
import { getLang } from '@swarmcast/shared/i18n';
import type { EmojiData } from './picker.js';

export async function loadEmojiData(): Promise<EmojiData> {
  const mod = getLang() === 'pt-BR' ? await import('virtual:swarmcast-emoji/pt-BR') : await import('virtual:swarmcast-emoji/en');
  return mod.default;
}
