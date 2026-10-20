# Subagent setup

ziptask ships an example multi-agent workflow: one **orchestrator** (the primary opencode agent you talk to) delegates to specialized **subagents**, and the whole handoff runs through the ziptask tracker. The examples live in [`agents_examples/`](agents_examples/) — treat them as templates to adapt, not as a plugin.

## What's in the examples

| File | Role |
|---|---|
| `AGENTS.md` | Global orchestrator rules: workspace, tracker policy, epics, artifacts, git handoff, delegation map, permissions |
| `analyst.md` | Requirements analysis, epic decomposition, acceptance criteria |
| `architect.md` | Architecture audits, designs, ADRs |
| `developer.md` | Implementation, refactoring, bugfixes |
| `tester.md` | Test writing/runs, coverage audits, the smoke suite |
| `docwriter.md` | README/docs/ADR/changelog/docstring work |
| `reviewer.md` | Code review (five axes), doubt-driven checks, verification audits |
| `devops.md` | CI pipelines, Docker/compose, deploy scripts, configs |
| `git.md` | Commits, pushes, branches, issues, PRs — deliberately **not** a tracker client |

## Prerequisites

- An MCP-capable agent runtime. The examples are written for [opencode](https://opencode.ai); see *Using another runtime* below.
- ziptask connected as an MCP server (see the README **MCP client config**). Subagents drive their tasks through the tracker tools; the `git` agent uses plain `git`/`gh` instead.
- Optional: the [`gh` CLI](https://cli.github.com) for the `git` agent on GitHub-hosted repositories.

## Install

1. **Agent files** — copy them into the global or per-project agent directory. The filename becomes the agent name.

   - Global: `~/.config/opencode/agents/`
   - Per-project: `.opencode/agents/`

   ```bash
   cp docs/agents_examples/{analyst,architect,developer,tester,docwriter,devops,git,reviewer}.md ~/.config/opencode/agents/
   ```

2. **Orchestrator rules** — `agents_examples/AGENTS.md` is a *global*-style rules file. Copy it to `~/.config/opencode/AGENTS.md`, or merge its sections into your project's root `AGENTS.md`. The orchestrator (your primary agent) reads it; subagents read the project's own `AGENTS.md`.

3. Restart opencode. The subagents appear in the `@` menu and can be delegated to via the Task tool.

## Using another runtime

ziptask is harness-agnostic — it speaks MCP, so **any MCP-capable client** can drive the tracker. opencode is used here as the **reference runtime, not a requirement**:

- The agent files embed opencode-specific frontmatter (`description`, `mode`, `steps`, `color`, `permissions`, plus an optional commented-out `model`). `permissions` is an ordered list of `action`/`resource`/`effect` rules. Porting to another runtime means rewriting that metadata block — the role prompt below the frontmatter is plain Markdown and carries over unchanged.
- The rules in `AGENTS.md` (tracker as the only coordination channel, orchestrator-only task creation and closure, epics, git handoff, the delegation map) are runtime-independent and apply as-is.
- The `git` agent needs only `git` (and `gh`), so it works anywhere.

Keep the workflow, swap the carrier.

## Configure your stack

Every agent ships a `shell` policy in its `permissions` list: `resource: "*"` → `effect: ask` first, then an explicit allow-list of read-only commands (`git status*`, `ls*`, `cat*`, `rg*`, …), then `effect: deny` for dangerous operations (`rm*`, `mv*`, `cp*`, shell redirections, `sed*`). Git mutations are the one exception: only the `git` agent's allow-list carries them (`git commit*`, `git push*`, `git merge*`). Every other agent refuses the whole git surface with a blanket `git *` deny and re-allows only the read-only forms — `git status*`, `git log*`, `git diff*`, `git show*`, the listing forms of `git branch` and the read-only forms of `git remote`. A git verb outside that list is REFUSED (deny), not left to a prompt: `git commit`, `git push`, `git reset`, `git clean`, `git merge`, `git add`, `git checkout`, `git switch`, `git revert`, `git tag`, `git stash`, `git cherry-pick`, `git pull`, `git fetch`, `git rebase`, `git rm`, `git restore`, `git worktree`, `git apply`, `git am`, `git config`, `git submodule`, `gh pr*` and `gh issue*` included. A shell rule is matched against the command text as a whole, so the exact `git branch` allows the bare listing only — `git branch -D feature` does not match it and stays denied. `developer`, `tester` and `devops` re-allow `rm -rf /tmp/*`, `rm -f /tmp/*` and the redirections `* > /tmp/*` / `* >> /tmp/*` after the denies — their scratch space under `/tmp` is writable, the same commands are refused everywhere else. Build/test/lint commands are intentionally **not** listed — add the ones your toolchain uses as `shell` entries in `developer.md`, `tester.md`, `devops.md` and `reviewer.md` (the examples' `AGENTS.md` calls this the `# ADD YOUR STACK'S COMMANDS HERE` block), and keep them in sync with your project's `AGENTS.md` verification commands. Anything left unlisted keeps the `ask` effect, so nothing runs silently and extension is incremental.

## Customize

- **Roles & delegation map** — edit the sections in `AGENTS.md` (which agent owns what, who may create tasks, who may commit).
- **Model per agent** — uncomment `# model: provider/model-id` in any agent file; omit it to inherit the invoking session's model.
- **Permissions** — the model is explained in `AGENTS.md` → *Permissions*. Tighten `edit` globs where a role is meant to be narrow: `analyst` and `architect` are already limited to `docs/**` (and their `AGENTS.md` files stay denied), so narrow `docwriter` the same way if its role warrants it. The git surface of every agent but `git` is the read-only list only — `git status*`, `git log*`, `git diff*`, `git show*`, the listing forms of `git branch`, the read-only forms of `git remote` — while `gh pr*` and `gh issue*` are refused outright; `developer`, `tester` and `devops` additionally re-allow `rm -rf /tmp/*`, `rm -f /tmp/*` and the redirections under `/tmp` for their scratch space.
- Prune roles you don't need; the workflow degrades gracefully.

## Notes

- The tracker **wire protocol** (statuses, claim/version/lease, comment contract) is owned by the ziptask MCP server `instructions` — don't restate it in agent files.
- **Epics** are orchestrator-only: subagents may read them but never create or mutate them.
- The **`git` agent is outside the tracker** by design — it receives direct commands and reports back, it never claims tasks.
