# CI restructure (agent progress, delete in the final commit)

Branch: worktree branch pushed as `ci/restructure`, draft PR into `feat/desktop-app`.

## Done
- Merged feat/desktop-app.

## In progress
- Composite action `.github/actions/setup`, rewrite ci/scripts/preflight/windows/codeql triggers,
  workflow_call gates in release.yml, desktop.yml (gated on apps/desktop), remove pr-commands.yml.

## Next steps
1. actionlint clean.
2. Push `ci/restructure`, open draft PR, watch runs, fix failures.
3. Temporary commit to exercise release.yml wiring (no publish), then revert.
4. Docs: PUBLICACAO_PT-BR.md pipelines section, DESKTOP.md CI paragraph.
5. Delete this file in the final commit.
