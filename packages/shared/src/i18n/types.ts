import type { en } from './en.js';

export type Lang = 'en' | 'pt-BR';

/** Plural forms, chosen from `params.count` (0 uses `other` in both languages). */
export interface Plural {
  one: string;
  other: string;
}
export type Entry = string | Plural;

export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

/** Every other language must define every key, with the same shape (plain text or plural). */
export type Messages = { [K in MessageKey]: (typeof en)[K] extends string ? string : Plural };
