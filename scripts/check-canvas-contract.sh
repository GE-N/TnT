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
# Each patch and the diff are split into per-file sections and compared in path order, so the patch
# filenames do not need to sort like git's paths. Two patches must not touch the same file.
exception=scripts/canvas-contract-exceptions
shopt -s nullglob
exception_patches=("$exception"/*.patch)
shopt -u nullglob

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tab=$'\t'

# Reads a git diff on stdin and writes one file per "diff --git" section into $work.
# Prints "path<TAB>source<TAB>section file" for each section. Exits 3 if text precedes the first section.
split_sections() {
  awk -v out="$work" -v tag="$1" -v src="$2" '
    function path_of(h,  n, l, i) {
      n = length(h)
      if ((n - 5) % 2 == 0) {
        l = (n - 5) / 2
        if (substr(h, 1, 2) == "a/" && substr(h, l + 3, 3) == " b/" && substr(h, 3, l) == substr(h, l + 6, l)) return substr(h, 3, l)
      }
      for (i = n - 2; i > 0; i--) if (substr(h, i, 3) == " b/") return substr(h, i + 3)
      return h
    }
    /^diff --git / {
      if (file != "") close(file)
      blanks = 0
      file = out "/" tag "." (++seq)
      printf "%s\t%s\t%s\n", path_of(substr($0, 12)), src, file
      print > file
      next
    }
    file == "" { if ($0 != "") { bad = 1; exit } next }
    $0 == "" { blanks++; next }
    { for (; blanks > 0; blanks--) print "" > file; print > file }
    END { if (file != "") close(file); if (bad) exit 3 }
  '
}

: > "$work/expected.idx"
i=0
for patch in "${exception_patches[@]}"; do
  i=$((i + 1))
  if ! split_sections "e$i" "$patch" < "$patch" >> "$work/expected.idx"; then
    echo "Canvas authoring contract failed: $patch is not a git diff (text before the first \"diff --git\" line)." >&2
    exit 1
  fi
done

duplicate="$(cut -f1 "$work/expected.idx" | LC_ALL=C sort | uniq -d | head -n 1)"
if [[ -n "$duplicate" ]]; then
  echo "Canvas authoring contract failed: more than one exception patch touches $duplicate. Record each exception as one combined patch, and give each file to one patch only." >&2
  awk -F "$tab" -v p="$duplicate" '$1 == p { print "  " $2 }' "$work/expected.idx" >&2
  exit 1
fi

git diff --no-color --full-index "$base" HEAD -- "${paths[@]}" | split_sections a diff > "$work/actual.idx"

LC_ALL=C sort -t "$tab" -k1,1 "$work/expected.idx" > "$work/expected.sorted"
LC_ALL=C sort -t "$tab" -k1,1 "$work/actual.idx" > "$work/actual.sorted"
section_of() { awk -F "$tab" -v p="$1" '$1 == p { print $3 }' "$2"; }
mismatches=()
while IFS= read -r path; do
  want="$(section_of "$path" "$work/expected.sorted")"
  got="$(section_of "$path" "$work/actual.sorted")"
  if [[ -z "$got" ]]; then
    mismatches+=("$path: in an exception patch but not in the diff")
  elif [[ -z "$want" ]]; then
    mismatches+=("$path: changed but not in any exception patch")
  elif ! cmp -s "$want" "$got"; then
    mismatches+=("$path: the diff differs from its exception patch")
  fi
done < <(cut -f1 "$work/expected.sorted" "$work/actual.sorted" | LC_ALL=C sort -u)
if (( ${#mismatches[@]} )); then
  git diff --stat "$base" HEAD -- "${paths[@]}" >&2
  echo "Canvas authoring contract failed: the diff against $base ($base_ref) differs from the named exceptions in $exception." >&2
  printf '  %s\n' "${mismatches[@]}" >&2
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
count=${#exception_patches[@]}
echo "canvas contract check passed ($count exception $([[ $count == 1 ]] && echo patch || echo patches))"
