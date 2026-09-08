#!/bin/sh
# ziptask one-line installer
# Usage: curl -LsS https://raw.githubusercontent.com/zumik3-del/ziptask/main/scripts/install.sh | sh
# Env: ZIPTASK_VERSION=<tag>  ZIPTASK_HOME=<dir>  --force

set -e

VERSION="${ZIPTASK_VERSION:-}"
HOME_DIR="${ZIPTASK_HOME:-$HOME/.ziptask}"
BIN="$HOME_DIR/bin"
BINARY="$BIN/ziptask"
SETTINGS="$HOME_DIR/settings.json"
REPO_URL="https://github.com/zumik3-del/ziptask/releases"
REPO_API="https://api.github.com/repos/zumik3-del/ziptask"
FORCE=false

# --- Parse arguments ---

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)
        FORCE=true
        shift
        ;;
      --help|-h)
        echo "Usage: curl -LsS ... | sh [-s --] [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --force         Overwrite existing installation"
        echo "  --help, -h      Show this help"
        echo ""
        echo "Env vars:"
        echo "  ZIPTASK_VERSION   Install specific version (e.g. v0.2.0)"
        echo "  ZIPTASK_HOME      Install directory (default: ~/.ziptask)"
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done
}

parse_args "$@"

# --- Helpers ---

info()  { echo "[ziptask] $*"; }
warn()  { echo "[ziptask] WARNING: $*" >&2; }
error() { echo "[ziptask] ERROR: $*" >&2; exit 1; }

# --- Detect platform ---

detect_os() {
  case "$(uname -s)" in
    Linux*) echo linux ;;
    Darwin*) echo darwin ;;
    *) echo "";;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64) echo x86_64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "";;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ -z "$OS" ] || [ -z "$ARCH" ]; then
  error "unsupported OS '$OS' or arch '$ARCH' (expected linux/darwin + x86_64/arm64)"
fi

# --- Resolve version ---

if [ -z "$VERSION" ]; then
  info "Determining latest release..."
  VERSION=$(curl -fsSL "$REPO_API/releases/latest" 2>/dev/null | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//' || echo "")
  if [ -z "$VERSION" ]; then
    error "Could not determine latest version. Set ZIPTASK_VERSION manually."
  fi
fi

# Normalize: ensure 'v' prefix
case "$VERSION" in
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac

VERSION_NUM="${VERSION#v}"

# --- Check existing installation ---

if [ -f "$BINARY" ] && [ "$FORCE" = false ]; then
  INSTALLED_VER="$("$BINARY" --version 2>/dev/null || echo "unknown")"
  INSTALLED_TAG="${INSTALLED_VER#ziptask }"
  if [ "$INSTALLED_TAG" = "$VERSION_NUM" ]; then
    echo ""
    echo "ziptask v${VERSION_NUM} already installed at ${BINARY}"
    echo ""
    echo "MCP client config (stdio):"
    echo ""
    echo "  \"mcpServers\": {"
    echo "    \"ziptask\": {"
    echo "      \"command\": \"${BINARY}\","
    echo "      \"args\": [\"--stdio\"]"
    echo "    }"
    echo "  }"
    echo ""
    echo "Upgrade: ZIPTASK_VERSION=<tag> $(printf '%q' "$0")"
    exit 0
  fi
  if [ "$INSTALLED_TAG" != "unknown" ] && [ "$(printf '%s\n%s\n' "$INSTALLED_TAG" "$VERSION_NUM" | sort -V | head -n1)" = "$VERSION_NUM" ]; then
    if [ "$FORCE" = false ]; then
      error "newer version (${INSTALLED_TAG}) already installed; use --force to override"
    fi
  fi
fi

# --- Download ---

ASSET="ziptask-${OS}-${ARCH}"
URL="${REPO_URL}/download/${VERSION}/${ASSET}"

mkdir -p "$BIN"
info "Downloading ${ASSET} ${VERSION} ..."

if command -v curl >/dev/null 2>&1; then
  curl -fLsS -o "$BINARY" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BINARY" "$URL"
else
  error "need curl or wget"
fi

chmod +x "$BINARY"

# --- Create settings ---

if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<'EOF'
{
  "dbPath": "./data/ziptask.db",
  "host": "127.0.0.1",
  "port": 0,
  "leaseTtlMin": 15,
  "maxAttempts": 3,
  "http": {
    "maxSessions": 100,
    "sessionTtlMs": 3600000
  },
  "defaults": {
    "priority": "p2",
    "reporter": "system",
    "listLimit": 50,
    "timelineLimit": 50,
    "queueLimit": 100
  }
}
EOF
  info "Wrote default settings to ${SETTINGS}"
fi

# --- Summary ---

echo ""
echo "=== ziptask installed ==="
echo ""
echo "  Version:    ${VERSION_NUM}"
echo "  Binary:     ${BINARY}"
echo "  Settings:   ${SETTINGS}"
echo ""
echo "  MCP client config (stdio):"
echo ""
echo "    \"mcpServers\": {"
echo "      \"ziptask\": {"
echo "        \"command\": \"${BINARY}\","
echo "        \"args\": [\"--stdio\"]"
echo "      }"
echo "    }"
echo ""
echo "  Upgrade:    ZIPTASK_VERSION=<tag> bash ${HOME_DIR}/scripts/update.sh"
echo "  Uninstall:  rm -rf ${HOME_DIR}"
echo ""
