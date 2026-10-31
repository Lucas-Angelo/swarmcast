# Releasing (maintainer)

How the GitHub repository is set up, how changes reach `main`, and how to ship a SwarmCast release.
The repository (`Lucas-Angelo/swarmcast`) is public, so release assets, the one-line installs and the
desktop app's update check all work straight from it.

Streamers never read this: their guide is the website, <https://lucas-angelo.github.io/swarmcast/>.
Contributors start with [CONTRIBUTING.md](../CONTRIBUTING.md).

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

**Settings → General.**

- Features: **Issues** on, **Discussions** on (categories Announcements, Q&A, Ideas and, from 0.3.0,
  Beta feedback), **Wiki** off (the docs live in `docs/` and on the website).
- Pull requests: allow **squash merging** only, with "Default commit message" set to **Pull request
  title** (blank body). Turn on **Automatically delete head branches** and **Always suggest updating pull
  request branches**.
- Releases: **Enable release immutability** (section 4).

**Settings → Moderation options → Reported content.** Accept reports, so people can use **Report
content → Report to repository admins**, the private route in
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

**Settings → Code security.** Turn on **Private vulnerability reporting** (it is how
[SECURITY.md](../SECURITY.md) asks people to report), Dependabot alerts and Dependabot security updates
(version updates are in `.github/dependabot.yml`), and secret scanning with push protection.

**Settings → Actions → General.** Require actions to be pinned to a full-length commit SHA, require
approval for fork pull request workflows from all outside contributors, and keep the default token
read-only (it may not create or approve pull requests).

**Labels.** The issue forms, the pull request template and `.github/release.yml` (the categories of
GitHub's generated pull request list) use these labels besides GitHub's defaults:

```sh
for l in breaking performance maintenance dependencies security skip-changelog needs-triage beta; do
  gh label create "$l" -R Lucas-Angelo/swarmcast 2>/dev/null || true
done
```

## 2. Branches, pull requests and protection

SwarmCast uses **trunk-based GitHub Flow**:

- **`main` is the only long-lived branch.** Every change goes through a short-lived branch and a pull
  request (`feat/…`, `fix/…`, `docs/…`, `ci/…`, `chore/…`; the name does not matter after the merge).
- Pull requests are **squash-merged**: the pull request title becomes the one commit on `main`, the body
  is dropped, and the branch is deleted. A branch may have as many commits as it likes. Titles follow
  [CONTRIBUTING.md](../CONTRIBUTING.md#pull-request-titles); a release pull request is titled
  `SwarmCast vX.Y.Z`.
- **Stable releases are tags on `main`** (section 4); a beta is a tag on the head of its minor's release
  pull request branch, `release/X.Y.Z`, which is merged only with the stable version. There is no
  `develop` branch.
- **`release/X.Y` maintenance branches** are made only when a stable fix cannot ship from `main`
  (section 4, "Hotfixes"). They share the `release/` prefix with the short-lived release pull request
  branches (`release/X.Y.Z`, three numbers). The orphan `stats` branch is data, not code (section 6).

**Protection.** One ruleset, in **Settings → Rules → Rulesets** (or with
`gh api -X POST repos/Lucas-Angelo/swarmcast/rulesets --input <file>.json`). This is the live ruleset
(read with `gh api repos/Lucas-Angelo/swarmcast/rulesets`, 2026-10-30):

```json
{
  "name": "main: nothing red lands",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "require_extra_approval_for_unattributed_changes": true,
        "required_review_thread_resolution": false,
        "required_reviewers": [],
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "ci-ok", "integration_id": 15368 } ] } }
  ]
}
```

- **0 approvals:** there is one maintainer, and agents work with the maintainer's account, so a required
  approval would only block every merge. The ruleset does not require resolved review threads; resolve
  them anyway before merging ([CONTRIBUTING.md](../CONTRIBUTING.md#branches-and-pull-requests)).
- **Required check `ci-ok`:** one check that sums up every CI job of a pull request and always reports,
  also when a docs-only change skips the app suites. GitHub only offers a check in the picker after it
  has run once. `15368` is the GitHub Actions app; the picker shows the source of each check.
- **"Up to date" is on** (`strict_required_status_checks_policy`): a pull request merges only when it
  contains the latest `main` and `ci-ok` passed on that head. Bring a branch up to date by merging `main`
  into it (the **Update branch** button), never by rebasing or force-pushing what is already pushed. Every
  update runs the pipeline again, so parallel pull requests merge one after another.
- **No bypass.** In an emergency, edit the ruleset for a moment; the change shows in the audit log.
- **Only `main` is covered** (`~DEFAULT_BRANCH`). The `release/X.Y.Z` and `release/X.Y` branches are not
  protected by a ruleset: never force-push or delete one while it is in use.

**Release tags** have their own ruleset, `release tags` (id 26232349): only the admin role
(`actor_id` 5, `bypass_mode: always`) can create, move or delete a `v*` tag, so a stray
`git push --tags` or `--force` cannot change a release tag.

```json
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" }, { "type": "non_fast_forward" } ]
}
```

Once a release is published, release immutability (section 1) also keeps its tag from being moved or
deleted; the admin can still move a tag whose release was not published yet (section 4, "If the release
workflow fails").

**CI.** One workflow, `pipeline.yml`, runs automatically on every pull request and push to `main`
(standard runners are free on a public repository), again on the 1st of every month with everything (to
catch dead third-party downloads or runner image changes), and by hand from **Actions → Pipeline → Run
workflow**; the **Re-run** button repeats a run, but never use it to turn a failed run green: a failure
is a bug, fixed at its cause (network steps already retry by themselves,
[.github/workflows/README.md](../.github/workflows/README.md#rules)), and `ci-ok` fails on any re-run
(a run attempt after the first), so a re-run cannot turn the required check green either. A newer push to a pull request
cancels its older run;
runs on `main` and tags are never cancelled. Its stages, how it builds once and tests the same bytes
everywhere, and what each change runs are in [.github/workflows/README.md](../.github/workflows/README.md).

| Stage | What | Runs on |
|-------|------|---------|
| `quick` | lint, typecheck, unit tests, `npm audit`, upstream binaries, tray helper, `cargo fmt` | Ubuntu |
| `build`, `desktop` | the web build, the script-mode packages, the desktop installers per target | Ubuntu, Windows, macOS arm64 + Intel, Ubuntu x64 + arm64 |
| `node` | unit and integration tests, `cargo clippy`/`test`, the start and uninstall scripts (when they changed) | Windows, macOS, Ubuntu |
| `e2e` | Playwright (Chrome, Firefox, WebKit), split into the `ui` and `media` tests | macOS, Ubuntu |
| `windows` | exhaustive Windows suites (installer, app in Chrome/Edge/Firefox, quality, direct mode, OBS) | Windows Server |
| `clean-machine` | per runner image: the pre-release check of the real package (install, live, watch, P2P, tunnel), the desktop installers (install, launch, autostart, update, uninstall), the AppImage on a minimal host | Windows, macOS arm64 + Intel, Ubuntu 22.04, 24.04 and 24.04 arm64 |
| `site` | the website's tests, when it changed | Ubuntu |
| `docker` | the Linux Docker suites (package and start script on Ubuntu 22.04/24.04 and Debian 12, AppImage on a minimal host, OBS Studio, Playwright in the Playwright image), when they or what they run changed | Ubuntu x64 + arm64 |
| `ci-ok` | the one required check: green only when every stage the change needs passed | Ubuntu |

Other workflows: `codeql.yml` (code scanning of TypeScript, Go, Rust and the workflows), `site.yml` and
`stats.yml` (the website and the usage numbers, section 6), `soak.yml` (stability measurements),
`linux-docker.yml` (the Docker suites weekly; pull requests that touch them run the same suites as the
pipeline's `docker` stage, inside `ci-ok`), and `release.yml` (on a `v*` tag: the whole pipeline as a gate, then
sign and publish, section 4).

Changes that only touch `docs/`, `site/` or `.md` files skip the app stages: `ci-ok` is green within a
minute (and the `site` stage runs for the pages they use). The usage-stats job writes only to its own
`stats` branch (section 6), which the rulesets do not cover.

## 3. Secrets

### Updater signing key (required for every release)

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |

The desktop app installs an update only when its signature matches the public key built into the app
(`plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`). The release workflow refuses to
start without these two secrets, because a release without signatures could never reach installed apps.

**They live in the `release` environment** (since 2026-10-30), not in the repository secrets:

- **Settings → Environments → `release`**: "Deployment branches and tags" is **Selected branches and
  tags**, with one **tag** rule `v*` and no branch rule. No required reviewer and no wait timer. The two
  secrets above are **environment secrets** of `release`; there are no repository copies.
- GitHub gives environment secrets only to a job that names the environment (`environment: release`),
  and only after the environment's rules pass, so only release jobs started by a `v*` tag can read the
  key. Pull request and branch runs, including ones that edit a workflow, cannot.
- In a reusable workflow, the job inside the called workflow is the one that must declare
  `environment: release`; the environment's secret then takes precedence over anything the caller passes.
- The tag rule pairs with the tag ruleset (section 2): only the admin can create `v*` tags.

Key care:

- **Where it lives:** the key pair was made with
  `npx tauri signer generate -w ~/.tauri/swarmcast-updater.key`. The private key is that file, its
  password is in `~/.tauri/swarmcast-updater.password` on the maintainer's computer, and a copy of each
  is in the two secrets above. A local build signs with them only when asked:
  `node scripts/build/desktop.mjs --release-key ~/.tauri/swarmcast-updater.key` (it reads the
  `.password` file next to it); without that flag or `TAURI_SIGNING_PRIVATE_KEY`, `desktop.mjs` builds
  without updater signatures, so a test build is never signed with the release key. Only the public key
  is in the repository. Never commit the private key or paste it anywhere else.
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

See section 7. Without those secrets the release is unsigned, which is the default. They belong in the
`release` environment too.

## 4. Ship a release

**Versions** follow [Semantic Versioning](https://semver.org/): minor bumps (`0.3.0`) for features,
patch bumps (`0.2.2`) for fixes.

**Pre-releases** (the opt-in beta channel, since 0.3.0): `X.Y.Z-beta.N`, and optionally `X.Y.Z-rc.N`
for a final frozen build. Always put a dot before the number (`beta.2`, not `beta2`), so `beta.11` sorts
after `beta.2`. No alpha: the release workflow refuses any other pre-release identifier. A beta is tagged
on the head of its minor's release pull request branch (`release/X.Y.Z`, merged into `main` only with the
stable version; see "Steps"), not on `main`, and is published as a **GitHub pre-release** that is never **Latest**, so
`/releases/latest` and its `latest.json` (stable apps, the start scripts and the site's download button)
never return them. Desktop apps with **Get beta versions** on read the beta feed
`https://lucas-angelo.github.io/swarmcast/updates/beta.json`, which the website build copies from the
`latest.json` of the highest release, beta or stable (docs/DESKTOP.md, "Updates").

**The rule: every version, patch releases included, ships as at least two betas first, and the stable
version only after both were verified.** `vX.Y.Z-beta.1`, then **Verify a beta**; `vX.Y.Z-beta.2`, then
**Verify a beta** again, which also proves that an app on the first beta updates itself to the second
through the beta feed; only then `vX.Y.Z`. `X.Y.0` is refused by the release workflow unless
`vX.Y.0-beta.N` (or `-rc.N`) is published. Merge and release only after every check passed on the pull
request (not only `ci-ok`), and a change to the tests or the pipeline lands only after repeated full
pipeline runs with no failure at all.

**A published release is never changed.** Release immutability is on (section 1): once published, its
assets and its tag cannot be edited, replaced or deleted, and GitHub adds a release attestation.
Installed apps and the scripts may already have it. A mistake is fixed by shipping the next version.

### Steps

For a beta (`vX.Y.Z-beta.N`), steps 1–5 are the same with these differences: the changelog stays under
`## [Unreleased]` (the workflow takes the beta's notes from there; it must not be empty), the version is
`X.Y.Z-beta.N` everywhere (step 2), and the beta is **not merged into `main`** (`main` only takes stable
versions): once `ci-ok` is green on the minor's release pull request (branch `release/X.Y.Z`, titled
`SwarmCast vX.Y.Z`), tag its head commit itself and push only the tag
(`git tag -a vX.Y.Z-beta.N -m "SwarmCast vX.Y.Z-beta.N" <head> && git push origin vX.Y.Z-beta.N`).
Then do **Verify a beta** below before the stable version.

1. **Changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` (or the prepared `## [X.Y.Z] - Unreleased`)
   to `## [X.Y.Z] - YYYY-MM-DD`, start a new empty `## [Unreleased]` above it, and update the link
   references at the bottom. The section must not be empty: it becomes the release notes and the
   desktop app's update dialog, so it is written for streamers.
2. **Version.** Set the same version in every `package.json` and `apps/desktop/src-tauri/Cargo.toml`:
   ```sh
   npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root
   # then edit apps/desktop/src-tauri/Cargo.toml (version = "X.Y.Z") and run cargo check to update Cargo.lock
   ```
   The root `package.json` is the one that counts: the tag must match it, and the build stamps it into the
   server, the packages and the desktop app.
3. **Release pull request.** Open a pull request with both changes, titled **`SwarmCast vX.Y.Z`**. Wait
   for `ci-ok` and squash-merge it: `SwarmCast vX.Y.Z` becomes the release commit on `main`.
4. **Tag** that commit on `main` and push the tag:
   ```sh
   git switch main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
5. **Watch the release workflow** in the **Actions** tab. It runs by itself on the tag and:
   1. checks that the tag matches `package.json`, that the version is `X.Y.Z`, `X.Y.Z-beta.N` or
      `X.Y.Z-rc.N`, that the tag commit is on `main` or `release/X.Y` (a pre-release may also be on the minor's release pull request branch `release/X.Y.Z`, same X.Y.Z, before it is merged), that a new minor `X.Y.0` had a
      published beta, that `CHANGELOG.md` has the notes (`## [X.Y.Z]`, or `## [Unreleased]` for a
      pre-release), that the updater signing secrets exist, and that no GitHub release exists yet for the
      tag;
   2. runs the whole pipeline, every stage, the same as for pull requests, with the desktop installers
      built with full optimisation and their update packages signed with the updater key (from the
      `release` environment, section 3). If anything fails, nothing is published;
   3. signs the server packages the pipeline built and tested when the code-signing secrets exist, and
      smoke-tests them on each platform;
   4. publishes the GitHub release, titled **SwarmCast vX.Y.Z**, with the release notes taken from the
      `CHANGELOG.md` section: it uploads every asset to a draft first, checks them, attests them (build
      provenance, `gh attestation verify <file> -R Lucas-Angelo/swarmcast`) and only then publishes the
      draft, so nothing edits a published release. A pre-release is published with
      `--prerelease --latest=false` and its page says what a beta is and links **Beta feedback**; a stable
      release becomes **Latest** only when it is the highest stable version (a hotfix on an older line
      does not take the download button back). The job then checks that `/releases/latest` is what it
      should be.
6. **Check the result** (a few minutes after it finishes):
   - the release is marked **Latest** and has every asset listed below;
   - `https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json` shows the new
     version with an entry per platform;
   - an installed desktop app finds the update (tray → **Check for updates**);
   - the site's download button links the new files. Publishing the release starts the **Usage stats**
     job, which records the latest release's installers and rebuilds the site (section 6). If the button
     still shows the old version after that, run **Usage stats** by hand in the Actions tab.

**Verify a beta** (before tagging the stable `vX.Y.Z`):

- the release is a **Pre-release**, not Latest, with every asset of section 5 (the same list as a stable
  release, `latest.json` included) and a `.sig` next to every updatable file;
  `gh attestation verify <asset> -R Lucas-Angelo/swarmcast` passes for a few of them;
- `https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json` still shows the
  previous **stable** version;
- after the Release → Usage stats → Website chain (or **Actions → Website → Run workflow** on `main`),
  `https://lucas-angelo.github.io/swarmcast/updates/beta.json` is byte for byte the beta's `latest.json`
  (`curl -sL <both> | shasum`);
- a desktop app on the previous stable version with **Get beta versions** off finds nothing new; turned on,
  it offers the beta, and **Update now** installs it and reopens with the settings kept (one OS at least,
  ideally the three); a `.deb` install shows `X.Y.Z~beta.N` in `dpkg -l | grep -i swarm`;
- beta testers' reports in **Discussions → Beta feedback** are answered or fixed (a fix ships as
  `-beta.N+1`).

Then the stable version: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (step 1), set `X.Y.Z`
(step 2), pull request `SwarmCast vX.Y.Z`, tag. Beta apps then get `X.Y.Z` from both feeds (it is higher
than every beta), and stable apps from the stable feed.

**If the release workflow fails** before publishing, fix the problem on `main` (a normal pull request),
then move the tag (the admin bypass of the tag ruleset allows it; an unpublished release does not lock its tag):
`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, tag the fixed commit and push it again. Once
a release is **published**, never re-use its version: ship `X.Y.Z+1` instead.

**Pull request list.** The release notes are the curated `CHANGELOG.md` text. GitHub's generated list of
merged pull requests (**Generate release notes**, or the `generate-notes` API) is sorted by label into
the categories in `.github/release.yml`; pull requests labelled `skip-changelog` are left out.

### Hotfixes

- **Usual case: `main` can be released.** Merge the fix, then a release pull request for `vX.Y.(Z+1)`,
  and tag it on `main`. No branch is needed.
- **`main` holds work that must not ship yet** (an open beta, a half-finished feature) and the stable bug
  cannot wait (security, data loss, crash on launch, broken update):
  1. merge the fix to `main` first, so the next minor has it too;
  2. if it does not exist yet, create the maintenance branch from the stable tag, named after the minor
     line: `git switch -c release/X.Y vX.Y.Z && git push -u origin release/X.Y`;
  3. on a short-lived branch from `release/X.Y`, `git cherry-pick -x <commit on main>`, do steps 1–2 for
     `X.Y.(Z+1)`, and open a pull request into `release/X.Y` titled `SwarmCast vX.Y.(Z+1)`;
  4. squash-merge it, tag the commit on `release/X.Y` and let the release workflow publish it;
  5. copy the new `CHANGELOG.md` section forward to `main` in a small pull request.

  A maintenance branch is never merged back. Once a newer minor is stable, ship fixes there instead:
  everyone is moved to the newest stable by the updater within about 6 hours.
- **Security fix:** prepare it in the advisory's temporary private fork, then follow one of the two cases
  above, then publish the advisory.

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

## 8. Mirrored CI dependencies (`ci-deps`)

Some publisher hosts are very slow from GitHub's runners: the macOS ffmpeg host
(`ffmpeg.martin-riedl.de`) has served 10–30 kB/s with stalls there, while a home connection gets the
same 28 MB in seconds. CI therefore downloads byte-identical copies from the
[`ci-deps`](https://github.com/Lucas-Angelo/swarmcast/releases/tag/ci-deps) pre-release of this
repository, which GitHub serves fast to its own runners.

- In `scripts/build/versions.json`, such an asset has `"mirrors": [<ci-deps URL>]` next to its publisher
  `url`. `fetch-binaries.mjs` tries the mirrors first and the publisher last, each with its own resume,
  retries and time cap. A missing or unreachable mirror falls back to the publisher; a file whose
  SHA-256 differs from the pin stops the download (the pin is the only thing trusted, whatever the source).
- Only CI and packagers use the mirrors. `binaries.json`, the start scripts and the app always download
  from the publisher's `url` (a test checks that `binaries.json` never contains `ci-deps`).
- `ci-deps` is a **pre-release, never "latest"**, so `/releases/latest` (the app's updater, the start
  scripts, the site) never sees it, and its asset names do not count as downloads in the usage numbers.
  It was created before immutable releases were turned on, so it stays editable: new files can be added.
  Do not delete it or its tag: with immutable releases on, a deleted release's tag name cannot be reused.
  If a new mirror release is ever needed, create a new pre-release (for example `ci-deps-2`) and point the
  new `mirrors` URLs at it.

To add or refresh a mirrored file (for example after pinning a new ffmpeg):

1. Pin the publisher's `url` and `sha256` in `versions.json` first, as for any dependency.
2. Download the file from the publisher into an empty folder, under a name that says what it is and never
   repeats an existing one: `<tool>-<version>-<target>.<ext>`, e.g. `ffmpeg-9.0.3-macos-arm64.zip`. Check it:
   `shasum -a 256 <file>` (Linux: `sha256sum`) must print the pin.
3. Upload it, without `--clobber` (old branches still pin the old files):
   `gh release upload ci-deps <file> --repo Lucas-Angelo/swarmcast`.
4. Check what GitHub stored: `gh release view ci-deps --repo Lucas-Angelo/swarmcast --json assets --jq '.assets[] | [.name, .digest] | @tsv'`
   shows `sha256:<pin>` for the new file.
5. Add `https://github.com/Lucas-Angelo/swarmcast/releases/download/ci-deps/<file>` to the asset's
   `mirrors` in every `versions.json` entry that pins the same file (`ffmpeg` and `ffmpeg-test` on macOS).
   `npx vitest run scripts/build/test/fetch-binaries.test.ts` checks the URLs and that one mirror file
   has one pin. `node scripts/build/fetch-binaries.mjs --only ffmpeg-test --target macos-arm64 --out <tmp>`
   proves the download.
6. Update the table in the release notes (`gh release edit ci-deps --notes-file <file>`), keeping the
   license section: for a GPL build, attach the matching FFmpeg source and say where the build script and
   library versions are.
7. Make sure it is still not the latest release: `gh api repos/Lucas-Angelo/swarmcast/releases/latest --jq .tag_name`
   must print the app's last version.

Delete an old file only when no supported branch pins it any more.
