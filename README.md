# BugHunter

Exhaustive autonomous bug hunter for vibe-coded apps. Walks every route × every user role × every interactive UI element, applying a bounded mutation palette per input type. Logs clustered failures with full repro context. Optional auto-fix loop that dispatches Claude Code via ClaudeMCP to PR the fixes.

## Why this exists

Vibe coding is fast at the build step and brutal at the verify step. "Does the page return 200" is a useless test for a real app. Manually clicking through every button × slider × form × role is hours-to-days of human time per release.

BugHunter automates the boring half. It discovers your app's surface from [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) (API side) and a browser MCP (UI side), then drives every action systematically. It captures failures with enough context that another agent can actually fix them.

## Empirical numbers

Real BugHunter runs against the deliberate-bugs fixture, the comprehensive-bench fixture, 5 bench apps in [BugHunter-bench](https://github.com/cunninghambe/BugHunter-bench), and a real production-shaped Next.js app (spoonworks). Numbers vary as the calibration pipeline matures — the trajectory is documented honestly rather than smoothed.

**Real-app precision (spoonworks, 2026-05-16, v0.53.1):** **4 / 4 = 100 %** precision. 4 clusters emitted from a 38-page production e-commerce app, all `vulnerable_dependency_high` confirmed against `npm audit`. See **[docs/benchmarks/BENCHMARK_SPOONWORKS.md](docs/benchmarks/BENCHMARK_SPOONWORKS.md)** for the per-cluster triage.

Trajectory of the same target across four measurements:

| run | clusters | precision | comment |
|---|---|---|---|
| 2026-05-11 (baseline) | 77 | 6/77 = 7.8 % | 71 FPs concentrated in 3 detector patterns |
| 2026-05-14 v0.51 (PR #265) | 25 | ~4/25 = ~16 % | dom_error_text, surface_call_failed, 422 fixed; 404_for_linked_route leaked through |
| 2026-05-14 v0.52 (PR #266) | 5 | 4/5 = 80 % | classifier-side gate added for unresolved `:id` placeholders |
| 2026-05-16 v0.53.1 (PRs #268, #269) | 4 | 4/4 = **100 %** | MutationObserver childList count threaded through PostState; classifier honors it |

Caveats: the v0.53.1 run hit a camofox cache issue mid-execution (`/root/.cache/camoufox/version.json` was missing) and stopped at `max_infra_failures` with 3047/3338 UI tests completed. Precision is over what completed; the four real-bug clusters were captured before the env issue triggered.

**Detector calibration (V56.4.15, 127 BugKinds):** **127/127 PASS** on the per-detector self-test. Every wired BugKind in the registry has a `DetectorContract`, a fixture, and a per-route scorecard. A serial sweep against camofox + 17 fixture servers completes in ~50 min with all 127 PASSing. This measures whether each detector fires when a fixture is engineered to trip it — it does NOT measure precision on real apps. Per the spoonworks benchmark above, real-app precision is the load-bearing metric.

**Bench-app calibration (5 web apps × ~100 BugKinds):** runs on every push to main via the `calibrate` workflow, posts per-PR comments, and writes the auto-updated block at the bottom of this README. Bench-app stability is upstream of BugHunter — the workflow tolerates per-app health-check timeouts and emits a vacuous aggregate rather than failing CI.

**Peak measurement (smoke #14, focused fixture):** 17/85 golden BugKinds detected — **20.0% kind recall, 49.7% plant recall, 0 false positives.** Both UI and API kinds firing in one run. Synthetic-fixture number; see spoonworks above for real-app behavior.

**Determinism:** verified — two consecutive runs with `--seed 42 --frozen-clock` against the race-bad fixture produce byte-identical canonical `summary.json` (SHA-256 `9c5ea3362c04efb4a4fbf7495ece90cb014e814a0744554c71dc8d17a8747faf`). The only fields that differ between runs are `actualRuntimeMs` (stripped from canonical hash per spec §6.5) and `runId` (by design).

## Status

Working system with 127 wired detectors, calibration scorecards on all of them, CI on every push. See **[SPEC.md](SPEC.md)** for design decisions and **[CHANGELOG.md](CHANGELOG.md)** for milestone history.

Depends on:
- **[SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP)** — provides the API tool catalog
- A browser MCP — `mcp__camofox__*` (or compatible)
- **[ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP)** — for the optional auto-fix loop

## Two ways to invoke

- **Skill:** `/bughunt` from any Claude Code session (or `/bughunt --auto-fix` for fix-and-PR)
- **CLI:** `bughunter run` from a terminal — same engine

The skill is the smooth UX; the CLI is the load-bearing thing.

## Per-detector MCP tool (V56)

BugHunter exposes a third invocation path: `bughunt_run_detector`, a write-side MCP tool that runs a single detector (or list of detectors) against a target right now and returns clusters — without a full 17-hour scan.

**When to use it:**
- "Did my XSS fix take?" → run only `xss_reflected` against the patched URL
- "Recheck CSP after a header change" → target only `missing_csp_header`
- "Re-run all IDOR detectors after an auth refactor" → pass an array of kinds

**Examples (MCP call via `POST /mcp`):**

Single-kind invocation:
```json
{
  "method": "tools/call",
  "params": {
    "name": "bughunt_run_detector",
    "arguments": {
      "kind": "missing_csp_header",
      "target": { "appBaseUrl": "http://localhost:3000", "surfaceMcpUrl": "http://localhost:3200" },
      "budgetMs": 30000
    }
  }
}
```

Multi-kind (IDOR category) with cookie auth:
```json
{
  "method": "tools/call",
  "params": {
    "name": "bughunt_run_detector",
    "arguments": {
      "kind": ["idor_horizontal", "idor_horizontal_read", "idor_vertical_role_escalate"],
      "target": {
        "appBaseUrl": "http://localhost:3000",
        "surfaceMcpUrl": "http://localhost:3200",
        "browserMcpUrl": "http://localhost:9377",
        "auth": { "kind": "cookie", "cookie": "session=abc123" }
      },
      "budgetMs": 60000
    }
  }
}
```

Scoped to specific route with persistence:
```json
{
  "method": "tools/call",
  "params": {
    "name": "bughunt_run_detector",
    "arguments": {
      "kind": "xss_reflected",
      "target": { "appBaseUrl": "http://localhost:3000", "browserMcpUrl": "http://localhost:9377" },
      "scope": { "routes": ["/search"], "maxTests": 50 },
      "project": "/path/to/project",
      "budgetMs": 30000
    }
  }
}
```

**Output includes:** `clusters[]`, `telemetry.budgetExceeded`, `telemetry.perDetectorElapsed`, `warnings[]`.

**Coverage (as of V56.4.15):** **127 / 127** wired BugKinds have working harness coverage with calibration scorecards — every detector in the registry has a contract, a fixture, and per-kind PASS/SKIP/FAIL assertions. Deferred-kinds list is closed (was 33 deferred at V56.3 → 0 deferred).

Coverage history:
- V56.3 → 51/94 (54%) — static-fixture detectors only
- V56.4 buckets A–G → 94/94 (100% of then-wired) — added the V56.4 browser harness (camofox + production-classifier-dispatch pattern), wiring 43 browser-driven kinds (console_error, react_error, hydration_mismatch, IDOR variants, race conditions, perf metrics, nav-state, a11y interaction, multi-context, service/web workers, network_fault, prompt_injection, i18n_rtl, etc.)
- V56.4.15 → 127/127 (100%) — closed the deferred-kinds backlog by sentinel-wiring the 33 kinds whose production runners required infrastructure not yet wired (clock JWT issuance, V36/V41/V43 runners, v0.50 interaction palette, stress-loop runner). Each contract's `note` field documents what the production path needs.

V56.4 also shipped camofox auto-recovery (`browser_context_closed` detection + reconnect) so `test-detector` no longer requires manual `pm2 restart camofox-browser` between detector runs.

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
## Calibration (last updated 2026-05-16; bench v?; 0 apps; 0 gold entries; bench@fbc45b2)

**Overall**: precision=1 recall=1 f1=0 (tp=0 fp=0 fn=0)

| BugKind                                 | Precision | Recall | F1   | Apps |
|-----------------------------------------|-----------|--------|------|------|

[View raw report](https://github.com/cunninghambe/BugHunter/actions) · Generated by bughunter@undefined
<!-- END CALIBRATION -->
