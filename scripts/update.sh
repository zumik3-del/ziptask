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
DB_PATH=""
DB_BACKUP=""
DB_BACKUP_OK=false

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
        echo ""
        echo "DB backup:"
        echo "  Before swapping the binary, update.sh creates an online SQLite backup"
        echo "  of ZIPTASK_DB into ${HOME_DIR}/backups/ (best-effort)."
        echo "  The backup path is printed on success so a failed upgrade is reversible."
        echo "  If sqlite3 is unavailable or the DB does not exist, a warning is printed"
        echo "  and the update continues."
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

# Resolve DB path: ZIPTASK_DB env > dbPath from settings.json > default
resolve_db_path() {
  # 1. Explicit env var
  if [ -n "${ZIPTASK_DB:-}" ]; then
    echo "$ZIPTASK_DB"
    return
  fi

  # 2. settings.json dbPath (relative paths resolve against HOME_DIR)
  local settings="$HOME_DIR/settings.json"
  if [ -f "$settings" ]; then
    local dbPath
    dbPath=$(sed -n 's/.*"dbPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$settings" 2>/dev/null || true)
    if [ -n "$dbPath" ]; then
      # Relative paths are resolved against HOME_DIR (where WorkingDirectory points)
      case "$dbPath" in
        /*) echo "$dbPath" ;;
        *)  echo "$HOME_DIR/$dbPath" ;;
      esac
      return
    fi
  fi

  # 3. Default
  echo "$HOME_DIR/data/ziptask.db"
}

# Best-effort online backup via sqlite3 CLI .backup
# Mirrors scripts/backup.ts approach (wal_checkpoint + .backup), keeps raw .db
backup_db() {
  DB_PATH="$(resolve_db_path)"

  if [ ! -f "$DB_PATH" ]; then
    info "No DB at ${DB_PATH} — skipping backup."
    return
  fi

  if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 not found — cannot create DB backup. Update proceeds without one."
    return
  fi

  local backup_dir="$HOME_DIR/backups"
  local ts
  ts=$(date -u +%Y-%m-%dT%H-%M-%S)
  DB_BACKUP="$backup_dir/ziptask-${ts}.db"

  mkdir -p "$backup_dir"

  # Truncate WAL before backup for a clean checkpoint
  sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true

  if sqlite3 "$DB_PATH" ".backup '${DB_BACKUP}'" >/dev/null 2>&1; then
    DB_BACKUP_OK=true
    echo "[ziptask] DB backup: $DB_BACKUP"
  else
    warn "sqlite3 .backup failed for ${DB_PATH}; upgrade proceeds without a DB backup."
    warn "Restore from a previous backup or recreate the database after downgrade."
  fi
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

# Backup DB before swapping the binary (best-effort)
backup_db

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
