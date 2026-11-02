import type { Plugin } from 'vite';
export const COMPRESSIBLE: RegExp;
export function precompressDir(dir: string): { files: number; raw: number; br: number; gz: number };
export function precompress(): Plugin;
