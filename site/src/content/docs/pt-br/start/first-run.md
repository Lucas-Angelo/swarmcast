---
title: Primeira vez e tutorial
description: O que o SwarmCast faz quando abre pela primeira vez e o tutorial passo a passo do painel.
---

Quando você abre o SwarmCast, aparece o **painel**, a tela onde você controla a sua live. Ele roda só no seu computador: ninguém mais consegue abrir.

## 1. O SwarmCast abre

![A janela do SwarmCast enquanto abre: Abrindo o SwarmCast… Isso costuma levar só alguns segundos.](../../../../assets/guides/start/pt-br/splash.webp)

A janela mostra **Abrindo o SwarmCast…** por alguns segundos, e depois o tutorial de configuração abre sozinho.

## 2. O tutorial de configuração

![Tutorial de configuração, passo 1 de 9: Boas-vindas ao SwarmCast, com 1 Próximo.](../../../../assets/guides/start/pt-br/welcome.webp)

Leva uns 5 minutos. Clique em **Próximo** para seguir e em **Voltar** para voltar. **Pular tutorial** fecha (dá para abrir de novo depois).

## 3. Conferindo o seu PC

![Passo 2, Conferindo o seu PC, enquanto roda: 1 Verificando o seu computador… (memória, processador, velocidade da internet, OBS). Leva mais ou menos um minuto.](../../../../assets/guides/start/pt-br/checking.webp)

Na primeira vez, o SwarmCast confere o seu computador. Ele mostra **Verificando o seu computador…** por mais ou menos um minuto.

![Passo 2 com o resultado: 1 um sinal verde ao lado do sistema, memória, processador, upload e download, disco, portas, OBS Studio, servidor de atualizações e versão, e 2 Próximo.](../../../../assets/guides/start/pt-br/pc-check.webp)

Verde quer dizer tudo certo; amarelo, funciona mas não é o ideal. Nada disso impede você de continuar. Ao mesmo tempo, o SwarmCast baixa o conversor de vídeo gratuito (ffmpeg) para as qualidades menores.

## 4. O OBS, uma vez só

![Passo 4, Para onde você vai transmitir?: 1 Outra plataforma + SwarmCast ao mesmo tempo (recomendado), ou 2 Só o SwarmCast.](../../../../assets/guides/start/pt-br/where.webp)

Escolha se você também transmite na Twitch, no YouTube ou na Kick, ou só no SwarmCast. Os próximos passos mostram as configurações do OBS para essa escolha.

![Passo 5: instale o plugin Multiple output no OBS e preencha um destino novo com 1 Nome, 2 URL (servidor) e 3 Chave de transmissão, cada um com um botão Copiar.](../../../../assets/guides/start/pt-br/obs-step.webp)

Use os botões **Copiar** e cole no OBS. O passo a passo completo, com imagens do OBS: [Configurar o OBS](/swarmcast/pt-br/start/obs/).

## 5. Teste e mande o link

![Passo 6, Teste: 1 O SwarmCast está ligado, depois Iniciar transmissão no OBS.](../../../../assets/guides/start/pt-br/test-it.webp)

Comece a transmitir no OBS. O tutorial mostra quando o vídeo chega.

![Passo 7, Compartilhe o link: o link da live (escondido aqui) e 1 Copiar link.](../../../../assets/guides/start/pt-br/share-link.webp)

Cada live ganha um link secreto novo. Mande só para os seus membros.

![Passo 9, Tudo pronto!: o que fazer no fim da live, e 1 Concluir.](../../../../assets/guides/start/pt-br/finish.webp)

Clique em **Concluir**. Para ver o tutorial de novo, clique em **Refazer o tutorial de configuração**, no fim do painel.

## O painel

![O painel durante uma live: 1 Ao vivo: 3 espectadores e OBS: enviando, 2 o link da live (escondido aqui), 3 Configuração do OBS, 4 Espectadores e ajuda P2P (quem ligou o P2P compartilha vídeo), 5 Proteção.](../../../../assets/guides/start/pt-br/panel.webp)

1. **No alto:** se você está ao vivo, se o OBS está enviando e o botão **Desligar tudo**.
2. **Link da live para seus inscritos:** o link para mandar. Veja [Fazer a live](/swarmcast/pt-br/live/go-live/).
3. **Configuração do OBS:** o servidor e a chave de transmissão para o OBS.
4. **Espectadores e ajuda P2P:** quantos assistem e quantos ajudam. Veja [Ajudar a transmissão (P2P)](/swarmcast/pt-br/live/p2p/).
5. **Proteção:** veja [Segurança e proteção](/swarmcast/pt-br/live/protection/).

Mais abaixo: **Qualidade para quem assiste**, **App do SwarmCast** (iniciar com o computador, atualizações), **Espectadores** (expulsar alguém), **Atividade** e **Relatório de problema** (mandar os logs). Quase todo botão tem um **ⓘ** pequeno: passe o mouse ou toque nele para ver a explicação.

## Onde o SwarmCast guarda as suas configurações

As configurações, a chave de transmissão e os logs ficam numa pasta do SwarmCast na sua conta de usuário. Atualizar o SwarmCast nunca apaga essa pasta.

- Windows: `%LOCALAPPDATA%\SwarmCast`
- macOS: `~/Library/Application Support/SwarmCast`
- Linux: `~/.local/share/swarmcast`

Próximo passo: [Configurar o OBS](/swarmcast/pt-br/start/obs/).
