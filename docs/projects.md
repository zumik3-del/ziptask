# Projects

A **project** is a slug-scoped namespace for the tasks of one tracker database. Every task row belongs to exactly one project, and the slug decides which rows an enumerating call may see.

Scoping is a **filter, not a token**: the slug narrows a query, grants nothing, and no endpoint authenticates. It exists because one tracker DB on one endpoint serves every project on the host — before v5, two orchestrators in different folders shared one queue and could claim each other's tasks.

## The slug

- Lowercase ASCII, `^[a-z0-9][a-z0-9._-]{0,31}$` (at most 32 characters).
- `create_project` derives it from the folder name when `slug` is omitted: lowercased, every other character mapped to `-`, leading non-alphanumerics stripped. Two folders with the same basename therefore want the same slug — the second is refused with `CONFLICT: project 'x' already exists`, so pass an explicit `slug` when that is the intent. A folder name that cannot yield a valid slug needs an explicit one: `INVALID: slug required (cannot derive from folder name)`.
- `legacy` is reserved (see below), and the pattern freely rejects `|` and `/`, so a slug is safe in any pipe row.
- `folder_path` is required and must be **absolute**: a relative input is refused with `INVALID: folder_path must be an absolute path` (`create_project` and `update_project` alike), so the server never resolves it against its own cwd and never records a path the caller did not name. It stays a **caller-side annotation**: normalized (trailing slash stripped) and recorded by the host that created the row, never checked for existence, not unique, and not used by any code to find or verify a project. The slug is the identity.
- The internal integer `id` never crosses the tool boundary — every call speaks the slug.

## Creating and listing

```
create_project {folder_path: "/srv/work/myproj"}   → {"slug":"myproj"}
list_projects                                      → myproj|/srv/work/myproj|0
```

`list_projects` prints one pipe line per project — `slug|folder|open`, ordered by `slug` ASC, where `open` counts the project's non-terminal tasks. Archived projects and `legacy` are listed identically; there is deliberately no archived column (the idempotent `update_project` below is how you un-archive). An empty table prints empty text.

## The scope rule

`project` is required — fail closed, never defaulted — on the four enumerating calls: `create_task` (always), `list_queue` (always), `list_tasks` (unless `ids` is non-empty) and `claim_task`'s auto-pick (unless `task_id`/`id` is given). The by-id tools (`get_task`, `update_status`, `add_comment`, `get_timeline`, `get_template`) do not take the argument at all and stay unscoped: ids are global and sequential. `claim_task` is the one tool that declares `project` on both branches — a single input shape serves auto-pick and by-id — and on the by-id branch the value is ignored and never validated: a bogus slug there is not an error.

There is **no default project and no all-projects mode**: a missing slug is `INVALID: project required`, an unknown one lists the known slugs so a typo is one round trip, and `project: "*"` (like `""`) is just another unknown slug — a cross-project read is one call per project, never a server-side widening.

In practice the orchestrator reads the slug from the project's `AGENTS.md` (next to its SynaptoMind slug) and hands a subagent a `task_id`; a subagent holds no slug, so auto-claim is orchestrator-only.

The full table plus every refusal string: [MCP tools → Projects and scope](mcp-tools.md#projects-and-scope). The normative wire version ships inside the server itself, as the `Projects` section of the MCP `instructions` (`src/mcp/instructions.md`).

## Archiving and deleting

- `update_project {project, archived: true}` stamps the archive. `create_task` into an archived project then refuses with `INVALID: project 'x' is archived`, while listing and claiming the existing work keeps working.
- `archived: false` clears the stamp and is **idempotent** on a live project, so a client can un-archive blind.
- `delete_project` works only on a project that holds no tasks: `{deleted:<slug>}`, or `CONFLICT: project 'x' has N tasks; archive it instead`.
- Project mutations write no audit row: the only trace of an update is the `updated_at` bump.

## `legacy`

`legacy` holds every row that predates v5 — the migration parks the existing backlog there in one step. It is a **parking lot, not a working scope**: `create_task` in it is refused (`INVALID: create_task is refused in the reserved project 'legacy'`) and the slug can be neither registered nor renamed into (`INVALID: 'legacy' is a reserved project slug`). Its tasks stay readable and claimable like any other project's, and the project itself can be deleted once it holds no tasks.

## The four project tools

| Tool | What it does |
|---|---|
| `create_project` | Register a project; `slug` derives from the folder name. Returns `{slug}` |
| `list_projects` | One `slug|folder|open` line per project, ordered by `slug` ASC |
| `update_project` | Rename, re-point `folder_path`, archive/un-archive. Returns `{slug}` |
| `delete_project` | Delete a project that holds no tasks. Returns `{deleted:<slug>}` |

Per-tool inputs and refusals: [MCP tools](mcp-tools.md).

There is no config for any of this: no `project` key in `settings.json` and no `ZIPTASK_PROJECT` ([Configuration](configuration.md)).
