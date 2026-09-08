# ziptask

MCP task tracker for AI agents. A pure state layer — statuses, dependencies, leases, versioning — over SQLite, served to agents over MCP.

## Features

- **Pure state layer** — task content lives in `description`/comments; the DB stores no file paths
- **Token-minimal wire format** — pipe-delimited bulk responses, numeric status codes, omit-null
- **Dependency blocking** — `list_queue` and auto-claim surface only dep-satisfied tasks
- **Optimistic concurrency** — `version` bumps on every status mutation; stale writes → `CONFLICT`
- **Leases with auto-reap** — expired claims return to `queued`, attempts counted
- **MCP transport** — Streamable HTTP (`POST /mcp`) + stdio; `GET /health` probe
- **Docker image** with scheduled online SQLite backup

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.4.

```bash
bun install
bun run start          # HTTP server on an ephemeral port (MCP endpoint + /health)
bun run start:stdio    # run over stdio
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_DB` | `./data/ziptask.db` | SQLite path (directory auto-created) |
| `ZIPTASK_HOST` | `127.0.0.1` | HTTP listen host |
| `ZIPTASK_PORT` | `0` (random) | HTTP listen port |
| `ZIPTASK_LEASE_TTL_MIN` | `15` | Claim lease length in minutes |

## MCP tools

| Tool | What it does |
|---|---|
| `create_task` | Enqueue a task; always `queued` — `blocked` is a manual flag only |
| `get_task` | Read a task; `description` only via explicit `fields` |
| `list_tasks` | Filter by `assignee`/`status`/`updated_since`; JSON result |
| `claim_task` | Claim a queued task (auto-pick or by id); returns `{id, lease_ttl_min, version}` |
| `update_status` | Transition status with optimistic version lock |
| `batch_statuses` | Pipe lines `id\|code` (+ `\|assignee` via `include`) |
| `list_queue` | Pipe lines of dep-satisfied queued tasks |
| `add_comment` | Append a comment to a task |
| `get_timeline` | Merged audit log + comments feed |
| `get_template` | Fetch a markdown template (task description, comments) |
| `metrics` | Aggregated stats: `done_count`, `status_time`, `bottleneck` |

## Statuses

Codes (`STATUS_CODES`): `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked.

Flow: `queued → in_progress → review → done` (or `failed` / `blocked`). `done` and `failed` are terminal; lease expiry returns to `queued` and increments `attempts`. Tasks with unsatisfied `depends_on` stay `queued` but are hidden from `list_queue` and auto-claim.

## Architecture

Layered by carrier, no framework beyond the MCP SDK:

| Layer | Location | Responsibility |
|---|---|---|
| MCP | `src/mcp/` | Tool schemas, registration, response shaping |
| Service | `src/core/` | Domain rules: transitions, leases, deps, versioning |
| Storage | `src/db/` | SQL (bun:sqlite, WAL) + migrations |
| Entry | `src/index.ts`, `src/server.ts` | Composition root, HTTP transport |

## Development

```bash
bun test               # unit tests (per-test temp DBs)
bunx tsc --noEmit      # type check
bunx biome check src/  # lint
bun run src/smoke.ts   # MCP end-to-end over HTTP (ephemeral port + temp DB)
```

## Docker

```bash
docker build -t ziptask .
docker run -d --name ziptask \
  -p 3000:3000 \
  -e ZIPTASK_HOST=0.0.0.0 \
  -e ZIPTASK_PORT=3000 \
  -v /host/data:/var/lib/ziptask \
  -v /host/backups:/backups \
  ziptask
```

The container takes an online SQLite backup on a cron schedule; old archives are pruned.

| Variable | Default | Description |
|---|---|---|
| `ZIPTASK_BACKUP_DIR` | `/backups` | Backup destination (mount a volume) |
| `ZIPTASK_BACKUP_PREFIX` | `ziptask` | Backup file prefix |
| `ZIPTASK_BACKUP_RETAIN` | `7` | Backups to keep (oldest pruned) |
| `CRON_SCHEDULE` | `0 2 * * *` | Cron expression for the backup job |

## License

MIT