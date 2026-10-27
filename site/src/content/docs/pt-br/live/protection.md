---
title: Segurança e proteção
description: Como o SwarmCast protege o seu computador e a sua live - o link secreto, a verificação do navegador, os limites de entrada e as listas públicas de bloqueio.
---

O SwarmCast foi feito para o seu computador nunca ficar aberto para a internet no **modo seguro**, que é o normal.

## O que protege você o tempo todo

- **O seu IP fica escondido.** Os espectadores chegam na sua live por um túnel criptografado (Cloudflare). Nada no seu computador aceita conexões vindas da internet.
- **O painel é só seu.** Ele só abre no seu próprio computador. Ninguém mais chega nele, nem quem tem o link da live.
- **Um link secreto novo a cada live.** Ele é comprido e aleatório, ninguém consegue adivinhar. O antigo para de funcionar.
- **A sua chave de transmissão não sai do seu computador.** Ela nunca é enviada para lugar nenhum e nunca aparece nos logs.
- **Vídeo conferido.** Cada pedaço que os espectadores passam entre si é conferido com uma impressão digital assinada (veja [Ajudar a transmissão](/swarmcast/pt-br/live/p2p/)).
- **Tudo desligado no fim.** **Desligar tudo** desconecta os espectadores, fecha o túnel, apaga o vídeo temporário e depois confere se nada ficou rodando ou acessível.

## O cartão Proteção

![O cartão Proteção: 1 o estado, Normal, 2 a verificação do navegador de quem entra (ligada por padrão), 3 Bloquear IPs maliciosos conhecidos (listas públicas), e as reações automáticas a um ataque.](../../../../assets/guides/live/pt-br/protection-card.webp)

O SwarmCast acompanha o tráfego da sua live e compara com o que o seu público costuma gerar. O cartão mostra o estado: **Normal**, **Atividade incomum** ou **Sob ataque**, e o motivo.

O que ele faz sozinho (dá para mudar cada item):

- **Verificação do navegador (um captcha sem quebra-cabeça), ligada por padrão:** o navegador de quem entra resolve um pequeno desafio automático, cerca de 1–2 segundos no celular, enquanto a pessoa digita o apelido. Nada para clicar, e nenhum serviço de fora participa. Isso deixa as entradas falsas em massa lentas e caras.
  - Dentro de uma mesma live (links novos, abas novas, recarregar a página) um navegador que já passou não é verificado de novo. **Gerar novo link** e **Desconectar todo mundo** não apagam isso, e quem você expulsou continua bloqueado.
  - Com o túnel rápido gratuito da Cloudflare cada live tem um endereço novo, então os espectadores fazem a verificação de ~1 s uma vez por live. Com um endereço fixo (modo Direto ou o seu próprio domínio) o navegador é lembrado por 30 dias.
  - Durante um ataque a verificação fica mais forte e os navegadores são verificados de novo.
  - Desligue no cartão só se o celular ou navegador muito antigo de algum espectador não conseguir terminar. Ela ainda liga sozinha quando algo parece errado.
- **Limites de entrada mais rígidos durante um ataque:** menos tentativas de entrada por endereço de internet, uma sessão por navegador e o limite de espectadores segurado perto do público atual. Ninguém que já está assistindo cai.
- **Listas públicas de bloqueio:** o SwarmCast recusa visitas de redes que estão em listas públicas e gratuitas de redes maliciosas conhecidas (Spamhaus DROP e FireHOL level1). As listas são baixadas uma vez por dia, sem conta nenhuma. Conexões normais de casa e de celular quase nunca estão nelas, e você pode desligar as listas no cartão.
- **Link novo durante um ataque** (desligado por padrão): o link antigo para de funcionar e você precisa mandar o novo.
- **Desligar tudo se um ataque for detectado** (desligado por padrão): quase nunca é preciso, porque o túnel aguenta grandes enxurradas de tráfego.

Quando passar (ou se foi alarme falso), clique em **Encerrar alerta**: os limites voltam na hora para as suas configurações.

## O que o SwarmCast não consegue fazer

Ser honesto sobre os limites ajuda você a decidir:

- **Quem tem o link consegue assistir,** e um membro pode repassar o link. Troque o link se ele vazar.
- **Nada impede alguém de gravar a tela.** Não existe proteção contra cópia.
- **Quem está com P2P ligado vê o IP dos outros** (só a localização aproximada). Veja [Ajudar a transmissão](/swarmcast/pt-br/live/p2p/).
- **A Cloudflare está no caminho.** O túnel gratuito é da Cloudflare, que consegue ver informações do tráfego. Ele não tem garantia de funcionamento e aguenta umas **120 pessoas assistindo ao mesmo tempo**; passando disso, quem chega não consegue entrar. O SwarmCast para de aceitar entradas em 120 por padrão (dá para mudar no painel) e avisa quando o túnel chega perto do limite.
- **O modo direto mostra o seu IP** para todo mundo que tem o link. Use só em emergência: [Modo direto](/swarmcast/pt-br/live/direct-mode/).
- **A detecção de ataques faz o melhor possível.** Um ataque muito lento ou muito espalhado pode passar abaixo dos alarmes.

Detalhes técnicos para quem tem curiosidade: [modelo de ameaças](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/THREAT_MODEL.md) (em inglês).
