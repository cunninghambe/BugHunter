# BugHunter

Exhaustive autonomous bug hunter for vibe-coded apps. Walks every route × every user role × every interactive UI element, applying a bounded mutation palette per input type. Logs clustered failures with full repro context. Optional auto-fix loop that dispatches Claude Code via ClaudeMCP to PR the fixes.

## Why this exists

Vibe coding is fast at the build step and brutal at the verify step. "Does the page return 200" is a useless test for a real app. Manually clicking through every button × slider × form × role is hours-to-days of human time per release.

BugHunter automates the boring half. It discovers your app's surface from [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) (API side) and a browser MCP (UI side), then drives every action systematically. It captures failures with enough context that another agent can actually fix them.

## Empirical numbers

These numbers come from real BugHunter runs against the deliberate-bugs fixture (self-test) and the vibe-todo bench app (calibration), not from aspirational targets. They represent the current honest baseline.

**V33 self-test** (178/178 tests run, no crashes): 6/105 golden BugKinds detected — **5.7% recall**, **0 false positives**. The six detected kinds are `coop_coep_violation`, `focus_lost_after_action`, `missing_state_change`, `seo_h1_missing_or_multiple`, `seo_title_duplicate_across_routes`, and `xss_reflected`. The 94.3% miss rate traces to four discrete structural blockers: the fixture's API server is not registered as a SurfaceMCP surface (blocking ~25 pen-test/race/IDOR kinds), HAR network capture is empty (blocking ~15 network/console/react kinds), the bundle probe returns 0 bytes (blocking perf kinds), and the axe runner emits 0 results silently (blocking a11y kinds). Each blocker is a scoped follow-up; the pipeline itself is healthy. (Measurement is pre-fix-PRs #102/103/104/105; smoke #5 was in flight at time of writing.)

**Calibration on vibe-todo** ([issue #93](https://github.com/cunninghambe/BugHunter/issues/93)): precision 0% / recall 0% / F1 0. These numbers reflect a partially-broken calibration pipeline: `calibrate.ts` was reading clusters from `summary.json.clusters` (always empty) instead of `bugs.jsonl`. PR [#94](https://github.com/cunninghambe/BugHunter/issues/94) fixed the silent-lie path. A re-run against vibe-todo with the fix applied, the Express backend registered as a SurfaceMCP surface, and browser auth working is needed before meaningful precision/recall numbers are possible. BugHunter did surface 20 real findings (COOP/COEP violations, SEO issues, vulnerable dependencies) that were not in the gold standard — those are not false positives, they are unlisted bugs.

**Determinism** ([issue #86](https://github.com/cunninghambe/BugHunter/issues/86)): verified — two consecutive runs with `--seed 42 --frozen-clock` against the race-bad fixture produce byte-identical canonical `summary.json` (SHA-256 `9c5ea3362c04efb4a4fbf7495ece90cb014e814a0744554c71dc8d17a8747faf`). The only fields that differ between runs are `actualRuntimeMs` (stripped from canonical hash per spec §6.5) and `runId` (by design).

**Last measured:** 2026-05-02

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
- [BugHunter-bench](https://github.com/cunninghambe/BugHunter-bench) — public calibration corpus (5 apps, gold-standard bug lists)

## Troubleshooting

### Orphaned fixture processes after a self-test

If `bughunter self-test` is interrupted (e.g., Ctrl-C or OOM kill), fixture servers can be left running on ports 9994, 4090, 5780–5782, 4091, 5790, and 5791. The `up.sh` orchestrator now installs a SIGINT/SIGTERM trap that runs `down.sh` automatically, but if it is force-killed you can clean up manually:

```bash
bughunter doctor --cleanup
```

This greps for processes matching `bh-e2e-fixture` or `bughunter-fixture-`, sends SIGTERM, waits 5 s, then SIGKILLs any stragglers. It prints a JSON report of what it killed and which ports were freed.

<!-- BEGIN CALIBRATION -->
## Calibration (last updated TBD; bench v0.1.0; 5 apps; TBD gold entries)

Precision/recall numbers are populated by CI after each merge to main.
Run `bughunter calibrate --app <bench-app> --enforce-thresholds` locally to verify.

| BugKind                                 | Precision | Recall | F1   | Apps |
|-----------------------------------------|-----------|--------|------|------|
| (pending first CI run)                  | —         | —      | —    | —    |

[View raw report](https://github.com/cunninghambe/BugHunter/actions) · See [BugHunter-bench](https://github.com/cunninghambe/BugHunter-bench) for corpus details.
<!-- END CALIBRATION -->
