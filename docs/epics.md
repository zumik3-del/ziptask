# Epic → sub-task workflow

Epics are structural containers, not work. They cannot be claimed and their status is manual.

## Declaring an epic

```
create_task {title: 'Release v2', reporter: 'orchestrator', epic: true}
```
or attach the first sub-task to promote it automatically:
```
create_task {title: 'Sub-work', reporter: 'orchestrator', epic_id: <epic-id>}
```
The target is auto-promoted to `is_epic=1` (audit row `promote_epic`).

## Attaching sub-tasks

Sub-tasks are ordinary tasks with `epic_id` pointing at the epic. Use `depends_on` for ordering:
```
create_task {title: 'Implement auth', reporter: 'orchestrator', epic_id: <epic-id>}
create_task {title: 'Write docs', reporter: 'orchestrator', epic_id: <epic-id>, depends_on: [<auth-id>]}
```
Nested membership is rejected (epic cannot be a sub-task; sub-task cannot be an epic).

## Roll-up and closure

- `get_task fields:["subtasks"]` on the epic returns `{total, open, done, failed, canceled}` (open = queued+in_progress+review+blocked; `canceled` counts withdrawn children, which are terminal).
- `list_tasks epic_id:<epic-id>` returns only children.
- The epic timeline (`get_timeline`) mirrors terminal sub-task events: `subtask_add`, `subtask_done`, `subtask_failed` (canceled children emit no mirror row).
- `update_status(epic→done)` is guarded: rejected with `CHILDREN: N sub-tasks not terminal` while any child is non-terminal (canceled children are terminal and do not block closure).

## Constraints

| Rule | Error |
|---|---|
| `epic: true` + `epic_id` | `INVALID: epic cannot have a parent epic` |
| `epic: true` + `depends_on` | `INVALID: epic cannot have depends_on` |
| `depends_on` pointing at an epic | `INVALID: dependencies on epic tasks not allowed (#N)` |
| `epic_id` pointing at a terminal task | `INVALID: cannot attach to a terminal task` |
| `epic_id` pointing at a sub-task (nesting) | `INVALID: cannot attach to a sub-task (no nesting)` |
| Explicit `claim_task` on an epic | `INVALID: #N is an epic, not claimable` |

## Notes

- `epic_id` is immutable after creation (no re-parent/detach). Manual SQL is the escape hatch.
- `blocked`/`failed` on an epic are manual flags only; no cascade to children.
- Metrics: epics are excluded from all metrics calculations — an epic sitting in one status for days would distort `bottleneck`. Implementation lives in `src/core/metrics.ts` (`computeMetrics`); issue #25 is resolved (deferred MCP tool moved to standalone CLI).
- Metrics CLI: `bun run scripts/metrics.ts --period <hours|all>` (default 24); `--db <path>` or `ZIPTASK_DB` env override. Pipe-format output: `done_count|N`, `status_time|status:min`, `bottleneck|status:min`. Empty DB → `done_count|0` with no `status_time`/`bottleneck`. Invalid period (e.g. `0`) → stderr error, exit 1. When `ZIPTASK_AUDIT_LOG=false`, timeline shows only comment rows and `status_time` degrades but `done_count` stays accurate.
