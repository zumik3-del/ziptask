#!/bin/sh
# Cron wrapper for SQLite online backup.
# Runs once per invocation; meant to be scheduled by cron inside the container.
#
# Env vars:
#   ZIPTASK_DB           — source DB path (default: ./data/ziptask.db)
#   ZIPTASK_BACKUP_DIR   — backup destination (default: /backups)
#   ZIPTASK_BACKUP_PREFIX — filename prefix (default: ziptask)
#   ZIPTASK_BACKUP_RETAIN — number of backups to keep (default: 7)
set -euo pipefail

exec bun run /app/scripts/backup.ts
