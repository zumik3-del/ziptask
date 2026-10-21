# ziptask — agent guide

## 1. Overview
MCP task tracker for AI agents: the state layer (statuses, deps, leases, versions) over SQLite. Content stays in files; token-minimalism is the core design principle.

Sources of truth: the wire protocol in `src/mcp/instructions.md`, the domain rules in `src/core/tasks.ts`, the decisions in the artifacts repo (`ziptask/adr/`, `ziptask/plans/`).

## 2. Stack & toolchain
- Bun 1.4.2, TypeScript, `@modelcontextprotocol/sdk`, `bun:sqlite` (WAL, no ORM), zod v4, biome (lint only).
- Bare `Bun.serve`: MCP StreamableHTTP at `/mcp` (`POST` messages, `GET` SSE, `DELETE` session) + `GET /health` + experimental `GET /api/task/:id` (subagentix integration) and `GET /api/tasks` (list by project); stdio entry. See `docs/http-endpoints.md`.
- Run: `bun run start` (HTTP, random port), `bun run start:stdio`, `bun run src/smoke.ts`.
- Config: optional `settings.json` (`--settings <path>` or `ZIPTASK_SETTINGS`; see `settings.example.json`), then env overrides — `ZIPTASK_DB`, `ZIPTASK_PORT` (0 = random), `ZIPTASK_HOST`, `ZIPTASK_LEASE_TTL_MIN`, `ZIPTASK_MAX_ATTEMPTS`, `ZIPTASK_LOG_LEVEL` (`info`), `ZIPTASK_AUDIT_LOG`. Full table: `docs/configuration.md`.

## 3. Verification
- `bun test` · `bunx biome check src/ scripts/` · `bunx tsc --noEmit` · smoke `bun run src/smoke.ts` (MCP over HTTP, ephemeral port + temp DB).
- Smoke is the tester's job, once per batch — never run it in a dev task.

## 4. Code conventions
- No comments unless truly necessary.
- Reuse before reimplementing: extend or generalise an existing module; write from scratch only when nothing fits.
- Name files after their contents — no `helpers`/`utils`/`common`/`misc` (`tasks.ts`, not `task-utils.ts`).
- Token-minimalism: `description` only via explicit `fields`; omit-null in JSON; sanitize `|` in titles (`sanitizePipe`).
- DB is pure state: never add `task_path`/`result_path`/`parent_id` — file paths live in description/comment text; task text in English. Carve-out: `epic_id`/`is_epic` are structural membership columns (single-level bounded relation).
- Migrations: numbered SQL in `src/db/migrations.ts`, strictly append-only — the released prefix is frozen; `schema_version = N` means "first N statements applied"; startup refuses a downgrade (V>L) and fails loudly on migration errors.
- Folders: SQL under `src/db/`; domain types + service logic under `src/core/`; thin MCP layer under `src/mcp/`; harnesses at `src/` root. Import direction `mcp/` → `core/` → `db/`; `db/` may import types and leaf-level pure helpers/constants from `core/` (never domain behaviour) — `src/db/sql.ts` owns the SQL text and reads the status constants from `core/tasks.ts`.
- Statuses, terminal set, transition table and the length limits live in `src/core/tasks.ts` — do not re-implement them ad hoc.

## 5. Testing setup + gotchas
- Unit tests `src/*.test.ts` per domain share `src/test-context.ts` (bun:test, per-test temp DBs); smoke `src/smoke.ts` asserts pipe output, typing, claim include.
- Keep test DBs under `/tmp/opencode`: SQLite fsyncs on `/mnt/external` are ~30× slower. Full suite ~17s (527 tests, 2026-10-20).
- bun:sqlite strict binding types: keep all binds the same type; cast LIMIT with `Math.floor()`.
- MCP SDK 1.30 + zod v4: a tool handler must return a `type` alias, not an `interface` — `CallToolResult` is `$loose`; interfaces fail tsc with a misleading overload error.

## 6. Branching & hosting
- Feature work on `dev`; `main` is PR-only. Conventional commits (`feat:`, `fix:`). Remote: GitHub `zumik3-del/ziptask` — commits/push/PR/tag/Release via the git subagent. Never commit `data/`, `.test-data/`, `node_modules/`.
- Git scan safety: never enumerate every ref or run `git ls-tree -r`/`git show` per ref — that fan-out can retain GBs. Prefer `rg` on checked-out files; for history use a named ref, an explicit path, `--max-count` and bounded output.
- Remote sync guard (issue #14): the git subagent never rewrites pushed history (rebase/force-push/reset) and never pulls/fetches unless asked. After any sync the orchestrator verifies tree completeness (`tsc` + `bun test`) before the next commit.
- Release (merge-driven): bump `version` on `dev`, commit `chore: bump version to X.Y.Z`, PR dev→main, merge. `release.yml` triggers on `main`, builds `dist/ziptask` (bun 1.4.2, frozen lockfile), creates the tag + Release. Assets: `ziptask-linux-x86_64`, `ziptask-<TAG>-linux-x86_64.tar.gz`. Install/update/uninstall go through the vendored `deploy/` framework.

## 7. Memory & tracker scope
- SynaptoMind slug `ziptask`; always pass `cwd=/mnt/external/zum/PROJECTS/local/ziptask`. State pointers ≤600 chars, English, identifiers verbatim.
- Tracker **project** slug `ziptask` — the required `project` argument on every enumerating call (`create_task`, `list_queue`, `list_tasks` without `ids`, auto-pick `claim_task`). It is a scope filter, not a token; by-id calls never take it; there is no default project and no all-projects mode (`docs/projects.md`).
- Task/epic/comment text comes from the tracker templates (`get_template`); their source of truth is `templates/`.
- Task priority scale: `p0` = highest urgency (blocker), `p1` = high, `p2` = normal (the default), `p3` = lowest (chore). The number descends as urgency rises — `p0` outranks `p1` outranks `p2` outranks `p3`; never read `p3` as more important than `p0`. Pass it as `pN`; `create_task` accepts the bare number `0..3` too (`2` → `p2`) — the canonical value is what gets stored and returned unchanged (`TASK_PRIORITIES`, `src/core/tasks.ts`).

## 8. Known pitfalls
- Do not reintroduce webhooks/Redis/Hono — rejected (pull model, MCP-only).
- Old v1 DBs are schema-incompatible — delete, do not migrate.
- Epics are not claimable (`queuedCandidates` filters `is_epic = 0`; `claim_task` rejects `is_epic: true`). An epic's status is manual — roll up via `get_task fields:["subtasks"]`, not `list_tasks ids=[]`. `update_status(epic→done|failed|canceled)` is guarded (`CHILDREN: N sub-tasks not terminal`); dep-on-epic is rejected at create.
- Re-parenting between epics has no API tool (`epic_id` is immutable): use the SQL recipe in `docs/epics.md`; verify the target is a non-terminal, non-sub-task epic and leave `version` untouched.

## 9. Delegation map
- Roles and handoff rules live in the global `AGENTS.md` (`~/.config/opencode/AGENTS.md`). Project deltas: the tester owns the smoke suite (§3); the git subagent is exempt from the tracker.

## 10. Workspace & communication
- Code → this repo. Documents → the artifacts repo `authelia/artifacts` under `ziptask/` (`forgejo_artifacts` MCP tools, `project: ziptask`).
- Tracker scope: enumerating calls carry `project: ziptask` (§7); by-id calls stay unscoped.
