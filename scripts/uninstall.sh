#!/bin/bash
# ziptask uninstaller
# Usage: bash ~/.ziptask/scripts/uninstall.sh [--keep-data]
set -euo pipefail

HOME_DIR="${ZIPTASK_HOME:-$HOME/.ziptask}"

info()  { echo "[ziptask] $*"; }
warn()  { echo "[ziptask] WARNING: $*" >&2; }

systemd_running() {
  local state
  state=$(systemctl is-system-running 2>&1) || true
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

# Run command as root if not already root
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

KEEP_DATA=false

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-data)
        KEEP_DATA=true
        shift
        ;;
      --help|-h)
        echo "Usage: bash $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --keep-data   Preserve DB and settings.json (only removes binary + scripts)"
        echo "  --help, -h    Show this help"
        echo ""
        echo "Removes:"
        echo "  Service:     /etc/systemd/system/ziptask.service"
        echo "  Install:     ${HOME_DIR}/"
        echo ""
        exit 0
        ;;
      *)
        echo "[ziptask] Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done
}

parse_args "$@"

echo "This will remove ziptask:"
echo "  - Service:  /etc/systemd/system/ziptask.service"
echo "  - Install:  ${HOME_DIR}/"
if [ "$KEEP_DATA" = false ]; then
  echo "  - Data:     ${HOME_DIR}/data/ (DB) and ${HOME_DIR}/settings.json"
fi
echo ""
read -p "Continue? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Stop service
if systemd_running && systemctl is-active ziptask &>/dev/null; then
  info "Stopping service..."
  run_root systemctl stop ziptask
fi

# Disable service
if systemd_running && systemctl is-enabled ziptask &>/dev/null; then
  info "Disabling service..."
  run_root systemctl disable ziptask 2>/dev/null || true
fi

# Remove service file
if [ -f /etc/systemd/system/ziptask.service ]; then
  info "Removing service file..."
  run_root rm /etc/systemd/system/ziptask.service
  if systemd_running; then
    run_root systemctl daemon-reload
  fi
fi

# Remove install directory (or keep data)
if [ -d "$HOME_DIR" ]; then
  if [ "$KEEP_DATA" = true ]; then
    # Remove binary and scripts, keep data/ and settings.json
    rm -rf "${HOME_DIR}/bin"
    rm -rf "${HOME_DIR}/scripts"
    info "Removed binary and scripts; kept data/ and settings.json"
  else
    info "Removing ${HOME_DIR}..."
    run_root rm -rf "$HOME_DIR"
  fi
fi

echo ""
info "ziptask uninstalled."
