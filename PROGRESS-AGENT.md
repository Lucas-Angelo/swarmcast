# CI restructure (agent progress, delete in the final commit)

Branch: worktree branch pushed as `ci/restructure`; draft PR https://github.com/Lucas-Angelo/swarmcast/pull/1 (base feat/desktop-app).

## Done
- `.github/actions/setup` composite (Node + npm cache keyed on root + site lockfiles, Go, ffmpeg with the real
  ffmpeg.exe ahead of the Chocolatey shim on Windows, npm ci).
- ci/scripts/preflight/windows/codeql/desktop: pull_request + push main (paths filters), monthly schedule,
  workflow_dispatch; workflow_call on ci/scripts/preflight/windows/desktop; concurrency cancels only PR runs.
- pr-commands.yml removed; no `/run` left in docs.
- release.yml: verify (tag, changelog, Tauri secrets present) -> gates ci/scripts/preflight/windows/desktop
  (workflow_call) -> build (linux-arm64 native on ubuntu-24.04-arm + smoke) -> publish (+ desktop installers,
  .sig, latest.json via updater-manifest.mjs --require-all).
- desktop.yml: rust (fmt/clippy/test x3 OS), build x5 targets (+ update test builds A/B with a throwaway key,
  desktop.mjs --updater-pubkey), test x6 (scripts/test/desktop/verify.mjs). Server hook SWARMCAST_TEST_LOGIN_FILE.
- Fixes: scripts.yml guide check allows data: images; ladder integration + E2E tests force libx264 (4-vCPU
  runners); site.yml installs root deps and runs site unit tests; CI checks job installs site deps;
  logs.rs data_dir test absolute path on Windows.
- Dependabot: cargo (apps/desktop/src-tauri), composite actions dir; site npm entry from the site agent.
- Merged feat/desktop-app up to 8bd44f1 (desktop shell, brand, site).

## Run state
- aae4ed5 (before the desktop shell): ALL GREEN.
- 3468932: Windows E2E all green, CI red only on diagnostics test (fixed upstream + here).
- 7b5247b: desktop clean-machine green on Windows, macOS arm64, macOS x64; Linux red (AppImage sidecar
  stripped -> NO_STRIP fix in desktop.mjs, not yet verified).
- Dry run #1 (40402322882): gates wired correctly; failures: macOS x64 DMG hdiutil "Resource busy" (retry
  added), Windows E2E Firefox via real tunnel (flaky; green on 3468932), binaries check (dispatch only).
- 8cec1b7 PR run + dry run #2 (40406115281) running.
- Known flakes: Windows E2E installer case 13 (Basic User quit) and Firefox tunnel; both pass on re-runs.
- Product bug to report: uninstall-linux.sh SC_DEB_PACKAGE="swarmcast-desktop" but the .deb is "swarm-cast".

## Next steps
1. Linux desktop tests green (AppImage); everything green on the PR.
2. Dry run #2: check build + publish steps run (Create release is skipped); delete ci/release-dryrun after.
3. Final report; delete this file in the final commit.
