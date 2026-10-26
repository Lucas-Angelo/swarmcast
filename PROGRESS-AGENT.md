# CI restructure (agent progress, delete in the final commit)

Branch: worktree branch pushed as `ci/restructure`; draft PR https://github.com/Lucas-Angelo/swarmcast/pull/1 (base feat/desktop-app).

## Done
- Merged feat/desktop-app.
- `.github/actions/setup` composite (Node + npm cache, Go, ffmpeg, npm ci).
- ci/scripts/preflight/windows/codeql: pull_request + push main (paths filters), schedule, dispatch; workflow_call on ci/scripts/preflight/windows/desktop.
- pr-commands.yml removed; docs (PUBLICACAO_PT-BR.md, DESKTOP.md) updated.
- desktop.yml (gated on apps/desktop/src-tauri/tauri.conf.json + scripts/build/desktop.mjs; TODO(desktop) commands).
- release.yml: gates via workflow_call, native linux-arm64 build + smoke, desktop artifacts + latest.json.
- dependabot: cargo (apps/desktop/src-tauri), composite actions dir.

- Fixed: scripts.yml guide check (data: images), ladder integration + E2E tests forced to libx264
  (4-vCPU runners keep only the original with encoder 'auto').
- Merged feat/desktop-app 4be671c (uninstaller desktop cases); coordinator wants the Windows
  uninstall.ps1 result (PowerShell 5.1) reported, incl. failing case output.

## In progress
- Watching PR runs on 6a3c344 and fixing failures.
- Release dry run: scratchpad dryrun.py patches release.yml (workflow_dispatch, skip tag check
  and `gh release create`); push it to a throwaway branch ci/release-dryrun, `gh workflow run
  release.yml --ref ci/release-dryrun`, then delete that branch.

## Next steps
1. All PR workflows green on all OSes.
2. Temporary commit to exercise release.yml wiring (pull_request trigger, publish skipped), then revert.
3. Delete this file in the final commit.
