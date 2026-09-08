#!/bin/bash
# ziptask updater
# Usage: bash ~/.ziptask/scripts/update.sh [--version <tag>]
set -euo pipefail

HOME_DIR="${ZIPTASK_HOME:-$HOME/.ziptask}"
BIN="$HOME_DIR/bin"
BINARY="$BIN/ziptask"
REPO_API="https://api.github.com/repos/zumik3-del/ziptask"
REPO_URL="https://github.com/zumik3-del/ziptask/releases"
VERSION=""

info()  { echo "[ziptask] $*"; }
warn()  { echo "[ziptask] WARNING: $*" >&2; }

systemd_running() {
  local state
  state=$(systemctl is-system-running 2>&1) || true
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        VERSION="$2"
        shift 2
        ;;
      --help|-h)
        echo "Usage: bash $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --version TAG   Update to specific version (e.g. v0.2.0)"
        echo "  --help, -h      Show this help"
        exit 0
        ;;
      *)
        echo "[ziptask] Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done
}

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

parse_args "$@"

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ -z "$OS" ] || [ -z "$ARCH" ]; then
  echo "error: unsupported OS '$OS' or arch '$ARCH'" >&2
  exit 1
fi

# Current version
CURRENT="unknown"
if [ -f "$BINARY" ]; then
  CURRENT=$("$BINARY" --version 2>/dev/null || echo "unknown")
  CURRENT="${CURRENT#ziptask }"
fi

# Latest version
if [ -z "$VERSION" ]; then
  info "Checking latest release..."
  VERSION=$(curl -fsSL "$REPO_API/releases/latest" 2>/dev/null | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//' || echo "")
  if [ -z "$VERSION" ]; then
    echo "[ziptask] Could not determine latest version. Check https://github.com/zumik3-del/ziptask/releases" >&2
    exit 1
  fi
fi

# Normalize: ensure 'v' prefix
case "$VERSION" in
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac

LATEST="${VERSION#v}"

echo "[ziptask] Current:  $CURRENT"
echo "[ziptask] Latest:   $LATEST"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "[ziptask] Already up to date."
  exit 0
fi

if [ "$CURRENT" != "unknown" ]; then
  echo ""
  read -p "[ziptask] Update ${CURRENT} -> ${LATEST}? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "[ziptask] Aborted."
    exit 0
  fi
fi

ASSET="ziptask-${OS}-${ARCH}"
URL="${REPO_URL}/download/${VERSION}/${ASSET}"

echo "[ziptask] Downloading ${ASSET} ${VERSION}..."
mkdir -p "$BIN"

if command -v curl >/dev/null 2>&1; then
  curl -fLsS -o "$BINARY" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BINARY" "$URL"
else
  echo "error: need curl or wget" >&2
  exit 1
fi

chmod +x "$BINARY"

# Restart service if systemd is active
if systemd_running; then
  if systemctl is-active ziptask &>/dev/null; then
    info "Restarting ziptask service..."
    if [ "$(id -u)" -eq 0 ]; then
      systemctl restart ziptask
    else
      sudo systemctl restart ziptask
    fi
    info "Service restarted."
  else
    info "Service not active — binary updated but you may want to start it:"
    info "  sudo systemctl start ziptask"
  fi
else
  warn "systemd not running — manual restart required:"
  warn "  ${BINARY}"
fi

echo ""
echo "[ziptask] Updated to ${LATEST}."
echo "[ziptask] Binary: $BINARY"
