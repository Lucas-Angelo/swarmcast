# Releasing (maintainer)

How to set up the GitHub repository and ship a SwarmCast release. The repository
(`Lucas-Angelo/swarmcast`) is public, so release assets, the one-line installs and the desktop app's
update check all work straight from it.

Streamers never read this: their guide is the website, <https://lucas-angelo.github.io/swarmcast/>.

## 1. Repository settings (once)

**About and topics.** They are what people see in search results and link previews:

```sh
gh repo edit Lucas-Angelo/swarmcast \
  --description "Members-only live streaming from your own computer: a secret link, viewers watch in the browser, optional P2P. Windows, macOS, Linux." \
  --homepage "https://lucas-angelo.github.io/swarmcast/" \
  --add-topic live-streaming --add-topic streaming --add-topic obs --add-topic hls \
  --add-topic p2p --add-topic webrtc --add-topic self-hosted --add-topic privacy \
  --add-topic desktop-app --add-topic tauri --add-topic typescript
```

On the repository page, the gear next to **About** also has "Use your GitHub Pages website" (fills the
homepage link) and the Releases / Packages / Deployments toggles: keep **Releases** on.

**Security.** Under **Settings → Code security**, turn on **Private vulnerability reporting** (it is
how [SECURITY.md](../SECURITY.md) asks people to report), Dependabot alerts and secret scanning.

## 2. Branch protection

Protect `main` so every change goes through a pull request with green checks. In
**Settings → Branches → Add branch ruleset** (or the classic branch protection rule):

- target the default branch;
- require a pull request before merging (0 approvals is fine for a solo maintainer);
- require status checks to pass, and pick the CI checks from the list (GitHub only offers checks that
  have already run once, so open a pull request first). Require branches to be up to date;
- block force pushes and deletions.

With the classic rule, the same thing from the command line (replace the `contexts` with the check names
your pull requests show):

```sh
gh api -X PUT repos/Lucas-Angelo/swarmcast/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["<check name>", "<check name>"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

CI runs automatically on every pull request and push to `main` (standard runners are free on a public
repository), again on the 1st of every month (to catch dead third-party downloads or runner image
changes), and by hand from **Actions → (workflow) → Run workflow**; the **Re-run** button repeats a run.
A newer push to a pull request cancels its older runs; runs on `main` and tags are never cancelled.

| Workflow | What | Runs on |
|----------|------|---------|
| `ci.yml` | lint, typecheck, build, unit, integration and E2E tests, `npm audit`, tray helper | Windows, macOS, Ubuntu |
| `scripts.yml` | start and uninstall scripts against a fake release | Windows (PowerShell 5.1), macOS, Ubuntu |
| `preflight.yml` | clean-machine check of the real script-mode package (install, live, watch, P2P, tunnel) | Windows, macOS arm64 + Intel, Ubuntu 22.04 + latest |
| `windows.yml` | exhaustive Windows suites (installer, app in Chrome/Edge/Firefox, quality, direct mode, OBS) | Windows Server |
| `desktop.yml` | `cargo fmt`/`clippy`/`test`, desktop installers per target, clean-machine install/launch/autostart/update/uninstall tests | Windows, macOS arm64 + Intel, Ubuntu x64 + arm64 |
| `codeql.yml` | code scanning (TypeScript, Go, Rust, the workflows) | Ubuntu |
| `site.yml`, `stats.yml` | the website and the usage numbers (section 6) | Ubuntu |
| `release.yml` | on a `v*` tag: the suites above as a gate, then build, sign and publish (section 4) | all |

Changes that only touch `docs/`, `site/` or `.md` files do not rebuild the app (`scripts.yml` and
`site.yml` run for the pages they use). A required check that did not run keeps a pull request waiting,
so require only checks that always run for app changes, or merge such docs-only pull requests as an admin.
The usage-stats job writes only to its own `stats` branch (section 6), so the protection on `main` never
blocks it.

## 3. Secrets

Set them in **Settings → Secrets and variables → Actions → Repository secrets**.

### Updater signing key (required for every release)

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

The desktop app installs an update only when its signature matches the public key built into the app
(`plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`). The release workflow refuses to
start without these two secrets, because a release without signatures could never reach installed apps.

- **Where it lives:** the key pair was made with
  `npx tauri signer generate -w ~/.tauri/swarmcast-updater.key`. The private key is that file, its
  password is in `~/.tauri/swarmcast-updater.password` on the maintainer's computer (local builds with
  `node scripts/build/desktop.mjs` read both), and a copy of each is in the two secrets above. Only the
  public key is in the repository. Never commit the private key or paste it anywhere else.
- **Back it up** now, outside this computer: for example both files in a password manager, plus an
  encrypted offline copy. GitHub secrets cannot be read back, so they are not a backup.
- **If it is lost or leaked:** a new key pair means a new public key in `tauri.conf.json`, and every
  installed app keeps trusting only the old one. Those apps can never auto-update again: each user has to
  download and install the new version by hand once. A leaked key lets someone else sign "updates", so
  rotate it right away (and say so in the release notes) even though it costs that manual step.

To rotate on purpose: generate a new pair, put the new public key in `tauri.conf.json`, update both
secrets, release, and tell users in the notes and on the site that this one version must be installed by
hand.

### Code signing (optional, paid)

See section 7. Without those secrets the release is unsigned, which is the default.

## 4. Ship a release

1. **Changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` (or the prepared `## [X.Y.Z] - Unreleased`)
   to `## [X.Y.Z] - YYYY-MM-DD`, start a new empty `## [Unreleased]` above it, and update the link
   references at the bottom. The section must not be empty: it becomes the release notes and the
   desktop app's update dialog.
2. **Version.** Set the same version in every `package.json` and `apps/desktop/src-tauri/Cargo.toml`:
   ```sh
   npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root
   # then edit apps/desktop/src-tauri/Cargo.toml (version = "X.Y.Z") and run cargo check to update Cargo.lock
   ```
   The root `package.json` is the one that counts: the tag must match it, and the build stamps it into the
   server, the packages and the desktop app.
3. Open a pull request with both changes, wait for CI, merge it.
4. **Tag** the merge commit on `main` and push the tag:
   ```sh
   git switch main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   A version with a hyphen (`v0.3.0-rc.1`) becomes a GitHub pre-release. Pre-releases are never offered
   to installed apps or the site's download button (both use `/releases/latest`), so they are safe for
   testing.
5. **Watch the release workflow** in the **Actions** tab. It runs by itself on the tag and:
   1. checks that the tag matches `package.json`, that `CHANGELOG.md` has a section for the version and
      that the updater signing secrets exist, and that no GitHub release exists yet for the tag (a published
      release is never changed);
   2. runs the full test suites (the same checks as pull requests, plus the install-script, pre-release,
      Windows and desktop-installer tests). If anything fails, nothing is published;
   3. builds and smoke-tests the server package on each platform, and signs the binaries when the
      code-signing secrets exist;
   4. builds the desktop installers and signs their update packages with the updater key;
   5. publishes the GitHub release, with the release notes taken from the `CHANGELOG.md` section.
6. **Check the result** (a few minutes after it finishes):
   - the release is marked **Latest** and has every asset listed below;
   - `https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json` shows the new
     version with an entry per platform;
   - an installed desktop app finds the update (tray → **Check for updates**);
   - the site's download button links the new files. Publishing the release starts the **Usage stats**
     job, which records the latest release's installers and rebuilds the site (section 6). If the button
     still shows the old version after that, run **Usage stats** by hand in the Actions tab.

**If the release workflow fails** before publishing, fix the problem on `main`, then move the tag:
`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, tag the fixed commit and push it again. Once
a release is **published**, never re-use its version: installed apps and the scripts may already have
it. Ship `X.Y.Z+1` instead.

## 5. What a release publishes

| Asset | For |
|-------|-----|
| `SwarmCast_<v>_x64-setup.exe` | Windows desktop installer (per user, no admin prompt) |
| `SwarmCast_<v>_aarch64.dmg`, `SwarmCast_<v>_x64.dmg` | macOS desktop app (Apple silicon, Intel) |
| `SwarmCast_<v>_amd64.deb`, `SwarmCast_<v>_arm64.deb`, `SwarmCast_<v>_*.AppImage` | Linux desktop app |
| `SwarmCast_<v>_<arch>.app.tar.gz` and a `.sig` next to every updatable file | Update packages and their signatures, used only by the app's updater |
| `latest.json` | The updater manifest: version, notes, one URL + signature per platform. The app reads it from `/releases/latest/download/latest.json` |
| `SwarmCast-v<v>-<target>.zip` / `.tar.gz` (`windows-x64`, `macos-arm64`, `macos-x64`, `linux-x64`, `linux-arm64`) | Script-mode packages, installed by the start scripts |
| `SwarmCast-v<v>-<target>-installer.zip` | Offline script install: start script + package + checksums + the HTML guide (EN and pt-BR) + uninstaller |
| `start-*` and `uninstall-*` scripts, `binaries.json` | One-line installs, uninstallers, and the ffmpeg pins the scripts download from its publisher |
| `SHA256SUMS.txt` | SHA-256 of every asset |

The desktop app is the main download for streamers (site → **Download**). The script mode stays for
advanced users and servers: [the script install page](https://lucas-angelo.github.io/swarmcast/advanced/script-install/)
has the one-line commands. Desktop details: [DESKTOP.md](DESKTOP.md).

The offline guide inside the installer zips is generated from the website's pages
(`site/src/content/docs/`, list and order in `site/offline-guide.json`, by
`scripts/build/guide-html.mjs`). To change it, edit the site: both always say the same thing.

## 6. GitHub Pages and usage numbers

The website in [`site/`](../site/README.md) is deployed by GitHub Actions.

- **Settings → Pages → Build and deployment → Source: GitHub Actions** (once; the deploy job fails until
  then). The site is then at <https://lucas-angelo.github.io/swarmcast/>.
- Pull requests that touch the site (or the screenshots, the brand or the shared translations) build and
  test it, without deploying. Each merge to `main` with such changes builds, tests and deploys it.
  **Actions → Website → Run workflow** on `main` deploys by hand.
- **Usage numbers without telemetry:** once a day and on every published release, the **Usage stats**
  job saves a snapshot of GitHub's public download counters (installers, and `latest.json` as the
  "apps opened" estimate) on the orphan branch `stats`, then the site is rebuilt with them. Nothing comes
  from the app or its users. Do not protect or delete the `stats` branch; without it, the site just hides
  the numbers. How the estimate works: `scripts/stats/stats.mjs`, and the site's "Privacy and usage
  numbers" page.

## 7. Code signing (optional, paid)

SwarmCast ships unsigned by default. Signing certificates cost money every year (an Apple Developer
account; a Windows code-signing certificate), so they are optional.

What users see without signing (the site's install pages explain each step with pictures):

- **Windows:** SmartScreen shows "Windows protected your PC" the first time: **More info → Run anyway**.
- **macOS:** the app and the scripts are not notarized, so Gatekeeper blocks the first open:
  **System Settings → Privacy & Security → Open Anyway** (older macOS: right-click → **Open**). The
  desktop app is ad-hoc signed; the start script removes the quarantine flag only from the files it
  verified by SHA-256.
- **Linux:** no warning.

The updater signature (section 3) is separate from code signing and is always on: it proves an update
came from this project, whether or not the installer is code-signed.

When the following secrets exist, the release signs the script-mode binaries (and notarizes the macOS
ones) by itself:

| Secret | Use |
|--------|-----|
| `MACOS_CERTIFICATE_P12_BASE64` | "Developer ID Application" certificate (.p12), base64 |
| `MACOS_CERTIFICATE_PASSWORD` | Password of the .p12 |
| `MACOS_SIGN_IDENTITY` | E.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_TEAM_ID` | Team ID of the Apple Developer account |
| `APPLE_APP_PASSWORD` | App-specific password (appleid.apple.com) for `notarytool` |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Code-signing certificate (.pfx), base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password of the .pfx |

The desktop installers are not code-signed yet even with these secrets: that needs the Tauri bundler's
signing settings (see [DESKTOP.md](DESKTOP.md), "Installers") and is future work.
