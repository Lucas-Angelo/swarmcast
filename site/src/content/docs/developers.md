---
title: For developers
description: Where to find SwarmCast's technical documentation, source code and contribution information.
---

This site is for streamers and viewers. The technical documentation lives with the source code on GitHub (in English):

- [Repository and README](https://github.com/Lucas-Angelo/swarmcast): what SwarmCast is and how to build it.
- [Development guide](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DEVELOPMENT.md): building, tests, configuration (`config.json`), version policy and releases.
- [Architecture](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/ARCHITECTURE.md): how it works, design choices and verified facts with sources.
- [Threat model](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/THREAT_MODEL.md): assets, attackers, mitigations and accepted risks.
- [Security research](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/SECURITY_RESEARCH.md): attack detection and protections, with sources.
- [Quality and upload budget](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/QUALITY.md): renditions, ffmpeg, player settings and the upload controller.
- [Desktop app](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DESKTOP.md): installers, the shell ↔ server protocol and updates.
- [Releasing (maintainer)](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/RELEASING.md): repository settings, releases, the updater signing key, this website and code signing.
- [Brand](https://github.com/Lucas-Angelo/swarmcast/blob/main/assets/brand/README.md): the Forest & Cream palette, design tokens, logo, icons and mascot.
- [Security policy](https://github.com/Lucas-Angelo/swarmcast/blob/main/SECURITY.md): how to report a vulnerability.

## This website

The site is built with [Astro Starlight](https://starlight.astro.build/) from the [`site/` folder](https://github.com/Lucas-Angelo/swarmcast/tree/main/site). Every page exists in English (`site/src/content/docs/`) and Brazilian Portuguese (`site/src/content/docs/pt-br/`). The offline guide inside the installer zips is generated from the same pages by `scripts/build/guide-html.mjs`, so there is only one place to edit.

Found a mistake on a page? Use the **Edit page** link at the bottom of it.
