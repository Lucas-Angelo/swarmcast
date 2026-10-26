---
title: Instalar no macOS
description: Instale o SwarmCast no Mac (chip Apple ou Intel) e libere com "Abrir Mesmo Assim" na primeira vez.
---

O SwarmCast precisa do macOS 13.5 (Ventura) ou mais novo.

## 1. Qual é o seu Mac?

Clique no menu Apple (a maçã no canto superior esquerdo da tela) → **Sobre Este Mac**.

- **Chip: Apple M1, M2, M3, M4…** → você precisa do arquivo para **chip Apple** (o nome termina em `aarch64.dmg`).
- **Processador: Intel…** → você precisa do arquivo para **chip Intel** (o nome termina em `x64.dmg`).

## 2. Baixar e instalar

1. Entre na [página de download](/swarmcast/pt-br/download/#macos) e baixe o arquivo `.dmg` certo.
2. Dê dois cliques no `.dmg` em **Downloads**. Uma janela abre.
3. Arraste o ícone do **SwarmCast** para a pasta **Aplicativos**.
4. Feche a janela. Na barra lateral do Finder, clique no botão de ejetar ao lado de **SwarmCast**.

## 3. Abrir pela primeira vez ("Abrir Mesmo Assim")

O macOS bloqueia apps que não são registrados na Apple (um programa pago). O SwarmCast é gratuito e de código aberto, então você libera uma vez:

1. Abra **Aplicativos** e dê dois cliques no **SwarmCast**.
2. Aparece uma mensagem dizendo que a Apple não pôde verificar o SwarmCast (ou "SwarmCast não foi aberto"). Clique em **OK**. Não clique em **Mover para o Lixo**.
3. Abra o menu Apple → **Ajustes do Sistema** → **Privacidade e Segurança**.
4. Role até **Segurança**. Ao lado de "O SwarmCast foi bloqueado…", clique em **Abrir Mesmo Assim**.
5. Confirme com a sua senha ou o Touch ID e clique em **Abrir Mesmo Assim** mais uma vez.

Pronto: daqui em diante o SwarmCast abre normalmente. O ícone dele também aparece na barra de menus, no topo da tela.

:::tip[É seguro?]
O aviso só quer dizer que o SwarmCast não é registrado na Apple. O código é público, e toda atualização que o app instala é conferida antes por uma assinatura digital.
:::

## 4. Primeira vez

A janela mostra **Abrindo o SwarmCast…** e depois um tutorial curto. Continue em [Primeira vez e tutorial](/swarmcast/pt-br/start/first-run/).

Se o macOS perguntar se o SwarmCast pode aceitar conexões de rede (isso pode acontecer quando você usa o [modo direto](/swarmcast/pt-br/live/direct-mode/)), clique em **Permitir**. No modo seguro, que é o normal, ninguém se conecta direto no seu Mac.

## Deu algum problema?

- **"O SwarmCast está danificado e não pode ser aberto":** primeiro apague o app e o `.dmg`, baixe de novo e repita os passos (o download pode ter sido cortado). Se continuar, abra o **Terminal** (Aplicativos → Utilitários), cole `xattr -dr com.apple.quarantine /Applications/SwarmCast.app`, aperte Enter e abra o SwarmCast de novo. Isso tira só do SwarmCast a marca de "baixado da internet".
- **Não aparece o botão "Abrir Mesmo Assim":** ele só aparece por mais ou menos uma hora depois que você tentou abrir o app. Dê dois cliques no SwarmCast de novo e volte em **Privacidade e Segurança**.
- Mais respostas: [Problemas e dúvidas](/swarmcast/pt-br/help/troubleshooting/).
