// Build-time emoji data for the chat's emoji picker (plan §5.7).
//
// Source: emojibase-data (MIT, pinned in apps/viewer/package.json), the compact `en` and `pt`
// files. Kept: the RGI emoji of the pinned Unicode version, tested with \p{RGI_Emoji} on the
// Node that builds (its Unicode version must equal PINNED_UNICODE, or the build fails loudly),
// without the "component" group (bare skin tones, hair) and the lone regional indicators.
// Each emoji keeps its label, its search keywords and, where it has them, its five one-tone
// skin variants. Served as two lazy chunks (one per language) that the picker loads when it
// first opens; nothing of this is in the page's main bundle.
//
// Vite plugin: `import('virtual:swarmcast-emoji/en')` / `…/pt-BR`.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The Unicode version the chat pins (plan §2.3 step 0: UCD 17.0, Node 24). */
export const PINNED_UNICODE = '17.0';
const PREFIX = 'virtual:swarmcast-emoji/';
const LOCALES = { en: 'en', 'pt-BR': 'pt' };
const COMPONENT_GROUP = 2;

/**
 * The picker data for `lang`: { v, unicode, groups: [[group, [[emoji, label, keywords, tones?]]]] }.
 * `tones`: the five one-tone variants (light to dark), when the emoji has them.
 */
export function emojiData(lang, { unicode = process.versions.unicode } = {}) {
  if (unicode !== PINNED_UNICODE) {
    throw new Error(`emoji data: this Node has Unicode ${unicode}, the chat pins ${PINNED_UNICODE}. Use the Node version in package.json "engines", or update PINNED_UNICODE together with the shared chat tables.`);
  }
  const rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');
  const en = require('emojibase-data/en/compact.json');
  const local = lang === 'en' ? en : require(`emojibase-data/${LOCALES[lang]}/compact.json`);
  const byHex = new Map(local.map((e) => [e.hexcode, e]));
  const groups = new Map();
  for (const e of [...en].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (typeof e.group !== 'number' || e.group === COMPONENT_GROUP) continue;
    if (!rgi.test(e.unicode)) continue;
    const l = byHex.get(e.hexcode) ?? e;
    const label = String(l.label ?? e.label);
    const keywords = [...new Set([label, ...(l.tags ?? e.tags ?? [])].map((s) => String(s).toLowerCase()))].join(' ');
    const row = [e.unicode, label, keywords];
    const tones = oneToneSkins(e, rgi);
    if (tones) row.push(tones);
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(row);
  }
  return { v: 1, unicode, groups: [...groups.entries()].sort((a, b) => a[0] - b[0]) };
}

function oneToneSkins(e, rgi) {
  if (!Array.isArray(e.skins)) return null;
  const tones = new Array(5).fill(null);
  for (const s of e.skins) {
    const mods = new Set([...s.unicode].map((c) => c.codePointAt(0)).filter((cp) => cp >= 0x1f3fb && cp <= 0x1f3ff));
    if (mods.size !== 1 || !rgi.test(s.unicode)) continue;
    const i = [...mods][0] - 0x1f3fb;
    tones[i] ??= s.unicode;
  }
  return tones.every((t) => typeof t === 'string') ? tones : null;
}

/** Vite plugin serving the data as virtual modules (each becomes its own lazy chunk). */
export function emojiDataPlugin() {
  return {
    name: 'swarmcast-emoji-data',
    resolveId(id) {
      if (id.startsWith(PREFIX) && Object.hasOwn(LOCALES, id.slice(PREFIX.length))) return `\0${id}`;
      return null;
    },
    load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const data = emojiData(id.slice(PREFIX.length + 1));
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(data))});`;
    },
  };
}
