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
| `create_task` | Enqueue a task; always `queued` — `blocked` is a manual flag only. Fields: `epic?` (declare as epic, not claimable), `epic_id?` (attach as sub-task to an existing epic) |
| `get_task` | Read a task; `description` only via explicit `fields`. Epics: `subtasks` roll-up (`{total,open,done,failed}`) via `fields:["subtasks"]`; `epic_id` via `fields` when reading a sub-task |
| `list_tasks` | Filter by `assignee`/`status`/`updated_since`/`epic_id` (children of an epic). JSON result |
| `claim_task` | Claim a queued task (auto-pick or by id); returns `{id, lease_ttl_min, version}`. Epics are excluded from auto-pick and explicit claim returns `INVALID: #N is an epic, not claimable` |
| `update_status` | Transition status with optimistic version lock. Epic close-guard: `done`/`failed` rejected while non-terminal children exist → `CHILDREN: N sub-tasks not terminal` |
| `batch_statuses` | Pipe lines `id\|code` (+ `\|assignee` via `include`) |
| `list_queue` | Pipe lines of dep-satisfied queued tasks (epics excluded) |
| `add_comment` | Append a comment to a task |
| `get_timeline` | Merged audit log + comments feed. Epics show `subtask_add`/`subtask_done`/`subtask_failed` mirror rows — history reads as `create → subtask_add… → subtask_done… → resolution` |
| `get_template` | Fetch a markdown template (task description, comments) |
| `metrics` | Aggregated stats: `done_count`, `status_time`, `bottleneck`. Epics excluded from all metrics |

## Statuses

Codes (`STATUS_CODES`): `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked.

Flow: `queued → in_progress → review → done` (or `failed` / `blocked`). `done` and `failed` are terminal; lease expiry returns to `queued` and increments `attempts`. Tasks with unsatisfied `depends_on` stay `queued` but are hidden from `list_queue` and auto-claim.

## Epic → sub-task workflow

Epics are structural containers, not work. They cannot be claimed and their status is manual.

### Declaring an epic

```
create_task {title: 'Release v2', reporter: 'orchestrator', epic: true}
```
or attach the first sub-task to promote it automatically:
```
create_task {title: 'Sub-work', reporter: 'orchestrator', epic_id: <epic-id>}
```
The target is auto-promoted to `is_epic=1` (audit row `promote_epic`).

### Attaching sub-tasks

Sub-tasks are ordinary tasks with `epic_id` pointing at the epic. Use `depends_on` for ordering:
```
create_task {title: 'Implement auth', reporter: 'orchestrator', epic_id: <epic-id>}
create_task {title: 'Write docs', reporter: 'orchestrator', epic_id: <epic-id>, depends_on: [<auth-id>]}
```
Nested membership is rejected (epic cannot be a sub-task; sub-task cannot be an epic).

### Roll-up and closure

- `get_task fields:["subtasks"]` on the epic returns `{total, open, done, failed}` (open = queued+in_progress+review+blocked).
- `list_tasks epic_id:<epic-id>` returns only children.
- The epic timeline (`get_timeline`) mirrors terminal sub-task events: `subtask_add`, `subtask_done`, `subtask_failed`.
- `update_status(epic→done)` is guarded: rejected with `CHILDREN: N sub-tasks not terminal` while any child is non-terminal.

### Constraints

| Rule | Error |
|---|---|
| `epic: true` + `epic_id` | `INVALID: epic cannot have a parent epic` |
| `epic: true` + `depends_on` | `INVALID: epic cannot have depends_on` |
| `depends_on` pointing at an epic | `INVALID: dependencies on epic tasks not allowed (#N)` |
| `epic_id` pointing at a terminal task | `INVALID: cannot attach to a terminal task` |
| `epic_id` pointing at a sub-task (nesting) | `INVALID: cannot attach to a sub-task (no nesting)` |
| Explicit `claim_task` on an epic | `INVALID: #N is an epic, not claimable` |

### Notes

- `epic_id` is immutable after creation (no re-parent/detach). Manual SQL is the escape hatch.
- `blocked`/`failed` on an epic are manual flags only; no cascade to children.
- Metrics (`metrics` tool) exclude epics — an epic sitting in one status for days would distort `bottleneck`.

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