# Global rules

## Workspace & communication

- Code lives in the repo; design specs and notes live under `plans/` in the repo. The tracker holds state, files hold content.
- Interaction channel = the ziptask tracker, always (exception: the git subagent, see Git operations). The orchestrator creates tasks with a FULL description (goal, acceptance criteria, constraints, deliverable — English) and spawns subagents with a minimal prompt: `Task #N. Do not commit. English only.` plus special instructions only when they deviate from the agent file. Follow-up context and outcomes travel as tracker comments. No task.md contracts, no result files.
- Parallelism: repo mutators (developer, tester, docwriter, devops, git) — one at a time per project; readers (architect, analyst) — unlimited between themselves.

## Tracker — orchestrator duties

Subagents drive their own task claims per the ziptask MCP `instructions` (the server owns the tracker wire protocol). The orchestrator owns:

- **Task creation (orchestrator-only)**: `create_task`, `epic: true` for epics, `epic_id` for sub-tasks, `depends_on` for ordering (never in prose). Subagents never create tasks — only the orchestrator does.
- **State transitions (policy, not protocol)**: only the orchestrator transitions a task out of `review`; `done`, `failed`, and `canceled` are orchestrator-only. A subagent that cannot finish sets `blocked` with the cause and never sets `done`/`failed`.
- **State reads**: via the tracker read tools (`list_tasks`, `list_queue`, `get_timeline`, `metrics`); detailed evidence lives in completion comments, not in files.

## Tracker — client policy

- The tracker is the ONLY coordination channel: write tracker state via your own tools only (claim/update_status/add_comment on YOUR task id) — never touch other agents' in-flight tasks. Subagents never create tasks.
- The wire protocol (statuses, claim, version/CONFLICT, lease, comment contract) is owned by the ziptask MCP server `instructions` — do not restate it in agent files or AGENTS.md.

## Instruction files

- `AGENTS.md` files (project root or global `~/.config/opencode/AGENTS.md`) are orchestrator-owned: subagents never edit them — propose changes via a tracker comment.

## Permissions

- Every agent ships with a language-agnostic `bash` policy: `"*": ask` (nothing runs silently), an explicit read-only inspection allow-list, and denies for dangerous operations (`rm`/`mv`/`cp`, shell redirects, `sed`). The `git` agent is the only one allowed to perform git mutations; every other agent denies them.
- The agents that run builds/tests (`developer`, `devops`, `tester`) have an `# ADD YOUR STACK'S COMMANDS HERE` block. Fill it with the build/test/lint commands of YOUR toolchain, taken from your project's `AGENTS.md`. Unlisted commands keep falling through to `ask`, so extension is safe and incremental.

## Epics — orchestrator-owned

Epics (is_epic) are created and managed only by the orchestrator. Subagents may read an epic (`get_task`, `get_timeline`) but never create or mutate them — task creation and epic mutation are orchestrator-only, enforced by the opencode agent-file permissions (no subagent is granted `ziptask_create_task`; `list_*`/`metrics` stay orchestrator-side). Roll-up via `get_task fields:["subtasks"]`; claiming/attaching to epics is rejected server-side.

## Artifacts

- Specs, designs, and ADRs live under `plans/` in the repo (written by the analyst/architect). Task text stays in the tracker; never store diffs, logs, or full reports inside tracker text.

## Templates

- Always build task/epic text from the tracker templates — fetch via `ziptask_get_template` **before** writing, then fill them in.
- Regular task → `get_template("task")`.
- Epic → `get_template("epic")`. **Source is required** — write the issue URL or `#N`, or `internal` when it came from thinking (no issue).
- Comment templates (`comment-success`/`comment-failure`) are used by subagents per their own agent files.

## Git operations

- Never run `git commit`, `git push`, `git revert`, or manage branches/PRs yourself.
- Delegate all commit/push/PR/revert work to the `git` subagent.
- You may still run read-only git commands (`git status`, `git diff`, `git log`) to inspect state before delegating.
- **The git subagent is NOT a tracker client**: it does not use ziptask and receives no tracker tasks. The orchestrator issues direct commands (commit/push/PR/tag/release) and gets reports in chat.
- **Remote sync guard**: the git subagent must never rewrite pushed history (rebase onto shared branches, force-push, reset) and must not perform `pull`/`fetch` remote sync unless the orchestrator explicitly requests it. After any remote sync, the orchestrator MUST verify tree completeness (typecheck + tests) before delegating any commit — otherwise the previous sync rewrites could have silently dropped files.

## Architecture

- Delegate architecture reviews, design work, and architecture decisions to the `architect` subagent.
- When a task involves auditing existing architecture, designing a new solution, or an ADR-style decision, hand it to `architect` rather than doing it yourself.

## Analysis

- Delegate requirements analysis, epic decomposition, and acceptance-criteria derivation to the `analyst` subagent. Specs go to the repo `plans/` directory.

## Development

- Delegate implementation, refactoring, and bugfixes for significant tasks to the `developer` subagent.
- Tiny single-file fixes may be done in the main session.
- The `developer` agent does NOT write tests. Only the orchestrator creates tasks — including `test:` tasks for the tester (`create_task` with `depends_on=[the developer task id]`). A developer never opens or creates a task; it signals completion via its tracker comment and the orchestrator opens the `test:` task.

## Testing

- Delegate test writing, test runs, and test audits to the `tester` subagent.
- When a task requires writing new tests, running the test suite, or reviewing test coverage, use the `tester` subagent.
- The `tester` agent owns the smoke/heavy integration suites: run once per batch (after all tasks in the batch reach `review`/`done`), not per-commit; developers never run them.
- The `tester` agent never commits or pushes — delegate those separately to `git`.

## Documentation

- Delegate README/docs/ADR/changelog/docstring work to the `docwriter` subagent.

## DevOps

- Delegate CI pipelines, Docker/compose, deploy scripts, and configuration work to the `devops` subagent.
- The `devops` agent stops and asks before any destructive action (stopping containers, deleting volumes, real deploys).

## Language

- All agent/harness-facing artifacts (task contracts, subagent prompts, project-level `AGENTS.md`) are written in English only — token economy and a single convention. Replies in chat follow the user's language.
