# BugHunter

Exhaustive autonomous bug hunter for vibe-coded apps. Walks every route × every user role × every interactive UI element, applying a bounded mutation palette per input type. Logs clustered failures with full repro context. Optional auto-fix loop that dispatches Claude Code via ClaudeMCP to PR the fixes.

## Why this exists

Vibe coding is fast at the build step and brutal at the verify step. "Does the page return 200" is a useless test for a real app. Manually clicking through every button × slider × form × role is hours-to-days of human time per release.

BugHunter automates the boring half. It discovers your app's surface from [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) (API side) and a browser MCP (UI side), then drives every action systematically. It captures failures with enough context that another agent can actually fix them.

## Empirical numbers

Real BugHunter runs against the deliberate-bugs fixture and the comprehensive-bench fixture. Numbers vary as the calibration pipeline matures — the trajectory is documented honestly rather than smoothed.

**Peak measurement (smoke #14, focused fixture):** 17/85 golden BugKinds detected — **20.0% kind recall, 49.7% plant recall, 0 false positives.** Both UI and API kinds firing in one run. This is the empirical signal of what the system delivers when its inputs reach it cleanly.

**Current measurement (smoke #20, comprehensive-bench):** 9/96 (9.4%) kind recall, 17/218 (7.8%) plant recall, 0 false positives in detector classes (8 unexpected `auth_bypass_via_unauthed_route` clusters fire on intentionally-public routes — pending suppression rule). The comprehensive-bench fixture (218 plants × 101 kinds × 22 auth-gated routes × 2 surfaces) is more demanding than the focused fixture, and surfaces a regression chain currently under investigation. Two unfixed blockers are tracked:
- Web surface budget overrun — `runPhaseForSurface` runs 7% past `budgetMs`, eating into API surface allocation
- API cookie propagation gap — `extraCookie` obtained but not reaching outbound headers despite landed PRs

**Determinism:** verified — two consecutive runs with `--seed 42 --frozen-clock` against the race-bad fixture produce byte-identical canonical `summary.json` (SHA-256 `9c5ea3362c04efb4a4fbf7495ece90cb014e814a0744554c71dc8d17a8747faf`). The only fields that differ between runs are `actualRuntimeMs` (stripped from canonical hash per spec §6.5) and `runId` (by design).

**False-positive precision:** 0 detector-class FPs on the focused fixture. On real-world targets (an Aspect staging app), 8 FP categories were identified and addressed across PRs #110–#114, #145, #150 (Vite dev-URL artifacts, mutator-validation rejections, Radix portal popovers, intentional brand colors as visual anomalies, etc.). The current FP rate on real apps is the honest open question — not the kind-recall number.

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
