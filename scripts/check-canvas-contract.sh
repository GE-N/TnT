#!/usr/bin/env bash
# T1 contract: canvas authoring and route projection stay byte-for-byte at the task base.
#
# CI must clone with fetch-depth: 0. A shallow history cannot compute merge-base
# against the base branch, and this script fails rather than reporting a vacuous pass.
# A CI push to the default branch has nothing to compare, so the script skips.
# Local checkouts of that branch are still checked.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

branch="$(git rev-parse --abbrev-ref HEAD)"
ref="${GITHUB_REF:-}"
if [[ -n "${CI:-}" && ( "$branch" == "main" || "$branch" == "master" || "$ref" == "refs/heads/main" || "$ref" == "refs/heads/master" ) ]]; then
  echo "Canvas authoring contract skipped: a push to the default branch has nothing to compare."
  exit 0
fi

base_ref="${1:-}"
if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    base_ref=origin/main
  else
    base_ref=main
  fi
fi
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "Canvas authoring contract failed: base $base_ref is not available. CI must fetch the full history (fetch-depth: 0)." >&2
  exit 1
fi
if ! base="$(git merge-base HEAD "$base_ref" 2>/dev/null)"; then
  echo "Canvas authoring contract failed: merge-base with $base_ref is unavailable. CI must fetch the full history (fetch-depth: 0)." >&2
  exit 1
fi
paths=(shared server/canvas.ts server/canvas-route.ts server/default-actions.ts)

if ! git diff --exit-code --stat "$base" -- "${paths[@]}"; then
  echo "Canvas authoring contract failed: expected an empty diff against $base ($base_ref)." >&2
  exit 1
fi
if ! git diff --exit-code --stat HEAD -- "${paths[@]}"; then
  echo "Canvas authoring contract failed: uncommitted edits in protected canvas files." >&2
  exit 1
fi
status="$(git status --porcelain -- "${paths[@]}")"
if [[ -n "$status" ]]; then
  echo "Canvas authoring contract failed: protected canvas files are not clean." >&2
  printf '%s\n' "$status" >&2
  exit 1
fi
