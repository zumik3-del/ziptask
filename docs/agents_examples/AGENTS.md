# Global rules (generic template)

> This is a **minimal, generic template**. Adapt paths, commands, and conventions to your project; it is not a verbatim copy of any specific project's rules.

## Workspace & communication

- Code lives in the repo; design specs and notes live under `docs/` in the repo. The tracker holds state, files hold content.
- Interaction channel = the ziptask tracker, always (exception: the git subagent, see Git operations). The orchestrator creates tasks with a FULL description (goal, acceptance criteria, constraints, deliverable — English) and spawns subagents with a minimal prompt: `Task #N. Do not commit. English only.` plus special instructions only when they deviate from the agent file. Follow-up context and outcomes travel as tracker comments. No task.md contracts, no result files.
- Parallelism: repo mutators (developer, tester, docwriter, devops, git) — up to 4 concurrent per project on disjoint files; readers (reviewer) — unlimited; the analyst and the architect are read-only on repo code but write specs and ADRs under `docs/`, so they count as mutators of `docs/` — keep them off the files another agent owns.

## Tracker — orchestrator duties

Subagents drive their own task claims per the ziptask MCP `instructions` (the server owns the tracker wire protocol). The orchestrator owns:

- **Task creation (orchestrator-only)**: `create_task`, `epic: true` for epics, `epic_id` for sub-tasks, `depends_on` for ordering (never in prose). Subagents never create tasks — only the orchestrator does.
- **State transitions (policy, not protocol)**: only the orchestrator transitions a task out of `review`; `done`, `failed`, and `canceled` are orchestrator-only. A subagent that cannot finish sets `blocked` with the cause and never sets `done`/`failed`.
- **State reads**: via the tracker read tools (`list_tasks`, `list_queue`, `get_timeline`); the enumerating ones (`list_queue`, and `list_tasks` without `ids`) additionally require the project slug the orchestrator declares, while by-id reads (`get_task`, `get_timeline`) stay unscoped. Detailed evidence lives in completion comments, not in files.

## Tracker — client policy

- The tracker is the ONLY coordination channel: write tracker state via your own tools only (claim/update_status/add_comment on YOUR task id) — never touch other agents' in-flight tasks. Subagents never create tasks.
- The wire protocol (statuses, claim, version/CONFLICT, lease, comment contract) is owned by the ziptask MCP server `instructions` — do not restate it in agent files or AGENTS.md.

## Instruction files

- `AGENTS.md` files (project root or global `~/.config/opencode/AGENTS.md`) are orchestrator-owned: subagents never edit them — every agent denies editing them (`AGENTS.md` and `**/AGENTS.md`; the reviewer denies `edit` outright, the analyst and the architect only write their own docs under `docs/`); propose changes via a tracker comment.

## Permissions

- Every agent ships a native V2 `permissions` list — an ordered set of `action`/`resource`/`effect` rules, last match wins. The shell commands live under `action: shell`: the first shell rule is `resource: "*"` with `effect: ask` (nothing runs silently), then an explicit allow-list of read-only inspection commands (`git status*`, `ls*`, `cat*`, `rg*`, …), then `effect: deny` for dangerous operations (`rm*`, `mv*`, `cp*`, shell redirects, `sed*`). Git mutations are the one exception: only the `git` agent's allow-list carries them (`git commit*`, `git push*`, `git merge*`). Every other agent refuses the whole git surface with a blanket `git *` deny and re-allows only the read-only forms: `git status*`, `git log*`, `git diff*`, `git show*`, the listing forms of `git branch` (`git branch`, `git branch -a`, `git branch -r`, `git branch -v`, `git branch -vv`, `git branch --list *`, `git branch --merged *`, `git branch --show-current`) and the read-only forms of `git remote` (`git remote`, `git remote -v*`, `git remote get-url*`). A git verb outside that list is REFUSED (deny), not left to a prompt — `git commit`, `git push`, `git reset`, `git clean`, `git merge`, `git add`, `git checkout`, `git switch`, `git revert`, `git tag`, `git stash`, `git cherry-pick`, `git pull`, `git fetch`, `git rebase`, `git rm`, `git restore`, `git worktree`, `git apply`, `git am`, `git config`, `git submodule`, `gh pr*` and `gh issue*` included. A shell rule is matched against the command text as a whole, so the exact `git branch` allows the bare listing only — `git branch -D feature` does not match it and stays denied.
- `developer`, `tester` and `devops` re-allow `rm -rf /tmp/*`, `rm -f /tmp/*` and the redirects `* > /tmp/*` / `* >> /tmp/*` after the denies, so their scratch space under `/tmp` stays writable while the same commands are refused everywhere else.
- The agents that run builds/tests (`developer`, `devops`, `tester`, `reviewer`) carry an `# ADD YOUR STACK'S COMMANDS HERE` block in their `permissions` list. Add the build/test/lint commands of YOUR toolchain there, as `action: shell` entries taken from your project's `AGENTS.md` verification commands. Build/test/lint commands are intentionally not listed in the examples; anything left unlisted keeps the `ask` effect, so nothing runs silently and extension is safe and incremental.

## Epics — orchestrator-owned

Epics (is_epic) are created and managed only by the orchestrator. Subagents may read an epic (`get_task`, `get_timeline`) but never create or mutate them — task creation and epic mutation are orchestrator-only, enforced by the opencode agent-file permissions (no subagent is granted `ziptask_create_task`; `list_*` stays orchestrator-side). Roll-up via `get_task fields:["subtasks"]`; claiming/attaching to epics is rejected server-side.

## Artifacts

- Specs, designs, and ADRs live under `docs/` in the repo (written by the analyst/architect). Task text stays in the tracker; never store diffs, logs, or full reports inside tracker text.

## Templates

- Always build task/epic text from the tracker templates — fetch via `ziptask_get_template` **before** writing, then fill them in.
- Regular task → `get_template("task")`.
- Epic → `get_template("epic")`. **Source is required** — write the issue URL or `#N`, or `internal` when it came from thinking (no issue).
- Comment templates (`comment-success`/`comment-failure`) are used by subagents per their own agent files.

## Git operations

- Never run a git mutation yourself — `git commit`, `git push`, `git merge`, `git rebase`, `git tag`, `git stash`, `git cherry-pick`, branch and PR management, and every other verb outside the read-only list (see *Permissions*). Every agent but `git` refuses them, so the command is refused instead of running.
- Delegate all commit/push/PR/revert work to the `git` subagent.
- You may still run read-only git commands (`git status`, `git diff`, `git log`) to inspect state before delegating.
- **The git subagent is NOT a tracker client**: it does not use ziptask and receives no tracker tasks. The orchestrator issues direct commands (commit/push/PR/tag/release) and gets reports in chat.
- **Remote sync guard**: the git subagent must never rewrite pushed history (rebase onto shared branches, force-push, reset) and must not perform `pull`/`fetch` remote sync unless the orchestrator explicitly requests it. After any remote sync, the orchestrator MUST verify tree completeness (typecheck + tests) before delegating any commit — otherwise the previous sync rewrites could have silently dropped files.

## Architecture

- Delegate architecture reviews, design work, and architecture decisions to the `architect` subagent.
- When a task involves auditing existing architecture, designing a new solution, or an ADR-style decision, hand it to `architect` rather than doing it yourself.

## Analysis

- Delegate requirements analysis, epic decomposition, and acceptance-criteria derivation to the `analyst` subagent. Specs go to the repo `docs/` directory.

## Development

- Delegate implementation, refactoring, and bugfixes for significant tasks to the `developer` subagent.
- Tiny single-file fixes may be done in the main session.
- The `developer` agent does NOT write tests. Only the orchestrator creates tasks — including `test:` tasks for the tester (`create_task` with `depends_on=[the developer task id]`). A developer never opens or creates a task; it signals completion via its tracker comment and the orchestrator opens the `test:` task.

## Testing

- Delegate test writing, test runs, and test audits to the `tester` subagent.
- When a task requires writing new tests, running the test suite, or reviewing test coverage, use the `tester` subagent.
- The `tester` agent owns the smoke/heavy integration suites: run once per batch (after all tasks in the batch reach `review`/`done`), not per-commit; developers never run them — `developer`, `reviewer` and `architect` deny the suite outright (`*smoke*`).
- The `tester` agent never commits or pushes — delegate those separately to `git`.

## Review

- Delegate pre-merge review of non-trivial changes to the `reviewer` subagent.
- The `reviewer` is READ-ONLY: findings (severity + `path:line`) go in its completion comment; it never edits code. The orchestrator turns required findings into follow-up fix tasks. The reviewer's verification commands (typecheck, lint, focused tests) are not listed in the example — they ask, unless your project adds them to the `# ADD YOUR STACK'S COMMANDS HERE` block of `reviewer.md`.

## Documentation

- Delegate README/docs/ADR/changelog/docstring work to the `docwriter` subagent.

## DevOps

- Delegate CI pipelines, Docker/compose, deploy scripts, and configuration work to the `devops` subagent.
- The `devops` agent stops and asks before any destructive action (stopping containers, deleting volumes, real deploys).

## Language

- All agent/harness-facing artifacts (task contracts, subagent prompts, project-level `AGENTS.md`) are written in English only — token economy and a single convention. Replies in chat follow the user's language.
