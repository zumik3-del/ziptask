# Epic → sub-task workflow

Epics are structural containers, not work. They cannot be claimed and their status is manual.

## Declaring an epic

```
create_task {title: 'Release v2', reporter: 'orchestrator', project: 'myproj', epic: true}
```
or attach the first sub-task to promote it automatically:
```
create_task {title: 'Sub-work', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>}
```
The target is auto-promoted to an epic (audit row `subtask_add`); the API exposes it as `is_epic: true` (`is_epic = 1` in SQL).

## Attaching sub-tasks

Sub-tasks are ordinary tasks with `epic_id` pointing at the epic. Use `depends_on` for ordering:
```
create_task {title: 'Implement auth', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>}
create_task {title: 'Write docs', reporter: 'orchestrator', project: 'myproj', epic_id: <epic-id>, depends_on: [<auth-id>]}
```
Nested membership is rejected (epic cannot be a sub-task; sub-task cannot be an epic).

`create_task` requires `project` even when `epic_id` is given, and `epic_id` must point into the **same** project as the new task: children carry their epic's project by equality, never by a lookup that would resolve the scope from the epic. See [Projects and scope](mcp-tools.md#projects-and-scope).

## Roll-up and closure

- `get_task fields:["subtasks"]` on the epic returns `{total, open, done, failed, canceled}` (open = queued+in_progress+review+blocked; `canceled` counts withdrawn children, which are terminal).
- `list_tasks epic_id:<epic-id>` returns only children (it is an enumerating call, so it also needs `project`).
- The epic timeline (`get_timeline`) mirrors terminal sub-task events: `subtask_add`, `subtask_done`, `subtask_failed` (canceled children emit no mirror row).
- `update_status(epic→done|failed|canceled)` is guarded: rejected with `CHILDREN: N sub-tasks not terminal` while any child is non-terminal (canceled children are terminal and do not block closure).

## Constraints

| Rule | Error |
|---|---|
| `epic: true` + `epic_id` | `INVALID: epic cannot have a parent epic` |
| `epic: true` + `depends_on` | `INVALID: epic cannot have depends_on` |
| `depends_on` pointing at an epic | `INVALID: dependencies on epic tasks not allowed (#N)` |
| `depends_on` pointing outside the new task's project | `INVALID: dependency #N belongs to project 'y'` |
| `epic_id` pointing outside the new task's project | `INVALID: epic #N belongs to project 'y'` |
| `epic_id` pointing at a terminal task | `INVALID: cannot attach to a terminal task` |
| `epic_id` pointing at a sub-task (nesting) | `INVALID: cannot attach to a sub-task (no nesting)` |
| Explicit `claim_task` on an epic | `INVALID: #N is an epic, not claimable` |

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
- `blocked`/`failed` on an epic are manual flags only; no cascade to children.
