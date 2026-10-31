<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark/swarmcast-lockup-dark.svg">
    <img src="assets/brand/wordmark/swarmcast-lockup-light.svg" alt="SwarmCast" width="320">
  </picture>
</h1>

Stream a members-only live straight from your own computer, through a secret link. Your members watch in any browser, with no app and no account, and help each other through optional P2P. They can talk in a built-in chat that you moderate, and the stream page carries your name, picture, links and a support button (a link or Pix). Free, private (no telemetry) and open source, for Windows, macOS and Linux, in English and Brazilian Portuguese.

**Guide, download and help: <https://lucas-angelo.github.io/swarmcast/>** (em português: <https://lucas-angelo.github.io/swarmcast/pt-br/>)

![The SwarmCast panel during a live: status and OBS at the top, the live link (hidden here), the live chat on the right, and the viewers list with device and P2P.](docs/img/panel-overview-en.png)

## Download

Get the SwarmCast app for your system from the [download page](https://lucas-angelo.github.io/swarmcast/download/) (or the [latest release](https://github.com/Lucas-Angelo/swarmcast/releases/latest)), then follow the install guide for [Windows](https://lucas-angelo.github.io/swarmcast/install/windows/), [macOS](https://lucas-angelo.github.io/swarmcast/install/macos/) or [Linux](https://lucas-angelo.github.io/swarmcast/install/linux/). The app updates itself. Got a link from a streamer? See [For viewers](https://lucas-angelo.github.io/swarmcast/viewers/).

## For developers

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): build, test, configuration, version policy and the website.
- [docs/](docs/README.md): architecture, threat model, security research, the [chat](docs/CHAT.md), the [streamer's page](docs/BRANDING.md), quality, the desktop app and the [release guide](docs/RELEASING.md).
- [CONTRIBUTING.md](CONTRIBUTING.md): bug reports, questions, pull requests and the [Code of Conduct](CODE_OF_CONDUCT.md).
- [AGENTS.md](AGENTS.md): the rules, commands and safety limits for coding agents (and the people who work with them).
- [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md) (reporting a vulnerability).

## License

[MIT](LICENSE). Bundled third-party software (MediaMTX: MIT, cloudflared: Apache-2.0, Node.js and npm dependencies) is listed in `THIRD_PARTY_LICENSES.txt` inside each release package. The Fredoka font is under the SIL Open Font License ([assets/brand/font/OFL.txt](assets/brand/font/OFL.txt)).
