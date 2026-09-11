# ziptask wire protocol

Server owns state (statuses, deps, leases, versions) over SQLite; content stays in files; task text is English.

## Statuses
`STATUS_CODES`: `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled. Flow `queued -> in_progress -> review -> done`; `done`/`failed`/`canceled` terminal; `blocked` manual. Readiness comes from `depends_on` at read time (unsatisfied deps stay queued, hidden from `list_queue`/auto-claim). Lease expiry requeues the task and increments `attempts`.

## Tools
- `list_queue` -> pipe `id|priority|title`; `list_tasks` JSON, or batch `ids` -> `id|code`; `description` only via explicit `fields`.
- `get_task` brief (`id,title,status,priority,blocked_by`), more via `fields`; `description` is the contract (goal, AC, constraints, deliverable).
- `claim_task` -> `{id, lease_ttl_min, version}`; `update_status` optimistic `version` lock (terminal takes a resolution `comment`); `add_comment`; `get_timeline` -> `seq|type|agent|at|text`; `get_template`.

## Lifecycle
1. `get_task` — the description is the contract.
2. `claim_task`; keep `id` + `version`.
3. Work, then `update_status(id, agent, "review", version)` + `add_comment`.
4. `CONFLICT` -> re-read `get_task fields:["version"]`, retry.
5. Lease expired -> task requeued; reclaim, treat old `version` as stale.
6. Cannot finish -> `blocked`/`failed` + comment the cause.

Comment from `get_template("comment-success")` or `"comment-failure"`: one English line with the verified outcome and the command that proves it.
