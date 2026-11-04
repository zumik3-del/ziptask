# Configuration

Layered: built-in defaults → `settings.json` → environment variables (env wins).

## `settings.json`

An optional JSON file; `settings.example.json` shows the full shape. Every key is optional and merged over the defaults, so a partial file is valid. The framework installer seeds **`/var/lib/ziptask/settings.json`** from that example (only when the file is absent), rewrites the seeded `port` and `dbPath` to the values the install resolved (`PORT` — or `--port N` — and `DATA_DIR`), and passes `--settings` in the systemd unit, so the service always reads it. An existing file is never rewritten, and it is also where the health gate reads the port from. `--dir D` moves that home to `D/data/settings.json`. Both `--port N` and `--dir D` are also persisted into the installed `~/.ziptask/scripts/app.env` (`INSTALL_DIR`, `DATA_DIR`, `EXEC_START`, `CONFIG_FILE`, `PORT`) — the file `updater.sh`/`update.sh` load on later runs — so the host keeps updating `D` and polling `N` instead of falling back to the canonical `/opt/ziptask`, `/var/lib/ziptask` and `3005`. A stdio client must pass the same path itself (the canonical one is `/var/lib/ziptask/settings.json`). That path is `DATA_DIR` — the app's config home, beside its database (ADR addendum R1, epic #1105) — not `~/.ziptask`, which is the deploy framework's own state directory. Select a file with `--settings <path>` (the `--settings=<path>` form is equivalent) or the `ZIPTASK_SETTINGS` env var (`--settings` wins). The shipped example sets `dbPath` to an absolute path (`/var/lib/ziptask/ziptask.db`) so stdio clients don't create the DB under their own cwd. Keys mirror the environment variables below: `dbPath`, `host`, `port`, `leaseTtlMin`, `maxAttempts`, `reapCooldownSec`, `autoClaimCeiling`, `http.maxSessions`, `http.sessionTtlMs`, `defaults.priority`, `defaults.reporter`, `defaults.listLimit`, `defaults.timelineLimit`, `defaults.queueLimit`, `logging.level`, `auditLog`.

> **Note:** `settings.example.json` is the installer's *seeded* configuration and its values are not the built-in defaults — e.g. `port: 3005` (built-in `0` = random) and `leaseTtlMin: 45` (built-in `15`). The built-in defaults are the **Default** column of the environment table below. A partial `settings.json` is still valid and merges over those built-in defaults.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_DB` | `./data/ziptask.db` | SQLite path (directory auto-created) |
| `ZIPTASK_HOST` | `127.0.0.1` | HTTP listen host. Binding to a non-loopback host logs a startup warning: the HTTP surface has no authentication by design, so expose it through an authenticating reverse proxy. |
| `ZIPTASK_PORT` | `0` (random) | HTTP listen port |
| `ZIPTASK_LEASE_TTL_MIN` | `15` | Claim lease length in minutes, capped at `1440` (a larger value fails validation — see below) |
| `ZIPTASK_MAX_ATTEMPTS` | `3` | Attempts before a reaped task is failed (needs human) |
| `ZIPTASK_REAP_COOLDOWN_SEC` | `60` | Minimum seconds between lease-reap sweeps on read paths |
| `ZIPTASK_AUTO_CLAIM_CEILING` | `10000` | Max candidate rows scanned by auto-claim |
| `ZIPTASK_HTTP_MAX_SESSIONS` | `100` | Max concurrent HTTP MCP sessions |
| `ZIPTASK_HTTP_SESSION_TTL_MS` | `3600000` | HTTP MCP session TTL in ms |
| `ZIPTASK_LOG_LEVEL` | `info` | Logger level — `off`, `error`, `warn`, `info`, `debug`. Matching is case-insensitive but **not** whitespace-trimmed, so a quoted `" DEBUG"` is unrecognised. Writes one single-line JSON record to stderr only; never stdout, so stdio MCP transport is safe. The value is passed to the logger unparsed, so an unrecognised one falls back to `info` and announces it with one `warn` record — while the same bad value in `settings.json` aborts startup instead. Record shape: [Log format](#log-format). `--version` intentionally writes to stdout. |
| `ZIPTASK_AUDIT_LOG` | `true` | Toggle audit log writes. When `false`, no new `audit_log` rows are created; `get_timeline` shows only comment rows for tasks with no historical audit data. |
| `ZIPTASK_DEFAULTS_PRIORITY` | `p2` | Default `priority` when `create_task` omits it. Accepts the same shapes as `create_task` — the canonical `p0`..`p3`, the number `0`..`3` or the digit string `"0"`..`"3"` (`p0` = highest urgency … `p3` = lowest) — and is stored as the canonical `pN`; anything else aborts the startup, with `Invalid configuration after env overrides: defaults.priority: …` for the env override and `Invalid settings.json: …` for a bad value in the settings file (see [Priorities](mcp-tools.md#priorities)) |
| `ZIPTASK_DEFAULTS_REPORTER` | `system` | Default `reporter` when `create_task` omits it |
| `ZIPTASK_DEFAULTS_LIST_LIMIT` | `50` | Fallback `limit` for `list_tasks` JSON mode |
| `ZIPTASK_DEFAULTS_TIMELINE_LIMIT` | `50` | Fallback `limit` for `get_timeline` |
| `ZIPTASK_DEFAULTS_QUEUE_LIMIT` | `100` | Fallback `limit` for `list_queue` |
| `ZIPTASK_SETTINGS` | (unset) | Path to `settings.json`; `--settings` takes precedence |

> **Legacy env var:** `ZIPTASK_LOGGING_LEVEL` is **ignored** — only `ZIPTASK_LOG_LEVEL` is read. Use `ZIPTASK_LOG_LEVEL`.

After the env layer is applied, the merged result is re-validated before it is returned (`MergedSettingsSchema` and the final `safeParse`, `loadSettings`, `src/config.ts`). Parsing is strict on purpose, so a typo cannot be reinterpreted: an `int` variable must match `^\d+$` **on the raw value** (no sign, decimal point or surrounding whitespace), and a `bool` variable accepts exactly `true`/`false` in any case — `1`, `yes` and the empty string are refused rather than guessed. A value that fails its type is ignored: the lower layer's value stays, and the caller is warned (`ignoring invalid ZIPTASK_PORT value`, with the offending value in the record) — `src/index.ts` buffers those warnings until the logger exists and replays them then. A value that parses but breaks its bound (`ZIPTASK_LEASE_TTL_MIN=0`, a `leaseTtlMin` above its cap) aborts startup with `Invalid configuration after env overrides: …`; a value that never parses is only warned about and dropped, so a signed or decimal `ZIPTASK_PORT` (`-1`, `1.5`) leaves the lower layer's port in place instead of aborting. The same bad number in `settings.json` does abort — that layer is a schema, so a negative `port` there throws `Invalid settings.json: …`. `logging.level` stays a bare `string` in that merged schema, so a bad level still reaches the logger rather than aborting here.

`leaseTtlMin` — in `settings.json`, in `ZIPTASK_LEASE_TTL_MIN` and as the `claim_task` `lease_ttl_min` argument — is capped at **1440 minutes** (`MAX_LEASE_TTL_MIN`). A larger value is refused, never clamped: the settings layers fail validation (`Invalid settings.json: …` / `Invalid configuration after env overrides: leaseTtlMin: Too big: expected number to be <=1440`), and an explicit `lease_ttl_min` on a claim is refused with `INVALID: lease_ttl_min too large`. The cap covers the configured default too: the settings layers refuse an over-cap value before a service exists (so the process exits at startup, see above), and `resolveOptions` (`src/core/service.ts`) refuses it again when `TaskService` is constructed. Every lease the server hands out without an explicit TTL — the claim default and each `update_status` renewal alike — is computed from that validated value, so no renewal can outlive the cap.

**There is deliberately no project key in either layer**: no `project` in `settings.json` and no `ZIPTASK_PROJECT`. The project slug is a required per-call argument on the enumerating tools ([Projects and scope](mcp-tools.md#projects-and-scope)), so an install cannot silently widen or narrow every call from config — the failure is a loud `INVALID: project required`.

## Log format

One JSON object per line, written to **stderr** and nothing else (`writeRecord`, `src/logger.ts`) — stdout belongs to the stdio MCP JSON-RPC stream, where a single stray line breaks the transport.

A record is assembled as `{ ...childContext, ...callFields, logger, ts, level, msg }` (`emit`, `src/logger.ts`), so **the custom fields come first and the reserved keys last**: `logger` (the name the logger was created with), `ts` (ISO-8601), `level`, `msg`. Independently of that order, `logger`, `ts`, `level` and `msg` are stripped from every context and field object before the record is built (`stripReservedKeys` against `RESERVED_KEYS`, applied to both the child context and the call fields by `mergeContext`, `src/logger.ts`), so a call site can never shadow them; the last-position ordering is what makes the guarantee visible when reading a line.

`error(msg, err, fields)` adds `err` (the `Error` message, or `String(err)` for a non-`Error`) and `stack` (for an `Error`) after the call fields and before the reserved keys (`errFields`, `src/logger.ts`) — the failure being reported wins over a call field of the same name. The second argument is resolved by `isFieldsObject`, so a plain object there lands in the **fields** slot instead of being stringified into `err`; with no second argument the record carries **no** `err` key at all, rather than `err: "undefined"`.

**Non-`Error` throws.** A throw site hands over `unknown`, so `normalizeError` (`src/logger.ts`) keeps the shape instead of losing it: an `Error` passes through to the `err`/`stack` path above, while anything else — a string, a plain object — becomes one named **`thrown`** field, which keeps a nested object intact where `String()` would have collapsed it to `"[object Object]"`. The http handler funnels its error path through it (`startHttp`, `src/server.ts`), so a `{"thrown":{…}}` line means the handler threw a non-`Error`.

```jsonc
// bun -e 'import {createLogger} from "./src/logger"; createLogger("app","info").child({session:"s1",agent:"opencode"}).info("session open", {port: 3005})' 2>&1
{"session":"s1","agent":"opencode","port":3005,"logger":"app","ts":"2026-10-03T05:40:21.414Z","level":"info","msg":"session open"}
```

The shape mirrors the production `session open` call: `SessionRegistry.open` logs `child({ session, agent })` with no per-call fields (`src/session-registry.ts`), reached from the transport's `onsessioninitialized` hook (`src/server.ts`). The matching `session close` line comes from the same class — `SessionRegistry.close`, reached from `onsessionclosed`, and `sweep`/`closeAll` on eviction and shutdown. The example above contributes `port` as a per-call field, and its output is verbatim.

**Single line, always.** Each record is one `JSON.stringify` and one `process.stderr.write` of that string plus `\n` (`serializeRecord` and `writeRecord`, `src/logger.ts`), so a multi-line value such as a stack trace is escaped into the line rather than spanning lines. If the fields cannot be serialized at all (a cycle, a `BigInt`), the `catch` arm of `serializeRecord` degrades the record to the reserved keys plus `fieldsUnserializable` with the `TypeError` message instead of throwing — inside an HTTP handler a thrown log line would turn into a 500.

**Levels.** `off` silences everything; otherwise a record is written when its own level is at least as severe as the configured one (`LOG_LEVEL_ORDER` and `logLevelEnabled`, `src/defaults.ts`, applied by the gate in `emit`, `src/logger.ts`). An unrecognised level resolves to `info` through `resolveLogLevel`/`parseLogLevel` (`src/logger.ts`), which consult `matchLogLevel` (`src/defaults.ts`), and `createLogger` itself emits one `warn` record naming the value it was handed (`requested`).

Which surface supplied the level decides whether that fallback is **loud**, because the two config layers validate differently. `ZIPTASK_LOG_LEVEL` is mapped as `type: 'string'` (`ENV_MAPPINGS`, `src/config.ts`), and `parseValue` returns a `string` as given, so `createLogger` is handed exactly what was exported (called with `settings.logging.level` in `src/index.ts`) and logs the `warn` instead of hiding it. `logging.level` in `settings.json` keeps a closed `z.enum` (`SettingsSchema`, `src/config.ts`; the level list itself lives in `src/defaults.ts`), so an unknown value there fails `safeParse` and throws `Invalid settings.json: …` from `loadSettings` — and since `loadSettings` runs before `createLogger`, startup aborts with no logger to warn with.

## Upgrade path

Upgrades go through the `deploy/` framework. `bash ~/.ziptask/scripts/updater.sh` is the entry point: it resolves the newest stable release tag, stages that release's own `deploy/update.sh` + `deploy/lib/common.sh` + the installed `app.env`, and runs it. To pin a version, pass `--version <tag>`; `--yes` skips the menu in a non-interactive shell:

```bash
bash ~/.ziptask/scripts/updater.sh
bash ~/.ziptask/scripts/updater.sh --version v0.5.5
```

`~/.ziptask/scripts/` is root-owned (`app.env` is `0640 root:<service-group>`, helpers and hooks `0750`): the service account and the operator can read and execute it, only root can change it — edit `app.env` with `sudoedit`. The service account must be a member of the service group, or the pre-update hook cannot read `app.env`.

`update.sh` (staged by the updater, also usable directly) downloads the release tarball, verifies it, keeps the previous payload as `<file>.prev` for a no-git rollback, swaps it in, re-renders the systemd unit and waits for `/health`. **Before the swap, the `pre-update` hook creates an online SQLite backup** of the database named by `settings.json` `dbPath` via `sqlite3 .backup`, next to the database in `<db>.backup/`; an existing database that cannot be backed up aborts the update, so code is never swapped without a copy. The printed backup path is the restore point. On a health-check failure the update prints the exact `.prev` move-back and `sqlite3` restore commands — restoring the database is mandatory, because migrations are append-only. A health check that never gets an answer is reported UNVERIFIED rather than failed, and nothing is rolled back for a silence.

The hook finds `settings.json` at `${DATA_DIR}/settings.json` first — the same path `EXEC_START` passes to `--settings`, so the file the service reads and the file the hook reads `dbPath` from are one path. `~/.ziptask/scripts/` and `/opt/ziptask/` are still searched after it, so an install that has not moved its config yet keeps working.

### Rollback: moving `settings.json` back out of `DATA_DIR`

Nothing under `DATA_DIR` is touched by a payload swap, so reverting the config move is a copy into `~/.ziptask/scripts/` and a re-render — no database restore is involved, and no code change. The destination is root-owned, so the copy needs `sudo` (as does any other write into `~/.ziptask/scripts/`):

```bash
sudo systemctl stop ziptask
# `install`, not `cp -p`: `-p` preserves the source owner and mode, and this copy
# must be root-owned — the pre-update hook runs as root and reads `dbPath` from
# it, so a service-owned copy would let the service account steer a root-run
# `sqlite3 .backup` at a path of its choosing.
sudo install -m 0640 -o root -g <service-group> \
  /var/lib/ziptask/settings.json ~/.ziptask/scripts/settings.json
# edit EXEC_START in ~/.ziptask/scripts/app.env back to (root-owned 0640, so
# use sudoedit):
#   /opt/ziptask/ziptask --settings /home/opencode/.ziptask/scripts/settings.json
sudo systemctl daemon-reload && sudo systemctl start ziptask
curl -s http://127.0.0.1:3005/health   # {"ok":true}
```

The previous unit body is also kept at `/etc/systemd/system/ziptask.service.bak`, so the single-line `ExecStart` revert can be done by restoring that file instead of editing. Reverting means the pre-update hook resolves `dbPath` through the `RUN_DIR` candidate again, which is why that candidate is retained.

**Schema guard on startup:** a fresh DB auto-initialises; an older DB (V < L) auto-migrates forward; a DB newer than the binary (V > L, i.e. you downgraded) refuses to start with `SCHEMA: database schema version <V> is newer than this binary supports (<L>); upgrade ziptask or restore the database from backup`, exit 1. Here `<V>` and `<L>` are counts of applied SQL migrations (the `schema_version` row), not product versions. Fix by re-upgrading to the newer binary or restoring the backup the pre-update hook wrote. `--version` does not touch the DB.

## Script environment variables

These apply only to the maintenance scripts, not the server.

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_BACKUP_DIR` | `./backups` | Backup destination directory (`scripts/backup.ts`) |
| `ZIPTASK_BACKUP_PREFIX` | `ziptask` | Backup filename prefix (`scripts/backup.ts`) |
| `ZIPTASK_BACKUP_RETAIN` | `7` | Number of backups to retain (`scripts/backup.ts`) |
| `PRUNE_OLDER_THAN_DAYS` | `30` | Age threshold for pruning closed-for-work tasks (`scripts/prune-tasks.ts`) |

## Backups

`bun run scripts/backup.ts` writes an online SQLite backup (`sqlite3 .backup`), compresses it to `*.db.tar.gz`, and deletes all but the newest `ZIPTASK_BACKUP_RETAIN` (default `7`). Env: `ZIPTASK_DB` (source DB, default `./data/ziptask.db`), `ZIPTASK_BACKUP_DIR` (default `./backups`), `ZIPTASK_BACKUP_PREFIX` (default `ziptask`). The update path also creates a pre-upgrade backup (see above).

## Task retention

`bun run scripts/prune-tasks.ts` deletes closed-for-work tasks (`done`/`failed`/`canceled`) whose `completed_at` is older than `--days` (default `30`; env `PRUNE_OLDER_THAN_DAYS`). It never deletes a task that a live (non-terminal) task still lists in `depends_on` — a missing dependency id would block its dependent forever — nor a parent epic with remaining children (`epic_id` has no `ON DELETE CASCADE`, so an epic is prunable only after its children are gone). `comments`/`audit_log` rows cascade with the task (schema v4). The script is a dry run unless `--apply` is passed; `--db`/`ZIPTASK_DB` selects the database.
