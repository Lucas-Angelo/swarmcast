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
- aae4ed5 (before the desktop shell): ALL GREEN (CI, Install scripts incl. Windows uninstall.ps1 18/18 with
  desktop cases 9/9b/9c, Pre-release check x5, Windows E2E, CodeQL, Website, Desktop gate).
- 2be15eb (desktop CI first run): Rust checks (windows-latest) red on the logs.rs test, fixed in 84b77ac.
- 84b77ac: running (desktop build/test jobs not seen yet; verify.mjs untested so far).

## Next steps
1. Watch the desktop.yml run on the latest head; fix build/test failures.
2. Release dry run: scratchpad dryrun.py patches release.yml (workflow_dispatch, skip tag check and
   `gh release create`); push to a throwaway branch ci/release-dryrun, `gh workflow run release.yml --ref
   ci/release-dryrun`, then delete that branch. Never tag.
3. Report to the coordinator; delete this file in the final commit.
