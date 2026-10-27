---
title: Atualizações
description: Como o SwarmCast avisa sobre versões novas e se atualiza com um clique, sem perder as configurações.
---

O SwarmCast procura uma versão **estável** nova logo depois de abrir e depois a cada 6 horas. Nada é instalado sem o seu OK.

## Quando tem versão nova

Aparece uma mensagem **"O SwarmCast X está disponível (você tem a versão Y)"** com as novidades, e o painel mostra o mesmo numa faixa.

1. Clique em **Atualizar agora** (ou **Depois**).
2. O SwarmCast baixa a atualização, confere a assinatura digital, instala e **abre de novo sozinho**. Leva mais ou menos um minuto.

As suas configurações, a chave de transmissão e o acesso dos espectadores continuam iguais.

:::caution[Atualizar encerra a live]
Se você estiver ao vivo, atualizar encerra a live para todo mundo. O SwarmCast avisa antes, e **Depois** já vem selecionado. Atualize quando a live acabar.
:::

## Procurar agora

![O cartão App do SwarmCast: Iniciar com o computador, Versão do app 0.2.0 e 2 Procurar atualizações, com Você já está com a versão mais recente.](../../../../assets/guides/app/pt-br/desktop-card.webp)

Clique em **Procurar atualizações** no cartão **App do SwarmCast** do painel ou no menu do ícone da bandeja. Quando não tem nada novo, o SwarmCast avisa:

![A mensagem Atualização do SwarmCast: Você já tem a versão mais recente do SwarmCast (0.2.0), com 1 OK.](../../../../assets/guides/app/pt-br/update-latest.webp)

## Se a atualização falhar

A versão que você tem continua funcionando. O SwarmCast tenta baixar de novo algumas vezes sozinho. Se ainda assim falhar, confira a sua internet e clique em **Tentar de novo** mais tarde.

## Linux

- **AppImage:** se atualiza sozinho, como no Windows e no macOS.
- **.deb:** se o app não conseguir instalar a atualização sozinho, ele abre a página de download. Baixe o `.deb` novo e instale do mesmo jeito da primeira vez ([Instalar no Linux](/swarmcast/pt-br/install/linux/)). As configurações continuam.

## Instalação por script

Se você instalou com script, rode o mesmo script de novo (ou o de um zip de instalação novo). Ele atualiza o SwarmCast e mantém as suas configurações. Veja [Avançado: instalar com script](/swarmcast/pt-br/advanced/script-install/).

## Como o SwarmCast procura (privacidade)

Para procurar, o app baixa um arquivinho público (`latest.json`) das versões do SwarmCast no GitHub. Ele não manda nada sobre você nem sobre a sua live. O GitHub conta quantas vezes esse arquivo foi baixado, e é assim que este site consegue estimar quantos apps estão em uso. Mais em [Privacidade e números de uso](/swarmcast/pt-br/about/privacy/).
