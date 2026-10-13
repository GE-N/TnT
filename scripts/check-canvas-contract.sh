#!/usr/bin/env bash
# T1 contract: canvas authoring and route projection stay byte-for-byte at the task base.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base_ref="${1:-}"
if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    base_ref=origin/main
  else
    base_ref=main
  fi
fi
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "Canvas authoring contract base not found: $base_ref" >&2
  exit 1
fi

base="$(git merge-base HEAD "$base_ref")"
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
