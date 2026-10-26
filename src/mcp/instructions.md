# ziptask wire protocol

Server owns state (statuses, deps, leases, versions) over SQLite; content stays in files; task text is English. This is the normative one-screen contract; the full reference is `docs/mcp-tools.md`.

## Statuses
`STATUS_CODES`: `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled, `8` open.

Flow `queued -> in_progress -> review -> done` for regular tasks, `open -> done|failed|canceled` for epics. `open` is epic-only, and an epic never holds `queued`/`in_progress`/`review`/`blocked` and takes no `assignee`. `done`/`failed`/`canceled` are closed for work: `completed_at` is set, no lease holder, and they never block a dependent, a parent epic or an open count. `failed -> canceled` is the administrative withdrawal (the failure stands, the task is closed out, never reopened). `blocked` is a manual flag.

Readiness comes from `depends_on` at read time: an unsatisfied dep keeps the task `queued` and hides it from `list_queue` and auto-claim.

Leases: `claim_task` is the door to a lease, and a non-renewal transition into `in_progress` must clear the same bar (not an epic, deps satisfied). `assignee` is the lease holder and nothing else — written on `in_progress`, cleared on every other status — so a task that leaves `in_progress` carries no holder, and a task is born `queued` without one (`create_task` refuses `assignee`). Keep a lease with `update_status(id, agent, "in_progress", version, renew: true)` about every `lease_ttl_min`/3: a renewal is liveness, not progress, so it never refunds. An expired lease is requeued and costs one `attempts` step; a late renewal cannot resurrect it. A budget spent on accidents is refunded with `reset_attempts: true`.

## Priorities
`p0` (highest urgency), `p1`, `p2` (the default), `p3` (lowest) — the number descends as urgency rises. `create_task` accepts the canonical `"p0".."p3"`, the number `0..3` and the digit string `"0".."3"`; every shape is stored and returned as the canonical `"pN"`, and the queue order is `ORDER BY priority` (lexicographic, `p0` first). Anything else is refused.

## Projects
`project` (a lowercase slug) is a required filter on exactly the enumerating calls: `create_task` (always), `list_queue` (always), `list_tasks` (unless `ids` is non-empty), `claim_task` (only when `task_id` is absent). There is no default and no all-projects mode: a missing slug is `INVALID: project required`, and `project: "*"` is just an unknown slug. By-id tools declare no `project` argument at all. `create_task` is refused in the reserved `legacy` project and in an archived project (existing work stays readable and claimable); `depends_on` and `epic_id` must point into the same project. Consequence: auto-claim is orchestrator-only in practice — a subagent holds no slug and is handed a `task_id`.

## Tools
- `create_task` -> regular tasks start `queued`, epics `open`; `blocked` is a manual flag only; build `description` from `get_template("task")`, or `get_template("epic")` for epics. Bounds: `description` 20000, `title`/`reporter`/`assignee` 200 code points, `depends_on` 100 ids.
- `list_queue` -> pipe `id|priority|title`; `list_tasks` -> JSON, or batch `ids` -> pipe `id|code`; `description` only via explicit `fields`; `project` via `fields` (`get_task`, `list_tasks`, `claim_task include`).
- `get_task` -> brief (`id,title,status,priority,blocked_by`), more via `fields`; `description` is the contract (goal, AC, constraints, deliverable).
- `update_task` -> version-locked patch of `title`/`description`/`priority`/`depends_on` on a `queued` task (regular) or an `open` epic with no lease holder; `agent` required, `version` optional lock, `comment?` rationale. A supplied value equal to the stored one is a no-op (`changed: []`, no version bump). Output `{id, version, changed}`.
- `claim_task` -> input key `task_id` -> `{id, lease_ttl_min, version}`; `update_status` -> optimistic `version` lock: a `done`/`failed`/`canceled` target takes a resolution `comment`, and `reset_attempts: true` requires a `comment` and echoes `attempts`; `add_comment`; `get_timeline` -> pipe `seq|type|agent|at|text`; `get_template`.
- `create_project` -> `{slug}` (`slug?` derives from the folder name; `folder_path` must be absolute); `list_projects` -> pipe `slug|folder|open`, ordered by slug ASC, empty table -> empty text, archived projects listed identically; `update_project` -> `{slug}`; `delete_project` -> `{deleted:<slug>}`, zero tasks only.
- Unknown argument keys are refused before any state change; the error lists the accepted keys.

## Lifecycle
1. `get_task` — the description is the contract.
2. `claim_task` with `task_id`; keep the response's `id` + `version`.
3. Long work: renew before `lease_ttl_min`/3 elapses. Only the holder may renew, and the version bumps, so keep the new one.
4. Work, then `update_status(id, agent, "review", version)` + `add_comment`.
5. `CONFLICT` -> re-read `get_task fields:["version"]` and retry. `CONFLICT: lease held by <other>` -> the lease is live and someone else's: do not retry, hand the task back through that agent (the holder renews it, or releases it with `update_status(status:"blocked")`). `CONFLICT: lease held by null` -> a legacy row with no holder: park it `blocked`, then `claim_task` for a fresh lease.
6. Lease expired -> the task is requeued and one `attempts` step is spent; re-claim and treat the old `version` as stale.
7. Cannot finish -> `blocked` or `failed` + a comment with the cause.
8. `attempts` spent without work done (accidental claims, downtime) -> fix the cause first, then refund in one call from `blocked`: `update_status(id, agent, "queued", version, reset_attempts: true, comment: "<why>")`; the `attempts: 0` echo confirms it, and a still-`queued` task has no self-edge, so park it `blocked` first. A task closed for work is never reopened: a `failed` task is recovered by recreating it, or closed out with `canceled`.
9. Refused into `in_progress` (an epic, or an open dep when entering from `queued`/`blocked`) -> nothing was written, not even an audit row. A dep-blocked task waits or stays `queued`; `review -> in_progress` is the sanctioned "work sent back" edge and asks no dep question.
10. `in_progress` whose timeline is `lease_renewed` only for more than one `lease_ttl_min` -> presumed dead: `update_status(status:"blocked")` + triage.
11. Epics: created `open`, never claimed or leased, and closed directly to `done`/`failed`/`canceled` only once every sub-task is terminal (`CHILDREN: N sub-tasks not terminal` otherwise). A task is promoted to an epic only from `queued` (attaching a child elsewhere is refused); promotion rewrites the status, drops the lease and bumps the target's `version`, so re-read it before the next write.

Comment from `get_template("comment-success")` or `"comment-failure"`: one English line with the verified outcome and the command that proves it.
