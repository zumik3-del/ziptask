# Configuration

Layered: built-in defaults → `settings.json` → environment variables (env wins).

## `settings.json`

An optional JSON file; `settings.example.json` shows the full shape. Every key is optional and merged over the defaults, so a partial file is valid. The framework installer seeds **`/var/lib/ziptask/settings.json`** from that example (only when the file is absent) and passes `--settings` in the systemd unit and the printed stdio config, so it is always read. That path is `DATA_DIR` — the app's config home, beside its database (ADR addendum R1, epic #1105) — not `~/.ziptask`, which is the deploy framework's own state directory. Select a file with `--settings <path>` or the `ZIPTASK_SETTINGS` env var (`--settings` wins). The shipped example sets `dbPath` to an absolute path (`/var/lib/ziptask/ziptask.db`) so stdio clients don't create the DB under their own cwd. Keys mirror the environment variables below: `dbPath`, `host`, `port`, `leaseTtlMin`, `maxAttempts`, `reapCooldownSec`, `autoClaimCeiling`, `http.maxSessions`, `http.sessionTtlMs`, `defaults.priority`, `defaults.reporter`, `defaults.listLimit`, `defaults.timelineLimit`, `defaults.queueLimit`, `logging.level`, `auditLog`.

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
| `ZIPTASK_LOG_LEVEL` | `info` | Logger level — `off`, `error`, `warn`, `info`, `debug`. Matching is case-insensitive but **not** whitespace-trimmed, so a quoted `" DEBUG"` is unrecognised. Writes one single-line JSON record to stderr only; never stdout, so stdio MCP transport is safe. The value is passed to the logger unparsed, so an unrecognised one falls back to `info` and announces it with one `warn` record — while the same bad value in `settings.json` aborts startup instead. Record shape: [Log format](#log-format). `--version` intentionally writes to stdout. |
| `ZIPTASK_AUDIT_LOG` | `true` | Toggle audit log writes. When `false`, no new `audit_log` rows are created; `get_timeline` shows only comment rows for tasks with no historical audit data. Metrics CLI `status_time` degrades but `done_count`/`canceled_count` stay accurate (both derived from `tasks`, not `audit_log`). |
| `ZIPTASK_DEFAULTS_PRIORITY` | `p2` | Default `priority` when `create_task` omits it |
| `ZIPTASK_DEFAULTS_REPORTER` | `system` | Default `reporter` when `create_task` omits it |
| `ZIPTASK_DEFAULTS_LIST_LIMIT` | `50` | Fallback `limit` for `list_tasks` JSON mode |
| `ZIPTASK_DEFAULTS_TIMELINE_LIMIT` | `50` | Fallback `limit` for `get_timeline` |
| `ZIPTASK_DEFAULTS_QUEUE_LIMIT` | `100` | Fallback `limit` for `list_queue` |
| `ZIPTASK_SETTINGS` | (unset) | Path to `settings.json`; `--settings` takes precedence |

## Log format

One JSON object per line, written to **stderr** and nothing else (`emit`, `src/logger.ts`) — stdout belongs to the stdio MCP JSON-RPC stream, where a single stray line breaks the transport.

A record is assembled as `{ ...childContext, ...callFields, logger, ts, level, msg }` (`emit`, `src/logger.ts`), so **the custom fields come first and the reserved keys last**: `logger` (the name the logger was created with), `ts` (ISO-8601), `level`, `msg`. Independently of that order, `logger`, `ts`, `level` and `msg` are stripped from every context and field object before the record is built (`unreserved` against `RESERVED_KEYS`, `src/logger.ts`), so a call site can never shadow them; the last-position ordering is what makes the guarantee visible when reading a line.

`error(msg, err, fields)` adds `err` (the `Error` message, or `String(err)` for a non-`Error`) and `stack` (for an `Error`) after the call fields and before the reserved keys (`errFields`, `src/logger.ts`) — the failure being reported wins over a call field of the same name. The second argument is resolved by `isFieldsObject`, so a plain object there lands in the **fields** slot instead of being stringified into `err`; with no second argument the record carries **no** `err` key at all, rather than `err: "undefined"`.

**Non-`Error` throws.** A throw site hands over `unknown`, so `normalizeError` (`src/logger.ts`) keeps the shape instead of losing it: an `Error` passes through to the `err`/`stack` path above, while anything else — a string, a plain object — becomes one named **`thrown`** field, which keeps a nested object intact where `String()` would have collapsed it to `"[object Object]"`. The http handler funnels its error path through it (`startHttp`, `src/server.ts`), so a `{"thrown":{…}}` line means the handler threw a non-`Error`.

```jsonc
// bun -e 'import {createLogger} from "./src/logger"; createLogger("app","info").child({session:"s1",agent:"opencode"}).info("session open", {port: 3005})' 2>&1
{"session":"s1","agent":"opencode","port":3005,"logger":"app","ts":"2026-10-03T05:40:21.414Z","level":"info","msg":"session open"}
```

The shape mirrors the `session open` call in `startHttp`'s `onsessioninitialized` (`src/server.ts`) — `child({ session, agent })` plus per-call fields; the output above is verbatim.

**Single line, always.** Each record is one `JSON.stringify` and one `process.stderr.write` of that string plus `\n` (`emit`, `src/logger.ts`), so a multi-line value such as a stack trace is escaped into the line rather than spanning lines. If the fields cannot be serialized at all (a cycle, a `BigInt`), the `catch` arm of `emit` degrades the record to the reserved keys plus `fieldsUnserializable` with the `TypeError` message instead of throwing — inside an HTTP handler a thrown log line would turn into a 500.

**Levels.** `off` silences everything; otherwise a record is written when its own level is at least as severe as the configured one (`LEVEL_ORDER` and the gate in `emit`, `src/logger.ts`). An unrecognised level resolves to `info` through `parseLogLevel`/`matchLevel` (`src/logger.ts`), and `createLogger` itself emits one `warn` record naming the value it was handed (`requested`).

Which surface supplied the level decides whether that fallback is **loud**, because the two config layers validate differently. `ZIPTASK_LOG_LEVEL` is mapped as `type: 'string'` (`ENV_MAPPINGS`, `src/config.ts`), and `parseValue` returns a `string` as given, so `createLogger` is handed exactly what was exported (called with `settings.logging.level` in `src/index.ts`) and logs the `warn` instead of hiding it. `logging.level` in `settings.json` keeps a closed `z.enum` (`SettingsSchema`, `src/config.ts`), so an unknown value there fails `safeParse` and throws `Invalid settings.json: …` from `loadSettings` — and since `loadSettings` runs before `createLogger`, startup aborts with no logger to warn with.

## Upgrade path

Upgrades go through the `deploy/` framework. `bash ~/.ziptask/scripts/updater.sh` is the entry point: it resolves the newest stable release tag, stages that release's own `deploy/update.sh` + `deploy/lib/common.sh` + the installed `app.env`, and runs it. To pin a version, pass `--version <tag>`; `--yes` skips the menu in a non-interactive shell:

```bash
bash ~/.ziptask/scripts/updater.sh
bash ~/.ziptask/scripts/updater.sh --version v0.2.0
```

`update.sh` (staged by the updater, also usable directly) downloads the release tarball, verifies it, keeps the previous payload as `<file>.prev` for a no-git rollback, swaps it in, re-renders the systemd unit and waits for `/health`. **Before the swap, the `pre-update` hook creates an online SQLite backup** of the database named by `settings.json` `dbPath` via `sqlite3 .backup`, next to the database in `<db>.backup/`; an existing database that cannot be backed up aborts the update, so code is never swapped without a copy. The printed backup path is the restore point. On a health-check failure the update prints the exact `.prev` move-back and `sqlite3` restore commands — restoring the database is mandatory, because migrations are append-only. A health check that never gets an answer is reported UNVERIFIED rather than failed, and nothing is rolled back for a silence.

The hook finds `settings.json` at `${DATA_DIR}/settings.json` first — the same path `EXEC_START` passes to `--settings`, so the file the service reads and the file the hook reads `dbPath` from are one path. `~/.ziptask/scripts/` and `/opt/ziptask/` are still searched after it, so an install that has not moved its config yet keeps working.

### Rollback: moving `settings.json` back out of `DATA_DIR`

Nothing under `DATA_DIR` is touched by a payload swap, so reverting the config move is a `cp` and a re-render — no database restore is involved, and no code change:

```bash
sudo systemctl stop ziptask
cp -p /var/lib/ziptask/settings.json ~/.ziptask/scripts/settings.json
# set EXEC_START in ~/.ziptask/scripts/app.env back to
#   /opt/ziptask/ziptask --settings /home/opencode/.ziptask/scripts/settings.json
sudo systemctl daemon-reload && sudo systemctl start ziptask
curl -s http://127.0.0.1:3005/health   # {"ok":true}
```

The previous unit body is also kept at `/etc/systemd/system/ziptask.service.bak`, so the single-line `ExecStart` revert can be done by restoring that file instead of editing. Reverting means the pre-update hook resolves `dbPath` through the `RUN_DIR` candidate again, which is why that candidate is retained.

**Schema guard on startup:** a fresh DB auto-initialises; an older DB (V < L) auto-migrates forward; a DB newer than the binary (V > L, i.e. you downgraded) refuses to start with `SCHEMA: database schema version <V> is newer than this binary supports (<L>); upgrade ziptask or restore the database from backup`, exit 1. Fix by re-upgrading to the newer binary or restoring the backup the pre-update hook wrote. `--version` does not touch the DB.

## Backups

`bun run scripts/backup.ts` writes an online SQLite backup (`sqlite3 .backup`), compresses it to `*.db.tar.gz`, and deletes all but the newest `ZIPTASK_BACKUP_RETAIN` (default `7`). Env: `ZIPTASK_DB` (source DB, default `./data/ziptask.db`), `ZIPTASK_BACKUP_DIR` (default `./backups`), `ZIPTASK_BACKUP_PREFIX` (default `ziptask`). The update path also creates a pre-upgrade backup (see above).
