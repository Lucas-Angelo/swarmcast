import type { Plugin } from 'vite';

export const PINNED_UNICODE: string;
export function emojiData(lang: 'en' | 'pt-BR', options?: { unicode?: string }): { v: number; unicode: string; groups: Array<[number, Array<[string, string, string, string[]?]>]> };
export function emojiDataPlugin(): Plugin;
