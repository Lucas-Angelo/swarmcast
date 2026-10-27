// Small UI strings used by the site's own components (navigation, download button, stats,
// diagram, header). The landing and download page copy is in ./copy.ts; the guide's prose lives
// in src/content/docs/ (English) and src/content/docs/pt-br/.
export type SiteLang = 'en' | 'pt-BR';

export const BASE = '/swarmcast';

/** Starlight locale (undefined for the root English locale) -> our language code. */
export function siteLang(locale: string | undefined): SiteLang {
  return locale === 'pt-br' ? 'pt-BR' : 'en';
}

/** A site path for `slug` in `lang`, e.g. ('pt-BR', 'install/windows') -> '/swarmcast/pt-br/install/windows/'. */
export function pagePath(lang: SiteLang, slug = ''): string {
  const [path, hash] = slug.split('#');
  const clean = path.replace(/^\/+|\/+$/g, '');
  const prefix = lang === 'pt-BR' ? `${BASE}/pt-br/` : `${BASE}/`;
  return (clean ? `${prefix}${clean}/` : prefix) + (hash ? `#${hash}` : '');
}

/** The same page in the other language. Works on any path below BASE. */
export function otherLangPath(pathname: string): { lang: SiteLang; href: string } {
  const pt = `${BASE}/pt-br`;
  if (pathname === pt || pathname.startsWith(`${pt}/`)) {
    return { lang: 'en', href: `${BASE}${pathname.slice(pt.length) || '/'}` };
  }
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return { lang: 'pt-BR', href: `${pt}${rest.startsWith('/') ? rest : `/${rest}`}` };
}

export const ui = {
  en: {
    'lang.switch': 'Português',
    'lang.short': 'PT',
    'lang.switch.label': 'Ler esta página em português',
    'nav.label': 'Main',
    'nav.home': 'SwarmCast home',
    'nav.guide': 'Guide',
    'nav.download': 'Download',
    'nav.github': 'GitHub',
    'nav.skip': 'Skip to content',
    'dl.button': 'Download SwarmCast',
    'dl.for.windows': 'Download for Windows',
    'dl.for.macos-arm64': 'Download for Mac',
    'dl.for.macos-x64': 'Download for Mac (Intel)',
    'dl.for.linux-deb': 'Download for Linux',
    'dl.for.linux-appimage': 'Download for Linux (AppImage)',
    'dl.note.windows': 'Windows 10 and 11, 64-bit',
    'dl.note.macos-arm64': 'Apple chip (M1 or newer)',
    'dl.note.macos-x64': 'Intel chip',
    'dl.note.linux-deb': '.deb for Ubuntu, Debian, Mint',
    'dl.note.linux-appimage': 'AppImage for any distribution',
    'dl.alt.macos-x64': 'Intel Mac',
    'dl.alt.macos-arm64': 'Mac with Apple chip',
    'dl.alt.linux-appimage': 'AppImage',
    'dl.alt.linux-deb': '.deb',
    'dl.version': 'Version {version}',
    'dl.other': 'Other platforms',
    'dl.allFiles': 'All files on GitHub',
    'dl.howTo': 'How to install',
    'dl.trust': 'Open source · MIT license · No account · No ads',
    'dl.mobile.title': 'SwarmCast runs on your computer',
    'dl.mobile': 'Open this page on the PC or Mac you stream from to download it. Your members can watch on phones.',
    'dl.copy': 'Copy link',
    'dl.copied': 'Link copied',
    'dl.share': 'Share',
    'dl.shareTitle': 'SwarmCast: members-only live streams from your own PC',
    'os.windows': 'Windows',
    'os.macos': 'macOS',
    'os.linux': 'Linux',
    'stats.title': 'SwarmCast in numbers',
    'stats.downloads': 'downloads',
    'stats.apps': 'apps opened this week',
    'stats.note': 'Approximate, from GitHub’s public download counters. Nothing is tracked.',
    'stats.how': 'How we count',
    'flow.label': 'How SwarmCast works, step by step',
    'flow.obs': 'OBS',
    'flow.obs.d': 'You stream from OBS, like always.',
    'flow.app': 'SwarmCast on your PC',
    'flow.app.d': 'Turns your stream into a members-only live. Your PC is the server.',
    'flow.link': 'A secret link',
    'flow.link.d': 'A new one every live. Share it only with your members.',
    'flow.viewers': "Members' browsers",
    'flow.viewers.d': 'They watch with no app and no account, and pass the video along to each other.',
    'theme.label': 'Theme',
    'theme.auto': 'Auto',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'docs.label': 'Guide',
    'anchor.stats': 'how-the-numbers-on-the-home-page-are-counted',
    'anchor.faq': 'frequent-questions',
  },
  'pt-BR': {
    'lang.switch': 'English',
    'lang.short': 'EN',
    'lang.switch.label': 'Read this page in English',
    'nav.label': 'Principal',
    'nav.home': 'Início do SwarmCast',
    'nav.guide': 'Guia',
    'nav.download': 'Baixar',
    'nav.github': 'GitHub',
    'nav.skip': 'Pular para o conteúdo',
    'dl.button': 'Baixar o SwarmCast',
    'dl.for.windows': 'Baixar para Windows',
    'dl.for.macos-arm64': 'Baixar para Mac',
    'dl.for.macos-x64': 'Baixar para Mac (Intel)',
    'dl.for.linux-deb': 'Baixar para Linux',
    'dl.for.linux-appimage': 'Baixar para Linux (AppImage)',
    'dl.note.windows': 'Windows 10 e 11, 64 bits',
    'dl.note.macos-arm64': 'Chip Apple (M1 ou mais novo)',
    'dl.note.macos-x64': 'Chip Intel',
    'dl.note.linux-deb': '.deb para Ubuntu, Debian, Mint',
    'dl.note.linux-appimage': 'AppImage para qualquer distribuição',
    'dl.alt.macos-x64': 'Mac com Intel',
    'dl.alt.macos-arm64': 'Mac com chip Apple',
    'dl.alt.linux-appimage': 'AppImage',
    'dl.alt.linux-deb': '.deb',
    'dl.version': 'Versão {version}',
    'dl.other': 'Outros sistemas',
    'dl.allFiles': 'Todos os arquivos no GitHub',
    'dl.howTo': 'Como instalar',
    'dl.trust': 'Código aberto · Licença MIT · Sem conta · Sem anúncios',
    'dl.mobile.title': 'O SwarmCast roda no computador',
    'dl.mobile': 'Abra esta página no PC ou Mac de onde você faz a live para baixar. Os seus membros podem assistir pelo celular.',
    'dl.copy': 'Copiar link',
    'dl.copied': 'Link copiado',
    'dl.share': 'Compartilhar',
    'dl.shareTitle': 'SwarmCast: lives só para membros, direto do seu PC',
    'os.windows': 'Windows',
    'os.macos': 'macOS',
    'os.linux': 'Linux',
    'stats.title': 'O SwarmCast em números',
    'stats.downloads': 'downloads',
    'stats.apps': 'apps abertos nesta semana',
    'stats.note': 'Números aproximados, dos contadores públicos de download do GitHub. Ninguém é rastreado.',
    'stats.how': 'Como contamos',
    'flow.label': 'Como o SwarmCast funciona, passo a passo',
    'flow.obs': 'OBS',
    'flow.obs.d': 'Você transmite pelo OBS, como sempre.',
    'flow.app': 'SwarmCast no seu PC',
    'flow.app.d': 'Transforma a sua live numa live só para membros. O seu PC é o servidor.',
    'flow.link': 'Um link secreto',
    'flow.link.d': 'Um novo a cada live. Mande só para quem é membro.',
    'flow.viewers': 'Navegadores dos membros',
    'flow.viewers.d': 'Assistem sem instalar nada e sem conta, e passam o vídeo adiante uns para os outros.',
    'theme.label': 'Tema',
    'theme.auto': 'Automático',
    'theme.light': 'Claro',
    'theme.dark': 'Escuro',
    'docs.label': 'Guia',
    'anchor.stats': 'como-os-números-da-página-inicial-são-contados',
    'anchor.faq': 'dúvidas-frequentes',
  },
} as const;

export type UiKey = keyof (typeof ui)['en'];

export function tr(lang: SiteLang, key: UiKey, params: Record<string, string> = {}): string {
  return ui[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
}
