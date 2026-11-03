import type { Plugin } from 'vite';

export const COMPRESSIBLE: RegExp;
export function compressedCopies(data: Uint8Array): { br: Buffer; gz: Buffer };
export function precompress(): Plugin;
