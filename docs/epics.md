# Epic → sub-task workflow

Epics are structural containers, not work. They cannot be claimed, hold no lease, and start in the `open` status (code 8) — a non-terminal status whose only outgoing transitions are to terminal outcomes (`done`, `failed`, `canceled`).

## Declaring an epic

```
create_task {title: 'Release v2', reporter: 'orchestrator', project: 'myproj', epic: true}
```
The created task comes back with `status: 'open'` (never `queued`). Or attach the first sub-task to promote a regular task automatically:
```
create_task {title: 'Sub-work', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>}
```
The target is auto-promoted to an epic (audit row `subtask_add`) and its status is rewritten from `queued` to `open`; lease metadata is cleared. The API exposes it as `is_epic: true` (`is_epic = 1` in SQL).

Promotion is confined to a **`queued`** target: rewriting the status drops the lease, so promoting a row somebody is already working would silently destroy that work. Attaching to an `in_progress`/`review`/`blocked` task is refused:

```
INVALID: cannot promote #42 from in_progress: only a queued task can become an epic
```

Attaching a *further* child to an epic that already exists promotes nothing and is always allowed — the target's status is irrelevant there.

An epic takes no `assignee`: the field means "lease holder" everywhere else and an epic holds no lease. `create_task(epic: true, assignee: '...')` is refused with `INVALID: an epic takes no assignee: it holds no lease`, and the column is `NULL` on every epic row (migration 007 clears it on pre-existing rows too).

## Attaching sub-tasks

Sub-tasks are ordinary tasks with `epic_id` pointing at the epic. Use `depends_on` for ordering:
```
create_task {title: 'Implement auth', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>}
create_task {title: 'Write docs', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>, depends_on: [<auth-id>]}
```
Nested membership is rejected (epic cannot be a sub-task; sub-task cannot be an epic).

`create_task` requires `project` even when `epic_id` is given, and `epic_id` must point into the **same** project as the new task: children carry their epic's project by equality, never by a lookup that would resolve the scope from the epic. See [Projects and scope](mcp-tools.md#projects-and-scope).

## Status and transitions

- An epic's status is `open` while work is in flight; it is never `queued`, `in_progress`, `review` or `blocked`.
- `open → done`, `open → failed`, `open → canceled` are the only outgoing transitions. `canceled` withdraws the epic.
- Epics are never leased: `claim_task` and any non-terminal `in_progress` acquisition are refused with `INVALID: #N is an epic, not claimable`. There is no lease-free on-ramp through intermediate statuses anymore.
- Closing an epic (`done`/`failed`/`canceled`) is guarded: rejected with `CHILDREN: N sub-tasks not terminal` while any child is non-terminal (canceled children are terminal and do not block closure).

## Roll-up and closure

- `get_task fields:["subtasks"]` on the epic returns `{total, open, done, failed, canceled}` (open = non-terminal children; `canceled` counts withdrawn children, which are terminal).
- `list_tasks epic_id:<epic-id>` returns only children (it is an enumerating call, so it also needs `project`).
- The epic timeline (`get_timeline`) mirrors terminal sub-task events: `subtask_add`, `subtask_done`, `subtask_failed` (canceled children emit no mirror row).
- `update_status(epic→done|failed|canceled)` is guarded: rejected with `CHILDREN: N sub-tasks not terminal` while any child is non-terminal (canceled children are terminal and do not block closure).

## Constraints

| Rule | Error |
|---|---|
| `epic: true` + `epic_id` | `INVALID: epic cannot have a parent epic` |
| `epic: true` + `depends_on` | `INVALID: epic cannot have depends_on` |
| `epic: true` + `assignee` | `INVALID: an epic takes no assignee: it holds no lease` |
| `depends_on` pointing at an epic | `INVALID: dependencies on epic tasks not allowed (#N)` |
| `depends_on` pointing outside the new task's project | `INVALID: dependency #N belongs to project 'y'` |
| `epic_id` pointing outside the new task's project | `INVALID: epic #N belongs to project 'y'` |
| `epic_id` pointing at a terminal task | `INVALID: cannot attach to a terminal task` |
| `epic_id` pointing at a sub-task (nesting) | `INVALID: cannot attach to a sub-task (no nesting)` |
| `epic_id` pointing at a non-`queued` task that is not yet an epic | `INVALID: cannot promote #N from <status>: only a queued task can become an epic` |
| Explicit `claim_task` on an epic | `INVALID: #N is an epic, not claimable` |
| `queued`/`in_progress`/`review`/`blocked` on an epic | `INVALID: <status> → <status>` (epics only accept `done`/`failed`/`canceled`) |
| Terminal close with non-terminal children | `CHILDREN: N sub-tasks not terminal` |

## Re-parent or detach (escape hatch)

There is no tool for re-parenting: `epic_id` is immutable through the API. When a task lands in the wrong epic (or an epic is retired), use raw SQL against `ZIPTASK_DB`:

```sql
-- move to another epic
UPDATE tasks SET epic_id = <new-epic-id>, updated_at = <iso-now> WHERE id = <task-id>;
-- detach to top level
UPDATE tasks SET epic_id = NULL, updated_at = <iso-now> WHERE id = <task-id>;
```

The target epic's roll-up is derived on read, so no counter recalculation is needed. Raw SQL bypasses the API guards — verify first that the target exists, is not `done`/`failed`/`canceled`, is not itself a sub-task, and is not the task itself. Leave `version` untouched (no client optimistic-lock is racing a manual edit). Detaching may leave the old epic empty.

## Notes

- `epic_id` is immutable after creation (no re-parent/detach tool) — use the SQL recipe above.
- `failed`/`canceled` on an epic are terminal; `done` closes it. There is no `blocked` state for epics.
- A migration (007) rewrote pre-existing non-terminal epics (`queued`/`in_progress`/`review`/`blocked`) to `open` and cleared their lease metadata.
