# ziptask

MCP task tracker for AI agents. Bun + TypeScript, SQLite, StreamableHTTP + stdio.

Schema v2: pure state layer — no file paths in DB (task content lives in `description`/comments text and files). English-only convention for titles/descriptions/comments (fewer tokens).

## Architecture

Layered by carrier: MCP tool layer → business rules → SQL repo. No frameworks.

| Layer | File | Lines | Responsibility |
|---|---|---|---|
| L1 — MCP | `src/tools.ts` | ~198 | zod schemas, tool registration, response shaping (pipe/json) |
| L2 — Service | `src/service.ts` | ~272 | status transitions, version bumping, lease/reap, deps/cycles |
| L3 — Repo | `src/repo.ts` | ~137 | all SQL (bun:sqlite, WAL) |
| Types | `src/tasks.ts` | ~63 | `Task`/`TaskStatus` types, `STATUS_CODES`, `isValidTransition` |
| Composition | `src/index.ts` | ~142 | constructor DI, HTTP (`Bun.serve`) + stdio entry points |

## Quick start

```bash
bun install
bun run start          # HTTP on random port (MCP + /health)
bun run start:stdio    # stdio mode
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_DB` | `./data/ziptask.db` | SQLite path (dir auto-created) |
| `ZIPTASK_PORT` | `0` (random) | HTTP listen port |
| `ZIPTASK_HOST` | `127.0.0.1` | HTTP listen host |
| `ZIPTASK_LEASE_TTL_MIN` | `15` | Lease TTL in minutes |

## MCP tools

| Tool | Contract |
|---|---|
| `create_task` | `{title, description?, priority?, assignee?, depends_on?, reporter?}` → `{id, status:"queued"}`. Always `queued`; readiness computed from deps at read time; `blocked` is a manual flag only |
| `get_task` | `{id, fields?}` → requested fields, omit-null. Brief default: `id,title,status,priority,blocked_by`. `description` only via explicit `fields:["description"]` |
| `list_tasks` | `{assignee?, status?, updated_since?, fields?, limit?}` → `{tasks[], total}`. `updated_since` = unix ms, returns tasks with `updated_at >= threshold`. `description` only via explicit fields. **Returns JSON** (unlike other pipe tools) |
| `claim_task` | `{agent, task_id?, include?}` → `{id, lease_ttl_min, version, …include}` (e.g. `include:["description"]` returns content in the same call) |
| `update_status` | `{id, agent, status, version, comment?}` → `{id, status, version}`. Optimistic lock via `version`. `comment` stored as `type:"resolution"` when new status is done/failed, else `type:"comment"` |
| `batch_statuses` | `{ids[], include?}` → pipe text, one line per task (see below) |
| `list_queue` | `{limit?}` → pipe text of dep-satisfied queued tasks (see below) |
| `add_comment` | `{id, agent, content}` → `{comment_id}`. Validates task exists; rejects empty agent/content |
| `get_timeline` | `{id, limit?}` → pipe text, one event per line (see below). Merged audit_log + comments, sorted by created_at tie-break rowid |
| `metrics` | `{period?}` → pipe text aggregated stats. `period` = hours (default 24) or `all`. See below |

## Pipe formats and status codes

Bulk responses are pipe-delimited text, one line per task — cheap to read for LLM consumers.

```
batch_statuses {ids:[1,2]}                    →  "1|2\n2|4"            (id|code)
batch_statuses {ids:[1], include:["assignee"]} →  "1|2|alice"          (id|code|assignee)
list_queue                                         →  "5|p1|Fix login"      (id|priority|title)
get_timeline {id:5}                           →  "1|action|dev|2024-…|create: null->queued\n2|comment|dev|…|hello"  (seq|type|agent|at|text)
get_timeline {id:5, limit:10}                 →  (first 10 events)
metrics {period:"all"}                        →  "done_count|3\nstatus_time|queued:120\nstatus_time|in_progress:90\nbottleneck|queued:120"
metrics                                       →  same but default period=24h
```

Status codes (`STATUS_CODES` in `src/tasks.ts`):

| code | status |
|---|---|
| 0 | not_found |
| 1 | queued |
| 2 | in_progress |
| 3 | review |
| 4 | done |
| 5 | failed |
| 6 | blocked |

`|` characters in titles are sanitized to `/`. Null assignee → `-`.

## Status machine

```
queued → in_progress → review → done
                   ↘ failed      ↘ blocked → (back to previous)
```

`done` and `failed` are terminal. Lease expiry returns to `queued`, `attempts++`. Max attempts → `failed`.

Deps: tasks with unsatisfied dependencies stay `queued` but are hidden from `list_queue` and `claim_task` (auto-unblock at read time). `blocked` is never set automatically — only by manual `update_status`.

Version semantics (plan v1.2, §12): `version` is a monotonic counter of ALL status mutations — `update_status`, `claim_task`, and reap each bump it. `update_status` uses optimistic locking: `version` mismatch → `CONFLICT`.

## Schema

- `tasks`: `id, title, description, status, priority, assignee, reporter, depends_on, attempts, max_attempts, lease_expires_at, version, created_at, updated_at, completed_at`. No `task_path`/`result_path`/`parent_id` — the DB is a state layer only; artifact paths live in description/comment text.
- `comments`: `id, task_id, agent, content, type ('comment'|'resolution'), created_at`.
- `audit_log`: state-change timeline.

## Development

```bash
bun test               # unit tests (68, ~60s — lease TTL sleeps are expected)
bunx tsc --noEmit      # type check
bunx biome check src/  # lint
bun run src/smoke.ts   # MCP smoke test (temp DB in /tmp/opencode)
```

## Design decisions

Full design spec: `task-tracker-plan.md` (v1.2, §12 records all decisions incl. rejected ideas). Key points:
- **Pull model only**: no webhooks, no Redis. Agents call MCP tools directly.
- **Token-minimalism**: pipe bulk responses, brief defaults, omit-null, numeric statuses.
- `data/` and `.test-data/` are never committed.

## Docker

### Build

```bash
docker build -t ziptask .
```

### Run

```bash
docker run -d \
  --name ziptask \
  -p 3000:3000 \
  -v /host/data:/var/lib/ziptask \
  -v /host/backups:/backups \
  -e ZIPTASK_DB=/var/lib/ziptask/ziptask.db \
  -e ZIPTASK_PORT=3000 \
  -e ZIPTASK_HOST=0.0.0.0 \
  -e ZIPTASK_LEASE_TTL_MIN=15 \
  ziptask
```

### Backup

The container runs a cron job that performs an online SQLite backup via `sqlite3 .backup` on a schedule. Backups are tar-gzipped and retained per `ZIPTASK_BACKUP_RETAIN`.

Mount a host directory for backups: `-v /host/backups:/backups`.

Cron schedule is set via `CRON_SCHEDULE` env var (default: `0 2 * * *` = daily at 02:00). Override by setting `CRON_SCHEDULE` when running the container.

### Backup environment variables

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_DB` | `/var/lib/ziptask/ziptask.db` | Source DB path (must match what the server uses) |
| `ZIPTASK_BACKUP_DIR` | `/backups` | Directory where backups are written |
| `ZIPTASK_BACKUP_PREFIX` | `ziptask` | Filename prefix for backup archives |
| `ZIPTASK_BACKUP_RETAIN` | `7` | Number of backups to keep (oldest removed first) |
| `CRON_SCHEDULE` | `0 2 * * *` | Cron expression for backup schedule |

### Verifications (local, no Docker required)

```bash
bunx --bun tsc --noEmit      # type check — green
bunx biome check src/        # lint — green
bun run src/smoke.ts         # MCP smoke test — green (69 tests)
```

`docker build` was not run in this environment (Docker unavailable). The Dockerfile is validated by tsc + biome passing, and the backup script was tested manually with `bun run scripts/backup.ts` against a synthetic DB.
