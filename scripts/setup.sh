#!/usr/bin/env bash
# TnT one-command setup for a new Mac.
#
#   bash scripts/setup.sh            check + install project-local bits + build
#   bash scripts/setup.sh --check    check only, install nothing
#   bash scripts/setup.sh --start    setup, build, then start the workbench
#
# Safe by design: no sudo, nothing installed system-wide, no shell rc edits.
# It installs only inside this repo: node_modules (npm ci) and Maestro 2.11.0
# in .tnt/tools/maestro. Everything else is checked and explained.
# Works with macOS's built-in bash 3.2.

set -u
set -o pipefail

MAESTRO_VERSION="2.11.0"
MAESTRO_URL="https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip"
# From the release's checksums_sha256.txt (cli-2.11.0).
MAESTRO_SHA256="5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a"
NODE_MIN="22.12.0"
JAVA_MIN=17

MODE="setup"
START=0
PORT_VALUE="${PORT:-4317}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/setup.sh [--check | --start] [--port N]

  (no flag)   Check prerequisites, install project-local parts
              (npm ci, Maestro 2.11.0 in .tnt/tools/maestro), and build.
  --check     Check only. Installs and builds nothing.
  --start     Do the default setup, then start TnT (npm start).
  --port N    Port for --start (default: $PORT or 4317).
  -h, --help  Show this help.

Downloads respect HTTPS_PROXY / https_proxy. For a company TLS-inspection
certificate, set CURL_CA_BUNDLE (curl) and NODE_EXTRA_CA_CERTS (npm/node)
to the company CA .pem file.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --start) START=1 ;;
    --port)
      shift
      [ $# -gt 0 ] || { echo "--port needs a value" >&2; exit 2; }
      PORT_VALUE="$1" ;;
    --port=*) PORT_VALUE="${1#--port=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "check" ] && [ "$START" -eq 1 ]; then
  echo "--check and --start cannot be combined." >&2
  exit 2
fi
case "$PORT_VALUE" in
  ''|*[!0-9]*) echo "Port must be a number from 1024 to 65535." >&2; exit 2 ;;
esac
if [ "$PORT_VALUE" -lt 1024 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  echo "Port must be a number from 1024 to 65535." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
if [ ! -f package.json ] || [ ! -f server/main.ts ]; then
  echo "Run this from a TnT checkout (scripts/setup.sh inside the repo)." >&2
  exit 1
fi

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_WARN=""; C_DIM=""; C_OFF=""
fi

# Result table (parallel arrays: bash 3.2 has no associative arrays).
R_NAME=(); R_STATUS=(); R_DETAIL=(); R_FIX=()
record() { # name status detail fix
  R_NAME+=("$1"); R_STATUS+=("$2"); R_DETAIL+=("$3"); R_FIX+=("${4:-}")
  local colour="$C_OK"
  case "$2" in MISSING|FAILED) colour="$C_BAD" ;; WARN|INFO|SKIPPED) colour="$C_WARN" ;; esac
  printf '  %-12s %s%-8s%s %s\n' "$1" "$colour" "$2" "$C_OFF" "$3"
}
step() { printf '\n%s==>%s %s\n' "$C_DIM" "$C_OFF" "$1"; }
tilde() { printf '%s' "$1" | sed "s|^$HOME|~|"; }

# version_ge A B: true when dotted version A >= B.
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    [ "${x:-0}" -gt "${y:-0}" ] && return 0
    [ "${x:-0}" -lt "${y:-0}" ] && return 1
  done
  return 0
}

# curl error code -> human explanation for proxy/corporate networks.
curl_hint() {
  case "$1" in
    5) echo "could not resolve the proxy. Check HTTPS_PROXY." ;;
    6) echo "could not resolve github.com. Check DNS, VPN or set HTTPS_PROXY." ;;
    7) echo "could not connect. If you are behind a company proxy, set HTTPS_PROXY=http://proxy:port." ;;
    22) echo "the server returned an HTTP error (blocked by a proxy/firewall, or the URL changed)." ;;
    28) echo "the download timed out. Retry, or check the proxy/VPN." ;;
    35|60|77|83) echo "TLS certificate problem. A company network that inspects HTTPS needs its CA: export CURL_CA_BUNDLE=/path/to/company-ca.pem and retry." ;;
    *) echo "curl failed with exit code $1." ;;
  esac
}

OVERALL_REQUIRED_OK=1
mark_bad() { OVERALL_REQUIRED_OK=0; }

echo "TnT setup  (mode: $MODE$([ "$START" -eq 1 ] && echo ' + start'))"
echo "Repo: $(tilde "$ROOT")"
[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && echo "Proxy: HTTPS_PROXY is set (downloads will use it)"

# ---------------------------------------------------------------- macOS
step "System"
OS_NAME="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS_NAME" = "Darwin" ]; then
  MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
  record "macOS" "OK" "$MACOS_VERSION ($ARCH)"
else
  MACOS_VERSION="n/a"
  record "macOS" "MISSING" "$OS_NAME ($ARCH): TnT runs only on macOS" "Use a Mac."
  mark_bad
fi

# ---------------------------------------------------------------- Xcode
XCODE_DIR="$(xcode-select -p 2>/dev/null || true)"
SIMCTL_OK=0
if [ -x /usr/bin/xcrun ] && /usr/bin/xcrun --find simctl >/dev/null 2>&1; then SIMCTL_OK=1; fi
if [ "$SIMCTL_OK" -eq 1 ]; then
  XCODE_VER="$( (xcodebuild -version 2>/dev/null || true) | head -1)"
  RUNTIMES="$(/usr/bin/xcrun simctl list runtimes 2>/dev/null | grep -E '^iOS ' | grep -v unavailable || true)"
  RUNTIME_COUNT="$(printf '%s' "$RUNTIMES" | grep -c '^iOS ' || true)"
  if [ "${RUNTIME_COUNT:-0}" -gt 0 ]; then
    LATEST_RT="$(printf '%s\n' "$RUNTIMES" | tail -1 | sed -E 's/^(iOS [0-9.]+).*/\1/')"
    record "Xcode" "OK" "${XCODE_VER:-Xcode} at $(tilde "$XCODE_DIR")"
    record "iOS sim" "OK" "$RUNTIME_COUNT iOS runtime(s), latest $LATEST_RT"
  else
    record "Xcode" "OK" "${XCODE_VER:-Xcode} at $(tilde "$XCODE_DIR")"
    record "iOS sim" "MISSING" "no iOS simulator runtime installed" \
      "Xcode > Settings > Components > iOS (or: xcodebuild -downloadPlatform iOS)."
    mark_bad
  fi
else
  if [ -n "$XCODE_DIR" ] && [ "${XCODE_DIR#*CommandLineTools}" != "$XCODE_DIR" ]; then
    DETAIL="only Command Line Tools selected ($XCODE_DIR); simctl needs full Xcode"
  else
    DETAIL="Xcode / simctl not found"
  fi
  FIX="Install Xcode (App Store or Self Service). If it is installed but not selected and you have no admin rights: export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer (or ask IT to run xcode-select -s)."
  for app in /Applications/Xcode*.app; do
    [ -d "$app" ] && FIX="Found $app. Select it without admin: export DEVELOPER_DIR=$app/Contents/Developer (add to ~/.zshrc yourself), or ask IT: sudo xcode-select -s $app" && break
  done
  record "Xcode" "MISSING" "$DETAIL" "$FIX"
  record "iOS sim" "MISSING" "needs Xcode first" "Install Xcode, then an iOS simulator runtime."
  mark_bad
fi

# ---------------------------------------------------------------- Node
step "Node.js and npm"
NODE_OK=0
NODE_FIX="Install Node $NODE_MIN+ : brew install node  |  official installer https://nodejs.org (needs admin)  |  no admin: download the macOS .tar.gz from https://nodejs.org/en/download, extract to ~/.local/node and add ~/.local/node/bin to PATH (or use nvm / fnm)."
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v 2>/dev/null | sed 's/^v//')"
  if version_ge "$NODE_V" "$NODE_MIN"; then
    NODE_OK=1
    record "Node.js" "OK" "v$NODE_V ($(tilde "$(command -v node)"))"
  else
    record "Node.js" "MISSING" "v$NODE_V is older than $NODE_MIN" "$NODE_FIX"
    mark_bad
  fi
else
  record "Node.js" "MISSING" "node not found on PATH" "$NODE_FIX"
  mark_bad
fi
if [ "$NODE_OK" -eq 1 ] && command -v npm >/dev/null 2>&1; then
  NPM_OK=1
else
  NPM_OK=0
fi

LOCK_SHA="$(shasum -a 256 package-lock.json 2>/dev/null | awk '{print $1}')"
STAMP="node_modules/.tnt-setup-lock-sha256"
deps_current() { [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_SHA" ]; }

DEPS_OK=0
if [ "$NPM_OK" -eq 0 ]; then
  record "npm deps" "SKIPPED" "needs Node $NODE_MIN+ with npm" "$NODE_FIX"
  mark_bad
elif deps_current; then
  DEPS_OK=1
  record "npm deps" "OK" "node_modules matches package-lock.json"
elif [ "$MODE" = "check" ]; then
  if [ -d node_modules ] && npm ls --depth=0 >/dev/null 2>&1; then
    DEPS_OK=1
    record "npm deps" "OK" "node_modules present (not installed by this script; run without --check to reinstall exactly)"
  else
    record "npm deps" "MISSING" "node_modules missing or out of date" "Run: bash scripts/setup.sh  (runs npm ci)"
    mark_bad
  fi
else
  echo "  Installing exact dependencies: npm ci (this can take a minute)..."
  NPM_LOG="$(mktemp -t tnt-npm-ci)"
  if npm ci --no-audit --no-fund >"$NPM_LOG" 2>&1; then
    printf '%s' "$LOCK_SHA" >"$STAMP"
    DEPS_OK=1
    record "npm deps" "OK" "installed with npm ci ($(grep -Eo 'added [0-9]+ packages' "$NPM_LOG" | head -1))"
    rm -f "$NPM_LOG"
  else
    tail -15 "$NPM_LOG" | sed 's/^/    | /'
    HINT="See the npm output above."
    if grep -Eqi 'SELF_SIGNED|UNABLE_TO_GET_ISSUER|CERT_|certificate' "$NPM_LOG"; then
      HINT="TLS certificate problem (company HTTPS inspection). export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem and retry."
    elif grep -Eqi 'ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET' "$NPM_LOG"; then
      HINT="Network problem reaching the npm registry. Behind a proxy: npm config set proxy \$HTTPS_PROXY; npm config set https-proxy \$HTTPS_PROXY (or ask IT for the internal registry)."
    fi
    record "npm deps" "FAILED" "npm ci failed (log: $(tilde "$NPM_LOG"))" "$HINT"
    mark_bad
  fi
fi

# ---------------------------------------------------------------- Java
# Mirrors server/maestro.ts: JAVA_HOME if it has bin/java, else java_home -v 17.
step "Java"
JAVA_EFFECTIVE=""
JAVA_SOURCE=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
  JAVA_EFFECTIVE="$JAVA_HOME"; JAVA_SOURCE="JAVA_HOME"
elif [ -x /usr/libexec/java_home ]; then
  JH="$(/usr/libexec/java_home -v "$JAVA_MIN" 2>/dev/null || true)"
  if [ -n "$JH" ] && [ -x "$JH/bin/java" ]; then
    JAVA_EFFECTIVE="$JH"
    JAVA_SOURCE="java_home -v $JAVA_MIN"
    [ -n "${JAVA_HOME:-}" ] && JAVA_SOURCE="$JAVA_SOURCE (your JAVA_HOME is invalid and is ignored by TnT)"
  fi
fi
JAVA_FIX="Install a JDK 17: brew install openjdk@17 then export JAVA_HOME=\$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home  |  no admin: download the Temurin 17 macOS .tar.gz from https://adoptium.net/temurin/releases/?version=17 and extract it into ~/Library/Java/JavaVirtualMachines/ (TnT finds it automatically)."
JAVA_OK=0
if [ -n "$JAVA_EFFECTIVE" ]; then
  JAVA_VLINE="$("$JAVA_EFFECTIVE/bin/java" -version 2>&1 | head -1)"
  JAVA_V="$(printf '%s' "$JAVA_VLINE" | sed -E 's/.*version "([^"]+)".*/\1/')"
  JAVA_MAJOR="${JAVA_V%%.*}"
  [ "$JAVA_MAJOR" = "1" ] && JAVA_MAJOR="$(printf '%s' "$JAVA_V" | cut -d. -f2)"
  case "$JAVA_MAJOR" in ''|*[!0-9]*) JAVA_MAJOR=0 ;; esac
  if [ "$JAVA_MAJOR" -ge "$JAVA_MIN" ]; then
    JAVA_OK=1
    record "Java" "OK" "$JAVA_V via $JAVA_SOURCE"
  else
    record "Java" "MISSING" "$JAVA_V via $JAVA_SOURCE is older than $JAVA_MIN" "$JAVA_FIX"
    mark_bad
  fi
else
  DETAIL="no JDK $JAVA_MIN found (JAVA_HOME unset/invalid and java_home -v $JAVA_MIN found nothing)"
  if command -v java >/dev/null 2>&1 && /usr/libexec/java_home >/dev/null 2>&1; then
    DETAIL="$DETAIL; other JDKs exist but TnT needs JAVA_HOME set to a 17+ JDK or a JDK 17 install"
  fi
  record "Java" "MISSING" "$DETAIL" "$JAVA_FIX"
  mark_bad
fi

# ---------------------------------------------------------------- Maestro
step "Maestro $MAESTRO_VERSION"
LOCAL_MAESTRO_DIR="$ROOT/.tnt/tools/maestro"
if [ -n "${MAESTRO_BIN:-}" ]; then
  MAESTRO_FILE="$MAESTRO_BIN"; MAESTRO_SOURCE="MAESTRO_BIN"
else
  MAESTRO_FILE="$LOCAL_MAESTRO_DIR/bin/maestro"; MAESTRO_SOURCE=".tnt/tools/maestro"
fi

maestro_version() { # file -> prints version or nothing
  [ -x "$1" ] || return 1
  [ -n "$JAVA_EFFECTIVE" ] || return 1
  env JAVA_HOME="$JAVA_EFFECTIVE" MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "$1" --version 2>/dev/null | tail -1 | tr -d '[:space:]'
}

install_maestro() {
  local dl_dir="$ROOT/.tnt/tools/.download"
  local zip="$dl_dir/maestro-$MAESTRO_VERSION.zip"
  mkdir -p "$dl_dir" || return 1
  if [ -f "$zip" ] && [ "$(shasum -a 256 "$zip" | awk '{print $1}')" = "$MAESTRO_SHA256" ]; then
    echo "  Using cached download $(tilde "$zip")"
  else
    rm -f "$zip" "$zip.part"
    echo "  Downloading Maestro $MAESTRO_VERSION (~300 MB) from GitHub releases..."
    local code=0
    curl -fL --retry 2 --connect-timeout 20 --progress-bar -o "$zip.part" "$MAESTRO_URL" || code=$?
    if [ "$code" -ne 0 ]; then
      rm -f "$zip.part"
      MAESTRO_ERR="download failed: $(curl_hint "$code")"
      return 1
    fi
    mv "$zip.part" "$zip"
    local got
    got="$(shasum -a 256 "$zip" | awk '{print $1}')"
    if [ "$got" != "$MAESTRO_SHA256" ]; then
      rm -f "$zip"
      MAESTRO_ERR="checksum mismatch (got $got). A proxy may have altered the download; it was deleted."
      return 1
    fi
    echo "  Checksum OK (sha256 matches the release's checksums_sha256.txt)"
  fi
  local tmp
  tmp="$(mktemp -d "$ROOT/.tnt/tools/.maestro-unpack.XXXXXX")" || return 1
  if ! /usr/bin/unzip -q "$zip" -d "$tmp"; then
    rm -rf "$tmp"; MAESTRO_ERR="could not unzip $zip"; return 1
  fi
  local src="$tmp/maestro"
  [ -x "$src/bin/maestro" ] || src="$(dirname "$(dirname "$(find "$tmp" -path '*/bin/maestro' -type f | head -1)")")"
  if [ ! -x "$src/bin/maestro" ]; then
    rm -rf "$tmp"; MAESTRO_ERR="unexpected archive layout (no bin/maestro)"; return 1
  fi
  if [ -e "$LOCAL_MAESTRO_DIR" ]; then
    local backup
    backup="$LOCAL_MAESTRO_DIR.previous-$(date +%Y%m%d%H%M%S)"
    mv "$LOCAL_MAESTRO_DIR" "$backup" && echo "  Kept the previous copy at $(tilde "$backup")"
  fi
  mv "$src" "$LOCAL_MAESTRO_DIR" && rm -rf "$tmp" && rm -f "$zip"
}

MAESTRO_V="$(maestro_version "$MAESTRO_FILE" || true)"
MAESTRO_ERR=""
if [ "$MAESTRO_V" = "$MAESTRO_VERSION" ]; then
  record "Maestro" "OK" "$MAESTRO_V via $MAESTRO_SOURCE"
elif [ -n "${MAESTRO_BIN:-}" ]; then
  if [ -n "$MAESTRO_V" ]; then D="MAESTRO_BIN is $MAESTRO_V, TnT needs exactly $MAESTRO_VERSION"
  elif [ "$JAVA_OK" -eq 0 ]; then D="cannot verify MAESTRO_BIN without Java $JAVA_MIN+"
  else D="MAESTRO_BIN=$(tilde "$MAESTRO_BIN") does not run"; fi
  record "Maestro" "MISSING" "$D" "Unset MAESTRO_BIN to let this script install $MAESTRO_VERSION into .tnt/tools/maestro, or point it at a $MAESTRO_VERSION install."
  mark_bad
elif [ "$MODE" = "check" ]; then
  if [ -x "$MAESTRO_FILE" ] && [ "$JAVA_OK" -eq 0 ]; then D="present in .tnt/tools/maestro but cannot verify without Java $JAVA_MIN+"
  elif [ -n "$MAESTRO_V" ]; then D="found $MAESTRO_V, TnT needs exactly $MAESTRO_VERSION"
  else D="not installed in .tnt/tools/maestro"; fi
  record "Maestro" "MISSING" "$D" "Run: bash scripts/setup.sh  (downloads $MAESTRO_VERSION into the project)"
  mark_bad
else
  if install_maestro; then
    MAESTRO_V="$(maestro_version "$MAESTRO_FILE" || true)"
    if [ "$MAESTRO_V" = "$MAESTRO_VERSION" ]; then
      record "Maestro" "OK" "installed $MAESTRO_V into .tnt/tools/maestro (checksum verified)"
    elif [ "$JAVA_OK" -eq 0 ]; then
      record "Maestro" "WARN" "installed into .tnt/tools/maestro (checksum verified); version check needs Java $JAVA_MIN+" "Install Java 17, then re-run this script."
      mark_bad
    else
      record "Maestro" "FAILED" "installed but --version printed '${MAESTRO_V:-nothing}'" "Re-run; if it persists, delete .tnt/tools/maestro and retry."
      mark_bad
    fi
  else
    record "Maestro" "FAILED" "${MAESTRO_ERR:-install failed}" "Fix the network issue and re-run, or download $MAESTRO_URL manually and extract its maestro/ folder to .tnt/tools/maestro"
    mark_bad
  fi
fi

# ---------------------------------------------------------------- Build
step "Build"
if [ "$MODE" = "check" ]; then
  if [ -f dist/index.html ]; then record "Build" "OK" "dist/ exists (built $(date -r dist/index.html '+%Y-%m-%d %H:%M'))"
  else record "Build" "INFO" "not built yet" "Run: bash scripts/setup.sh  (runs npm run build)"; fi
elif [ "$DEPS_OK" -eq 1 ]; then
  BUILD_LOG="$(mktemp -t tnt-build)"
  echo "  npm run build..."
  if npm run build >"$BUILD_LOG" 2>&1; then
    record "Build" "OK" "npm run build passed"; rm -f "$BUILD_LOG"
  else
    tail -20 "$BUILD_LOG" | sed 's/^/    | /'
    record "Build" "FAILED" "npm run build failed (log: $(tilde "$BUILD_LOG"))" "See the output above."
    mark_bad
  fi
else
  record "Build" "SKIPPED" "needs npm dependencies first"; mark_bad
fi

# ---------------------------------------------------------------- Port
step "Port"
PORT_BUSY=""
if command -v lsof >/dev/null 2>&1; then
  PORT_BUSY="$(lsof -nP -iTCP:"$PORT_VALUE" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
fi
if [ -n "$PORT_BUSY" ]; then
  record "Port" "WARN" "$PORT_VALUE is in use (pid $PORT_BUSY)" "Stop that process or use --port / PORT=<other>."
else
  record "Port" "OK" "$PORT_VALUE is free"
fi

# ---------------------------------------------------------------- AI (info)
step "AI (optional, informational)"
if command -v copilot >/dev/null 2>&1; then
  COP_V="$(copilot --version 2>/dev/null | head -1)"
  record "Copilot CLI" "INFO" "present (${COP_V:-version unknown}); TnT does not use it yet"
else
  record "Copilot CLI" "INFO" "not installed; TnT does not use it yet"
fi
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then record "GitHub CLI" "INFO" "gh present, signed in"
  else record "GitHub CLI" "INFO" "gh present, not signed in"; fi
else
  record "GitHub CLI" "INFO" "gh not installed"
fi
echo "  ${C_DIM}In-app AI today needs an OpenRouter / OpenAI-compatible key; Copilot support is not built yet. No tokens were read.${C_OFF}"

# ---------------------------------------------------------------- Fixes
FIXES=0
for i in "${!R_NAME[@]}"; do
  case "${R_STATUS[$i]}" in
    MISSING|FAILED|WARN)
      [ "$FIXES" -eq 0 ] && step "How to fix"
      FIXES=1
      printf '  - %s: %s\n' "${R_NAME[$i]}" "${R_FIX[$i]:-see details above}" ;;
  esac
done

# ---------------------------------------------------------------- Summary
if [ "$OVERALL_REQUIRED_OK" -eq 1 ]; then VERDICT="READY"; else VERDICT="NOT READY"; fi
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo
echo "----- TnT setup summary (copy from here) -----"
echo "result:   $VERDICT"
echo "mode:     $MODE$([ "$START" -eq 1 ] && echo ' + start')"
echo "date:     $(date '+%Y-%m-%d %H:%M %Z')"
echo "repo:     $GIT_SHA"
echo "system:   macOS $MACOS_VERSION $ARCH"
for i in "${!R_NAME[@]}"; do
  printf '%-12s %-8s %s\n' "${R_NAME[$i]}" "${R_STATUS[$i]}" "${R_DETAIL[$i]}"
done
echo "----- end of summary -----"

if [ "$VERDICT" != "READY" ]; then
  [ "$START" -eq 1 ] && echo "Not starting TnT: fix the items above first."
  exit 1
fi

if [ "$START" -eq 1 ]; then
  if [ -n "$PORT_BUSY" ]; then
    echo "Port $PORT_VALUE is busy; choose another with --port." >&2
    exit 1
  fi
  echo
  echo "Starting TnT on http://127.0.0.1:$PORT_VALUE  (Ctrl-C to stop)"
  PORT="$PORT_VALUE" exec npm start
else
  echo
  if [ "$MODE" = "check" ]; then
    echo "Next: bash scripts/setup.sh --start"
  else
    echo "Next: npm start   (or bash scripts/setup.sh --start), then open http://127.0.0.1:$PORT_VALUE"
  fi
fi
