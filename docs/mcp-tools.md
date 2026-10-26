# MCP tools

ziptask exposes 14 tools:

| Tool | What it does |
|---|---|
| `create_task` | Enqueue a task; regular tasks start `queued`, epics start `open` — `blocked` is a manual flag only for regular tasks. Fields: `assignee?` (refused at creation — a task is born `queued` without a lease and the claim writes the holder; see [Lease recovery paths](#lease-recovery-paths)), `reporter?` (the actor name the row and the audit log carry), `epic?` (declare as epic, not claimable, no `assignee`), `epic_id?` (attach as sub-task to an existing epic; promotes the target only when it is `queued` — the promotion is re-checked inside the write, so a target a rival claimed in between is refused with `CONFLICT: epic #N changed state during promotion` and nothing is written: no child, no `subtask_add` mirror row; a promotion is a row write and bumps the target's `version`), `priority?` (the canonical `p0`..`p3`, the number `0`..`3` or the digit string `"0"`..`"3"` — see [Priorities](#priorities)), `project` (required — see [Projects and scope](#projects-and-scope)). `description` is bounded at 20000 code points, `title` at 200 code points, `reporter` and `assignee` at 200 code points each and `depends_on` at 100 ids — see [Input bounds](#input-bounds) |
| `get_task` | Read a task; `description` only via explicit `fields`, and the project slug via `fields:["project"]`. Epics: `subtasks` roll-up (`{total,open,done,failed,canceled}`) via `fields:["subtasks"]`; `epic_id` via `fields` when reading a sub-task |
| `list_tasks` | JSON mode: filter by `assignee`/`status`/`updated_since`/`epic_id`; `project` required unless `ids` is non-empty (see [Projects and scope](#projects-and-scope)); `description` only via explicit `fields`. Pipe mode (batch): pass `ids` (array of ints) — implicit pipe `id|code`, no `format` param; `fields:["assignee"]` → `id|code|assignee`, null assignee → `-`; request order is preserved, unknown id → `id|0` (and `id|0|-` with `fields:["assignee"]`). All other filters ignored when `ids` is set. Merges the former `batch_statuses` tool — rationale: the separate "ask about tasks" was an ambiguous duplicate of `list_tasks`-by-ids; unified under one tool with two output shapes. |
| `claim_task` | Claim a task; auto-pick selects among `queued` **of one project** (the required `project` — see [Projects and scope](#projects-and-scope)), explicit `task_id` also accepts a manually `blocked` task. Returns `{id, lease_ttl_min, version}`. Epics are excluded from auto-pick and explicit claim returns `INVALID: #N is an epic, not claimable`. A non-renewal `update_status` into `in_progress` is held to the same eligibility — see [Lease recovery paths](#lease-recovery-paths) |
| `update_status` | Transition status with optimistic version lock; the normative status list and transition table live in the MCP `instructions` (`src/mcp/instructions.md`). `canceled` withdraws any task that is still open for work (`queued`/`in_progress`/`review`/`blocked`); a `failed` task is closed for work and can be withdrawn to `canceled` administratively — the failure stands, the task is only closed out, and it is never reopened; `done` and `canceled` have no outgoing edge. Optional `comment` is stored as a `resolution` when the target status is closed for work (`done`/`failed`/`canceled`), otherwise as a `comment`. Optional `renew: true` is the lease heartbeat: with `status=in_progress` on an `in_progress` task it re-arms the caller's own lease as a `lease_ttl_min` window computed from now (never the old deadline + TTL), bumps `version`, and audits `lease_renewed: <old>-><new>` instead of `update_status` (so `statusDurations` keeps one `in_progress` segment). Rejected without state change: `in_progress → in_progress` without the flag (`INVALID: in_progress → in_progress requires renew: true`), `renew` on any other target or task state (`INVALID: renew requires status=in_progress on an in_progress task`), `renew` on an epic (`INVALID: #N is an epic`), and a caller that is not the holder (`CONFLICT: lease held by <assignee>` — a mistake-catcher, not authorization; the tracker has no auth). Optional `reset_attempts: true` refunds a spent attempts budget: it rides on any legal transition, zeroes `attempts` in the same version-guarded write (so it is atomic with the status change and the `version` bump), leaves `max_attempts` untouched, audits `attempts_reset: N->0`, and adds `attempts` to the response as the confirmation that the flag reached the server. The primary case is `blocked → queued` (one call). Rejected without state change: without a `comment` (`INVALID: reset_attempts requires a comment`), on an epic (`INVALID: cannot reset attempts on epic #N` — the epic refusal wins) and on a task closed for work (`INVALID: cannot reset attempts on terminal task #N`). A refund never rides on the administrative withdrawal: a `failed` task is recovered by recreating it with fresh counters, or by closing it out with `canceled` — never by reopening. The reaper's charge rule is unchanged: one expiry still costs one `attempts` step even with zero progress, because that charge is the loop-breaker. A non-renewal transition into `in_progress` is held to the same eligibility as `claim_task`: refused for an epic (`INVALID: #N is an epic, not claimable`) and for unmet `depends_on` when entering from `queued`/`blocked` (`BLOCKED: dependencies not satisfied`); `review → in_progress` asks no dependency question (`depends_on` is immutable after the claim, and a dependency that is closed for work stays closed for work). Refusals are checked in the order agent/comment → refund `comment` → `NOT_FOUND` → `version` → `renew` intent → epic status → transition → renewal holder → lease acquisition → refund on an epic → refund on a task closed for work → epic children, so a combined `in_progress` + `reset_attempts` call on an epic reports the acquisition, not the refund, and a heartbeat on a legacy leased epic reports the renewal path (`INVALID: #N is an epic`) rather than the acquisition one. A refused acquisition writes nothing: not the task, not the audit log. Epic close-guard: `done`/`failed`/`canceled` rejected while children that are not closed for work exist → `CHILDREN: N sub-tasks not terminal` |
| `update_task` | Patch a task that is not under way yet: a `queued` task (regular) or an `open` epic, with no lease holder. Fields: `title?` (<=200 code points), `description?` (<=20000 code points; the contract), `priority?` (`p0`..`p3`, the number `0`..`3` or the digit string `"0"`..`"3"`), `depends_on?` (<=100 ids; **replaces** the list; an epic takes no deps), `comment?` (rationale). Everything else is immutable: `status` belongs to `update_status`, `assignee` is the lease holder, `project`/`epic_id`/`reporter`/`max_attempts` never change. `version` is an optional optimistic lock (the write always compares against the version it read). Refused without a write: a task that is `in_progress`/`review`/`blocked` or closed for work (`INVALID: cannot edit #N in status=<s>: only a queued task (or an open epic) is editable` — use `add_comment` there); a task holding a lease (`INVALID: task #N holds a lease and is not editable`); a stale version (`CONFLICT: expected version N, got M`); no editable field at all (`INVALID: nothing to update`); a supplied value equal to the stored one is a no-op (`changed: []`, no version bump, no audit row). Output `{id, version, changed}` |
| `list_queue` | Pipe lines of dep-satisfied queued tasks **of one project** (epics excluded; the required `project` — see [Projects and scope](#projects-and-scope)) |
| `add_comment` | Append a comment to a task |
| `get_timeline` | Merged audit log + comments feed. Epics show `subtask_add`/`subtask_done`/`subtask_failed` mirror rows — history reads as `create → subtask_add… → subtask_done… → resolution` |
| `get_template` | Fetch a markdown template (task description, comments) |
| `create_project` | Register a project. `folder_path` is required and must be **absolute** — a relative input is refused with `INVALID: folder_path must be an absolute path` (never resolved against the server's cwd, which would record a path the caller never named) — and it is recorded as an annotation: normalized (trailing slash stripped), never checked for existence, not unique, and used to derive the slug when that is omitted. Output `{slug}`, never the row — the internal `id` does not cross the tool boundary |
| `list_projects` | Pipe lines `slug|folder|open`, ordered by `slug` ASC — `open` counts the project's tasks that are not closed for work. Archived projects are listed identically (there is no archived column, and `legacy` is listed too); an empty table produces empty text |
| `update_project` | Update a project by slug: `project`, plus any of `folder_path?` (absolute only, as in `create_project`), `archived?`. Output `{slug}`. `archived: false` is **idempotent** — a live project accepts it and the only effect is the `updated_at` bump, so un-archiving needs no out-of-band knowledge of the flag. `INVALID: nothing to update` fires only when the call carries **no optional argument at all** (`{project}` alone), never because a supplied value already equals the stored one. The slug is immutable after create |
| `delete_project` | Delete a project that holds no tasks. Output `{deleted:<slug>}`; a project with tasks refuses with `CONFLICT: project 'x' has N tasks; archive it instead` |

## Projects and scope

`project` — a lowercase slug — is a **filter, not a token**: it decides which rows a call may enumerate, and it grants nothing. It is enforced in the service (the one place all four shapes share), not by the schema, so a missing slug is a refusal rather than a default. It is required (fail closed) on exactly the four enumerating shapes:

| Tool | `project` | Required when | By-id escape |
|---|---|---|---|
| `create_task` | yes | always | — |
| `list_queue` | yes | always | — |
| `list_tasks` | yes | `ids` absent **or empty** | `ids: [1,2]` → unscoped pipe mode |
| `claim_task` | yes | neither `task_id` nor `id` given | `task_id`/`id` present → unscoped |
| `get_task`, `update_status`, `update_task`, `add_comment`, `get_timeline`, `get_template` | **no** | — | always by id |

- The slug is resolved once, against `projects.slug`; an unknown slug lists the known slugs, so a typo is self-correcting in one round trip.
- **No default project and no all-projects mode.** An enumerating call without `project` is refused — never defaulted, never silently widened. `project: "*"` and `project: ""` are ordinary unknown slugs: a cross-project read is N+1 calls, one per project.
- By-id calls stay unscoped on purpose (ids are global and sequential). A by-id tool does not declare the argument at all — passing `project` to `get_task`, `update_status`, `update_task`, `add_comment`, `get_timeline` or `get_template` answers `INVALID: unknown argument project on <tool> (accepted: …)`, e.g. `INVALID: unknown argument project on get_task (accepted: fields, id)`. `claim_task` is the exception: **one input shape serves both branches**, so it declares `project` (auto-pick needs it), and on the by-id branch the value is **ignored and never validated** — `claim_task({task_id: 999, project: 'no-such-slug'})` reaches `NOT_FOUND:`, never `INVALID: unknown project`.
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
| `create_project` / `update_project` with a relative `folder_path` | `INVALID: folder_path must be an absolute path` |
| `create_project` with a malformed explicit `slug` | `INVALID: slug must match ^[a-z0-9][a-z0-9._-]{0,31}$` |
| `create_project` with `slug: 'legacy'` | `INVALID: 'legacy' is a reserved project slug` |
| `create_project` whose folder name cannot yield a valid slug | `INVALID: slug required (cannot derive from folder name)` |
| `create_project` on an existing slug | `CONFLICT: project 'x' already exists` |
| `update_project` / `delete_project` on an unknown slug | `NOT_FOUND:` |
| `update_project` with no optional argument | `INVALID: nothing to update` |
| `delete_project` on a project that has tasks | `CONFLICT: project 'x' has N tasks; archive it instead` |

A duplicate `folder_path` is **not** an error: it is a caller-side annotation with no uniqueness constraint, recorded by the host that created the row (`create_project` and `update_project` accept an absolute path and normalize it — trailing slash stripped — but the server never resolves it against its own cwd, never checks it for existence, and never looks a project up by it; the slug — not the path — is the identity). Deleting `legacy` is allowed only while it holds no tasks; as a *creation* target the slug stays reserved.

The normative one-screen version of this rule ships inside the server itself, as the `Projects` section of the MCP `instructions` (`src/mcp/instructions.md`) that every client receives on initialize.

## Lease recovery paths

`in_progress` is a leased state and `claim_task` is the door to a lease: a non-renewal `update_status` into `in_progress` must clear the same bar as a claim — the task exists, is not an epic, and its dependencies are satisfied. These are the refusals that come back, and what to do with each.

| Refusal | What it means | Recovery |
|---|---|---|
| `CONFLICT: expected version N, got M` | A parallel write won; the `version` you sent is stale | Re-read `get_task fields:["version"]` and retry |
| `CONFLICT: lease held by <other>` | The lease was still live when the sweep ran and belongs to another agent — a mistake-catcher, not authorization (the tracker has no auth) | Do not retry. Hand the task back through that agent: the holder renews it or releases it with `update_status(status:"blocked")`. Only a renewal is guarded, so an orchestrator can seize a stuck lease with that same `blocked` hop |
| `CONFLICT: lease held by null` | A row written before leases tracked a holder — `assignee` started following the agent on `→ in_progress` when the heartbeat shipped, so a legacy row can have none and its lease can never be renewed | Park it: `update_status(status:"blocked")` clears the lease, then `claim_task` takes it and records a real holder |
| `INVALID: #N is an epic, not claimable` | An epic holds no work, so it never gets a lease | Nothing was written. An epic is already `open`; close it directly to `done`/`failed`/`canceled` once its children are closed for work, or withdraw it to `canceled` |
| `INVALID: #N is an epic` | A renewal heartbeat aimed at an epic — the renewal path, not the acquisition path | Nothing was written; the lease is not extended. Cancel the open sub-tasks and re-create the epic |
| `INVALID: cannot promote #N from <status>: only a queued task can become an epic` | `epic_id` pointed at a task somebody is already working | Nothing was written; the target keeps its status, lease and assignee. Promote a `queued` task, or create the epic with `epic: true` instead |
| `CONFLICT: epic #N changed state during promotion` | The `epic_id` target left the state it had when the call was checked — a rival claimed it in the window before the write | Nothing was written: no child row, no `subtask_add` mirror row. Re-read the target (`get_task`): if it is `queued` again, attach again; if it is leased, wait for the holder |
| `INVALID: an epic takes no assignee: it holds no lease` | `epic: true` was combined with `assignee` | Drop `assignee`; `assignee` means "lease holder" and an epic has none |
| `INVALID: assignee is refused at creation: a task holds a lease only from in_progress` | `create_task` was given an `assignee` | Drop `assignee`: the task is born `queued` without a lease and the claim writes the holder |
| `BLOCKED: dependencies not satisfied` | Entering `in_progress` from `queued`/`blocked` with an open `depends_on` — such a task was never claimable either | Nothing was written. Wait for the dependency and claim it later; `review → in_progress` (work sent back) is not subject to this check |
| `INVALID: in_progress → in_progress requires renew: true` | A bare self-transition without the heartbeat flag | Send `renew: true` if you hold the lease, or name a real target status |
| `INVALID: renew requires status=in_progress on an in_progress task` | A late heartbeat: the unconditional reap ahead of the read already requeued the task and charged one `attempts` step | Re-claim with `claim_task`. The old lease is gone and cannot be resurrected; there is no grace window |
| `INVALID: #N is an epic` | `renew` on an epic, kept as defence for a stale or hand-edited row | Nothing was written; the lease is not extended. The row cannot be released to `blocked` (an epic refuses `queued`/`review`/`blocked` — `INVALID: in_progress → blocked`): cancel the still-open sub-tasks, then re-create the epic (`create_task({..., epic: true})`) |
| `INVALID: reset_attempts requires a comment` | An audited refund has to state why | Add the reason and re-send; the refund rides on a legal transition and echoes `attempts: 0` |

No refusal writes a row of its own — no task row, no audit row — so a refusal is safe to retry once the cause is fixed. The sweep that runs ahead of the read is the one exception: it may already have requeued an expired lease and charged its `attempts` step, which is why every retry starts from a fresh `version`.

**`assignee` is the lease holder.** It is written when a task enters `in_progress` and cleared on every other status — the same rule the reaper applies when it requeues an expired lease. A task that leaves `in_progress` therefore carries no holder: sent to `review`, parked in `blocked`, refunded back to `queued`, or closed. The refund path is the case that used to leak — a manually blocked task returned to `queued` kept its previous holder, so `assignee` no longer meant "lease holder" there. A task is also born **without** a holder: `create_task` refuses an `assignee` (`INVALID: assignee is refused at creation: a task holds a lease only from in_progress`), because a `queued` task holds no lease and the queue is shared — nothing would honour a name written at creation, and the first claim overwrites it. The claim is what binds a task to an agent.

**Refunding a spent attempts budget.** Fix the cause first; a refund on top of an unfixed cause just re-arms the loop. Then one call from `blocked`: `update_status({id, agent, "queued", version, reset_attempts: true, comment: "<why>"})`. A task still `queued` has no self-edge, so park it `blocked` first (two calls). `max_attempts` is untouched, `attempts_reset: N->0` lands in the timeline, and the `attempts` field in the response is the in-band confirmation that the flag reached the server.

### Wire compatibility

The acquisition guard adds refusals only: two error strings, no new argument, response field, tool, schema, migration or config key. A server predating it answers the same call with **success** — the opposite of a pre-heartbeat build, where `renew: true` fails loudly with `INVALID: in_progress → in_progress` because the self-edge did not exist yet — so there is no in-band signal here. Before the redeploy the operative rule is procedural ("an epic is never leased, `claim_task` is the door to a lease"), and the epic case is independently detectable via `list_tasks(status:'in_progress', fields:['is_epic'], project:'<slug>')` (scoped like every `list_tasks` call). Everything else on this page (renewals, refunds, the holder guard) is enforced by the same build that serves this doc.

## Argument contract

Every tool rejects unknown argument keys with `INVALID: unknown argument(s) <names> on <tool> (accepted: ...)` before any state change — the accepted-key list is part of the error, so a wrong key is a self-correcting one-round-trip failure instead of a silently ignored argument. Shape/type errors (wrong type, out-of-range, bad enum) stay SDK-side. The contract covers argument *keys* only: unknown field *names* inside `include`/`fields` are still dropped silently.

### Input bounds

Five inputs are bounded: `create_task` writes the `title`, the `description` and the `reporter` into the task row (and `GET /api/task/:id` echoes them) and the `depends_on` id list into the `depends_on` JSON blob — one call could otherwise push an unbounded string or id array into the store and into the batch read that resolves the dependencies. The `assignee` is bounded as well, although it is never stored: it is refused at creation, and the length guard runs first, so an over-long name answers `assignee too long` rather than the creation refusal. The bound is the same constant in both layers: the advertised schema refuses it on the wire, and the create guard refuses it in the service, so a call that skips the schema is still bounded.

A string bound is counted in **Unicode code points** in both layers. JSON Schema defines a string's length in code points, zod v4 measures `maxLength` in code points, and the create guard counts code points too (`codePointLength` in `src/core/tasks.ts`) — so the two layers refuse exactly the same strings and the schema always answers first on the wire. `depends_on` counts ids: an array length, which both layers count identically, so the schema always takes it.

| Input | Bound | Refusal on the wire | Refusal in the service |
|---|---|---|---|
| `create_task` `title` | 200 code points | `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: title too long at title` | `INVALID: title too long` |
| `create_task` `description` | 20000 code points | `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: description too long at description` | `INVALID: description too long` |
| `create_task` `reporter` | 200 code points | `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: reporter too long at reporter` | `INVALID: reporter too long` |
| `create_task` `assignee` | 200 code points | `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: assignee too long at assignee` | `INVALID: assignee too long` |
| `create_task` `depends_on` | 100 ids | `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: depends_on too long at depends_on` | `INVALID: depends_on too long` |

Every refusal writes nothing: no task row, no audit row, no comment. The two layers answer in different shapes, so a client matching on the text has to know which one it is looking at:

- **The wire shape** is the schema refusal, wrapped by the MCP SDK — the zod message is only the tail of it. The SDK prefixes `MCP error -32602: Input validation error: Invalid arguments for tool create_task:` and appends the argument path (` at description`). It arrives as a tool result with `isError: true`, so the `-32602` is part of the text, not a JSON-RPC error envelope.
- **The service shape** is the bare `INVALID: …` string — the plain form every other service refusal uses on the wire (`INVALID: unknown project 'x' (known: a, b)`, `INVALID: unknown argument bogus on create_task (accepted: …)`), with no `MCP error` prefix and no path suffix.

The cost of counting code points is bytes, not characters: a code point is at most 4 UTF-8 bytes, so a 20000-code-point description is at most 80000 bytes (80 KB) and a 200-code-point title at most 800 bytes. The column is `description TEXT` (SQLite, no length limit) and `GET /api/task/:id` echoes the row, so one task can carry an 80 KB description. That is acceptable: the bound still stops a single call from pushing an unbounded string into the store and into every read that echoes it, while 80 KB per row is ordinary for a row-oriented store behind a loopback API.

## Priorities

`p0` (highest urgency), `p1`, `p2` (the default), `p3` (lowest). The number **descends** as the urgency rises: `p0` outranks `p1` outranks `p2` outranks `p3`, and `p3` is never the most important one.

`create_task` accepts the priority in three shapes — the canonical `"p0".."p3"`, the number `0..3` and the digit string `"0".."3"` — so a client that passes a bare number no longer gets a schema error. Every accepted shape resolves to the canonical `"pN"` **before the row is written**: the stored form stays the canonical string (no DB schema change, no migration), the queue order (`ORDER BY priority`, a lexicographic sort — `p0` first) keeps working, and every wire output (`get_task`, `list_tasks`, `list_queue`) still reports `"p2"`.

The accepted set and the mapping live in one place — the normalizer next to `TASK_PRIORITIES` in `src/core/tasks.ts` — and the tool schema, the settings schema and the service all resolve through it, so the three layers cannot drift apart. A value outside the accepted set is refused with **one** message and nothing is written (no task row, no audit row):

| Input | Result |
|---|---|
| `"p0"`, `"p1"`, `"p2"`, `"p3"` | stored as that string |
| `0`, `1`, `2`, `3` | stored as `"p0"`, `"p1"`, `"p2"`, `"p3"` |
| `"0"`, `"1"`, `"2"`, `"3"` | stored as `"p0"`, `"p1"`, `"p2"`, `"p3"` |
| `"p4"`, `"high"`, `""`, `5`, `-1`, `2.5`, another type | refused: `INVALID: priority must be one of p0, p1, p2, p3 or the number 0..3` |

On the wire the refusal is the schema refusal (the SDK wraps it): `MCP error -32602: Input validation error: Invalid arguments for tool create_task: INVALID: priority must be one of p0, p1, p2, p3 or the number 0..3 at priority`. A call that skips the schema (a direct service call) gets the bare service form of the same refusal.

The configured default (`ZIPTASK_DEFAULTS_PRIORITY`, `defaults.priority` in `settings.json`) accepts the same three shapes and is stored as the canonical `"pN"` — see [Configuration](configuration.md).

## Statuses

Codes (`STATUS_CODES`): `0` not_found, `1` queued, `2` in_progress, `3` review, `4` done, `5` failed, `6` blocked, `7` canceled, `8` open.

The normative one-screen version of the status list and the transition table ships inside the server itself, as the `Statuses` section of the MCP `instructions` (`src/mcp/instructions.md`) that every client receives on initialize. This page describes what the statuses mean; the rules live there.

Flow: regular tasks `queued → in_progress → review → done` (or `failed` / `blocked`); epics `open → done` / `failed` / `canceled`. `done`, `failed` and `canceled` are closed for work — no further work is expected, so they carry `completed_at`, hold no lease holder, and never block a dependent, a parent epic or an open count. Any status that is still open for work can be withdrawn to `canceled`, and `failed` is the one closed status with an outgoing edge: `failed → canceled` is the administrative withdrawal — the failure stands, the task is only closed out, and it is never reopened (`failed → queued`/`in_progress`/`review` stay refused). Lease expiry returns to `queued` and increments `attempts` (unchanged by the heartbeat — the charge is the loop-breaker, and a renewal is liveness rather than progress). An exhausted budget is refunded by hand with `update_status(..., reset_attempts: true)` from a task that is still open for work; a closed task is never refunded (the refund is refused) and never reopened. Entering `in_progress` requires claim-grade eligibility (not an epic, dependencies satisfied) — see [Lease recovery paths](#lease-recovery-paths). Tasks with unsatisfied `depends_on` stay `queued` but are hidden from `list_queue` and auto-claim. `open` is epic-only: non-epics cannot enter it and epics cannot enter `queued`/`in_progress`/`review`/`blocked`.

## Reads and lease reap

Reads are not guaranteed to be side-effect-free. Before answering, `get_task`, `list_tasks`, `list_queue` and `get_timeline` first run a **lazy lease reap**: if the reap cooldown has elapsed, expired `in_progress` leases are settled (back to `queued`, or `failed` once `attempts > max_attempts`) and their `version` is bumped. A read may therefore change task state and invalidate the `version` a client is holding. The sweep is throttled by `ZIPTASK_REAP_COOLDOWN_SEC` (default `60`) — at most one sweep per cooldown window per process. `add_comment` reaps the same way. `claim_task` and `update_status` reap unconditionally, ignoring the cooldown.

`TaskLifecycleService.reapExpiredLeases()` is a **test-only seam**: it forces a sweep regardless of cooldown and has no production caller — production code reaps through the read paths and `claim_task`/`update_status` above.

## Audit trail

Every state write appends an audit row, rendered by `get_timeline` as `seq|type|agent|at|text`. The action names a client may meet: `create`, `update_status`, `lease_renewed: <old>-><new>` (a renewal, not a status change), `attempts_reset: N->0`, `resolution`, `comment`, `subtask_add`/`subtask_done`/`subtask_failed`, and one row per edited field — `update_task:title`, `update_task:priority`, `update_task:depends_on`, `update_task:description`. The description is audited as a digest, not the text: `sha256:<16 hex>:<code points>` (`sha256` of the UTF-8 bytes, the first 16 hex characters, and the code-point length), so a rewritten contract leaves a cheap, comparable fingerprint. An `update_task` call that changes nothing writes no audit row at all.

The sweep is also what fences the lease heartbeat: `update_status` reaps unconditionally before it reads the task, so a renewal that arrives after its deadline sees the requeued task (and the charged `attempts` step) and is rejected — it never resurrects a dead lease. There is no grace window; the recovery is a re-claim. Renew roughly every `lease_ttl_min`/3 so one missed call is not fatal.
