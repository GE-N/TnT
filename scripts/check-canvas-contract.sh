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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tab=$'\t'
gitq() { git -c core.quotePath=false "$@"; }

# Reads a git diff on stdin and writes one file per "diff --git" section into $work.
# Prints "path<TAB>source<TAB>section file" for each section.
# Trailing blank lines at end of a section are dropped so an extra newline at EOF
# of a patch is not a false mismatch (git diffs do not include those blanks).
# Exit 3: text precedes the first section. Exit 4: a quoted path was written to $work/quoted.
# File paths are passed through ENVIRON so awk -v cannot interpret backslash escapes.
split_sections() {
  CONTRACT_SPLIT_OUT="$work" \
  CONTRACT_SPLIT_TAG="$1" \
  CONTRACT_SPLIT_SRC="$2" \
  CONTRACT_SPLIT_QUOTED="$work/quoted" \
  awk '
    BEGIN {
      out = ENVIRON["CONTRACT_SPLIT_OUT"]
      tag = ENVIRON["CONTRACT_SPLIT_TAG"]
      src = ENVIRON["CONTRACT_SPLIT_SRC"]
      quoted_file = ENVIRON["CONTRACT_SPLIT_QUOTED"]
    }
    function flush(  i, j) {
      if (file == "") return
      for (i = nlines; i >= 1 && (lines[i] == "" || lines[i] == "\r"); i--);
      for (j = 1; j <= i; j++) print lines[j] > file
      close(file)
      nlines = 0
    }
    function unquote_from(s, start,  i, n, c, out, oct, nacc, k) {
      n = length(s)
      if (substr(s, start, 1) != "\"") return ""
      for (i = start + 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\"") { qend = i; return out }
        if (c == "\\") {
          i++
          if (i > n) return out
          c = substr(s, i, 1)
          if (c == "n") out = out "\n"
          else if (c == "t") out = out "\t"
          else if (c == "r") out = out "\r"
          else if (c ~ /[0-7]/) {
            oct = c
            if (i + 1 <= n && substr(s, i + 1, 1) ~ /[0-7]/) { i++; oct = oct substr(s, i, 1) }
            if (i + 1 <= n && substr(s, i + 1, 1) ~ /[0-7]/) { i++; oct = oct substr(s, i, 1) }
            nacc = 0
            for (k = 1; k <= length(oct); k++) nacc = nacc * 8 + substr(oct, k, 1)
            out = out sprintf("%c", nacc)
          } else out = out c
        } else out = out c
      }
      return out
    }
    function strip_ab(p) {
      if (substr(p, 1, 2) == "a/" || substr(p, 1, 2) == "b/") return substr(p, 3)
      return p
    }
    function quoted_name(h,  a, b) {
      a = unquote_from(h, 1)
      b = unquote_from(h, qend + 2)
      if (b != "") return strip_ab(b)
      if (a != "") return strip_ab(a)
      return h
    }
    function path_of(h,  n, l, i) {
      n = length(h)
      if ((n - 5) % 2 == 0) {
        l = (n - 5) / 2
        if (substr(h, 1, 2) == "a/" && substr(h, l + 3, 3) == " b/" && substr(h, 3, l) == substr(h, l + 6, l)) return substr(h, 3, l)
      }
      for (i = n - 2; i > 0; i--) if (substr(h, i, 3) == " b/") return substr(h, i + 3)
      return h
    }
    function header() {
      h = $0
      sub(/\r$/, "", h)
      return substr(h, 12)
    }
    /^diff --git / {
      h = header()
      if (index(h, "\"") != 0) {
        print quoted_name(h) > quoted_file
        close(quoted_file)
        exit 4
      }
      flush()
      file = out "/" tag "." (++seq)
      printf "%s\t%s\t%s\n", path_of(h), src, file
      lines[++nlines] = $0
      next
    }
    file == "" {
      line = $0
      sub(/\r$/, "", line)
      if (line != "") { bad = 1; exit }
      next
    }
    { lines[++nlines] = $0 }
    END { flush(); if (bad) exit 3 }
  '
}

fail_split() {
  local status=$1 src=$2
  if (( status == 3 )); then
    echo "Canvas authoring contract failed: $src is not a git diff (text before the first \"diff --git\" line)." >&2
    exit 1
  fi
  if (( status == 4 )); then
    echo "Canvas authoring contract failed: quoted path $(cat "$work/quoted") cannot be recorded as an exception (tab, double quote, or backslash in the filename)." >&2
    exit 1
  fi
  if (( status != 0 )); then
    exit "$status"
  fi
}

: > "$work/expected.idx"
i=0
# Bash 3.2 (macOS /bin/bash) treats "${empty[@]}" as unbound under set -u, so iterate
# the glob with nullglob instead of expanding an empty exception_patches array.
shopt -s nullglob
for patch in "$exception"/*.patch; do
  i=$((i + 1))
  # Fail closed on CR bytes rather than normalizing. Patches are marked -text, so git
  # will not convert CRLF, and stripping CR here would hide a non-LF file behind a
  # successful cmp against git's LF diff. Name the patch so the author can re-save as LF.
  cr_bytes=$(LC_ALL=C tr -cd '\r' < "$patch" | wc -c)
  if (( cr_bytes > 0 )); then
    echo "Canvas authoring contract failed: $patch has CRLF line endings. Exception patches must use LF bytes (.gitattributes marks $exception/*.patch -text, so git will not convert them)." >&2
    exit 1
  fi
  set +e
  split_sections "e$i" "$patch" < "$patch" >> "$work/expected.idx"
  status=$?
  set -e
  fail_split "$status" "$patch"
done
shopt -u nullglob

duplicate="$(cut -f1 "$work/expected.idx" | LC_ALL=C sort | uniq -d | head -n 1)"
if [[ -n "$duplicate" ]]; then
  echo "Canvas authoring contract failed: more than one exception patch touches $duplicate. Record each exception as one combined patch, and give each file to one patch only." >&2
  CONTRACT_AWK_PATH="$duplicate" awk -F "$tab" '$1 == ENVIRON["CONTRACT_AWK_PATH"] { print "  " $2 }' "$work/expected.idx" >&2
  exit 1
fi

set +e +o pipefail
gitq diff --no-color --full-index "$base" HEAD -- "${paths[@]}" | split_sections a diff > "$work/actual.idx"
status=${PIPESTATUS[1]}
set -e -o pipefail
fail_split "$status" "diff"

LC_ALL=C sort -t "$tab" -k1,1 "$work/expected.idx" > "$work/expected.sorted"
LC_ALL=C sort -t "$tab" -k1,1 "$work/actual.idx" > "$work/actual.sorted"
section_of() { CONTRACT_AWK_PATH="$1" awk -F "$tab" '$1 == ENVIRON["CONTRACT_AWK_PATH"] { print $3 }' "$2"; }
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
  gitq diff --stat "$base" HEAD -- "${paths[@]}" >&2
  echo "Canvas authoring contract failed: the diff against $base ($base_ref) differs from the named exceptions in $exception." >&2
  printf '  %s\n' "${mismatches[@]}" >&2
  exit 1
fi
if ! gitq diff --exit-code --stat HEAD -- "${paths[@]}"; then
  echo "Canvas authoring contract failed: uncommitted edits in protected canvas files." >&2
  exit 1
fi
status="$(gitq status --porcelain -- "${paths[@]}")"
if [[ -n "$status" ]]; then
  echo "Canvas authoring contract failed: protected canvas files are not clean." >&2
  printf '%s\n' "$status" >&2
  exit 1
fi
count=$i
echo "canvas contract check passed ($count exception $([[ $count == 1 ]] && echo patch || echo patches))"
