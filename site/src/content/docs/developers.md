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
- [Chat](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/CHAT.md): settings, protocol, text safety, moderation, flood protection, GIFs and privacy.
- [Your page](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/BRANDING.md): the streamer's name, pictures, links, support button and Pix, and link previews.
- [Quality and upload budget](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/QUALITY.md): renditions, ffmpeg, player settings and the upload controller.
- [Desktop app](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DESKTOP.md): installers, the shell ↔ server protocol and updates.
- [Releasing (maintainer)](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/RELEASING.md): repository settings, releases, the updater signing key, this website and code signing.
- [Brand](https://github.com/Lucas-Angelo/swarmcast/blob/main/assets/brand/README.md): the Forest & Cream palette, design tokens, logo, icons and mascot.
- [Testing](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/TESTING.md): the test suites, how to run them and the bar every change must pass.
- [Design decisions](https://github.com/Lucas-Angelo/swarmcast/blob/main/docs/DECISIONS.md): why SwarmCast is built the way it is, with links to the details.
- [Contributing](https://github.com/Lucas-Angelo/swarmcast/blob/main/CONTRIBUTING.md): bug reports, questions, pull requests and the promises every change keeps.
- [Agent guide](https://github.com/Lucas-Angelo/swarmcast/blob/main/AGENTS.md): the rules and commands that coding agents (and people) follow in the repository.
- [Security policy](https://github.com/Lucas-Angelo/swarmcast/blob/main/SECURITY.md): how to report a vulnerability.

## This website

The site is built with [Astro Starlight](https://starlight.astro.build/) from the [`site/` folder](https://github.com/Lucas-Angelo/swarmcast/tree/main/site). Every page exists in English (`site/src/content/docs/`) and Brazilian Portuguese (`site/src/content/docs/pt-br/`). The offline guide inside the installer zips is generated from the same pages by `scripts/build/guide-html.mjs`, so there is only one place to edit.

Found a mistake on a page? Use the **Edit page** link at the bottom of it.
