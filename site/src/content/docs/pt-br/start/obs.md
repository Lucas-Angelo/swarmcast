---
title: Configurar o OBS
description: Ligue o OBS Studio ao SwarmCast uma vez só, com ou sem outra plataforma (Twitch, YouTube, Kick) ao mesmo tempo.
---

Você faz isso **uma vez só**. O SwarmCast funciona com o [OBS Studio](https://obsproject.com/) (gratuito). O que você já usa para outras plataformas continua do mesmo jeito.

Você vai precisar de duas coisas do painel do SwarmCast, no cartão **Configuração do OBS**. Cada uma tem um botão **Copiar**:

- **Servidor:** `rtmp://127.0.0.1:1935/live`
- **Chave de transmissão:** um código secreto comprido. **Nunca mostre ela na live.** Quem tiver a sua chave consegue mandar vídeo para o seu SwarmCast.

## Passo 1 (sempre): intervalo de quadro-chave de 2 segundos

1. No OBS, abra **Configurações** → **Saída**.
2. **Modo de saída:** escolha **Avançado**.
3. Fique na aba **Transmissão**.
4. **Intervalo de quadro-chave:** coloque **2 s** e clique em **OK**.

![Configurações do OBS, página Saída: 1 Saída, 2 Modo de saída Avançado, 3 aba Transmissão, 4 Intervalo de quadro-chave 2 s. Imagem do OBS em inglês.](../../../../../../apps/admin/src/onboarding/img/obs-output.png)

Por quê: quem assiste recebe o vídeo em pedaços que começam em cada quadro-chave. A Twitch, o YouTube e a Kick também recomendam 2 s. O modo "Simples" faz pedaços de uns 8 segundos: mais atraso e mais travadas.

## Passo 2: escolha como você transmite

### A. Outra plataforma e SwarmCast ao mesmo tempo (recomendado)

Sozinho, o OBS só manda para um lugar. O plugin gratuito **Multiple RTMP outputs** (obs-multi-rtmp) cria uma segunda saída. A sua configuração da Twitch, do YouTube ou da Kick continua igual.

1. Feche o OBS. Baixe e instale o plugin pela [página oficial no fórum do OBS](https://obsproject.com/forum/resources/multiple-rtmp-outputs-plugin.964/) ou pelos [releases no GitHub](https://github.com/sorayuki/obs-multi-rtmp/releases). No Windows é um instalador `.exe`; no Mac, um `.pkg`.
2. Abra o OBS. Vai aparecer um painel novo chamado **Multiple output**. Se ele não aparecer, abra o menu **Painéis** (Docks) e marque **Multiple output**.

   ![Menu Painéis (Docks) do OBS: 1 Docks, 2 Multiple output.](../../../../../../apps/admin/src/onboarding/img/obs-docks-menu.png)

3. Nesse painel, clique em **Add new target** e preencha:
   - **Name (nome):** `SwarmCast` (qualquer nome serve).
   - **URL (servidor):** o servidor do painel do SwarmCast.
   - **Stream key (chave):** a chave do painel do SwarmCast.
   - **Encoder:** escolha **usar o mesmo encoder da transmissão** (ele compartilha o encoder da sua live principal, então o PC não codifica o vídeo duas vezes). O texto exato pode mudar um pouco conforme a versão do plugin.
   - Opcional: marque **Sync start** e **Sync stop** para ele começar e parar junto com a sua live principal.
   - Clique em **OK**.

   ![Janela de destino do plugin: 1 Nome, 2 URL, 3 Chave de transmissão, 4 Encoder, 5 Sync start/stop, 6 OK.](../../../../../../apps/admin/src/onboarding/img/obs-target.png)

4. **Não mexa** em Configurações → Transmissão: ali continua a sua outra plataforma.

Na hora da live, clique em **Iniciar transmissão** no OBS, como sempre, e no painel **Multiple output** clique em **Start** ao lado do SwarmCast (não precisa se marcou "Sync start").

![Painel Multiple output: 1 Add new target, 2 Start ao lado do SwarmCast.](../../../../../../apps/admin/src/onboarding/img/obs-multi-dock.png)

### B. Só no SwarmCast

1. No OBS, abra **Configurações** → **Transmissão**.
2. **Serviço:** escolha **Personalizado...**.
3. **Servidor:** cole o servidor do painel do SwarmCast.
4. **Chave de transmissão:** cole a chave e clique em **OK**.

![Configurações do OBS, página Transmissão: 1 Transmissão, 2 Serviço Personalizado, 3 Servidor, 4 Chave de transmissão. Imagem do OBS em inglês.](../../../../../../apps/admin/src/onboarding/img/obs-stream-custom.png)

Para voltar a transmitir em outra plataforma depois, escolha ela em **Configurações → Transmissão**.

## Conferir se funcionou

Comece a transmitir no OBS. Em poucos segundos o topo do painel do SwarmCast mostra **OBS: enviando**. Se não mostrar, veja [Problemas e dúvidas](/swarmcast/pt-br/help/troubleshooting/#o-obs-não-conecta).

:::tip[Encoder da placa de vídeo]
No OBS, em **Configurações → Saída → Codificador de vídeo**, prefira um encoder da placa de vídeo (NVIDIA NVENC, AMD, Intel QuickSync ou Apple VT) em vez do x264. Assim o processador fica livre para o seu jogo e para o SwarmCast.
:::

Próximo passo: [Fazer a live e mandar o link](/swarmcast/pt-br/live/go-live/).
