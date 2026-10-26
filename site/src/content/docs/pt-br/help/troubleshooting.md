---
title: Problemas e dúvidas
description: Respostas para os problemas mais comuns na instalação, no OBS, com o link e na live, e as dúvidas frequentes.
---

## Instalar e abrir

### Windows: "O Windows protegeu o computador"

Clique em **Mais informações** e depois em **Executar assim mesmo**. Veja [Instalar no Windows](/swarmcast/pt-br/install/windows/).

### macOS: "A Apple não pôde verificar o SwarmCast" ou "não pode ser aberto"

Abra **Ajustes do Sistema** → **Privacidade e Segurança**, role para baixo e clique em **Abrir Mesmo Assim**. Veja [Instalar no macOS](/swarmcast/pt-br/install/macos/).

### "O SwarmCast já está aberto em outra janela ou num terminal"

Já tem outro SwarmCast rodando, por exemplo um que você abriu por script. Feche ele (no terminal: **Ctrl+C**; ou no ícone da bandeja → **Sair**) e clique em **Tentar de novo**.

### "Outro programa está usando as portas de que o SwarmCast precisa"

Outro app de transmissão, ou um segundo SwarmCast, está usando a porta 1935 (a que o OBS usa para mandar o vídeo) ou a porta do painel. Feche esse programa e clique em **Tentar de novo**. Reiniciar o computador também resolve.

### "O SwarmCast não conseguiu abrir"

Clique em **Tentar de novo**. Se continuar falhando, clique em **Abrir pasta de logs** e mande o arquivo mais recente quando for pedir ajuda (veja o fim desta página).

## OBS

### O OBS não conecta

- Confira se o SwarmCast está aberto e se o topo do painel diz **Esperando o OBS começar a transmitir…** ou **Ao vivo**. Se disser **Desligado**, clique em **Ligar o SwarmCast**.
- O servidor tem que ser exatamente `rtmp://127.0.0.1:1935/live`.
- A chave tem que ser a do painel. Use os botões **Copiar** em vez de digitar.
- Com o plugin Multiple output, clique em **Start** ao lado do SwarmCast.

### "O intervalo de quadros-chave parece errado"

No OBS: **Configurações** → **Saída** → **Modo de saída: Avançado** → **Transmissão** → **Intervalo de quadro-chave: 2 s**. Veja [Configurar o OBS](/swarmcast/pt-br/start/obs/).

## O link e os espectadores

### Os espectadores veem "Link inválido"

Eles estão com um link antigo. Cada live tem um link novo, e **Gerar novo link** troca o link. Mande o link atual, que está no painel.

### Os espectadores veem que a live está lotada

Você chegou no **Máximo de espectadores ao mesmo tempo**. Aumente no painel se o seu upload aguentar.

### O vídeo começa sem som

Os navegadores começam os vídeos sem som. Quem assiste clica uma vez em **Ativar som**.

### Trava para um espectador

Provavelmente a internet dele está lenta. O player desce de qualidade sozinho (**Auto**). Ele também pode escolher a reprodução **Estável**, que deixa mais vídeo guardado.

### Trava para todo mundo

1. Veja os avisos no topo do painel. **"Espectadores demais para o seu upload"**: peça para o pessoal deixar **Ajudar a transmissão (P2P)** ligado, ou diminua a taxa de bits (bitrate) do OBS.
2. Confira se nada mais está usando o seu upload (backup na nuvem, downloads, outra transmissão com bitrate alto).
3. Se o túnel gratuito continuar falhando, o [modo direto](/swarmcast/pt-br/live/direct-mode/) é o último recurso. Leia o aviso antes.

### "Possível ataque"

O cartão Proteção reage sozinho. Se o aviso disser que existe um link NOVO, mande o link novo. Quando passar, clique em **Encerrar alerta**. Veja [Segurança e proteção](/swarmcast/pt-br/live/protection/).

## Outros

### Só aparece a qualidade original

O seu computador pode não ter um chip de vídeo que converte, ou o conversor de vídeo (ffmpeg) não está instalado. Veja [Qualidades](/swarmcast/pt-br/live/quality/).

### Sem ícone na bandeja no Linux (GNOME)

Instale a extensão "AppIndicator and KStatusNotifierItem Support" ou use a janela do SwarmCast.

### Linux: "AppImages require FUSE to run"

Veja [Instalar no Linux](/swarmcast/pt-br/install/linux/).

## Dúvidas frequentes

### O SwarmCast é grátis?

Sim. Ele é gratuito e de código aberto (licença MIT). Não tem conta, assinatura nem anúncio.

### Ele substitui a Twitch, o YouTube ou a Kick?

Não. Ele serve para uma live **só para membros**, junto com a sua live pública ou sozinha. Dá para transmitir nos dois ao mesmo tempo ([Configurar o OBS](/swarmcast/pt-br/start/obs/)).

### Quantas pessoas conseguem assistir?

Depende do seu **upload** de internet e de quantos espectadores ajudam pelo P2P. O painel mostra uma estimativa. Mínimo: 10 Mbps de upload, 4 GB de memória e 2 núcleos de processador. Recomendado: 50 Mbps de upload ou mais, 8 GB e 4 núcleos.

### Dá para fazer a live pelo celular?

Não. O SwarmCast roda no computador onde o OBS roda (Windows, macOS ou Linux). Os espectadores podem assistir pelo celular.

### O SwarmCast coleta dados meus ou de quem assiste?

Não. O SwarmCast não tem telemetria nem estatísticas de uso. Veja [Privacidade e números de uso](/swarmcast/pt-br/about/privacy/).

### Dá para usar o Streamlabs ou outro programa em vez do OBS Studio?

O SwarmCast é testado com o OBS Studio. Qualquer programa que mande para um servidor RTMP personalizado, com chave de transmissão e quadro-chave de 2 segundos, deve funcionar, mas os guias mostram o OBS.

## Pedir ajuda

1. No cartão **Atividade** do painel, clique em **Copiar tudo**. Os segredos (chave de transmissão, link) já vêm escondidos.
2. Abra uma issue no [GitHub](https://github.com/Lucas-Angelo/swarmcast/issues) e cole o texto, dizendo o seu sistema (Windows, macOS ou Linux) e o que você fez. Pode escrever em português.
