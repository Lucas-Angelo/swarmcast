---
title: Desinstalar
description: Tire o SwarmCast do Windows, do macOS ou do Linux, mantendo ou apagando as configurações e a chave de transmissão.
---

Desinstalar nunca mexe no OBS. Se quiser, apague você mesmo o destino do SwarmCast (painel Multiplas saídas), as configurações de transmissão do Vertical (Aitum Vertical) ou o servidor personalizado no OBS.

## Windows

1. Feche o SwarmCast (ícone da bandeja → **Sair**).
2. Abra **Configurações** → **Aplicativos** → **Aplicativos instalados**, encontre o **SwarmCast**, clique em **…** → **Desinstalar**.
3. O desinstalador mantém as suas configurações e a chave de transmissão, a não ser que você marque a opção de **apagar os dados do app**.

## macOS

1. Feche o SwarmCast (ícone na barra de menus → **Sair**).
2. Se **Iniciar com o computador** estiver ligado, desligue antes no painel ([Iniciar com o computador](/swarmcast/pt-br/app/autostart/)).
3. Abra **Aplicativos** e arraste o **SwarmCast** para o Lixo.
4. As suas configurações continuam em `~/Library/Application Support/SwarmCast`. Para apagar tudo, use o script de desinstalação abaixo.

## Linux

- **.deb:** no terminal, `sudo apt remove swarm-cast`.
- **AppImage:** desligue **Iniciar com o computador** no painel, feche o SwarmCast e apague o arquivo `.AppImage`.

As suas configurações continuam em `~/.local/share/swarmcast`. Para apagar tudo, use o script de desinstalação abaixo.

## Apagar tudo (script de desinstalação)

O script de desinstalação tira o SwarmCast por completo: o app, a entrada de "iniciar com o computador", as configurações, a chave de transmissão e os logs. Ele também fecha uma porta do roteador que o modo direto possa ter deixado aberta. Ele não pergunta nada.

1. Baixe o desinstalador do seu sistema na [versão mais recente](https://github.com/Lucas-Angelo/swarmcast/releases/latest) (ele também vem dentro dos zips de instalação da [instalação por script](/swarmcast/pt-br/advanced/script-install/)):
   - Windows: `uninstall-windows.cmd` **e** `uninstall-windows.ps1` (deixe os dois na mesma pasta)
   - macOS: `uninstall-macos.command`
   - Linux: `uninstall-linux.sh`
2. Rode:
   - **Windows:** dê dois cliques em `uninstall-windows.cmd`. Se aparecer "O Windows protegeu o computador", clique em **Mais informações** → **Executar assim mesmo**.
   - **macOS:** dê dois cliques em `uninstall-macos.command`. Se o macOS bloquear, libere como o app: **Ajustes do Sistema** → **Privacidade e Segurança** → **Abrir Mesmo Assim** (em versões mais antigas do macOS: botão direito no arquivo → **Abrir** → **Abrir**).
   - **Linux:** num terminal nessa pasta: `bash uninstall-linux.sh`
3. A janela mostra o resultado. No Windows, aperte uma tecla para fechar.

Quer reinstalar depois com a mesma chave de transmissão? Acrescente `--keep-settings`, por exemplo `uninstall-windows.cmd --keep-settings` ou `bash uninstall-linux.sh --keep-settings` num terminal.
