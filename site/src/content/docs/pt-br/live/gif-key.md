---
title: Como conseguir uma chave de GIFs
description: Os GIFs do chat vêm desligados. Pegue a sua chave grátis do KLIPY, ligue os GIFs e saiba o que o navegador de quem assiste compartilha com o KLIPY.
---

Os GIFs do chat vêm **desligados por padrão**. Para ligar, você precisa da sua própria chave grátis do **KLIPY**, o serviço de GIFs que o SwarmCast usa. O SwarmCast não tem chave compartilhada: cada pessoa que transmite usa a sua.

:::caution[O que muda ao ligar os GIFs]
O navegador de quem assiste acessa o KLIPY para buscar e mostrar GIFs. O KLIPY vê o endereço IP dessas pessoas (localização aproximada) e pode registrar o que elas buscam. Nada passa pelo seu computador. O seu computador só acessa o KLIPY se você mesmo buscar GIFs no painel.
:::

## 1. Crie a chave

1. Abra o KLIPY Partner Panel, <https://partner.klipy.com/>, e crie uma conta grátis.
2. Vá em **API Keys** e crie a sua plataforma (o seu app, por exemplo "Minha live").
3. Copie a **API key** que aparece.

Uma chave nova começa em **modo de teste**, limitada a 100 consultas por hora. As buscas de todo mundo que assiste contam na sua chave, então, quando os GIFs estiverem funcionando, peça o **acesso de produção** no mesmo Partner Panel (é grátis) para tirar o limite.

:::note
O site do KLIPY é em inglês e pode estar diferente destes passos; procure por "API Keys" no Partner Panel. A chave não é segredo: o navegador de quem assiste usa ela para buscar GIFs, é assim que o KLIPY funciona.
:::

## 2. Ligue os GIFs no painel

1. No cartão **Chat**, abra **Configurações do chat**.
2. Marque **Permitir GIFs do KLIPY** e cole a chave em **Sua chave de API**.
3. Escolha um **Filtro de conteúdo**: **Rígido (livre para todos)**, **Moderado** (o padrão) ou **Leve (adolescentes e adultos)**. O Partner Panel do KLIPY também deixa bloquear palavras de busca.
4. Deixe **Espectadores precisam permitir GIFs** ligado (recomendado).
5. Confira se **GIFs** está marcado em **O que dá para mandar** e clique em **Salvar configurações do chat**.

## O que quem assiste vê

- Um GIF no chat aparece primeiro como um aviso. A pessoa toca em **Carregar GIFs** uma vez antes de o navegador dela acessar o KLIPY; a escolha fica lembrada naquele navegador.
- Quem nunca aceitar nunca acessa o KLIPY: a página só conversa com a sua live, como sem GIFs.
- Um GIF por pessoa a cada 30 segundos.
- Enquanto o chat está protegido contra flood, ou o seu computador está ocupado, os GIFs pausam sozinhos.

No painel, os GIFs que o pessoal manda aparecem como a palavra "GIF" e não são carregados, então o seu computador não acessa o KLIPY por causa deles.

## Desligar os GIFs

Desmarque **Permitir GIFs do KLIPY** (ou **GIFs** em **O que dá para mandar**) e salve. A partir daí, a página de quem assiste não acessa nenhum serviço de fora para GIFs. Mais sobre o chat em [Chat](/swarmcast/pt-br/live/chat/).
