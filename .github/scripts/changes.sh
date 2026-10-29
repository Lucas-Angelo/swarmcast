#!/usr/bin/env bash
# What a pipeline run has to test (pipeline.yml, job `changes`), from the files the change touches.
#
#   changes.sh [--all]        prints app=, site=, scripts=, files= lines (for $GITHUB_OUTPUT)
#
# The changed files come from git, per event (GitHub's own event payload, read from env):
#   pull_request   the PR's merge commit against its first parent (the base branch tip), so only
#                  what the PR changes counts, whatever happened on the base branch since;
#   merge_group    merge_group.base_sha .. merge_group.head_sha;
#   push           before .. after; a new branch (before = 000…) or a before commit that cannot
#                  be fetched (a force push) counts as "everything changed".
# Anything else (schedule, workflow_dispatch, a release calling the pipeline), --all, or a diff
# that fails means everything changed: when in doubt, test.
#
# Outputs:
#   app      the app and its tests: anything except docs (docs/, *.md), the website (site/) and
#            the files below that only other workflows read
#   site     the website's sources and what it embeds (site.yml / _site.yml)
#   scripts  the start and uninstall scripts and their tests (the install-scripts step of the
#            clean-machine stage)
set -uo pipefail

all=false
[ "${1:-}" = --all ] && all=true

files=""
diff_ok=false
if [ "$all" = false ]; then
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request | pull_request_target)
      # actions/checkout (fetch-depth: 2) checked out refs/pull/N/merge and its parents.
      if git rev-parse -q --verify 'HEAD^2' >/dev/null; then
        files="$(git diff --name-only 'HEAD^1' HEAD)" && diff_ok=true
      fi
      ;;
    merge_group)
      base="$(jq -r '.merge_group.base_sha // empty' "$GITHUB_EVENT_PATH")"
      head="$(jq -r '.merge_group.head_sha // empty' "$GITHUB_EVENT_PATH")"
      if [ -n "$base" ] && git fetch -q --no-tags --depth=1 origin "$base" 2>/dev/null; then
        files="$(git diff --name-only "$base" "$head")" && diff_ok=true
      fi
      ;;
    push)
      before="$(jq -r '.before // empty' "$GITHUB_EVENT_PATH")"
      if [ -n "$before" ] && [ "$before" != 0000000000000000000000000000000000000000 ] &&
        git fetch -q --no-tags --depth=1 origin "$before" 2>/dev/null; then
        files="$(git diff --name-only "$before" "$GITHUB_SHA")" && diff_ok=true
      fi
      ;;
  esac
fi

if [ "$diff_ok" = true ]; then
  # Files only other workflows read: they do not change what this pipeline tests.
  #   the soak (soak.yml, its plan, scripts/ci), the Docker suites (linux-docker.yml,
  #   scripts/test/docker), CodeQL, the usage numbers, Dependabot, issue forms, release notes.
  not_app='^(docs/|site/)|\.md$|^\.github/(workflows/(soak|linux-docker|codeql|stats)\.yml|soak-plan\.json|dependabot\.yml|release\.yml|ISSUE_TEMPLATE/)|^scripts/(ci|test/docker)/'
  site_re='^(site/|scripts/releases/|docs/img/|assets/brand/|apps/admin/src/onboarding/img/|packages/shared/src/i18n/|packages/shared/web/font-licenses\.mjs|\.github/actions/|\.github/workflows/(_site|site|pipeline)\.yml)'
  scripts_re='^(scripts/|\.github/actions/|\.github/workflows/(_node|pipeline)\.yml)'
  has() { grep -qE "$1" <<<"$files" && echo true || echo false; }
  app="$(grep -vE "$not_app" <<<"$files" | grep -q . && echo true || echo false)"
  site="$(has "$site_re")"
  # scripts/ci and scripts/test/docker are not install scripts.
  scripts="$(grep -E "$scripts_re" <<<"$files" | grep -qvE '^scripts/(ci|test/docker)/' && echo true || echo false)"
  count="$(grep -c . <<<"$files")"
else
  app=true site=true scripts=true count=all
fi

echo "app=$app"
echo "site=$site"
echo "scripts=$scripts"
echo "files=$count"
{
  echo "## Changes"
  echo
  echo "| app | site | install scripts | files |"
  echo "|---|---|---|---|"
  echo "| $app | $site | $scripts | $count |"
  if [ "$diff_ok" = true ] && [ -n "$files" ]; then
    echo
    echo '<details><summary>Changed files</summary>'
    echo
    echo '```'
    head -n 300 <<<"$files"
    echo '```'
    echo '</details>'
  fi
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
