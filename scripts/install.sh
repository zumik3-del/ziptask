#!/bin/sh
# ziptask one-line installer
# Usage: curl -LsS https://raw.githubusercontent.com/zumik3-del/ziptask/main/scripts/install.sh | sh
# Env: ZIPTASK_VERSION=<tag>  ZIPTASK_HOME=<dir>  --force  --port <port>  --no-service

set -e

VERSION="${ZIPTASK_VERSION:-}"
HOME_DIR=""
BIN=""
BINARY=""
SETTINGS=""
TARGET_USER=""
TARGET_HOME=""
DB_PATH=""
REPO_URL="https://github.com/zumik3-del/ziptask/releases"
REPO_API="https://api.github.com/repos/zumik3-del/ziptask"
FORCE=false
INSTALL_PORT=3005
NO_SERVICE=false
SERVICE_INSTALLED=false

# --- Parse arguments ---

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)
        FORCE=true
        shift
        ;;
      --port)
        INSTALL_PORT="$2"
        shift 2
        ;;
      --no-service)
        NO_SERVICE=true
        shift
        ;;
      --help|-h)
        echo "Usage: curl -LsS ... | sh [-s --] [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --force          Overwrite existing installation"
        echo "  --port PORT      HTTP listen port (default: 3005)"
        echo "  --no-service     Skip systemd service installation"
        echo "  --help, -h       Show this help"
        echo ""
        echo "Env vars (set on the sh side of the pipe):"
        echo "  ZIPTASK_VERSION   Install specific version (e.g. v0.2.0)"
        echo "  ZIPTASK_HOME      Install directory (default: ~/.ziptask)"
        echo ""
        echo "Example:"
        echo "  curl -LsS <install-url> | ZIPTASK_VERSION=v0.2.0 sh"
        echo ""
        echo "Service mode (default: enabled on systemd systems):"
        echo "  Installs /etc/systemd/system/ziptask.service (uses sudo)"
        echo "  Skipped automatically when root access is unavailable"
        echo "  Start:  sudo systemctl start ziptask"
        echo "  Stop:   sudo systemctl stop ziptask"
        echo "  Logs:   journalctl -u ziptask -f"
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

# Check if systemd is actually running.
# Accepts "running" and "degraded" — both mean systemd is up.
systemd_running() {
  local state
  state=$(systemctl is-system-running 2>&1) || true
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

# `curl | sudo sh` runs as root: install for the invoking user, not root.
resolve_target_user() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    TARGET_USER="$SUDO_USER"
  else
    TARGET_USER="$(id -un)"
  fi
  TARGET_HOME=""
  if command -v getent >/dev/null 2>&1; then
    TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)" || true
  fi
  [ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"
  HOME_DIR="${ZIPTASK_HOME:-$TARGET_HOME/.ziptask}"
  BIN="$HOME_DIR/bin"
  BINARY="$BIN/ziptask"
  SETTINGS="$HOME_DIR/settings.json"
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

resolve_target_user

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
    echo "      \"args\": [\"--stdio\", \"--settings\", \"${SETTINGS}\"]"
    echo "    }"
    echo "  }"
    echo ""
    echo "Upgrade: bash ${HOME_DIR}/scripts/update.sh"
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

DL_TMP="${BIN}/.ziptask.$$.tmp"
trap 'rm -f "$DL_TMP"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fLsS -o "$DL_TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$DL_TMP" "$URL"
else
  error "need curl or wget"
fi

chmod +x "$DL_TMP"

DOWNLOADED_VER="$("$DL_TMP" --version 2>/dev/null || echo "")"
case "$DOWNLOADED_VER" in
  "ziptask $VERSION_NUM") ;;
  *) error "downloaded binary failed version check (got '${DOWNLOADED_VER:-nothing}', expected 'ziptask ${VERSION_NUM}')" ;;
esac

mv -f "$DL_TMP" "$BINARY"

# --- Create / preserve settings ---

if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<EOF
{
  "dbPath": "${HOME_DIR}/data/ziptask.db",
  "host": "127.0.0.1",
  "port": ${INSTALL_PORT},
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
  info "Wrote default settings to ${SETTINGS} (port=${INSTALL_PORT})"
else
  info "Preserved existing settings at ${SETTINGS}"
fi

# --- Install helper scripts ---

install_helper_scripts() {
  local scripts_dir="$HOME_DIR/scripts"
  local base_url="https://raw.githubusercontent.com/zumik3-del/ziptask/${VERSION}/scripts"
  mkdir -p "$scripts_dir"
  for script in update.sh uninstall.sh; do
    local dest="$scripts_dir/$script"
    if command -v curl >/dev/null 2>&1; then
      if curl -fLsS -o "$dest" "$base_url/$script" 2>/dev/null; then continue; fi
    else
      if wget -qO "$dest" "$base_url/$script" 2>/dev/null; then continue; fi
    fi
    rm -f "$dest"
    warn "could not fetch ${script} for ${VERSION}; use the copy in the repository instead"
  done
  chmod +x "$scripts_dir"/*.sh 2>/dev/null || true
  info "Installed helper scripts to ${scripts_dir}"
}

install_helper_scripts

# --- Install systemd service ---

install_service() {
  if [ "$NO_SERVICE" = true ]; then
    info "Skipping systemd service (--no-service)"
    return
  fi

  if [ ! -d /etc/systemd/system ]; then
    info "systemd not found — skipping service installation"
    warn "Start manually: ${BINARY}"
    return
  fi

  if ! systemd_running; then
    warn "systemd not running — skipping service installation"
    warn "Start manually: ${BINARY}"
    return
  fi

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    warn "sudo not available — skipping service installation"
    warn "Start manually: ${BINARY}"
    return
  fi

  local service_file="/etc/systemd/system/ziptask.service"

  if ! run_root tee "$service_file" >/dev/null <<EOF
[Unit]
Description=ziptask — MCP task tracker
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${HOME_DIR}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=ZIPTASK_HOST=127.0.0.1
Environment=ZIPTASK_PORT=${INSTALL_PORT}
ExecStart=${BINARY} --settings ${SETTINGS}
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
EOF
  then
    warn "Could not write ${service_file} (root access required) — skipping service installation"
    warn "Start manually: ${BINARY}"
    return
  fi
  SERVICE_INSTALLED=true

  if run_root systemctl daemon-reload; then
    info "Installed systemd unit: ${service_file}"
  else
    warn "systemctl daemon-reload failed"
  fi

  if run_root systemctl enable ziptask >/dev/null 2>&1; then
    info "Enabled ziptask service"
  else
    warn "Could not enable ziptask service"
  fi

  if run_root systemctl start ziptask >/dev/null 2>&1; then
    info "Started ziptask service"
  else
    warn "Could not start ziptask service; check: journalctl -u ziptask"
  fi
}

install_service

# --- Verify installation ---

verify_installation() {
  if [ "$NO_SERVICE" = true ]; then
    return
  fi

  if ! systemd_running; then
    info "systemd not running — skip health check"
    return
  fi

  if ! systemctl is-active ziptask >/dev/null 2>&1; then
    info "Service not active yet — run: sudo systemctl start ziptask"
    return
  fi

  if curl -sf "http://127.0.0.1:${INSTALL_PORT}/health" >/dev/null 2>&1; then
    info "Service healthy at http://127.0.0.1:${INSTALL_PORT}"
  else
    warn "Service installed but health check failed"
    warn "Check logs: journalctl -u ziptask -f"
  fi
}

verify_installation

# --- Summary ---

echo ""
echo "=== ziptask installed ==="
echo ""
echo "  Version:    ${VERSION_NUM}"
echo "  Binary:     ${BINARY}"
echo "  Settings:   ${SETTINGS}"
echo "  Port:       ${INSTALL_PORT}"
echo ""

if [ "$SERVICE_INSTALLED" = true ]; then
  echo "  Service:    /etc/systemd/system/ziptask.service"
  echo "  Start:      sudo systemctl start ziptask"
  echo "  Stop:       sudo systemctl stop ziptask"
  echo "  Logs:       journalctl -u ziptask -f"
else
  echo "  Service:    skipped"
  echo "  Start:      ${BINARY} --settings ${SETTINGS}"
  echo "  Logs:       stdout"
fi

echo ""
echo "  MCP client config (stdio):"
echo ""
echo "    \"mcpServers\": {"
echo "      \"ziptask\": {"
echo "        \"command\": \"${BINARY}\","
echo "        \"args\": [\"--stdio\", \"--settings\", \"${SETTINGS}\"]"
echo "      }"
echo "    }"
echo ""
if [ "$SERVICE_INSTALLED" = true ]; then
  echo "  MCP client config (remote HTTP, same host):"
  echo ""
  echo "    \"mcp\": {"
  echo "      \"ziptask\": { \"type\": \"remote\", \"url\": \"http://127.0.0.1:${INSTALL_PORT}/mcp\" }"
  echo "    }"
  echo ""
fi
echo "  Upgrade:    bash ${HOME_DIR}/scripts/update.sh"
echo "  Uninstall:  bash ${HOME_DIR}/scripts/uninstall.sh"
echo ""
