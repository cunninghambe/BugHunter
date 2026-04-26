# BugHunter

Exhaustive autonomous bug hunter for vibe-coded apps. Walks every route × every user role × every interactive UI element, applying a bounded mutation palette per input type. Logs clustered failures with full repro context. Optional auto-fix loop that dispatches Claude Code via ClaudeMCP to PR the fixes.

## Why this exists

Vibe coding is fast at the build step and brutal at the verify step. "Does the page return 200" is a useless test for a real app. Manually clicking through every button × slider × form × role is hours-to-days of human time per release.

BugHunter automates the boring half. It discovers your app's surface from [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) (API side) and a browser MCP (UI side), then drives every action systematically. It captures failures with enough context that another agent can actually fix them.

## Status

Spec only. See **[SPEC.md](SPEC.md)**.

Depends on:
- **[SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP)** — provides the API tool catalog
- A browser MCP — `mcp__camofox__*` (or compatible)
- **[ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP)** — for the optional auto-fix loop

## Two ways to invoke

- **Skill:** `/bughunt` from any Claude Code session (or `/bughunt --auto-fix` for fix-and-PR)
- **CLI:** `bughunter run` from a terminal — same engine

The skill is the smooth UX; the CLI is the load-bearing thing.

## Companion projects

- [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) — the API surface
- [ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP) — the build-delegation MCP used for auto-fix
