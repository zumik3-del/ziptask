# ziptask

MCP task tracker for AI agents. A pure state layer — statuses, dependencies, leases, versioning — over SQLite, served to agents over MCP.

## Install

One-liner — downloads a compiled binary, writes default config, prints client setup:

```bash
curl -LsS https://github.com/zumik3-del/ziptask/releases/latest/download/install.sh | sh
```

Default install dir: `~/.ziptask/`. Override with `ZIPTASK_HOME=/some/path`. Pin a version with `ZIPTASK_VERSION=0.1.0`.

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

### Upgrade

```bash
curl -LsS https://github.com/zumik3-del/ziptask/releases/latest/download/install.sh | sh
# or pin a specific version
ZIPTASK_VERSION=0.2.0 sh install.sh
```

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