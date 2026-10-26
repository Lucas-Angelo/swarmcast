// The words of the landing page and the download page, in both languages. The `Copy` type makes
// TypeScript (npm run check) refuse a language that misses a string. Links are page slugs
// (see pagePath) or full URLs. `**x**` marks bold in the few strings that render it.
import type { SiteLang } from './i18n';

export type IconName =
  | 'record'
  | 'monitor'
  | 'link'
  | 'users'
  | 'tag'
  | 'lock'
  | 'p2p'
  | 'shield'
  | 'layers'
  | 'refresh'
  | 'code'
  | 'signature'
  | 'eye-off'
  | 'chart';

interface Item {
  icon: IconName;
  title: string;
  text: string;
}

export interface Copy {
  meta: { title: string; description: string };
  hero: { title: string; lead: string; shotAlt: string; shotCaption: string };
  how: { title: string; lead: string };
  features: { title: string; lead: string; items: Item[] };
  trust: {
    title: string;
    lead: string;
    items: (Item & { link?: { label: string; href: string } })[];
    limitsTitle: string;
    limits: string[];
    limitsLink: string;
  };
  faq: { title: string; items: { q: string; a: string }[]; more: string };
  cta: { title: string; lead: string; download: string; guide: string };
  footer: {
    tagline: string;
    product: string;
    help: string;
    project: string;
    links: {
      download: string;
      guide: string;
      viewers: string;
      updates: string;
      troubleshooting: string;
      askHelp: string;
      security: string;
      source: string;
      privacy: string;
      developers: string;
      license: string;
    };
    legal: string;
  };
  download: {
    title: string;
    description: string;
    lead: string;
    leadVersion: string;
    yours: string;
    file: string;
    firstRun: string;
    guide: string;
    windows: { req: string; button: string; fileHint: string; firstRun: string };
    macos: { req: string; arm: string; armHint: string; intel: string; intelHint: string; which: string; firstRun: string };
    linux: { req: string; deb: string; debHint: string; appimage: string; appimageHint: string; arm: string; firstRun: string };
    why: { title: string; text: string[] };
    verify: { title: string; steps: string[]; windowsCmd: string; unixCmd: string; windowsLabel: string; unixLabel: string };
    req: { title: string; minimum: string; recommended: string; rows: [string, string, string][]; obs: string };
    other: { title: string; script: string; scriptText: string; source: string; sourceText: string };
  };
}

const en: Copy = {
  meta: {
    title: 'SwarmCast: members-only lives from your own PC',
    description: 'Stream a members-only live from your own computer through a secret link. Your members watch in the browser. Free, private and open source, for Windows, macOS and Linux.',
  },
  hero: {
    title: 'Members-only lives, straight from your PC.',
    lead: 'Keep streaming from OBS. Send one secret link, and your members watch in their browser.',
    shotAlt: 'The SwarmCast panel during a live: 3 viewers, the secret link for subscribers, the OBS settings, viewers helping through P2P, and the protection card.',
    shotCaption: 'The SwarmCast panel during a live.',
  },
  how: {
    title: 'How it works',
    lead: 'Four pieces, and you already have the first one.',
  },
  features: {
    title: 'Everything a private live needs',
    lead: 'No subscription, no server to rent, nothing to configure by hand.',
    items: [
      { icon: 'tag', title: 'Free, for real', text: 'No subscription, no ads, no account. It runs on your computer, so there is no server to pay for.' },
      { icon: 'lock', title: 'Private by default', text: 'Only people with the secret link can watch, and every live gets a new one. Your IP stays hidden behind an encrypted tunnel.' },
      { icon: 'p2p', title: 'Viewers help each other', text: 'Members pass the video along (P2P), so your upload goes further. Every piece is checked, so nobody can send altered video.' },
      { icon: 'shield', title: 'Protection built in', text: 'A browser check, join limits and public blocklists keep fake viewers out. Kick anyone or make a new link in one click.' },
      { icon: 'layers', title: 'A quality for every connection', text: '1080p, 720p, 480p or 360p, picked for each viewer automatically, when your computer can afford it.' },
      { icon: 'refresh', title: 'One-click updates', text: 'New versions install with one click, only after the app checks their digital signature. Your settings stay.' },
    ],
  },
  trust: {
    title: 'Open, and honest about it',
    lead: 'SwarmCast is built in the open. Here is what you can count on, and what it cannot do.',
    items: [
      { icon: 'code', title: 'Open source', text: 'All the code is public on GitHub under the MIT license. Anyone can read it, build it and check it.', link: { label: 'Source on GitHub', href: 'https://github.com/Lucas-Angelo/swarmcast' } },
      { icon: 'signature', title: 'Signed updates', text: 'The app installs an update only after checking its digital signature. A changed file is refused.', link: { label: 'How updates work', href: 'app/updates' } },
      { icon: 'eye-off', title: 'No telemetry', text: 'No analytics, no crash reports, no trackers: not in the app, not on the viewer page, not on this site.', link: { label: 'Privacy', href: 'about/privacy' } },
    ],
    limitsTitle: 'What it cannot do',
    limits: [
      'Anyone with the link can watch, and a member can forward it. Make a new link if it leaks.',
      'Nothing stops screen recording.',
      'Viewers who help through P2P see each other’s IP address (approximate location only).',
      'The free tunnel is run by Cloudflare and has no uptime guarantee.',
    ],
    limitsLink: 'Security and protection',
  },
  faq: {
    title: 'Questions',
    items: [
      { q: 'Is it really free?', a: 'Yes. SwarmCast is free and open source (MIT license). No account, no subscription, no ads, and no server to pay for: it runs on your computer.' },
      { q: 'Does it replace Twitch, YouTube or Kick?', a: 'No. It is for a members-only live next to your public one, or on its own. OBS can send to both at the same time.' },
      { q: 'How many people can watch?', a: 'It depends on your upload speed and on how many viewers help through P2P; the panel shows an estimate. You need at least 10 Mbps of upload; 50 Mbps or more is recommended.' },
      { q: 'Why does Windows or macOS warn me when I install it?', a: 'SwarmCast has no paid code-signing certificate, so the system shows a warning the first time. This is normal for free, open-source apps. The download page shows how to continue and how to check the file.' },
      { q: 'Can my members watch on a phone?', a: 'Yes. They open the link in any modern browser, on a phone or a computer. No app, no account.' },
    ],
    more: 'More answers in the guide',
  },
  cta: {
    title: 'Ready for your first members-only live?',
    lead: 'Download SwarmCast, follow the 5-minute setup, and send the link.',
    download: 'Download',
    guide: 'Read the guide',
  },
  footer: {
    tagline: 'Members-only lives from your own PC. Free and open source.',
    product: 'Product',
    help: 'Help',
    project: 'Project',
    links: {
      download: 'Download',
      guide: 'Guide',
      viewers: 'For viewers',
      updates: 'Updates',
      troubleshooting: 'Troubleshooting',
      askHelp: 'Ask for help',
      security: 'Security',
      source: 'Source code',
      privacy: 'Privacy',
      developers: 'Developers',
      license: 'MIT license',
    },
    legal: 'SwarmCast is free software under the MIT license. No cookies, no trackers.',
  },
  download: {
    title: 'Download SwarmCast',
    description: 'Download the SwarmCast desktop app for Windows, macOS or Linux. Free and open source, with checksums for every file.',
    lead: 'Free and open source, for Windows, macOS and Linux.',
    leadVersion: 'Latest version: {version}.',
    yours: 'Your system',
    file: 'File',
    firstRun: 'The first time you open it',
    guide: 'Step-by-step guide',
    windows: {
      req: 'Windows 10 or 11, 64-bit',
      button: 'Download for Windows',
      fileHint: 'ends in x64-setup.exe',
      firstRun: 'Windows may show **Windows protected your PC**. Click **More info**, then **Run anyway**. You only do this once.',
    },
    macos: {
      req: 'macOS 13.5 (Ventura) or newer',
      arm: 'Apple chip (M1 or newer)',
      armHint: 'ends in aarch64.dmg',
      intel: 'Intel chip',
      intelHint: 'ends in x64.dmg',
      which: 'Not sure which Mac you have? Apple menu → About This Mac.',
      firstRun: 'macOS may say it could not verify SwarmCast. Click **Done**, open **System Settings → Privacy & Security** and click **Open Anyway**. You only do this once.',
    },
    linux: {
      req: 'x64. ARM files are on GitHub.',
      deb: '.deb package',
      debHint: 'Ubuntu, Debian, Mint, Pop!_OS',
      appimage: 'AppImage',
      appimageHint: 'Any distribution, updates itself',
      arm: 'ARM (arm64) files',
      firstRun: 'The .deb installs from your software center. For the AppImage, allow it to run once: **Properties → Permissions → Allow executing file as program**.',
    },
    why: {
      title: 'Why does my computer warn me?',
      text: [
        'Windows and macOS warn about apps whose developer has not bought a code-signing certificate, which costs hundreds of dollars a year. SwarmCast is a free, open-source project without one, so you see the warning once.',
        'It does not mean something is wrong with the file. You can check that it is the real one in a minute.',
      ],
    },
    verify: {
      title: 'Check your download',
      steps: [
        'Download only from this page or from the official GitHub releases page.',
        'Optional: compare the file’s SHA-256 fingerprint with the **SHA256SUMS.txt** file published with every release. They must be identical.',
        'After that, every update is checked with a digital signature before the app installs it.',
      ],
      windowsLabel: 'Windows (PowerShell)',
      unixLabel: 'macOS or Linux (Terminal)',
      windowsCmd: 'Get-FileHash .\\SwarmCast_*_x64-setup.exe',
      unixCmd: 'shasum -a 256 SwarmCast_*',
    },
    req: {
      title: 'System requirements',
      minimum: 'Minimum',
      recommended: 'Recommended',
      rows: [
        ['Memory', '4 GB', '8 GB'],
        ['Processor', '2 cores', '4 cores'],
        ['Upload speed', '10 Mbps', '50 Mbps or more'],
      ],
      obs: 'You also need OBS Studio (free). Viewers only need a browser.',
    },
    other: {
      title: 'Other ways to install',
      script: 'Install with a script',
      scriptText: 'For advanced users and servers: an installer zip or a single command.',
      source: 'All files and source code',
      sourceText: 'Every release, its notes and SHA256SUMS.txt on GitHub.',
    },
  },
};

const pt: Copy = {
  meta: {
    title: 'SwarmCast: lives só para membros, direto do seu PC',
    description: 'Faça uma live só para membros direto do seu computador, por um link secreto. Os membros assistem pelo navegador. Grátis, privado e de código aberto, para Windows, macOS e Linux.',
  },
  hero: {
    title: 'Lives só para membros, direto do seu PC.',
    lead: 'Continue transmitindo pelo OBS. Mande um link secreto e os seus membros assistem pelo navegador.',
    shotAlt: 'O painel do SwarmCast durante uma live: 3 espectadores, o link secreto para os inscritos, as configurações do OBS, espectadores ajudando pelo P2P e o cartão de proteção.',
    shotCaption: 'O painel do SwarmCast durante uma live.',
  },
  how: {
    title: 'Como funciona',
    lead: 'Quatro partes, e a primeira você já tem.',
  },
  features: {
    title: 'Tudo o que uma live privada precisa',
    lead: 'Sem assinatura, sem servidor para alugar, nada para configurar na mão.',
    items: [
      { icon: 'tag', title: 'Grátis de verdade', text: 'Sem assinatura, sem anúncio, sem conta. Roda no seu computador, então não tem servidor para pagar.' },
      { icon: 'lock', title: 'Privado desde o início', text: 'Só quem tem o link secreto assiste, e cada live tem um link novo. O seu IP fica escondido atrás de um túnel criptografado.' },
      { icon: 'p2p', title: 'Quem assiste ajuda', text: 'Os membros passam o vídeo adiante (P2P), e o seu upload rende mais. Cada pedaço é conferido, ninguém consegue mandar vídeo alterado.' },
      { icon: 'shield', title: 'Proteção incluída', text: 'Verificação do navegador, limites de entrada e listas públicas de bloqueio barram espectadores falsos. Expulse alguém ou gere um link novo com um clique.' },
      { icon: 'layers', title: 'Uma qualidade para cada internet', text: '1080p, 720p, 480p ou 360p, escolhida sozinha para cada espectador, quando o seu computador aguenta.' },
      { icon: 'refresh', title: 'Atualiza com um clique', text: 'Versões novas instalam com um clique, só depois de o app conferir a assinatura digital. As suas configurações ficam.' },
    ],
  },
  trust: {
    title: 'Aberto, e honesto sobre isso',
    lead: 'O SwarmCast é feito às claras. Veja com o que você pode contar, e o que ele não faz.',
    items: [
      { icon: 'code', title: 'Código aberto', text: 'Todo o código é público no GitHub, com licença MIT. Qualquer pessoa pode ler, compilar e conferir.', link: { label: 'Código no GitHub', href: 'https://github.com/Lucas-Angelo/swarmcast' } },
      { icon: 'signature', title: 'Atualizações assinadas', text: 'O app só instala uma atualização depois de conferir a assinatura digital. Um arquivo alterado é recusado.', link: { label: 'Como funcionam as atualizações', href: 'app/updates' } },
      { icon: 'eye-off', title: 'Sem telemetria', text: 'Sem estatísticas de uso, sem relatório de erro, sem rastreador: nem no app, nem na página de quem assiste, nem neste site.', link: { label: 'Privacidade', href: 'about/privacy' } },
    ],
    limitsTitle: 'O que ele não faz',
    limits: [
      'Quem tem o link assiste, e um membro pode repassar. Gere um link novo se vazar.',
      'Nada impede que alguém grave a tela.',
      'Quem ajuda pelo P2P vê o IP dos outros (só a localização aproximada).',
      'O túnel gratuito é da Cloudflare e não tem garantia de funcionamento.',
    ],
    limitsLink: 'Segurança e proteção',
  },
  faq: {
    title: 'Perguntas',
    items: [
      { q: 'É grátis mesmo?', a: 'Sim. O SwarmCast é gratuito e de código aberto (licença MIT). Sem conta, sem assinatura, sem anúncio e sem servidor para pagar: ele roda no seu computador.' },
      { q: 'Substitui a Twitch, o YouTube ou a Kick?', a: 'Não. É para uma live só para membros junto com a sua live pública, ou sozinha. O OBS consegue mandar para os dois ao mesmo tempo.' },
      { q: 'Quantas pessoas podem assistir?', a: 'Depende do seu upload e de quantos espectadores ajudam pelo P2P; o painel mostra uma estimativa. Você precisa de pelo menos 10 Mbps de upload; o recomendado é 50 Mbps ou mais.' },
      { q: 'Por que o Windows ou o macOS dá um aviso na instalação?', a: 'O SwarmCast não tem um certificado pago de assinatura de código, então o sistema mostra um aviso na primeira vez. Isso é normal em apps gratuitos e de código aberto. A página de download mostra como continuar e como conferir o arquivo.' },
      { q: 'Os membros podem assistir pelo celular?', a: 'Sim. Eles abrem o link em qualquer navegador atual, no celular ou no computador. Sem app e sem conta.' },
    ],
    more: 'Mais respostas no guia',
  },
  cta: {
    title: 'Pronto para a primeira live só para membros?',
    lead: 'Baixe o SwarmCast, siga a configuração de 5 minutos e mande o link.',
    download: 'Baixar',
    guide: 'Ler o guia',
  },
  footer: {
    tagline: 'Lives só para membros, direto do seu PC. Grátis e de código aberto.',
    product: 'Produto',
    help: 'Ajuda',
    project: 'Projeto',
    links: {
      download: 'Baixar',
      guide: 'Guia',
      viewers: 'Para quem assiste',
      updates: 'Atualizações',
      troubleshooting: 'Problemas e dúvidas',
      askHelp: 'Pedir ajuda',
      security: 'Segurança',
      source: 'Código-fonte',
      privacy: 'Privacidade',
      developers: 'Desenvolvedores',
      license: 'Licença MIT',
    },
    legal: 'O SwarmCast é software livre, com licença MIT. Sem cookies e sem rastreadores.',
  },
  download: {
    title: 'Baixar o SwarmCast',
    description: 'Baixe o app do SwarmCast para Windows, macOS ou Linux. Gratuito e de código aberto, com checksums de todos os arquivos.',
    lead: 'Gratuito e de código aberto, para Windows, macOS e Linux.',
    leadVersion: 'Versão mais recente: {version}.',
    yours: 'Seu sistema',
    file: 'Arquivo',
    firstRun: 'Na primeira vez que abrir',
    guide: 'Guia passo a passo',
    windows: {
      req: 'Windows 10 ou 11, 64 bits',
      button: 'Baixar para Windows',
      fileHint: 'termina em x64-setup.exe',
      firstRun: 'O Windows pode mostrar **O Windows protegeu o computador**. Clique em **Mais informações** e depois em **Executar assim mesmo**. Só na primeira vez.',
    },
    macos: {
      req: 'macOS 13.5 (Ventura) ou mais novo',
      arm: 'Chip Apple (M1 ou mais novo)',
      armHint: 'termina em aarch64.dmg',
      intel: 'Chip Intel',
      intelHint: 'termina em x64.dmg',
      which: 'Não sabe qual é o seu Mac? Menu Apple → Sobre Este Mac.',
      firstRun: 'O macOS pode dizer que não conseguiu verificar o SwarmCast. Clique em **OK**, abra **Ajustes do Sistema → Privacidade e Segurança** e clique em **Abrir Mesmo Assim**. Só na primeira vez.',
    },
    linux: {
      req: 'x64. Os arquivos ARM estão no GitHub.',
      deb: 'Pacote .deb',
      debHint: 'Ubuntu, Debian, Mint, Pop!_OS',
      appimage: 'AppImage',
      appimageHint: 'Qualquer distribuição, atualiza sozinho',
      arm: 'Arquivos ARM (arm64)',
      firstRun: 'O .deb instala pela central de programas. No AppImage, permita a execução uma vez: **Propriedades → Permissões → Permitir execução do arquivo como programa**.',
    },
    why: {
      title: 'Por que o computador dá um aviso?',
      text: [
        'O Windows e o macOS avisam sobre apps cujo desenvolvedor não comprou um certificado de assinatura de código, que custa centenas de dólares por ano. O SwarmCast é um projeto gratuito e de código aberto sem esse certificado, então o aviso aparece uma vez.',
        'Isso não quer dizer que o arquivo tem algum problema. Dá para conferir que ele é o original em um minuto.',
      ],
    },
    verify: {
      title: 'Confira o seu download',
      steps: [
        'Baixe só desta página ou da página oficial de versões no GitHub.',
        'Opcional: compare a impressão digital SHA-256 do arquivo com o arquivo **SHA256SUMS.txt** publicado em toda versão. As duas têm que ser iguais.',
        'Depois disso, toda atualização é conferida com uma assinatura digital antes de o app instalar.',
      ],
      windowsLabel: 'Windows (PowerShell)',
      unixLabel: 'macOS ou Linux (Terminal)',
      windowsCmd: 'Get-FileHash .\\SwarmCast_*_x64-setup.exe',
      unixCmd: 'shasum -a 256 SwarmCast_*',
    },
    req: {
      title: 'Requisitos',
      minimum: 'Mínimo',
      recommended: 'Recomendado',
      rows: [
        ['Memória', '4 GB', '8 GB'],
        ['Processador', '2 núcleos', '4 núcleos'],
        ['Upload', '10 Mbps', '50 Mbps ou mais'],
      ],
      obs: 'Você também precisa do OBS Studio (gratuito). Quem assiste só precisa de um navegador.',
    },
    other: {
      title: 'Outros jeitos de instalar',
      script: 'Instalar com script',
      scriptText: 'Para quem tem experiência e para servidores: um zip de instalação ou um comando só.',
      source: 'Todos os arquivos e o código-fonte',
      sourceText: 'Todas as versões, as notas e o SHA256SUMS.txt no GitHub.',
    },
  },
};

export const copy: Record<SiteLang, Copy> = { en, 'pt-BR': pt };

/** `**bold**` -> <strong>, everything else escaped. For the few strings that use it. */
export function boldHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
