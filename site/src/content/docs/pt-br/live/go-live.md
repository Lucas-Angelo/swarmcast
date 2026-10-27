---
title: Fazer a live e mandar o link
description: Toda live, passo a passo - ligar o SwarmCast, iniciar o OBS, mandar o link secreto e desligar tudo no fim.
---

## Em toda live

### 1. Abra o SwarmCast

Ele liga sozinho e mostra **Esperando o OBS começar a transmitir…**. Se o topo do painel disser **Desligado**, clique em **Ligar o SwarmCast**.

### 2. Comece a transmitir no OBS

![Controles do OBS e o painel Multiplas saídas: 1 Iniciar transmissão, 2 Iniciar ao lado do SwarmCast.](../../../../assets/guides/obs/pt-br/start-both.webp)

Clique em **Iniciar transmissão**, como sempre. Com o plugin Multiplas saídas, o SwarmCast começa junto se você marcou "Sincronizar início"; se não, clique também em **Iniciar** ao lado do SwarmCast. Configuração: [Configurar o OBS](/swarmcast/pt-br/start/obs/).

### 3. Espere aparecer "OBS: enviando"

![O topo do painel: 1 OBS: enviando · 2,6 Mbps embaixo de Ao vivo: 3 espectadores, e 2 Desligar tudo.](../../../../assets/guides/live/pt-br/status-live.webp)

O topo do painel muda para **Ao vivo** e mostra **OBS: enviando**.

### 4. Copie o link e mande

![O cartão Link da live para seus inscritos: o link (escondido aqui), 1 Copiar link, 2 Gerar novo link, 3 Desconectar todo mundo.](../../../../assets/guides/live/pt-br/link-card.webp)

Clique em **Copiar link** e mande só para os seus membros, por exemplo num canal do Discord só para subs. Cada live ganha um link novo.

Os membros abrem o link, digitam um apelido e assistem no navegador. Veja [Para quem assiste](/swarmcast/pt-br/viewers/).

:::caution[O link é só para os membros]
Quem tiver o link consegue assistir. Se ele vazar, clique em **Gerar novo link** e mande o novo. Veja [Expulsar alguém e trocar o link](/swarmcast/pt-br/live/kick-and-new-link/).
:::

## O cartão Configuração do OBS

![O cartão Configuração do OBS: Servidor rtmp://127.0.0.1:1935/live com 1 Copiar, a Chave de transmissão escondida com 2 Copiar, e 3 O OBS está enviando vídeo (2,6 Mbps).](../../../../assets/guides/live/pt-br/obs-card.webp)

As duas coisas que o OBS precisa, cada uma com um botão **Copiar**. A chave fica escondida: **nunca mostre a chave na live nem num print**. **O OBS está enviando vídeo** em verde quer dizer que o OBS está conectado.

## Durante a live

- **Espectadores e ajuda P2P:** quantos assistem e quantos ajudam por P2P.
- **Seu upload agora:** quanto do seu upload o SwarmCast está usando. Nunca passa do **Upload máximo para espectadores**.
- **Avisos** no topo, por exemplo **"Espectadores demais para o seu upload"**: peça para o pessoal ligar **Ajudar a transmissão (P2P)**, que vem desligado por padrão ([Ajudar a transmissão](/swarmcast/pt-br/live/p2p/)).

## Quando terminar

1. Pare a transmissão no OBS.
2. No painel, clique em **Desligar tudo** e espere aparecer isto:

![O topo do painel depois de Desligar tudo: 1 Desligado: nada no seu computador está acessível, e 2 Ligar o SwarmCast para a próxima live.](../../../../assets/guides/live/pt-br/stopped.webp)

Se o OBS ficar 10 minutos sem mandar vídeo, o SwarmCast desliga tudo sozinho (**Desligar após … minutos sem vídeo**, no painel).

## Fechar a janela

![A pergunta ao fechar a janela durante a live: A live está no ar. Se você fechar, ela acaba para todo mundo. 1 Encerrar e sair, 2 Deixar rodando na bandeja.](../../../../assets/guides/live/pt-br/close-dialog.webp)

Se você fechar a janela com a live no ar, o SwarmCast pergunta: **Encerrar e sair** acaba a live; **Deixar rodando na bandeja** esconde a janela e a live continua.

![O menu do SwarmCast na barra de menus do macOS: 1 o ícone, depois Abrir o SwarmCast, Iniciar a live, Encerrar a live, Procurar atualizações, Exportar logs… e Sair.](../../../../assets/guides/live/pt-br/tray.webp)

O ícone fica na barra de menus (Mac) ou perto do relógio (Windows e Linux; clique na setinha **^** se não aparecer). O menu dele tem **Abrir o SwarmCast**, **Iniciar a live** / **Encerrar a live**, **Procurar atualizações**, **Exportar logs…** e **Sair**.
