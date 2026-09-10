# ziptask

[![Coverage Status](https://coveralls.io/repos/github/zumik3-del/ziptask/badge.svg?branch=main)](https://coveralls.io/github/zumik3-del/ziptask?branch=main)

MCP task tracker for AI agents. A pure state layer — statuses, dependencies, leases, versioning — over SQLite, served to agents over MCP.

## Install

One-liner — downloads a compiled binary, writes default config, prints client setup:

```bash
curl -LsS https://raw.githubusercontent.com/zumik3-del/ziptask/main/scripts/install.sh | sh
```

Default install dir: `~/.ziptask/`. Override with `ZIPTASK_HOME=/some/path`. Pin a version with `ZIPTASK_VERSION=0.1.2`. On systemd systems the installer provisions a background service on port 3005 (override with `--port`); skip it with `--no-service`. `update.sh` and `uninstall.sh` are installed into `~/.ziptask/scripts/`.

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
      "args": ["--stdio", "--settings", "~/.ziptask/settings.json"]
    }
  }
}
```

Pass `--settings` so the DB path and options come from `settings.json` regardless of the client's working directory — otherwise the DB defaults to `./data/ziptask.db` under the client's cwd. Some clients do not expand `~` in arguments; substitute the absolute path (the installer prints a ready-to-paste block).

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
dist/ziptask --version   # prints the package.json version
dist/ziptask --stdio     # runs as stdio MCP server
```

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

## Documentation

- [Configuration](docs/configuration.md) — `settings.json`, environment variables, the upgrade path, and backups.
- [MCP tools](docs/mcp-tools.md) — tool reference and task statuses.
- [Epic → sub-task workflow](docs/epics.md) — declaring epics, attaching sub-tasks, roll-up and closure.

## License

MIT

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.
