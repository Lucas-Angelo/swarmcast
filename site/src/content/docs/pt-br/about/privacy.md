---
title: Privacidade e números de uso
description: O SwarmCast não tem telemetria. Como os números da página inicial são contados a partir dos contadores públicos de download do GitHub.
---

## O SwarmCast não manda nada para casa

- O app **não tem telemetria, nem estatísticas de uso, nem relatório de erros automático**. Ele nunca manda para o projeto SwarmCast nada sobre você, o seu computador, a sua live ou quem assiste.
- A sua chave de transmissão, os seus links e os apelidos e IPs de quem assiste ficam no seu computador, na memória ou na pasta de configurações.
- A página de quem assiste não tem anúncios, rastreadores nem estatísticas.
- Este site **não tem rastreadores nem cookies** e não carrega fontes nem scripts de outras empresas. Ele só guarda no seu próprio navegador (armazenamento local) o idioma e o tema claro/escuro que você escolheu.

Com quem o app fala, e por quê:

- **Cloudflare:** o túnel gratuito (modo seguro), o teste de velocidade, uma checagem rápida do atraso da sua conexão durante a live e descobrir o seu IP público (no modo direto, e durante a live no modo seguro, para o P2P ficar desligado para quem assiste na sua própria conexão; ele nunca vai para os logs). Os navegadores de quem assiste também usam um servidor da Cloudflare para se encontrarem no P2P.
- **GitHub:** procurar atualizações (um arquivinho público) e baixar as atualizações.
- **Quem publica o ffmpeg:** baixar o conversor de vídeo, na primeira vez.
- **Listas públicas de bloqueio** (Spamhaus, FireHOL): baixadas uma vez por dia, sem conta.
- **Let's Encrypt:** só no modo direto, para o certificado HTTPS.

## Como os números da página inicial são contados

Sem telemetria, não dá para saber exatamente quantas pessoas usam o SwarmCast. A página inicial mostra dois números aproximados, baseados só em **contadores públicos que o GitHub mantém para cada arquivo de uma versão**. Qualquer pessoa pode conferir.

### Downloads

A soma dos contadores de download dos instaladores (Windows, macOS e Linux) e dos pacotes da instalação por script, em todas as versões. Ela também conta:

- a mesma pessoa baixando duas vezes;
- as atualizações que o app baixa sozinho no Windows e no Linux (AppImage).

Por isso é "cerca de N downloads", e não "N pessoas".

### SwarmCast abertos nesta semana

Quando o app abre, e depois a cada 6 horas enquanto continua aberto, ele baixa um arquivinho público da versão mais recente (`latest.json`) para procurar atualizações. O GitHub conta cada um desses downloads. Nada mais é enviado.

Uma vez por dia, uma tarefa no GitHub guarda esses contadores (um por versão, porque cada versão nova começa o seu contador do zero) e calcula:

1. **Buscas por atualização na semana** = quanto os contadores do `latest.json` cresceram nos últimos 7 dias, somando todas as versões (enquanto não temos 7 dias de histórico, o crescimento até agora é projetado para 7 dias).
2. **SwarmCast abertos na semana ≈ buscas por atualização ÷ 3.**

Por que 3: um app faz **uma busca cada vez que abre**, e mais uma a cada 6 horas que fica aberto. Quem abre o SwarmCast para duas ou três lives por semana, cada uma com menos de 6 horas, faz umas 3 buscas por semana. O número real de apps fica entre "buscas ÷ 14" (um app aberto a semana inteira) e "buscas" (um app aberto uma vez só). Clicar em **Procurar atualizações** também conta como busca.

O número é arredondado **para baixo** ("cerca de 120" vale para qualquer coisa de 120 a 129) e fica escondido até ter dados suficientes.

O código que calcula os dois números é público: [`scripts/stats/stats.mjs`](https://github.com/Lucas-Angelo/swarmcast/blob/main/scripts/stats/stats.mjs).
