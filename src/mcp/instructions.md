# ziptask wire protocol

Server owns state (statuses, deps, leases, versions) over SQLite; content stays in files; task text is English.

## Statuses
`STATUS_CODES`: `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled. Flow `queued -> in_progress -> review -> done`; `done`/`failed`/`canceled` terminal; `blocked` manual. Readiness comes from `depends_on` at read time (unsatisfied deps stay queued, hidden from `list_queue`/auto-claim). Lease expiry requeues the task and increments `attempts` (a heartbeat is liveness, not progress, so it never refunds). The holder keeps a lease with `update_status(id, agent, "in_progress", version, renew: true)` — renew about every `lease_ttl_min`/3, otherwise a long task is requeued; a renewal after the deadline cannot resurrect the lease and costs one `attempts` step. A budget spent on accidents is refunded with `reset_attempts: true`. `in_progress` is a leased state and `claim_task` is the door to a lease: a non-renewal transition into it needs claim-grade eligibility — an epic (`INVALID: #N is an epic, not claimable`) or an open dep entering from `queued`/`blocked` (`BLOCKED: dependencies not satisfied`) is refused, so an epic is never leased. A server predating that guard answers the same call with success; a leased epic then surfaces in `list_tasks(status:'in_progress', fields:['is_epic'])`.

## Tools
- `create_task` -> always queued; `blocked` is a manual flag only; build `description` from `get_template("task")`, or `get_template("epic")` for epics.
- `list_queue` -> pipe `id|priority|title`; `list_tasks` JSON, or batch `ids` -> `id|code`; `description` only via explicit `fields`.
- `get_task` brief (`id,title,status,priority,blocked_by`), more via `fields`; `description` is the contract (goal, AC, constraints, deliverable).
- `claim_task` -> input key is `task_id` (`id` is an accepted alias of `task_id`; `id` alone claims that task, both equal is fine, both different is an `INVALID:` conflict) -> `{id, lease_ttl_min, version}`; `update_status` optimistic `version` lock (terminal takes a resolution `comment`; `renew: true` extends your own `in_progress` lease and bumps `version`; `reset_attempts: true` requires a `comment`, zeroes `attempts` on any legal transition, audits `attempts_reset` and echoes `attempts` in the response; a non-renewal `in_progress` needs claim-grade eligibility and refusals are checked in this order — `agent`/`comment`, refund `comment`, `NOT_FOUND`, `version`, `renew` intent, transition, renewal holder, lease acquisition, refund on an epic, epic children — so a combined `in_progress` + `reset_attempts` call on an epic reports the acquisition); `add_comment`; `get_timeline` -> `seq|type|agent|at|text`; `get_template`.
- Every tool rejects unknown argument keys with `INVALID: unknown argument(s) <names> on <tool> (accepted: ...)` before any state change — the error lists the accepted keys; shape/type errors stay SDK-side.

## Lifecycle
1. `get_task` — the description is the contract.
2. `claim_task` with `task_id`; keep the response's `id` + `version`.
3. Work longer than `lease_ttl_min`/3 -> `update_status(id, agent, "in_progress", version, renew: true)`; only the holder may renew and the version bumps, so keep the new one.
4. Work, then `update_status(id, agent, "review", version)` + `add_comment`.
5. `CONFLICT` -> re-read `get_task fields:["version"]`, retry. `CONFLICT: lease held by <other>` -> the lease is live and someone else's: do not retry, hand the task back through that agent (the holder renews it, or releases it with `update_status(status:"blocked")`). `CONFLICT: lease held by null` -> a legacy row with no assignee (nothing recorded one before leases tracked a holder): park it `blocked` and `claim_task` it to take a fresh lease.
6. Lease expired -> task requeued and one `attempts` step spent; re-claim, treat old `version` as stale.
7. Cannot finish -> `blocked`/`failed` + comment the cause.
8. `attempts` spent without work done (accidental claims, machine downtime) -> fix the cause first, then refund with one call from `blocked`: `update_status(id, agent, "queued", version, reset_attempts: true, comment: "<why>")`; the `comment` is mandatory and the `attempts: 0` echo confirms it. A task still `queued` has no self-edge, so park it `blocked` first. Terminal stays terminal: a `failed` task is recovered by recreating it, not by reopening.
9. Refused into `in_progress` (`INVALID: #N is an epic, not claimable` / `BLOCKED: dependencies not satisfied`) -> nothing was written, not even an audit row. An epic is never leased: move it `queued -> blocked -> review` (lease-free hops) or `canceled`. A dep-blocked task waits for its dep or stays `queued`; `review -> in_progress` is the sanctioned "work sent back" edge and asks no dep question.
10. `in_progress` whose timeline is `lease_renewed` only (no comment, no status change) for more than one `lease_ttl_min` -> presumed dead: `update_status(status:"blocked")` + triage.

Comment from `get_template("comment-success")` or `"comment-failure"`: one English line with the verified outcome and the command that proves it.
