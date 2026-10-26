---
title: Primeira vez e tutorial
description: O que o SwarmCast faz quando abre pela primeira vez e o tutorial passo a passo do painel.
---

Quando você abre o SwarmCast, aparece o **painel**: a tela onde você controla a sua live. Ele roda só no seu computador. Ninguém mais consegue abrir.

## O que acontece na primeira vez

1. A janela mostra **Abrindo o SwarmCast…** por alguns segundos.
2. O SwarmCast confere o seu computador: memória, processador, velocidade da internet e se o OBS está instalado. Leva mais ou menos um minuto. ✓ quer dizer tudo certo, ⚠ funciona mas não é o ideal. Nada disso impede você de continuar.
3. Ele baixa o conversor de vídeo gratuito (ffmpeg) direto de quem publica e confere o arquivo. É ele que deixa quem tem internet lenta escolher uma qualidade menor. Se o download falhar, o SwarmCast tenta de novo sozinho, e tudo continua funcionando na qualidade original.
4. O **tutorial de configuração** abre.

## O tutorial de configuração

O tutorial leva uns 5 minutos e tem imagens do OBS. Ele mostra:

1. **A conferência do seu PC:** o que o SwarmCast encontrou neste computador.
2. **Saída do OBS:** o intervalo de quadro-chave de 2 segundos (obrigatório).
3. **Onde você vai transmitir?** Em outra plataforma (Twitch, YouTube, Kick…) e no SwarmCast ao mesmo tempo, ou só no SwarmCast.
4. **Mandar o OBS para o SwarmCast:** o servidor e a chave de transmissão, com botões de **Copiar**.
5. **Testar:** você começa a transmitir no OBS e o tutorial mostra quando o vídeo chega.
6. **Compartilhar o link** e um tour rápido pelo painel.

Os mesmos passos estão explicados aqui no site: [Configurar o OBS](/swarmcast/pt-br/start/obs/) e [Fazer a live e mandar o link](/swarmcast/pt-br/live/go-live/).

Para ver o tutorial de novo, clique em **Refazer o tutorial de configuração** no fim do painel.

![O painel do SwarmCast durante a live: Ao vivo e OBS: enviando no topo, o cartão do link da live (o link está escondido aqui) e a lista de espectadores com o aparelho e o P2P de cada um.](../../../../../../docs/img/panel-overview-pt-BR.png)

## As partes do painel

- **No topo:** se você está ao vivo, se o OBS está enviando e o botão **Desligar tudo**.
- **Link da live para seus inscritos:** o link secreto para compartilhar, com **Copiar link** e **Gerar novo link**.
- **Espectadores e ajuda P2P:** quem está assistindo (apelido e aparelho) e quem está ajudando a passar o vídeo.
- **Qualidade para quem assiste** e **Sua internet:** as qualidades menores e quanto do seu upload o SwarmCast usa.
- **Modo de conexão:** modo seguro (o normal) ou modo direto (só para emergências).
- **Proteção:** o que o SwarmCast detectou e fez contra ataques.
- **App do SwarmCast:** iniciar com o computador, versão e atualizações.
- **Atividade:** tudo o que acontece durante a live. Copie quando for pedir ajuda.
- **No fim:** o idioma, **Ajuda** (este site), **Refazer o tutorial de configuração** e **Fechar o SwarmCast**.

A maioria dos botões tem um **ⓘ** do lado: passe o mouse ou toque nele para ver a explicação.

## Onde o SwarmCast guarda as suas configurações

As configurações, a chave de transmissão e os logs ficam numa pasta do SwarmCast no seu usuário. Atualizar o SwarmCast nunca apaga essa pasta.

- Windows: `%LOCALAPPDATA%\SwarmCast`
- macOS: `~/Library/Application Support/SwarmCast`
- Linux: `~/.local/share/swarmcast`

Próximo passo: [Configurar o OBS](/swarmcast/pt-br/start/obs/).
