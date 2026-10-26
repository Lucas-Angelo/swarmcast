import fs from 'node:fs';
import path from 'node:path';
import { resolveLang } from '@swarmcast/shared/i18n';

/**
 * The two pages the panel server writes itself, before the panel is open: the sign-in hop of
 * `/auth/<token>` and "not authorized". Styled with the brand through a small stylesheet that the
 * admin build makes from apps/admin/gate.html (the panel's CSP allows no inline style or script,
 * so the page links `/assets/gate-<hash>.css`). Text in English or Brazilian Portuguese from the
 * browser's Accept-Language. Everything here is static text: no request data goes into the page.
 */

type Lang = 'en' | 'pt-BR';

export function pageLang(acceptLanguage: string | undefined): Lang {
  return resolveLang((acceptLanguage ?? '').split(',').map((l) => l.split(';')[0]!.trim()));
}

/**
 * The stylesheet and favicon `<link>` tags of the built `gate.html` (hashed file names), rebuilt
 * from their `href` only. Empty when the file is missing (source checkouts without a build, tests):
 * the pages then show unstyled, which still works.
 */
export function gateHead(adminDir: string): string {
  let html: string;
  try {
    html = fs.readFileSync(path.join(adminDir, 'gate.html'), 'utf8');
  } catch {
    return '';
  }
  const tags: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel="([^"]+)"/i.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    if (!href || !/^\/assets\/[\w.-]+\.(?:css|svg)$/.test(href)) continue;
    if (rel === 'stylesheet') tags.push(`<link rel="stylesheet" href="${href}">`);
    else if (rel === 'icon') tags.push(`<link rel="icon" href="${href}" type="image/svg+xml">`);
  }
  return tags.join('');
}

const BRAND = '<div class="sc-brand"><span class="sc-symbol" aria-hidden="true"></span><span class="sc-wordmark">SwarmCast</span></div>';

function page(lang: Lang, title: string, head: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">${extraHead}<title>${title}</title>${head}</head>
<body class="gate"><main class="gate-card">${BRAND}
${body}
</main></body></html>`;
}

const SIGNED_IN = {
  en: { title: 'SwarmCast panel', opening: 'Opening the panel…', open: 'Open the panel' },
  'pt-BR': { title: 'Painel do SwarmCast', opening: 'Abrindo o painel…', open: 'Abrir o painel' },
} as const;

/**
 * Answer of `/auth/<token>`: sets the cookie, then opens `/` from this page (meta refresh,
 * plus a link). Not a redirect: the panel cookie is SameSite=Strict, and a redirect chain that
 * started on another site (the desktop app's splash page) does not send it to `/`, while a
 * navigation started by this 127.0.0.1 page does. No script (the CSP allows none inline), no
 * token in the page.
 */
export function signedInPage(acceptLanguage: string | undefined, head: string): string {
  const lang = pageLang(acceptLanguage);
  const m = SIGNED_IN[lang];
  return page(lang, m.title, head, `<h1>${m.opening}</h1>
<p class="gate-open"><a href="/">${m.open}</a></p>`, '<meta http-equiv="refresh" content="0;url=/">');
}

const NOT_AUTHORIZED = {
  en: {
    title: 'SwarmCast panel',
    heading: 'Open the panel from the SwarmCast app',
    lead: 'For your safety, the SwarmCast panel only opens from the SwarmCast app or window on this computer. This page is not signed in to the panel.',
    how: 'How to open it again',
    appLabel: 'SwarmCast app',
    app: 'Open SwarmCast from the Start menu, the Applications folder or your apps menu. If it is already running, click the SwarmCast icon in the tray or menu bar and choose “Open SwarmCast”.',
    scriptLabel: 'Started with a start script',
    script: 'Click the SwarmCast icon in the tray or menu bar and choose “Open panel”, or run the start script again.',
    note: 'The panel gets a new key every time SwarmCast starts, so a bookmark, an old tab or a link copied from another computer cannot open it.',
  },
  'pt-BR': {
    title: 'Painel do SwarmCast',
    heading: 'Abra o painel pelo aplicativo SwarmCast',
    lead: 'Para sua segurança, o painel do SwarmCast só abre pelo aplicativo ou pela janela do SwarmCast neste computador. Esta página não está conectada ao painel.',
    how: 'Como abrir de novo',
    appLabel: 'Aplicativo SwarmCast',
    app: 'Abra o SwarmCast pelo menu Iniciar, pela pasta Aplicativos ou pelo menu de aplicativos. Se ele já estiver aberto, clique no ícone do SwarmCast na bandeja ou na barra de menus e escolha “Abrir o SwarmCast”.',
    scriptLabel: 'Iniciado pelo script de início',
    script: 'Clique no ícone do SwarmCast na bandeja ou na barra de menus e escolha “Open panel”, ou rode o script de início de novo.',
    note: 'O painel ganha uma chave nova toda vez que o SwarmCast abre, então um favorito, uma aba antiga ou um link copiado de outro computador não abre o painel.',
  },
} as const;

/** Shown without the per-run token (status 401): what happened and how to reopen the panel. */
export function notAuthorizedPage(acceptLanguage: string | undefined, head: string): string {
  const lang = pageLang(acceptLanguage);
  const m = NOT_AUTHORIZED[lang];
  return page(lang, m.title, head, `<h1>${m.heading}</h1>
<p>${m.lead}</p>
<h2>${m.how}</h2>
<ul class="gate-steps">
<li><strong>${m.appLabel}</strong>${m.app}</li>
<li><strong>${m.scriptLabel}</strong>${m.script}</li>
</ul>
<p class="gate-note">${m.note}</p>`);
}
