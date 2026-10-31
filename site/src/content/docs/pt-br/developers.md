---
title: Para desenvolvedores
description: Onde encontrar a documentação técnica, o código-fonte e como contribuir com o SwarmCast.
---

Este site é para quem faz live e para quem assiste. A documentação técnica fica junto com o código no GitHub (em inglês):

- [Repositório e README](https://github.com/Lucas-Angelo/swarmcast): o que é o SwarmCast e como compilar.
- [Guia de desenvolvimento](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DEVELOPMENT.md): compilar, testes, configuração (`config.json`), política de versões e lançamentos.
- [Arquitetura](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/ARCHITECTURE.md): como funciona, decisões de projeto e fatos verificados com fontes.
- [Modelo de ameaças](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/THREAT_MODEL.md): o que proteger, quem ataca, defesas e riscos aceitos.
- [Pesquisa de segurança](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/SECURITY_RESEARCH.md): detecção de ataques e proteções, com fontes.
- [Chat](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/CHAT.md): configurações, protocolo, segurança dos textos, moderação, proteção contra flood, GIFs e privacidade.
- [Sua página](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/BRANDING.md): o nome, as fotos, os links, o botão de apoio e o Pix de quem faz a live, e as prévias de link.
- [Qualidade e upload](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/QUALITY.md): qualidades, ffmpeg, configurações do player e o controle de upload.
- [App](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DESKTOP.md): instaladores, o protocolo entre o app e o servidor e as atualizações.
- [Lançamentos (mantenedor)](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/RELEASING.md): configurações do repositório, lançamentos, a chave de assinatura das atualizações, este site e a assinatura de código.
- [Marca](https://github.com/Lucas-Angelo/swarmcast/blob/main/assets/brand/README.md): a paleta Forest & Cream, os tokens de design, o logo, os ícones e o mascote.
- [Testes](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/TESTING.md): os conjuntos de testes, como rodar cada um e o padrão que toda mudança precisa cumprir.
- [Decisões de projeto](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DECISIONS.md): por que o SwarmCast é feito do jeito que é, com links para os detalhes.
- [Como contribuir](https://github.com/Lucas-Angelo/swarmcast/blob/main/CONTRIBUTING.md): relatar problemas, tirar dúvidas, pull requests e as promessas que toda mudança mantém.
- [Guia para agentes](https://github.com/Lucas-Angelo/swarmcast/blob/main/AGENTS.md): as regras e os comandos que agentes de programação (e pessoas) seguem no repositório.
- [Política de segurança](https://github.com/Lucas-Angelo/swarmcast/blob/main/SECURITY.md): como avisar sobre uma vulnerabilidade.

## Este site

O site é feito com o [Astro Starlight](https://starlight.astro.build/), na [pasta `site/`](https://github.com/Lucas-Angelo/swarmcast/tree/main/site). Cada página existe em inglês (`site/src/content/docs/`) e em português do Brasil (`site/src/content/docs/pt-br/`). O guia offline que vai dentro dos zips de instalação é gerado a partir dessas mesmas páginas por `scripts/build/guide-html.mjs`, então só existe um lugar para editar.

Achou um erro numa página? Use o link **Editar página** no fim dela.
