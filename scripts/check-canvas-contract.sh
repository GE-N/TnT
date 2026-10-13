#!/usr/bin/env bash
# T1 contract: canvas authoring and route projection stay byte-for-byte at the contract base,
# apart from the named exceptions recorded in scripts/canvas-contract-exceptions/.
#
# CI must clone with fetch-depth: 0. A shallow history may not contain the contract base,
# and this script fails rather than reporting a vacuous pass.
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

# Merge of #44 (optional destination, same-screen actions) in #53, on top of the #41 golden snapshots.
contract_base=6639263
base_ref="${1:-$contract_base}"
if ! base="$(git rev-parse --verify --quiet "$base_ref^{commit}")"; then
  echo "Canvas authoring contract failed: base $base_ref is not available. CI must fetch the full history (fetch-depth: 0)." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$base" HEAD; then
  echo "Canvas authoring contract failed: base $base_ref is not an ancestor of HEAD." >&2
  exit 1
fi
paths=(shared server/canvas.ts server/canvas-route.ts server/default-actions.ts)

# Named exceptions: the diff must equal the patches in this folder exactly. With none, it must be empty.
exception=scripts/canvas-contract-exceptions
shopt -s nullglob
exception_patches=("$exception"/*.patch)
shopt -u nullglob
expected=""
if (( ${#exception_patches[@]} )); then
  expected="$(cat "${exception_patches[@]}")"
fi
actual="$(git diff --no-color --full-index "$base" HEAD -- "${paths[@]}")"
if [[ "$actual" != "$expected" ]]; then
  git diff --stat "$base" HEAD -- "${paths[@]}" >&2
  echo "Canvas authoring contract failed: the diff against $base ($base_ref) differs from the named exceptions in $exception." >&2
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
if [[ -n "$actual" ]]; then
  echo "Canvas authoring contract passed: the diff against $base matches the named exceptions in $exception."
fi
