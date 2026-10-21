# ziptask — agent guide

## 1. Overview
MCP task tracker for AI agents: the state layer (statuses, deps, leases, versions) over SQLite. Content stays in files; token-minimalism is the core design principle.

Sources of truth: the wire protocol in `src/mcp/instructions.md`, the domain rules in `src/core/tasks.ts`, the decisions in the artifacts repo (`ziptask/adr/`, `ziptask/plans/`).

## 2. Stack & toolchain
- Bun 1.4.2, TypeScript, `@modelcontextprotocol/sdk`, `bun:sqlite` (WAL, no ORM), zod v4, biome (lint only).
- Bare `Bun.serve`: MCP StreamableHTTP at `/mcp` + `GET /health` + experimental `GET /api/task/:id` and `GET /api/tasks`; stdio entry. See `docs/http-endpoints.md`.
- Run: `bun run start` (HTTP, random port), `bun run start:stdio`, `bun run src/smoke.ts`.
- Config: optional `settings.json` (`--settings <path>` or `ZIPTASK_SETTINGS`; see `settings.example.json`), then env overrides (`ZIPTASK_DB`, `ZIPTASK_PORT`, `ZIPTASK_HOST`, …; full table: `docs/configuration.md`).

## 3. Verification commands
- `bun test` · `bunx biome check src/ scripts/` · `bunx tsc --noEmit` · smoke `bun run src/smoke.ts`.
- The smoke suite is the tester's — once per batch, never in a dev task.

## 4. Code conventions
- No comments unless truly necessary. Reuse before reimplementing: extend or generalise an existing module; write from scratch only when nothing fits.
- Name files after their contents — no `helpers`/`utils`/`common`/`misc` (`tasks.ts`, not `task-utils.ts`).
- Token-minimalism: `description` only via explicit `fields`; omit-null in JSON; sanitize `|` in titles (`sanitizePipe`).
- DB is pure state: never add `task_path`/`result_path`/`parent_id` — file paths live in description/comment text; task text in English. Carve-out: `epic_id`/`is_epic` are structural membership columns (single-level bounded relation).
- Migrations: numbered SQL in `src/db/migrations.ts`, strictly append-only — the released prefix is frozen; `schema_version = N` means "first N statements applied"; startup refuses a downgrade (V>L) and fails loudly on migration errors.
- Folders: SQL under `src/db/`; domain types + service logic under `src/core/`; thin MCP layer under `src/mcp/`; harnesses at `src/` root. Import direction `mcp/` → `core/` → `db/`; `db/` may import types and leaf-level pure helpers/constants from `core/` (never domain behaviour) — `src/db/sql.ts` owns the SQL text.
- Statuses, terminal set, transition table, length limits and the priority list live in `src/core/tasks.ts` — do not re-implement them ad hoc.

## 5. Testing setup + gotchas
- Unit tests `src/*.test.ts` per domain share `src/test-context.ts` (bun:test, per-test temp DBs); the smoke harness is `src/smoke.ts`.
- Keep test DBs under `/tmp/opencode`: SQLite fsyncs on `/mnt/external` are ~30× slower.
- bun:sqlite strict binding types: keep all binds the same type; cast LIMIT with `Math.floor()`.
- MCP SDK + zod v4: a tool handler must return a `type` alias, not an `interface` — `CallToolResult` is `$loose`; interfaces fail tsc with a misleading overload error.

## 6. Branching & hosting
- Feature work on `dev`; `main` is PR-only. Conventional commits (`feat:`, `fix:`). Remote: GitHub `zumik3-del/ziptask` — commits/push/PR/tag/Release via the git subagent. Never commit `data/`, `.test-data/`, `node_modules/`.
- Git scan safety: never enumerate every ref or run `git ls-tree -r`/`git show` per ref — that fan-out can retain GBs. Prefer `rg` on checked-out files; for history use a named ref, an explicit path, `--max-count` and bounded output.
- Release (merge-driven): bump `version` on `dev` (`chore: bump version to X.Y.Z`), PR dev→main, merge. `release.yml` triggers on `main` (bun 1.4.2, frozen lockfile) and creates the tag + Release with the assets `ziptask-linux-x86_64` and `ziptask-<TAG>-linux-x86_64.tar.gz`; install/update/uninstall go through the vendored `deploy/` framework.

## 7. Memory conventions
- SynaptoMind slug `ziptask`; always pass `cwd=/mnt/external/zum/PROJECTS/local/ziptask`.
- Tracker **project** slug: `ziptask` (§10) — required on every enumerating call; a scope filter, not a token; by-id calls never take it; no default project, no all-projects mode (`docs/projects.md`).

## 8. Known pitfalls
- Do not reintroduce webhooks/Redis/Hono — rejected (pull model, MCP-only).
- Old v1 DBs are schema-incompatible — delete, do not migrate.
- Epics are never claimable and their status is manual: roll up via `get_task fields:["subtasks"]`; `update_status(epic→done|failed|canceled)` is guarded (`CHILDREN: N sub-tasks not terminal`); dep-on-epic is rejected at create.
- Re-parenting between epics has no API tool (`epic_id` is immutable): use the SQL recipe in `docs/epics.md`; verify the target is a non-terminal, non-sub-task epic and leave `version` untouched.

## 9. Delegation map
Roles and handoff rules live in the global `AGENTS.md` (`~/.config/opencode/AGENTS.md`); the only project-specific part is §3 — the canonical commands each role verifies against.

## 10. Workspace & communication
- Project slug: `ziptask` — use it verbatim for both systems: the `forgejo_artifacts` `project:` argument (documents → `authelia/artifacts` under `ziptask/`) and the tracker `project:` on enumerating calls (§7). The two register projects independently, so their listings differ — never infer one slug from the other's.
- Code → this repo; long-form documents live in the artifacts repo, state pointers in SynaptoMind with the artifact permalink.
