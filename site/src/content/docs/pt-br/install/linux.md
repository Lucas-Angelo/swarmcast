---
title: Instalar no Linux
description: Instale o SwarmCast no Linux com o pacote .deb (Ubuntu, Debian, Mint) ou o AppImage (qualquer distribuição).
---

Existem dois arquivos. Escolha um:

- **`.deb`**: para Ubuntu, Debian, Linux Mint, Pop!_OS e outros sistemas baseados no Debian. Instala como qualquer app e aparece no menu de aplicativos.
- **`.AppImage`**: um arquivo só, que roda em quase qualquer distribuição (Fedora, Arch, openSUSE…) sem instalar. Ele também se atualiza sozinho.

A maioria dos computadores usa os arquivos **x64** (`amd64`). Os **arm64** (`aarch64`) são só para computadores ARM, como o Raspberry Pi 5.

## Opção A: o pacote .deb

1. Entre na [página de download](/swarmcast/pt-br/download/#linux) e baixe o arquivo `.deb` (por exemplo, `swarmcast_0.2.0_amd64.deb`).
2. Instale:
   - **Com o mouse:** dê dois cliques no arquivo. A central de programas abre. Clique em **Instalar** e digite sua senha.
   - **No terminal**, dentro da pasta Downloads: `sudo apt install ./swarmcast_*_amd64.deb`
3. Abra o **SwarmCast** pelo menu de aplicativos.

O `apt` também instala as duas bibliotecas do sistema de que o SwarmCast precisa (WebKitGTK e a do ícone da bandeja).

## Opção B: o AppImage

1. Baixe o arquivo `.AppImage` na [página de download](/swarmcast/pt-br/download/#linux).
2. Deixe ele rodar: botão direito no arquivo → **Propriedades** → **Permissões** → marque **Permitir execução do arquivo como programa** (ou no terminal: `chmod +x SwarmCast_*.AppImage`).
3. Dê dois cliques nele.

O AppImage usa as bibliotecas comuns de desktop (fontes, gráficos/OpenGL), que toda distribuição com ambiente gráfico já tem. Numa instalação mínima, sem desktop completo, use o `.deb`.

:::caution[Ubuntu 22.04 ou mais novo: "AppImages require FUSE to run"]
Instale a biblioteca FUSE 2 uma vez e tente de novo:

- Ubuntu 24.04 ou mais novo: `sudo apt install libfuse2t64`
- Ubuntu 22.04: `sudo apt install libfuse2`
:::

Deixe o AppImage num lugar fixo (por exemplo, uma pasta `Applications` na sua pasta pessoal) antes de ligar [Iniciar com o computador](/swarmcast/pt-br/app/autostart/), porque essa opção guarda onde o arquivo está.

## Primeira vez

A janela mostra **Abrindo o SwarmCast…** e depois um tutorial curto. Continue em [Primeira vez e tutorial](/swarmcast/pt-br/start/first-run/).

:::note[Sem ícone na bandeja no GNOME?]
O Ubuntu já mostra o ícone. Em outros ambientes GNOME, instale a extensão "AppIndicator and KStatusNotifierItem Support" ou use só a janela do SwarmCast.
:::

Mais respostas: [Problemas e dúvidas](/swarmcast/pt-br/help/troubleshooting/).
