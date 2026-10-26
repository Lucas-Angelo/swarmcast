// Licences of the self-hosted fonts (Inter, Fredoka: SIL Open Font License 1.1). The OFL asks for
// the licence to travel with the font files, so every build that ships them also writes this text
// next to them: the panel and viewer pages (Vite plugin below, assets/FONT-LICENSES.txt) and the
// website (site/astro.config.mjs, _astro/FONT-LICENSES.txt).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FONT_LICENSES_FILE = 'FONT-LICENSES.txt';

/**
 * @param {{ resolveFrom?: string, fredokaLicense?: string }} [options]
 *   resolveFrom: file URL / path whose node_modules holds @fontsource-variable/inter (default: this package);
 *   fredokaLicense: path of Fredoka's OFL.txt (default: ./fonts/OFL-Fredoka.txt).
 */
export function fontLicensesText({ resolveFrom = import.meta.url, fredokaLicense = path.join(here, 'fonts', 'OFL-Fredoka.txt') } = {}) {
  const require = createRequire(resolveFrom);
  const interPkg = require('@fontsource-variable/inter/package.json');
  const inter = fs.readFileSync(require.resolve('@fontsource-variable/inter/LICENSE'), 'utf8').trim();
  const fredoka = fs.readFileSync(fredokaLicense, 'utf8').trim();
  return [
    'Fonts used by these pages, self-hosted next to this file.',
    '',
    `== Inter (https://github.com/rsms/inter), from @fontsource-variable/inter ${interPkg.version} — SIL Open Font License 1.1 ==`,
    inter,
    '',
    '== Fredoka (https://github.com/hafontia/Fredoka-One), subset to Latin — SIL Open Font License 1.1 ==',
    fredoka,
    '',
  ].join('\n');
}

/** Vite plugin: emits assets/FONT-LICENSES.txt in production builds. */
export function fontLicenses(options) {
  return {
    name: 'swarmcast-font-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: `assets/${FONT_LICENSES_FILE}`, source: fontLicensesText(options) });
    },
  };
}
