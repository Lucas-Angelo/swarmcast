// The built-in SwarmCast emote pack (assets/brand/emotes, made by build_emotes.py from the
// mascot art). The files are part of the viewer build (hashed names under /assets/, cached as
// immutable) and are only downloaded when an emote is shown or the picker opens.
import manifest from '../../../../assets/brand/emotes/emotes.json';

const files = import.meta.glob<string>('../../../../assets/brand/emotes/*.webp', { eager: true, query: '?url', import: 'default' });

export interface Emote {
  code: string;
  url: string;
  url2x: string;
  w: number;
  h: number;
}

const fileUrl = (name: string): string => files[`../../../../assets/brand/emotes/${name}`] ?? '';

export const BUILTIN_EMOTES: readonly Emote[] = manifest.emotes
  .map((e) => ({ code: e.code, url: fileUrl(e.file), url2x: fileUrl(e.file2x), w: e.w, h: e.h }))
  .filter((e) => e.url !== '');

/** Emotes usable now: the built-in pack when the streamer has it on (custom emotes: 0.4.1). */
export function emoteTable(builtinOn: boolean): Map<string, Emote> {
  return new Map(builtinOn ? BUILTIN_EMOTES.map((e) => [e.code, e]) : []);
}
