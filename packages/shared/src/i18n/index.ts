import { en } from './en.js';
import { ptBR } from './pt-BR.js';
import type { Lang, MessageKey, MessageParams, Messages, Plural } from './types.js';

export type { Entry, Lang, MessageKey, MessageParams, Messages, Plural } from './types.js';

export const LANGS: readonly Lang[] = ['en', 'pt-BR'];
const DICTS: Record<Lang, Messages> = { en, 'pt-BR': ptBR };
const plurals = new Map<Lang, Intl.PluralRules>();
const numbers = new Map<Lang, Intl.NumberFormat>();

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function isMessageKey(key: unknown): key is MessageKey {
  return typeof key === 'string' && Object.hasOwn(en, key);
}

/** Normalize "pt", "pt-br", "PT-BR", "en-US"… to a supported language, or null. */
export function toLang(value: string | null | undefined): Lang | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.startsWith('pt')) return 'pt-BR';
  if (v.startsWith('en')) return 'en';
  return null;
}

/** An explicit override wins; otherwise the first browser language starting with "pt" picks pt-BR. */
export function resolveLang(languages: readonly string[], override?: string | null): Lang {
  const o = toLang(override);
  if (o) return o;
  return languages.some((l) => l.toLowerCase().startsWith('pt')) ? 'pt-BR' : 'en';
}

/** The streamer guide on the website (site/ in this repository). */
export const GUIDE_URL = 'https://lucas-angelo.github.io/swarmcast/';

/** `page` without leading or trailing slashes, in one pass (a /\/+$/ regex is quadratic on "a////…b"). */
function trimSlashes(page: string): string {
  let start = 0;
  let end = page.length;
  while (start < end && page[start] === '/') start++;
  while (end > start && page[end - 1] === '/') end--;
  return page.slice(start, end);
}

/** A page of the guide in `lang` (Portuguese pages live under pt-br/), e.g. guideUrl('pt-BR', 'start/obs'). */
export function guideUrl(lang: Lang, page = ''): string {
  const p = trimSlashes(page);
  return `${GUIDE_URL}${lang === 'pt-BR' ? 'pt-br/' : ''}${p ? `${p}/` : ''}`;
}

/** Decimal numbers follow the language (2.6 / 2,6); integers are left alone (ports, counts). */
export function formatNumber(n: number, lang: Lang = current): string {
  if (Number.isInteger(n)) return String(n);
  let f = numbers.get(lang);
  if (!f) numbers.set(lang, (f = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, useGrouping: false })));
  return f.format(n);
}

function pickPlural(lang: Lang, entry: Plural, count: number): string {
  if (count === 0) return entry.other;
  let rules = plurals.get(lang);
  if (!rules) plurals.set(lang, (rules = new Intl.PluralRules(lang)));
  return rules.select(count) === 'one' ? entry.one : entry.other;
}

/**
 * Translate `key` into `lang`. `{name}` placeholders take `params.name`; a param whose name
 * ends in "Key" and holds a message key is translated itself (e.g. `{ stepKey: 'step.server' }`).
 */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const entry = DICTS[lang][key] ?? en[key];
  const text = typeof entry === 'string' ? entry : pickPlural(lang, entry, Number(params?.count ?? 0));
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    if (v === undefined) return match;
    if (typeof v === 'number') return formatNumber(v, lang);
    if (name.endsWith('Key') && isMessageKey(v)) return translate(lang, v);
    return v;
  });
}

/** Translate into the current UI language. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

/**
 * Translate a server-provided coded text (`{ code, params }`), falling back to the English
 * text the server sent when the code is missing or unknown to this build.
 */
export function tc(coded: { code?: string | null; params?: MessageParams | null } | null | undefined, fallback: string): string {
  if (!coded || !isMessageKey(coded.code)) return fallback;
  return translate(current, coded.code, coded.params ?? undefined);
}

/**
 * Translate a code and params that came over the wire (chat system lines) without ever throwing:
 * a code this build does not know (a newer server) gives `fallback`, and only string and finite
 * number params are used (anything else is left out, so its placeholder stays as written).
 */
export function translateWire(code: unknown, params: unknown, fallback: MessageKey, lang: Lang = current): string {
  if (!isMessageKey(code)) return translate(lang, fallback);
  if (params === null || typeof params !== 'object') return translate(lang, code);
  const clean: MessageParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) clean[k] = v;
  }
  return translate(lang, code, clean);
}

/** "less than a minute", "12 minutes", "1 h 5 min". */
export function humanDuration(ms: number, lang: Lang = current): string {
  if (ms < 60_000) return translate(lang, 'time.lessThanMinute');
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return translate(lang, 'time.minutes', { count: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? translate(lang, 'time.hours', { count: h }) : translate(lang, 'time.hoursMinutes', { h, m });
}
