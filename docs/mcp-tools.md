# MCP tools

ziptask exposes 9 tools:

| Tool | What it does |
|---|---|
| `create_task` | Enqueue a task; always `queued` — `blocked` is a manual flag only. Fields: `epic?` (declare as epic, not claimable), `epic_id?` (attach as sub-task to an existing epic) |
| `get_task` | Read a task; `description` only via explicit `fields`. Epics: `subtasks` roll-up (`{total,open,done,failed,canceled}`) via `fields:["subtasks"]`; `epic_id` via `fields` when reading a sub-task |
| `list_tasks` | JSON mode: filter by `assignee`/`status`/`updated_since`/`epic_id`; `description` only via explicit `fields`. Pipe mode (batch): pass `ids` (array of ints) — implicit pipe `id|code`, no `format` param; `fields:["assignee"]` → `id|code|assignee`, null assignee → `-`; request order is preserved, unknown id → `0`. All other filters ignored when `ids` is set. Merges the former `batch_statuses` tool — rationale: the separate "ask about tasks" was an ambiguous duplicate of `list_tasks`-by-ids; unified under one tool with two output shapes. |
| `claim_task` | Claim a task; auto-pick selects among `queued`, explicit `task_id` also accepts a manually `blocked` task. Returns `{id, lease_ttl_min, version}`. Epics are excluded from auto-pick and explicit claim returns `INVALID: #N is an epic, not claimable` |
| `update_status` | Transition status with optimistic version lock. `canceled` is terminal and withdraws any non-terminal task (`queued`/`in_progress`/`review`/`blocked`); `done`/`failed` cannot be canceled. Optional `comment` is stored as a `resolution` when the target status is terminal (`done`/`failed`/`canceled`), otherwise as a `comment`. Epic close-guard: `done`/`failed`/`canceled` rejected while non-terminal children exist → `CHILDREN: N sub-tasks not terminal` |
| `list_queue` | Pipe lines of dep-satisfied queued tasks (epics excluded) |
| `add_comment` | Append a comment to a task |
| `get_timeline` | Merged audit log + comments feed. Epics show `subtask_add`/`subtask_done`/`subtask_failed` mirror rows — history reads as `create → subtask_add… → subtask_done… → resolution` |
| `get_template` | Fetch a markdown template (task description, comments) |

## Statuses

Codes (`STATUS_CODES`): `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled.

Flow: `queued → in_progress → review → done` (or `failed` / `blocked`). Any non-terminal status can be withdrawn to `canceled`. `done`, `failed` and `canceled` are terminal; lease expiry returns to `queued` and increments `attempts`. Tasks with unsatisfied `depends_on` stay `queued` but are hidden from `list_queue` and auto-claim.
