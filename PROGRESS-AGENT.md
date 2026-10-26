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

## In progress
- Watching PR runs and fixing failures.

## Next steps
1. All PR workflows green on all OSes.
2. Temporary commit to exercise release.yml wiring (pull_request trigger, publish skipped), then revert.
3. Delete this file in the final commit.
