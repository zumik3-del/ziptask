# HTTP endpoints

`bun run start` (and the systemd service) exposes a small HTTP surface next to the MCP transport. ziptask is MCP-first, not MCP-only: the task API is MCP, plus one experimental REST-style read endpoint kept for an external client.

| Method & path | Purpose |
|---|---|
| `POST` / `GET` / `DELETE` `/mcp` | MCP StreamableHTTP transport — the client-facing API (tool calls, SSE stream, session teardown) |
| `GET /health` | Liveness probe, always `{"ok":true}` |
| `GET /api/task/:id` | **Experimental** read-only task view (subagentix integration) |

Every path returns `404` `Not Found` when it does not match. No endpoint authenticates — keep the listener bound to `127.0.0.1` (`ZIPTASK_HOST`/`settings.json`) and put an authenticating reverse proxy in front if it must be reachable from other hosts.

## `GET /api/task/:id` (experimental)

A provisional, read-only endpoint that is **an intentional integration endpoint for the subagentix client** — a REST-style consumer that does not speak MCP. It is not a general-purpose public API and its response shape is subject to change (the comment in `src/server.ts` marks it `EXPERIMENTAL`). It goes through the same service layer as the MCP tools.

```jsonc
{
  "task": { "id": 42, "title": "…", "description": "…", "status": "in_progress", "priority": "p2", "…": "…" },
  "blocked_by": [7],                 // dependency ids that are not terminal yet
  "subtasks": { "total": 3, "open": 1, "done": 2, "failed": 0, "canceled": 0 },
  "comments": [ { "id": 1, "agent": "developer", "content": "…", "type": "comment", "created_at": "…" } ]
}
```

- `task` is the **whole task row**, including `description`. This is the key difference from the token-minimal MCP `get_task`, which omits `description` unless it is requested explicitly via `fields`.
- `blocked_by` lists the dependency ids that are not terminal.
- `subtasks` is present only when the task is an epic with at least one child — the same derived roll-up as `get_task fields:["subtasks"]`.
- `comments` holds the task's comment and resolution rows, oldest first (the same rows the MCP `get_timeline` surfaces).

Errors:

| Condition | Status | Body |
|---|---|---|
| non-integer or empty id | `400` | `{"error":"Invalid task id"}` |
| unknown id | `404` | `{"error":"NOT_FOUND"}` |

Because it routes through the service, this read also triggers the [lazy lease reap](mcp-tools.md#reads-and-lease-reap) — it can change task state and bump `version`.
