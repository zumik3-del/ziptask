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
   cp docs/agents_examples/{analyst,architect,developer,tester,docwriter,devops,git}.md ~/.config/opencode/agents/
   ```

2. **Orchestrator rules** — `agents_examples/AGENTS.md` is a *global*-style rules file. Copy it to `~/.config/opencode/AGENTS.md`, or merge its sections into your project's root `AGENTS.md`. The orchestrator (your primary agent) reads it; subagents read the project's own `AGENTS.md`.

3. Restart opencode. The subagents appear in the `@` menu and can be delegated to via the Task tool.

## Using another runtime

ziptask is harness-agnostic — it speaks MCP, so **any MCP-capable client** can drive the tracker. opencode is used here as the **reference runtime, not a requirement**:

- The agent files embed opencode-specific frontmatter (`mode`, `permission`, `temperature`, `model`, `steps`). Porting to another runtime means rewriting that metadata block — the role prompt below the frontmatter is plain Markdown and carries over unchanged.
- The rules in `AGENTS.md` (tracker as the only coordination channel, orchestrator-only task creation and closure, epics, git handoff, the delegation map) are runtime-independent and apply as-is.
- The `git` agent needs only `git` (and `gh`), so it works anywhere.

Keep the workflow, swap the carrier.

## Configure your stack

Every agent ships a language-agnostic `bash` policy: `"*": ask`, an explicit read-only allow-list, and denies for dangerous operations. Build/test/lint commands are intentionally **not** listed — add the ones your toolchain uses to the `# ADD YOUR STACK'S COMMANDS HERE` block in `developer.md`, `tester.md`, and `devops.md`, and keep them in sync with your project's `AGENTS.md` verification commands. Anything left unlisted prompts for approval, so nothing runs silently and extension is incremental.

## Customize

- **Roles & delegation map** — edit the sections in `AGENTS.md` (which agent owns what, who may create tasks, who may commit).
- **Model per agent** — uncomment `# model: provider/model-id` in any agent file; omit it to inherit the invoking session's model.
- **Permissions** — the model is explained in `AGENTS.md` → *Permissions*. Tighten `edit` globs where a role is meant to be narrow (for example, restrict `docwriter` to `docs/**`).
- Prune roles you don't need; the workflow degrades gracefully.

## Notes

- The tracker **wire protocol** (statuses, claim/version/lease, comment contract) is owned by the ziptask MCP server `instructions` — don't restate it in agent files.
- **Epics** are orchestrator-only: subagents may read them but never create or mutate them.
- The **`git` agent is outside the tracker** by design — it receives direct commands and reports back, it never claims tasks.
