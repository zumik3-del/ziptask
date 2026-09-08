# ziptask

MCP task tracker for AI agents. A pure state layer — statuses, dependencies, leases, versioning — over SQLite, served to agents over MCP.

## Install

One-liner — downloads a compiled binary, writes default config, prints client setup:

```bash
curl -LsS https://raw.githubusercontent.com/zumik3-del/ziptask/main/scripts/install.sh | sh
```

Default install dir: `~/.ziptask/`. Override with `ZIPTASK_HOME=/some/path`. Pin a version with `ZIPTASK_VERSION=0.1.0`. On systemd systems the installer provisions a background service on port 3005 (override with `--port`); skip it with `--no-service`.

### Service mode

When systemd is detected and running, `install.sh` creates `/etc/systemd/system/ziptask.service` (Type=simple, `Restart=on-failure`, port 3005). Manage it with:

```bash
sudo systemctl start ziptask
sudo systemctl stop ziptask
sudo systemctl enable ziptask     # auto-start on boot
journalctl -u ziptask -f         # live logs
```

Remove with `bash ~/.ziptask/scripts/uninstall.sh` (use `--keep-data` to preserve the DB and settings).

### MCP client config (stdio)

```jsonc
// Claude / Cursor / opencode — ~/.config/claude/settings.json or equivalent
{
  "mcpServers": {
    "ziptask": {
      "command": "~/.ziptask/bin/ziptask",
      "args": ["--stdio"]
    }
  }
}
```

Upgrade path is via `bash ~/.ziptask/scripts/update.sh` — it fetches the latest release, downloads the matching binary, and restarts the systemd service when active. To pin a version, pass `--version <tag>` (the script accepts tags with or without a `v` prefix):

```bash
bash ~/.ziptask/scripts/update.sh
bash ~/.ziptask/scripts/update.sh --version v0.2.0
```

The script prompts y/N before overwriting. **Before swapping the binary it creates an online SQLite backup** of `ZIPTASK_DB` (resolved from env → `settings.json` dbPath → `~/.ziptask/data/ziptask.db`) into `~/.ziptask/backups/ziptask-<timestamp>.db` via `sqlite3 .backup`; missing sqlite3 or a missing DB are handled as warnings and the update continues. The backup path is printed so a failed upgrade is reversible. On non-systemd systems the binary is replaced but you must restart manually.

**Schema guard on startup:** a fresh DB auto-initialises; an older DB (V < L) auto-migrates forward; a DB newer than the binary (V > L, i.e. you downgraded) refuses to start with `SCHEMA: database schema version <V> is newer than this binary supports (<L>); upgrade ziptask or restore the database from backup`, exit 1. Fix by re-upgrading to the newer binary or restoring the backup that `update.sh` wrote. `--version` does not touch the DB.

## Quick start (from source)

Requires [Bun](https://bun.sh) ≥ 1.4.

```bash
bun install
bun run start          # HTTP server on an ephemeral port (MCP endpoint + /health)
bun run start:stdio    # run over stdio
```

## Build a binary

```bash
bun run build:bin        # produces dist/ziptask
dist/ziptask --version   # prints ziptask 0.1.0
dist/ziptask --stdio     # runs as stdio MCP server
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

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.