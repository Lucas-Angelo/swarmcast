# Contributing to SwarmCast

Thanks for helping. SwarmCast is made for streamers who are not technical, so clear bug reports and
small, tested changes help as much as big features.

## Where things go

| You want to… | Go to |
|---|---|
| Report something that does not work | [New issue → Bug report](https://github.com/Lucas-Angelo/swarmcast/issues/new/choose). Attach the logs ZIP from **Problem report → Export logs**. |
| Ask a question or get help | [Discussions → Q&A](https://github.com/Lucas-Angelo/swarmcast/discussions/categories/q-a), and the [troubleshooting guide](https://lucas-angelo.github.io/swarmcast/help/troubleshooting/) |
| Share an idea that is still rough | [Discussions → Ideas](https://github.com/Lucas-Angelo/swarmcast/discussions/categories/ideas) |
| Ask for a well-defined feature | [New issue → Feature request](https://github.com/Lucas-Angelo/swarmcast/issues/new/choose) |
| Give feedback on a beta version (from 0.3.0) | Discussions → Beta feedback |
| Report a security problem | **Privately**, as described in [SECURITY.md](SECURITY.md). Never in a public issue. |
| Change code, docs or the website | A pull request (below). For anything bigger than a small fix, open an issue or a discussion first, so we agree on the idea before you spend time on it. |

**Never post a stream key, a live link, a panel address or a password**, not in issues, discussions,
pull requests, logs or screenshots. The exported logs ZIP already leaves them out.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules for changes

SwarmCast keeps a few promises to its users. A change that breaks one of them will not be merged:

- **Free, no accounts.** Nothing may need a paid service or a sign-up, for streamers or viewers.
- **No telemetry.** The app never reports to us. Usage numbers come only from GitHub's public download
  counters.
- **Private by default.** Members-only links, the stream key and viewers' data stay protected
  ([docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)).
- **Made for lay users.** Installers and scripts never ask questions. Every text in the panel, the viewer
  pages, the desktop app and the website is in **English and Brazilian Portuguese** (with tooltips in the
  panel). The strings are in `packages/shared/src/i18n/`.

## Set up and test

Setup, build and test commands are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Before opening a pull
request, run what your change touches:

```sh
npm run lint && npm run typecheck
npm test                  # unit
npm run test:integration  # needs ffmpeg
npm run test:e2e          # Playwright
```

- Desktop app (in `apps/desktop/src-tauri`): `cargo fmt --check`,
  `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`.
- Website (`site/`): `npm run build` and `npm run check` inside `site/`.
- Fix bugs at the cause and add a test that fails without the fix. Do not hide flaky tests behind
  retries or longer timeouts.

CI runs everything on Windows, macOS and Linux for every pull request.

## Branches and pull requests

The project uses trunk-based GitHub Flow ([docs/RELEASING.md](docs/RELEASING.md#2-branches-pull-requests-and-protection)):

- Branch from `main` with a short-lived branch (`feat/…`, `fix/…`, `docs/…`, `ci/…`, `chore/…`).
- Keep one topic per pull request. Your branch can have many commits.
- Pull requests are **squash-merged**: the pull request title becomes the single commit on `main`, and
  the branch is deleted after the merge.
- The required check `ci-ok` must be green, and review threads must be resolved.

### Pull request titles

The title is the commit message on `main`, so it follows
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
type(scope): short summary in plain English
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`,
  `deps`.
- **Scopes** (optional): `server`, `viewer`, `panel`, `desktop`, `tray`, `scripts`, `site`, `shared`,
  `release`, `deps`, or another short area name.
- Add `!` after the type or scope for a breaking change: `feat(server)!: …`.
- Keep it within 72 characters.
- Examples: `fix(desktop): keep the window size after an update`,
  `docs(site): explain the Windows SmartScreen warning`.
- **Release pull requests** are the one exception: they are titled `SwarmCast vX.Y.Z`.

### Changelog

If users will notice the change, add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
Write it for streamers and viewers: what changes for them, not how the code changed. It becomes the
release notes and the text in the desktop app's update dialog. Changes users will not notice (tests, CI,
refactors) get the `skip-changelog` label instead.

### Tools and AI assistants

You may use any tools, including AI assistants. You are responsible for every line you submit: read it,
understand it and test it. Do not open large unreviewed or generated pull requests. Do not add tool
attribution lines (such as "Generated with …" or tool co-author trailers) to commits or pull requests.

## Releases

Only the maintainer tags releases. How it works: [docs/RELEASING.md](docs/RELEASING.md).

## License

SwarmCast is under the [MIT License](LICENSE). By contributing, you agree that your contribution is
published under the same license. There is no separate agreement to sign.
