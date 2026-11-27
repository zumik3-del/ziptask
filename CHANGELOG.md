# Changelog

All notable changes to this project are documented in the [GitHub Releases](https://github.com/zumik3-del/ziptask/releases).

## v0.9.1

MCP tool annotations on all 14 tools, with the reaping query tools (`get_task`, `list_tasks`, `list_queue`, `get_timeline`) advertised as mutating rather than read-only; a `get_template` description that names its four templates and the tool each feeds; and a test guard on the description-plus-schema payload. Also fixes the `deploy/` `app_version` default command, which aborted installs and updates. See the [release notes](https://github.com/zumik3-del/ziptask/releases/tag/v0.9.1) for details.

## v0.9.0

Dependency and CI maintenance — Dependabot replaced by a self-hosted Renovate run, with GitHub Actions, Bun and lock-file pins updated — plus the config-independent `--version`/`--help` handling and the experimental read-API error fixes merged since v0.8.0. See the [release notes](https://github.com/zumik3-del/ziptask/releases/tag/v0.9.0) for details.

## v0.8.0

See the [release notes](https://github.com/zumik3-del/ziptask/releases/tag/v0.8.0) for details.
