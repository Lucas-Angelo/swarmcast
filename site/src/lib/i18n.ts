// Small UI strings used by the site's own components (download button, stats, diagram, header).
// The page prose lives in src/content/docs/ (English) and src/content/docs/pt-br/.
export type SiteLang = 'en' | 'pt-BR';

export const BASE = '/swarmcast';

/** Starlight locale (undefined for the root English locale) -> our language code. */
export function siteLang(locale: string | undefined): SiteLang {
  return locale === 'pt-br' ? 'pt-BR' : 'en';
}

/** A site path for `slug` in `lang`, e.g. ('pt-BR', 'install/windows') -> '/swarmcast/pt-br/install/windows/'. */
export function pagePath(lang: SiteLang, slug = ''): string {
  const clean = slug.replace(/^\/+|\/+$/g, '');
  const prefix = lang === 'pt-BR' ? `${BASE}/pt-br/` : `${BASE}/`;
  return clean ? `${prefix}${clean}/` : prefix;
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
    'lang.switch.label': 'Ler esta página em português',
    'dl.button': 'Download SwarmCast',
    'dl.for.windows': 'Download for Windows',
    'dl.for.macos-arm64': 'Download for Mac (Apple chip)',
    'dl.for.macos-x64': 'Download for Mac (Intel chip)',
    'dl.for.linux-deb': 'Download for Linux (.deb)',
    'dl.for.linux-appimage': 'Download for Linux (AppImage)',
    'dl.alt.macos-x64': 'Mac with an Intel chip',
    'dl.alt.macos-arm64': 'Mac with an Apple chip (M1 or newer)',
    'dl.alt.linux-appimage': 'AppImage (any distribution)',
    'dl.alt.linux-deb': '.deb (Ubuntu, Debian, Mint)',
    'dl.free': 'Free and open source · Windows 10/11, macOS, Linux',
    'dl.version': 'Version {version}',
    'dl.other': 'Other systems:',
    'dl.allFiles': 'All files',
    'dl.howTo': 'How to install',
    'dl.mobile': 'SwarmCast runs on the computer you stream from. Open this page there, or pick your system:',
    'os.windows': 'Windows',
    'os.macos': 'macOS',
    'os.linux': 'Linux',
    'stats.title': 'SwarmCast in numbers',
    'stats.downloads': 'about {n} downloads',
    'stats.apps': 'about {n} SwarmCast apps opened this week',
    'stats.how': 'How we count (no tracking)',
    'flow.label': 'How SwarmCast works, from top to bottom',
    'flow.obs': 'OBS',
    'flow.obs.d': 'You stream from OBS, like always.',
    'flow.app': 'SwarmCast on your PC',
    'flow.app.d': 'Turns your stream into a members-only live. Your PC is the server.',
    'flow.link': 'A secret link',
    'flow.link.d': 'A new one every live. Share it only with your members.',
    'flow.viewers': "Members' browsers",
    'flow.viewers.d': 'They watch with no app and no account, and help each other by passing the video along.',
  },
  'pt-BR': {
    'lang.switch': 'English',
    'lang.switch.label': 'Read this page in English',
    'dl.button': 'Baixar o SwarmCast',
    'dl.for.windows': 'Baixar para Windows',
    'dl.for.macos-arm64': 'Baixar para Mac (chip Apple)',
    'dl.for.macos-x64': 'Baixar para Mac (chip Intel)',
    'dl.for.linux-deb': 'Baixar para Linux (.deb)',
    'dl.for.linux-appimage': 'Baixar para Linux (AppImage)',
    'dl.alt.macos-x64': 'Mac com chip Intel',
    'dl.alt.macos-arm64': 'Mac com chip Apple (M1 ou mais novo)',
    'dl.alt.linux-appimage': 'AppImage (qualquer distribuição)',
    'dl.alt.linux-deb': '.deb (Ubuntu, Debian, Mint)',
    'dl.free': 'Grátis e de código aberto · Windows 10/11, macOS, Linux',
    'dl.version': 'Versão {version}',
    'dl.other': 'Outros sistemas:',
    'dl.allFiles': 'Todos os arquivos',
    'dl.howTo': 'Como instalar',
    'dl.mobile': 'O SwarmCast roda no computador de onde você faz a live. Abra esta página nele ou escolha o sistema:',
    'os.windows': 'Windows',
    'os.macos': 'macOS',
    'os.linux': 'Linux',
    'stats.title': 'O SwarmCast em números',
    'stats.downloads': 'cerca de {n} downloads',
    'stats.apps': 'cerca de {n} SwarmCast abertos nesta semana',
    'stats.how': 'Como contamos (sem rastrear ninguém)',
    'flow.label': 'Como o SwarmCast funciona, de cima para baixo',
    'flow.obs': 'OBS',
    'flow.obs.d': 'Você transmite pelo OBS, como sempre.',
    'flow.app': 'SwarmCast no seu PC',
    'flow.app.d': 'Transforma a sua live numa live só para membros. O seu PC é o servidor.',
    'flow.link': 'Um link secreto',
    'flow.link.d': 'Um novo a cada live. Mande só para quem é membro.',
    'flow.viewers': 'Navegadores dos membros',
    'flow.viewers.d': 'Assistem sem instalar nada e sem conta, e se ajudam passando o vídeo adiante.',
  },
} as const;

export type UiKey = keyof (typeof ui)['en'];

export function tr(lang: SiteLang, key: UiKey, params: Record<string, string> = {}): string {
  return ui[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
}
