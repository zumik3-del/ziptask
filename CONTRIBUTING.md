# Contributing to ziptask

Thanks for your interest in contributing! This document explains how to get started.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/zumik3-del/ziptask/issues) to avoid duplicates.
2. Open a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (Bun version, DB path, transport)

### Suggesting Features

Open an issue with the `feature` label. Describe the problem you want to solve and your proposed solution.

### Submitting Changes

1. Fork the repo and create a feature branch from `dev`.
2. Make your changes following the code conventions below.
3. Run `bun test` to make sure tests pass.
4. Run `bunx biome check src/` for lint.
5. Run `bunx tsc --noEmit` for type checking.
6. Open a pull request `dev` → `main` with a **Conventional Commit title** (see below).
7. PRs are merged with a **merge commit** (never squash) — the PR title becomes the merge-commit subject on `main`.

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The PR title (used as the merge-commit subject) must follow this format:

```
<type>(<optional scope>): <description>
```

### Allowed types

| Type | When to use |
|------|-------------|
| `fix` | Bug fix |
| `feat` | New feature |
| `feat!` / `BREAKING CHANGE:` | Breaking change |
| `chore`, `docs`, `refactor`, `test`, `ci`, `build` | Maintenance |

### Examples

- `fix: crash on empty database`
- `feat: add task leasing`
- `chore: update dependencies`

### Invalid

- `Fixed bug` (not imperative mood)
- `✨ Added feature` (emoji, not conventional)
- `update stuff` (no type prefix)

## Code Conventions

- **SOLID, KISS, DRY** — apply where it matters, skip where it doesn't.
- **TypeScript strict** — no `any` unless unavoidable.
- **Functions do one thing**, files are short, names are clear.
- **Tests alongside source** — `.test.ts` suffix, same directory.

## Project Structure

```
src/
  core/         Domain logic (tasks, deps, projects, service)
  db/           SQLite schema, migrations, repositories
  mcp/          MCP server + tools
```

## Development Setup

```bash
bun install
bun test                    # run tests
bunx biome check src/       # lint
bunx tsc --noEmit           # type check
bun run start               # start server (HTTP)
bun run dev                 # watch mode (restart on change)
```

## Pull Request Guidelines

- Keep PRs focused on a single change.
- Reference related issues (e.g., `closes #12`).
- Describe what changed and why.
- Ensure CI passes before requesting review.
