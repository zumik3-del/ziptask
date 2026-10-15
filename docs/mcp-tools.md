# MCP tools

ziptask exposes 13 tools:

| Tool | What it does |
|---|---|
| `create_task` | Enqueue a task; always `queued` — `blocked` is a manual flag only. Fields: `epic?` (declare as epic, not claimable), `epic_id?` (attach as sub-task to an existing epic), `project` (required — see [Projects and scope](#projects-and-scope)) |
| `get_task` | Read a task; `description` only via explicit `fields`, and the project slug via `fields:["project"]`. Epics: `subtasks` roll-up (`{total,open,done,failed,canceled}`) via `fields:["subtasks"]`; `epic_id` via `fields` when reading a sub-task |
| `list_tasks` | JSON mode: filter by `assignee`/`status`/`updated_since`/`epic_id`; `project` required unless `ids` is non-empty (see [Projects and scope](#projects-and-scope)); `description` only via explicit `fields`. Pipe mode (batch): pass `ids` (array of ints) — implicit pipe `id|code`, no `format` param; `fields:["assignee"]` → `id|code|assignee`, null assignee → `-`; request order is preserved, unknown id → `0`. All other filters ignored when `ids` is set. Merges the former `batch_statuses` tool — rationale: the separate "ask about tasks" was an ambiguous duplicate of `list_tasks`-by-ids; unified under one tool with two output shapes. |
| `claim_task` | Claim a task; auto-pick selects among `queued` **of one project** (the required `project` — see [Projects and scope](#projects-and-scope)), explicit `task_id` also accepts a manually `blocked` task. `id` is an accepted alias of `task_id` (`id` alone claims that task; both present and equal is fine; both present and different is rejected with `INVALID: claim_task id/task_id conflict (id=… task_id=…); task_id is canonical` and nothing is claimed). Returns `{id, lease_ttl_min, version}`. Epics are excluded from auto-pick and explicit claim returns `INVALID: #N is an epic, not claimable`. A non-renewal `update_status` into `in_progress` is held to the same eligibility — see [Lease recovery paths](#lease-recovery-paths) |
| `update_status` | Transition status with optimistic version lock. `canceled` is terminal and withdraws any non-terminal task (`queued`/`in_progress`/`review`/`blocked`); `done`/`failed` cannot be canceled. Optional `comment` is stored as a `resolution` when the target status is terminal (`done`/`failed`/`canceled`), otherwise as a `comment`. Optional `renew: true` is the lease heartbeat: with `status=in_progress` on an `in_progress` task it re-arms the caller's own lease as a `lease_ttl_min` window computed from now (never the old deadline + TTL), bumps `version`, and audits `lease_renewed: <old>-><new>` instead of `update_status` (so `statusDurations` keeps one `in_progress` segment). Rejected without state change: `in_progress → in_progress` without the flag (`INVALID: in_progress → in_progress requires renew: true`), `renew` on any other target or task state (`INVALID: renew requires status=in_progress on an in_progress task`), `renew` on an epic (`INVALID: #N is an epic`), and a caller that is not the holder (`CONFLICT: lease held by <assignee>` — a mistake-catcher, not authorization; the tracker has no auth). Optional `reset_attempts: true` refunds a spent attempts budget: it rides on any legal transition, zeroes `attempts` in the same version-guarded write (so it is atomic with the status change and the `version` bump), leaves `max_attempts` untouched, audits `attempts_reset: N->0`, and adds `attempts` to the response as the confirmation that the flag reached the server. The primary case is `blocked → queued` (one call). Rejected without state change: without a `comment` (`INVALID: reset_attempts requires a comment`) and on an epic (`INVALID: cannot reset attempts on epic #N`). Terminal statuses have no outgoing edge, so a refund on `done`/`failed`/`canceled` is refused by the transition guard — a `failed` task is recovered by recreating it with fresh counters, not by reopening. The reaper's charge rule is unchanged: one expiry still costs one `attempts` step even with zero progress, because that charge is the loop-breaker. A non-renewal transition into `in_progress` is held to the same eligibility as `claim_task`: refused for an epic (`INVALID: #N is an epic, not claimable`) and for unmet `depends_on` when entering from `queued`/`blocked` (`BLOCKED: dependencies not satisfied`); `review → in_progress` asks no dependency question (`depends_on` is immutable after create and terminal statuses have no outgoing edge). Refusals are checked in the order agent/comment → refund `comment` → `NOT_FOUND` → `version` → `renew` intent → transition → renewal holder → lease acquisition → refund on an epic → epic children, so a combined `in_progress` + `reset_attempts` call on an epic reports the acquisition, not the refund. A refused acquisition writes nothing: not the task, not the audit log. Epic close-guard: `done`/`failed`/`canceled` rejected while non-terminal children exist → `CHILDREN: N sub-tasks not terminal` |
| `list_queue` | Pipe lines of dep-satisfied queued tasks **of one project** (epics excluded; the required `project` — see [Projects and scope](#projects-and-scope)) |
| `add_comment` | Append a comment to a task |
| `get_timeline` | Merged audit log + comments feed. Epics show `subtask_add`/`subtask_done`/`subtask_failed` mirror rows — history reads as `create → subtask_add… → subtask_done… → resolution` |
| `get_template` | Fetch a markdown template (task description, comments) |
| `create_project` | Register a project. `folder_path` is required and recorded as an annotation — normalized to an absolute path, never checked for existence, not unique, and used to derive the slug when that is omitted. Output `{slug}`, never the row — the internal `id` does not cross the tool boundary |
| `list_projects` | Pipe lines `slug|folder|open`, ordered by `slug` ASC — `open` counts the project's non-terminal tasks. Archived projects are listed identically (there is no archived column, and `legacy` is listed too); an empty table produces empty text |
| `update_project` | Update a project by slug: `project`, plus any of `slug?`, `folder_path?`, `archived?`. Output `{slug}`. `archived: false` is **idempotent** — a live project accepts it and the only effect is the `updated_at` bump, so un-archiving needs no out-of-band knowledge of the flag. `INVALID: nothing to update` fires only when the call carries **no optional argument at all** (`{project}` alone), never because a supplied value already equals the stored one |
| `delete_project` | Delete a project that holds no tasks. Output `{deleted:<slug>}`; a project with tasks refuses with `CONFLICT: project 'x' has N tasks; archive it instead` |

## Projects and scope

`project` — a lowercase slug — is a **filter, not a token**: it decides which rows a call may enumerate, and it grants nothing. It is enforced in the service (the one place all four shapes share), not by the schema, so a missing slug is a refusal rather than a default. It is required (fail closed) on exactly the four enumerating shapes:

| Tool | `project` | Required when | By-id escape |
|---|---|---|---|
| `create_task` | yes | always | — |
| `list_queue` | yes | always | — |
| `list_tasks` | yes | `ids` absent **or empty** | `ids: [1,2]` → unscoped pipe mode |
| `claim_task` | yes | neither `task_id` nor `id` given | `task_id`/`id` present → unscoped |
| `get_task`, `update_status`, `add_comment`, `get_timeline`, `get_template` | **no** | — | always by id |

- The slug is resolved once, against `projects.slug`; an unknown slug lists the known slugs, so a typo is self-correcting in one round trip.
- **No default project and no all-projects mode.** An enumerating call without `project` is refused — never defaulted, never silently widened. `project: "*"` and `project: ""` are ordinary unknown slugs: a cross-project read is N+1 calls, one per project.
- By-id calls stay unscoped on purpose (ids are global and sequential). A by-id tool does not declare the argument at all — passing `project` to `get_task` answers `INVALID: unknown argument project on get_task (accepted: fields, id)` — while a `claim_task` that carries `task_id`/`id` accepts `project` and does not consult it.
- `create_task` requires `project` even when `epic_id` is given, and the sub-task's project must equal its epic's: inheritance is equality, never a lookup that would quietly resolve the scope from the epic.
- Consequence in practice: **auto-claim is orchestrator-only**, because a subagent holds no slug — it is handed a `task_id`, which is the by-id path.
- `list_queue`, `list_tasks` and `claim_task` on an **archived** project succeed (existing work stays readable and claimable); only `create_task` is refused.

| Condition | Result |
|---|---|
| enumerating call, `project` absent | `INVALID: project required` |
| slug unknown, projects exist | `INVALID: unknown project 'x' (known: a, b, legacy)` |
| slug unknown, no projects at all | `INVALID: unknown project 'x' (no projects defined; create one with create_project)` |
| `project` is `*`, `""` or any other non-slug | the unknown-slug row above — there is no all-projects mode |
| `create_task` with `project: 'legacy'` | `INVALID: create_task is refused in the reserved project 'legacy'` |
| `create_task` into an archived project | `INVALID: project 'x' is archived` |
| `depends_on` in another project | `INVALID: dependency #N belongs to project 'y'` |
| `epic_id` in another project | `INVALID: epic #N belongs to project 'y'` |

| Project tool refusal | Result |
|---|---|
| `create_project` without `folder_path` | `INVALID: folder_path required` |
| `create_project` with a malformed explicit `slug` | `INVALID: slug must match ^[a-z0-9][a-z0-9._-]{0,31}$` |
| `create_project` / `update_project` with `slug: 'legacy'` | `INVALID: 'legacy' is a reserved project slug` |
| `create_project` whose folder name cannot yield a valid slug | `INVALID: slug required (cannot derive from folder name)` |
| `create_project` on an existing slug | `CONFLICT: project 'x' already exists` |
| `update_project` / `delete_project` on an unknown slug | `NOT_FOUND:` |
| `update_project` with no optional argument | `INVALID: nothing to update` |
| `delete_project` on a project that has tasks | `CONFLICT: project 'x' has N tasks; archive it instead` |

A duplicate `folder_path` is **not** an error: it is a caller-side annotation with no uniqueness constraint, recorded by the host that created the row (`create_project` normalizes it to an absolute path but the server never resolves or checks it, and the slug — not the path — is the identity). Deleting `legacy` is allowed only while it holds no tasks; as a *creation* target the slug stays reserved.

The normative one-screen version of this rule ships inside the server itself, as the `Projects` section of the MCP `instructions` (`src/mcp/instructions.md`) that every client receives on initialize.

## Lease recovery paths

`in_progress` is a leased state and `claim_task` is the door to a lease: a non-renewal `update_status` into `in_progress` must clear the same bar as a claim — the task exists, is not an epic, and its dependencies are satisfied. These are the refusals that come back, and what to do with each.

| Refusal | What it means | Recovery |
|---|---|---|
| `CONFLICT: expected version N, got M` | A parallel write won; the `version` you sent is stale | Re-read `get_task fields:["version"]` and retry |
| `CONFLICT: lease held by <other>` | The lease was still live when the sweep ran and belongs to another agent — a mistake-catcher, not authorization (the tracker has no auth) | Do not retry. Hand the task back through that agent: the holder renews it or releases it with `update_status(status:"blocked")`. Only a renewal is guarded, so an orchestrator can seize a stuck lease with that same `blocked` hop |
| `CONFLICT: lease held by null` | A row written before leases tracked a holder — `assignee` started following the agent on `→ in_progress` when the heartbeat shipped, so a legacy row can have none and its lease can never be renewed | Park it: `update_status(status:"blocked")` clears the lease, then `claim_task` takes it and records a real holder |
| `INVALID: #N is an epic, not claimable` | An epic holds no work, so it never gets a lease | Nothing was written. Move the epic with lease-free hops `queued → blocked → review`, or withdraw it to `canceled` |
| `BLOCKED: dependencies not satisfied` | Entering `in_progress` from `queued`/`blocked` with an open `depends_on` — such a task was never claimable either | Nothing was written. Wait for the dependency and claim it later; `review → in_progress` (work sent back) is not subject to this check |
| `INVALID: in_progress → in_progress requires renew: true` | A bare self-transition without the heartbeat flag | Send `renew: true` if you hold the lease, or name a real target status |
| `INVALID: renew requires status=in_progress on an in_progress task` | A late heartbeat: the unconditional reap ahead of the read already requeued the task and charged one `attempts` step | Re-claim with `claim_task`. The old lease is gone and cannot be resurrected; there is no grace window |
| `INVALID: #N is an epic` | `renew` on an epic, kept as defence for a stale or hand-edited row | Release the row with `update_status(status:"blocked")` |
| `INVALID: reset_attempts requires a comment` | An audited refund has to state why | Add the reason and re-send; the refund rides on a legal transition and echoes `attempts: 0` |

No refusal writes a row of its own — no task row, no audit row — so a refusal is safe to retry once the cause is fixed. The sweep that runs ahead of the read is the one exception: it may already have requeued an expired lease and charged its `attempts` step, which is why every retry starts from a fresh `version`.

**Refunding a spent attempts budget.** Fix the cause first; a refund on top of an unfixed cause just re-arms the loop. Then one call from `blocked`: `update_status({id, agent, "queued", version, reset_attempts: true, comment: "<why>"})`. A task still `queued` has no self-edge, so park it `blocked` first (two calls). `max_attempts` is untouched, `attempts_reset: N->0` lands in the timeline, and the `attempts` field in the response is the in-band confirmation that the flag reached the server.

### Legacy epic rows

The sweep carries `is_epic = 0`, so an epic row that is already `in_progress` is **stranded** rather than dead: never reaped, never charged, never killed. Such a row can only come from a build predating the acquisition guard or from a hand-edit. It is listed by `list_tasks(status:'in_progress', fields:['is_epic'], project:'<slug>')`, `renew` on it is refused (`INVALID: #N is an epic`), and one lease-free hop `update_status(status:"blocked")` releases it — after that `blocked → review` and the `CHILDREN:` close-guard work as before.

An epic that the pre-guard reaper already drove to `failed` is the one shape with no self-service recovery: `failed` has no outgoing edge, so it can be neither reopened nor canceled, and `reset_attempts` is refused on an epic. The sanctioned recovery is the orchestrator's: cancel the still-open sub-tasks and re-create the epic (`create_task({..., epic: true})`), recording in each new task which id it replaces. `epic_id` is immutable through the API, so re-parenting existing sub-tasks to the new epic needs the SQL recipe in [epics.md](epics.md).

### Wire compatibility

The acquisition guard adds refusals only: two error strings, no new argument, response field, tool, schema, migration or config key. A server predating it answers the same call with **success** — the opposite of a pre-heartbeat build, where `renew: true` fails loudly with `INVALID: in_progress → in_progress` because the self-edge did not exist yet — so there is no in-band signal here. Before the redeploy the operative rule is procedural ("an epic is never leased, `claim_task` is the door to a lease"), and the epic case is independently detectable via `list_tasks(status:'in_progress', fields:['is_epic'], project:'<slug>')` (scoped like every `list_tasks` call). Everything else on this page (renewals, refunds, the holder guard) is enforced by the same build that serves this doc.

## Argument contract

Every tool rejects unknown argument keys with `INVALID: unknown argument(s) <names> on <tool> (accepted: ...)` before any state change — the accepted-key list is part of the error, so a wrong key is a self-correcting one-round-trip failure instead of a silently ignored argument. Shape/type errors (wrong type, out-of-range, bad enum) stay SDK-side. `claim_task` is the only tool with an alias: `id` ≡ `task_id`. The contract covers argument *keys* only: unknown field *names* inside `include`/`fields` are still dropped silently.

## Statuses

Codes (`STATUS_CODES`): `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled.

Flow: `queued → in_progress → review → done` (or `failed` / `blocked`). Any non-terminal status can be withdrawn to `canceled`. `done`, `failed` and `canceled` are terminal; lease expiry returns to `queued` and increments `attempts` (unchanged by the heartbeat — the charge is the loop-breaker, and a renewal is liveness rather than progress). An exhausted budget is refunded by hand with `update_status(..., reset_attempts: true)`, not by reopening a terminal task. Entering `in_progress` requires claim-grade eligibility (not an epic, dependencies satisfied) — see [Lease recovery paths](#lease-recovery-paths). Tasks with unsatisfied `depends_on` stay `queued` but are hidden from `list_queue` and auto-claim.

## Reads and lease reap

Reads are not guaranteed to be side-effect-free. Before answering, `get_task`, `list_tasks`, `list_queue` and `get_timeline` first run a **lazy lease reap**: if the reap cooldown has elapsed, expired `in_progress` leases are settled (back to `queued`, or `failed` once `attempts > max_attempts`) and their `version` is bumped. A read may therefore change task state and invalidate the `version` a client is holding. The sweep is throttled by `ZIPTASK_REAP_COOLDOWN_SEC` (default `60`) — at most one sweep per cooldown window per process. `add_comment` reaps the same way. `claim_task` and `update_status` reap unconditionally, ignoring the cooldown.

`TaskService.reapExpiredLeases()` is a **test-only seam**: it forces a sweep regardless of cooldown and has no production caller — production code reaps through the read paths and `claim_task`/`update_status` above.

The sweep is also what fences the lease heartbeat: `update_status` reaps unconditionally before it reads the task, so a renewal that arrives after its deadline sees the requeued task (and the charged `attempts` step) and is rejected — it never resurrects a dead lease. There is no grace window; the recovery is a re-claim. Renew roughly every `lease_ttl_min`/3 so one missed call is not fatal.
