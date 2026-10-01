# Configuration

Layered: built-in defaults → `settings.json` → environment variables (env wins).

## `settings.json`

An optional JSON file; `settings.example.json` shows the full shape. Every key is optional and merged over the defaults, so a partial file is valid. The framework installer seeds `~/.ziptask/scripts/settings.json` from that example (only when the file is absent) and passes `--settings` in the systemd unit and the printed stdio config, so it is always read. Select a file with `--settings <path>` or the `ZIPTASK_SETTINGS` env var (`--settings` wins). The shipped example sets `dbPath` to an absolute path (`/var/lib/ziptask/ziptask.db`) so stdio clients don't create the DB under their own cwd. Keys mirror the environment variables below: `dbPath`, `host`, `port`, `leaseTtlMin`, `maxAttempts`, `reapCooldownSec`, `autoClaimCeiling`, `http.maxSessions`, `http.sessionTtlMs`, `defaults.priority`, `defaults.reporter`, `defaults.listLimit`, `defaults.timelineLimit`, `defaults.queueLimit`, `logging.level`, `auditLog`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_DB` | `./data/ziptask.db` | SQLite path (directory auto-created) |
| `ZIPTASK_HOST` | `127.0.0.1` | HTTP listen host |
| `ZIPTASK_PORT` | `0` (random) | HTTP listen port |
| `ZIPTASK_LEASE_TTL_MIN` | `15` | Claim lease length in minutes |
| `ZIPTASK_MAX_ATTEMPTS` | `3` | Attempts before a reaped task is failed (needs human) |
| `ZIPTASK_REAP_COOLDOWN_SEC` | `60` | Minimum seconds between lease-reap sweeps on read paths |
| `ZIPTASK_AUTO_CLAIM_CEILING` | `10000` | Max candidate rows scanned by auto-claim |
| `ZIPTASK_HTTP_MAX_SESSIONS` | `100` | Max concurrent HTTP MCP sessions |
| `ZIPTASK_HTTP_SESSION_TTL_MS` | `3600000` | HTTP MCP session TTL in ms |
| `ZIPTASK_LOG_LEVEL` | `info` | Logger level — `off`, `error`, `info`, `debug`. Writes single-line records to stderr only; never stdout, so stdio MCP transport is safe. `--version` intentionally writes to stdout. |
| `ZIPTASK_AUDIT_LOG` | `true` | Toggle audit log writes. When `false`, no new `audit_log` rows are created; `get_timeline` shows only comment rows for tasks with no historical audit data. Metrics CLI `status_time` degrades but `done_count`/`canceled_count` stay accurate (both derived from `tasks`, not `audit_log`). |
| `ZIPTASK_DEFAULTS_PRIORITY` | `p2` | Default `priority` when `create_task` omits it |
| `ZIPTASK_DEFAULTS_REPORTER` | `system` | Default `reporter` when `create_task` omits it |
| `ZIPTASK_DEFAULTS_LIST_LIMIT` | `50` | Fallback `limit` for `list_tasks` JSON mode |
| `ZIPTASK_DEFAULTS_TIMELINE_LIMIT` | `50` | Fallback `limit` for `get_timeline` |
| `ZIPTASK_DEFAULTS_QUEUE_LIMIT` | `100` | Fallback `limit` for `list_queue` |
| `ZIPTASK_SETTINGS` | (unset) | Path to `settings.json`; `--settings` takes precedence |

## Upgrade path

Upgrades go through the `deploy/` framework. `bash ~/.ziptask/scripts/updater.sh` is the entry point: it resolves the newest stable release tag, stages that release's own `deploy/update.sh` + `deploy/lib/common.sh` + the installed `app.env`, and runs it. To pin a version, pass `--version <tag>`; `--yes` skips the menu in a non-interactive shell:

```bash
bash ~/.ziptask/scripts/updater.sh
bash ~/.ziptask/scripts/updater.sh --version v0.2.0
```

`update.sh` (staged by the updater, also usable directly) downloads the release tarball, verifies it, keeps the previous payload as `<file>.prev` for a no-git rollback, swaps it in, re-renders the systemd unit and waits for `/health`. **Before the swap, the `pre-update` hook creates an online SQLite backup** of the database named by `settings.json` `dbPath` via `sqlite3 .backup`, next to the database in `<db>.backup/`; an existing database that cannot be backed up aborts the update, so code is never swapped without a copy. The printed backup path is the restore point. On a health-check failure the update prints the exact `.prev` move-back and `sqlite3` restore commands — restoring the database is mandatory, because migrations are append-only. A health check that never gets an answer is reported UNVERIFIED rather than failed, and nothing is rolled back for a silence.

**Schema guard on startup:** a fresh DB auto-initialises; an older DB (V < L) auto-migrates forward; a DB newer than the binary (V > L, i.e. you downgraded) refuses to start with `SCHEMA: database schema version <V> is newer than this binary supports (<L>); upgrade ziptask or restore the database from backup`, exit 1. Fix by re-upgrading to the newer binary or restoring the backup the pre-update hook wrote. `--version` does not touch the DB.

## Backups

`bun run scripts/backup.ts` writes an online SQLite backup (`sqlite3 .backup`), compresses it to `*.db.tar.gz`, and deletes all but the newest `ZIPTASK_BACKUP_RETAIN` (default `7`). Env: `ZIPTASK_DB` (source DB, default `./data/ziptask.db`), `ZIPTASK_BACKUP_DIR` (default `./backups`), `ZIPTASK_BACKUP_PREFIX` (default `ziptask`). The update path also creates a pre-upgrade backup (see above).
