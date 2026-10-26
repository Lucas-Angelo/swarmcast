import type { Plugin } from 'vite';

export interface FontLicensesOptions {
  /** File URL or path whose node_modules holds @fontsource-variable/inter. */
  resolveFrom?: string;
  /** Path of Fredoka's OFL.txt. */
  fredokaLicense?: string;
}

export const FONT_LICENSES_FILE: string;
export function fontLicensesText(options?: FontLicensesOptions): string;
export function fontLicenses(options?: FontLicensesOptions): Plugin;
