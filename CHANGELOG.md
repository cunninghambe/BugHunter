# Changelog

All notable changes to BugHunter are documented here.

## [Unreleased]

### Added — V56.1: Per-Detector MCP Harness Infrastructure

V56.1 lands the load-bearing infrastructure for the per-detector harness. No detector contracts ship in this release — V56.2 populates the first 10.

**A. Detector contract type system (`packages/cli/src/detectors/contracts.ts`)**
- `DetectorContract` type with `requires` (phases, tools, surface, role, pageContext), `fixture`, `defaultBudgetMs`, `note`
- `ClusterAssertion` discriminated union (`fires` | `silent`)
- `DETECTOR_CONTRACTS: ReadonlyArray<DetectorContract>` — empty in V56.1, populated in V56.2+
- `harness?: boolean` field added to `DetectorRegistryEntry` in `registry.ts`
- V56 lockstep assertions added to `registry.lockstep.test.ts`: 1:1 between `harness:true` rows and `DETECTOR_CONTRACTS`

**B. MCP tool: `bughunt_run_detector` (`packages/mcp/src/tools/run-detector.ts`)**
- Registered in `packages/mcp/src/server.ts` alongside existing tools
- Input: `kind: BugKind | BugKind[]`, `target`, `scope?`, `budgetMs?`, `reset?`, `project?`
- Output: `{ clusters, telemetry: { plannedTests, runTests, skippedTests, durationMs, perDetectorElapsed, budgetExceeded, phasesRun }, warnings }`
- Returns `unknown_detector_kind` error while `DETECTOR_CONTRACTS` is empty (V56.1 only)
- Runtime AbortSignal compliance check at tool startup (warns, does not fail — per resolved decision 4)

**C. Run-store schema: `runMode` field**
- `RunState.runMode?: 'full-scan' | 'detector-call'` added to `packages/cli/src/types.ts`
- Read path tolerates missing field (pre-V56 records default to `'full-scan'`)
- `bughunt_run_detector` persists runs with `runMode: 'detector-call'` when `project` is supplied

**D. AbortSignal propagation**
- `packages/cli/src/harness/executor.ts`: `runHarness` accepts `signal?: AbortSignal` and combines with internal budget `AbortController`
- Budget hard-stop propagated through phase loop; returns `budgetExceeded: true` on abort
- `checkAdapterSignalCompliance` runtime check at MCP tool startup
- TODO comment referencing V57+ for comprehensive adapter audit

**E. CLI: `bughunter test-detector` and `bughunter self-test --tier`**
- `bughunter test-detector <kind|all> [--target <url>] [--verbose] [--no-up] [--keep] [--json]`
- `bughunter self-test --tier <1|2|3|all> [--bail] [--json]`
- Tier 1: per-detector fixture runs (parallelized at 8), passes vacuously with 0 contracts
- Tier 2: phase-level smoke infrastructure ready; `_phase-smoke` fixture created (full execution in V56.2)
- Tier 3: existing comprehensive-bench self-test (unchanged); `bughunter self-test` (no --tier) = Tier 3
- Tier gating: Tier 1 failure blocks Tier 2/3 from running

**F. Fixture scaffolding**
- `fixtures/detector-calibration/_phase-smoke/` — meta-fixture for Tier 2; stub server in V56.1
- `fixtures/detector-calibration/_template/` — reference template for V56.2+ coder

**G. Documentation**
- README: "Per-detector MCP tool" section with 3 usage examples
- CHANGELOG: this entry

### Fixed



- **fix(transport): friendly error for mcp-http on legacy camofox-mcp (#115)**
  When `browserTransport` is `mcp-http` (the default since v0.42) and the configured
  camofox-mcp server does not advertise the Streamable HTTP MCP transport, BugHunter
  now throws a clear error at startup rather than failing silently mid-run.

  Error message: `Your camofox-mcp at <url> does not advertise the mcp-http transport.
  Either upgrade camofox-mcp to ≥0.3.0 or set 'browserTransport: "http-rest"' in your config.`

## v0.42

### Breaking / Migration Note

**`browserTransport` default changed to `'mcp-http'`.**

If you are running camofox-mcp older than v0.3.0, add the following to your
`bughunter.config.json` to restore the previous behaviour:

```json
{
  "browserTransport": "http-rest"
}
```

To upgrade camofox-mcp: `npm install -g camofox-mcp@latest` (requires v0.3.0+).
