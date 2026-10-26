---
title: Modo direto (só em emergência)
description: O que é o modo direto, por que ele mostra o seu IP para quem assiste e como voltar para o modo seguro.
---

Normalmente o SwarmCast usa o **modo seguro**: os espectadores se conectam por um túnel criptografado e nunca veem o seu IP. Só que o túnel gratuito não tem garantia de funcionamento. Se a live continuar travando para **todo mundo**, o modo direto é o último recurso.

:::danger[O modo direto mostra o seu endereço IP]
No modo direto, os espectadores se conectam **direto no seu computador**, então **todo mundo que tem o link consegue ver o seu IP de internet**. Isso revela a sua região aproximada e abre espaço para ataques que derrubam a sua internet (DDoS). Use só com gente de confiança e só quando o túnel continuar falhando.
:::

## Ligar

1. No cartão **Modo de conexão**, clique em **Usar o modo direto…**.
2. O SwarmCast confere o seu roteador e a sua conexão e explica o que encontrou. Algumas operadoras não permitem conexões diretas (CGNAT). Aí o modo direto não funciona.
3. Leia o aviso, marque **Entendo os riscos** e clique em **Ligar o modo direto**.
4. Todo mundo é desconectado e você recebe um **link novo**. Mande de novo.

No Windows, na primeira vez, o Windows pode perguntar se o SwarmCast pode usar as redes: clique em **Permitir** (redes privadas). Senão, ninguém consegue se conectar.

Enquanto o modo direto estiver ligado, o painel mostra uma faixa de aviso e quantas pessoas viram o link nesse modo.

## O SwarmCast protege você enquanto ele está ligado

Nos primeiros sinais de ataque, o SwarmCast volta sozinho para o modo seguro (com um link novo). Se isso falhar, ele desliga tudo. As duas coisas vêm ligadas no cartão **Proteção**.

## Voltar para o modo seguro

Clique em **Voltar ao modo seguro**. O SwarmCast fecha a porta do roteador, reabre o túnel e cria um link novo. Todo mundo é desconectado: mande o link novo de novo.

## Depois: tentar trocar de IP

O seu IP pode continuar o mesmo depois que você sai do modo direto. Para tentar pegar outro, desligue o modem ou o roteador da tomada por alguns minutos. Não é garantido. Na próxima vez que você usar o modo direto, o painel avisa se o seu IP mudou.
