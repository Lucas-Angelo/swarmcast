---
title: "Avançado: instalar com script"
description: Instale o SwarmCast com os scripts ou o zip de instalação, sem o app - para quem já tem experiência e para servidores.
---

Para a maioria das pessoas, o melhor é o [app](/swarmcast/pt-br/download/). Os scripts são para quem já tem experiência, para servidores e para computadores onde o app não pode ser instalado. Os dois usam o mesmo SwarmCast e a mesma pasta de configurações, mas não rode os dois ao mesmo tempo.

Com os scripts, o SwarmCast roda numa janela de terminal e o painel abre no navegador. Tem um iconezinho na bandeja, mas não tem atualização automática nem "Iniciar com o computador".

## Opção 1: o zip de instalação

1. Baixe o zip do seu computador na [versão mais recente](https://github.com/Lucas-Angelo/swarmcast/releases/latest):
   - Windows: `SwarmCast-vX.Y.Z-windows-x64-installer.zip`
   - Mac com chip Apple (M1 ou mais novo): `SwarmCast-vX.Y.Z-macos-arm64-installer.zip`
   - Mac com chip Intel: `SwarmCast-vX.Y.Z-macos-x64-installer.zip`
   - Linux: `SwarmCast-vX.Y.Z-linux-x64-installer.zip` (ou `linux-arm64`)
2. Extraia o zip. Não rode nada de dentro do zip.
   - Windows: botão direito no zip → **Extrair tudo…** → **Extrair**.
   - macOS: dois cliques no zip.
   - Linux: botão direito → **Extrair aqui**.
3. Abra a pasta extraída e rode o script:
   - **Windows:** dois cliques em `start-windows.cmd`. Na primeira vez, o Windows pode mostrar "O Windows protegeu o computador": clique em **Mais informações** → **Executar assim mesmo**. Se perguntar "Deseja executar este arquivo?", clique em **Executar**.
   - **macOS:** dois cliques em `start-macos.command`. Na primeira vez o macOS bloqueia: clique em **OK**, abra **Ajustes do Sistema** → **Privacidade e Segurança**, role até o fim, clique em **Abrir Mesmo Assim** e confirme. Em versões mais antigas do macOS: botão direito no arquivo → **Abrir** → **Abrir**.
   - **Linux:** abra um terminal na pasta e rode `./start-linux.sh`.

O zip também traz este guia como página offline: `LEIA-ME - Como fazer a live.html` e `READ-ME - How to go live.html`.

## Opção 2: um comando só

Cole num terminal (Windows: PowerShell; macOS: Terminal):

- Windows: `irm https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-windows.ps1 | iex`
- macOS: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-macos.sh | bash`
- Linux: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-linux.sh | bash`

## O que o script faz

1. Confere o seu computador: memória, processador, disco, velocidade da internet e OBS. ✓ quer dizer tudo certo, ⚠ funciona mas não é o ideal, ✗ está abaixo do mínimo. Ele nunca faz perguntas: abaixo do mínimo, mostra um aviso e continua.
2. No Linux, se faltarem ferramentas básicas, ele explica o motivo e pede a sua senha (`sudo`) para instalar. Nada mais precisa de permissão de administrador.
3. Instala ou atualiza o SwarmCast para o seu usuário e confere se os arquivos estão íntegros (SHA-256). Também baixa o conversor de vídeo gratuito (ffmpeg) para as qualidades menores.
4. Se algo falhar, ele tenta de novo sozinho e volta para a versão anterior se uma atualização der errado. Se mesmo assim falhar, ele diz o que fazer e espera você apertar Enter para fechar.
5. O painel do SwarmCast abre no navegador, com o [tutorial de configuração](/swarmcast/pt-br/start/first-run/) na primeira vez.

**Deixe a janela aberta enquanto faz a live.** Fechar a janela desliga o SwarmCast.

## Em toda live

Rode o script de novo (dois cliques ou o mesmo comando) e siga [Fazer a live e mandar o link](/swarmcast/pt-br/live/go-live/). Para fechar, use o ícone da bandeja → **Fechar o SwarmCast**, o botão **Fechar o SwarmCast** no painel, ou feche a janela.

## Atualizar

- **Zip de instalação:** extraia o zip novo e rode o script dele do mesmo jeito. As suas configurações e a chave de transmissão continuam. Pode apagar a pasta antiga.
- **Um comando só:** rode o mesmo comando de novo.

Se a atualização falhar, a versão anterior continua funcionando. Um zip antigo nunca troca uma versão mais nova que já esteja instalada.

## Opções do script

Coloque depois do nome do script ou do comando, por exemplo `./start-linux.sh --no-tunnel`:

- `--no-tunnel`: só local, sem link público (para testes).
- `--install-only`: instala ou atualiza sem abrir.
- `--skip-speedtest`: pula o teste de velocidade.
- `--no-ffmpeg`: não baixa o conversor de vídeo.
- `--ask`: pergunta antes de continuar num computador abaixo do mínimo.

No Windows, as mesmas opções também funcionam como `-NoTunnel`, `-NoFfmpeg`, `-Ask` e assim por diante.

## Problemas com os scripts

- **"Could not download SwarmCast" ou "HTTP 404":** você rodou o script fora da pasta extraída (ou de dentro do zip). Extraia o zip e rode o script na pasta extraída.
- **"Port … is busy":** outro SwarmCast (o app, por exemplo) ou outro programa está usando a porta 1935, 8080 ou 8081. Feche e rode o script de novo.

Para desinstalar, veja [Desinstalar](/swarmcast/pt-br/app/uninstall/#apagar-tudo-script-de-desinstalação).
