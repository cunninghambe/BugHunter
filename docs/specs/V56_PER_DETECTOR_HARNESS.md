# V56 — Per-Detector MCP Harness, Minimal Fixtures, and Tiered Self-Test

**Status:** Draft 1 — implementation contract (multi-coder, parallel-safe)
**Author:** @architect
**Date:** 2026-05-04
**Depends on:** V33 (self-test), V34 (registry lockstep), V53 (multi-surface), V54 (comprehensive-bench), V55 (browser-login)
**Deferred to follow-ups:** V57 (per-detector budget tuning), V58 (multi-detector composition rules)

---

## 1. Problem statement

BugHunter today has two product shapes wedged into one codebase: a 17-hour batch scanner (`bughunter run`) and a read-side MCP that queries past-tense run output (`bughunt_clusters`, `bughunt_cluster_detail`, etc.). The missing third shape — and the one that actually unblocks the recall trajectory — is **the per-detector primitive**: "run ONE detector against ONE target right now, in seconds."

The recall trajectory is the proximate driver. Smoke #14 was peak (20.0% recall, 0 FPs) on the small fixture; six smokes on the comprehensive-bench have monotonically regressed to 9.4%. We cannot tell which subsystem broke from cycle to cycle because failures attribute at the run level, not the detector level. Per-detector observability turns minutes-of-debugging into seconds-of-attribution: a per-detector fixture either fires or it does not, and the failing fixture names the broken subsystem.

The strategic driver is parallel: BugHunter becomes a primitive other agents call ("re-run XSS detectors against `/search`", "did the IDOR fix take?", "recheck CSP only"). This is the future tense of how BugHunter is consumed — agents calling targeted bug-hunting tools mid-task, not waiting for nightly batches. V56 lands the load-bearing infrastructure for both: an enforceable detector contract, an MCP tool that scopes one detector to one target, minimal per-detector fixtures, and a tiered self-test runner so Tier 1 fails fast before the 17-hour Tier 3 ever boots.

---

## 2. Boundaries

### 2.1 In scope

- Detector contract type (`DetectorContract`) enforced at TypeScript level via lockstep test
- MCP tool `bughunt_run_detector` (write-side; runs work, returns clusters)
- CLI `bughunter test-detector <kind>` for local fixture-based regression
- Tiered self-test runner: `bughunter self-test --tier <1|2|3|all>`
- Minimal fixture format under `fixtures/detector-calibration/<kind>/`
- Cluster assertion format (`expected-clusters.jsonl`)
- Migration plan in 6 phases (V56.1 through V56.6); only the first two phases ship within V56 scope
- ~30 detectors with fixtures + assertions by V56.2 close

### 2.2 Out of scope

- Replacing `bughunter run` (the batch path stays unchanged)
- Replacing existing read-side MCP tools (`bughunt_clusters`, etc.)
- Per-detector budget / cost tuning (deferred to V57)
- Multi-detector composition rules ("run X+Y to detect Z") (deferred to V58)
- Detector versioning or revision migration paths (deferred)
- Migrating all 127 BugKinds at once (phased; V56.3+ ship after V56 closes)
- New BugKinds (V56 strictly wraps existing detectors; no new detection logic)

### 2.3 External dependencies

- `@modelcontextprotocol/sdk` (already a dep) — for MCP tool registration
- Existing phase code (`packages/cli/src/phases/*`) — wrapped, not rewritten
- Existing camofox-mcp, surface-mcp adapters — used as-is
- V54 `resetCommand` mechanism — invoked when `reset: true` passed
- V55 browser-login schemas — pass through to detector executor

---

## 3. Existing code map (READ FIRST — agents over-duplicate when unfamiliar)

### 3.1 Files you MUST read before writing any V56 code

| File | Purpose for V56 |
|---|---|
| `/root/BugHunter/packages/cli/src/detectors/registry.ts` | DETECTOR_REGISTRY (~127 BugKinds). V56 ADDS a `harness` field — does NOT replace the registry. |
| `/root/BugHunter/packages/cli/src/detectors/registry.lockstep.test.ts` | Existing lockstep enforcement. V56 EXTENDS it; does NOT replace. |
| `/root/BugHunter/packages/cli/src/types.ts` (lines 29–180) | `BugKind` union. V56 imports it; never redeclares. |
| `/root/BugHunter/packages/cli/src/cli/run.ts` (`runMultiSurfacePipeline` line 1609, `runPhaseForSurface` callback) | The batch pipeline. V56 reuses phase functions; does NOT call `runCommand`. |
| `/root/BugHunter/packages/cli/src/cli/self-test.ts` | Existing self-test runner. V56 wraps it as Tier 3; adds Tier 1 + Tier 2 above it. |
| `/root/BugHunter/packages/cli/src/phases/*.ts` (validate/discover/plan/execute/classify/cluster/emit) | Phase entrypoints. V56 invokes a subset per detector based on `requires.phases`. |
| `/root/BugHunter/packages/mcp/src/server.ts` | Where new tool registers. V56 ADDS one `register*` import; does NOT change transport setup. |
| `/root/BugHunter/packages/mcp/src/tools/clusters.ts` | Reference shape for an MCP tool (Zod input schema, `toolOk`/`toolErr`, `registerXxxTool` export). |
| `/root/BugHunter/packages/mcp/src/envelope.ts` | `toolOk`, `toolErr` envelope helpers — REUSE; do NOT invent a new shape. |
| `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/bin/up.sh` | Canonical fixture-up script style (set -euo pipefail, port-conflict check, pid file). V56 mirrors this. |
| `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/reuse-manifest.json` | Reference shape for kind→fixture mapping. V56's per-detector fixtures hook in here. |
| `/root/BugHunter/SPEC_PATH_TO_EXHAUSTIVE.md` | Strategic frame for "primitive vs scanner". |
| `/root/.claude/projects/-root/memory/project_bughunter_session_resume.md` | Recall trajectory context (smoke #14 peak, current B1/B2 blockers). |

### 3.2 Patterns to follow

- **MCP tool registration:** mirror `clusters.ts` — `export function register<Name>Tool(server: McpServer): void`, Zod input schema as a const, `toolOk`/`toolErr` for envelope.
- **Fixture bin scripts:** match `bughunter-self-deliberate-bugs/bin/up.sh` — `set -euo pipefail`, `check_port_free`, `wait_for_port`, trap on INT/TERM that calls `down.sh`.
- **Type-safe error returns:** discriminated unions, never `throw` from public function boundaries unless truly unrecoverable. See `packages/cli/src/store/run-state.ts` patterns.
- **Phase callback pattern:** see `runMultiSurfacePipeline` invoking `runPhaseForSurface(boundAdapter, surfaceConfig, summary.name)` — V56's executor follows the same callback shape but calls a smaller subset of phases.

### 3.3 DO NOT

- DO NOT create a new types file for `BugKind`. Import from `packages/cli/src/types.ts`.
- DO NOT create a parallel detector registry. Extend the existing `DETECTOR_REGISTRY`.
- DO NOT bypass the V54 `resetCommand` for fixture reset. The fixture's `bin/reset.sh` SHOULD invoke it.
- DO NOT rewrite phase functions. The harness adapts them; it does not replace them.
- DO NOT create a new MCP envelope. Use `toolOk` / `toolErr` from `packages/mcp/src/envelope.ts`.
- DO NOT replace the existing self-test (`packages/cli/src/cli/self-test.ts`). It becomes Tier 3 reachable via the tiered runner.
- DO NOT use `any` to bridge phase signatures. If a phase signature is awkward for the harness, surface it in the spec — don't paper over it.
- DO NOT introduce per-kind branching as `if (kind === 'xss_reflected') { ... } else if ...`. The contract is data; branching is a smell.

---

## 4. Detector contract (the load-bearing decision)

The contract turns "detector" from an implicit concept (scattered across phases + classify + cluster) into an explicit, queryable record. Each wired BugKind has exactly one `DetectorContract` entry. The contract is enforced at TypeScript level via the existing lockstep test (V34) extended to require a contract entry per `status: 'wired'` registry row.

### 4.1 Type

```ts
// New file: packages/cli/src/detectors/contracts.ts

import type { BugKind, BugDetection, BugCluster, TestCase } from '../types.js';

/** Phases the harness will run for this detector. Must be a subset of the existing phase set. */
export type RequiredPhase =
  | 'validate'
  | 'discover'
  | 'plan'
  | 'execute'
  | 'classify'
  | 'cluster'
  | 'emit';

/** Tools the executor needs available. Used to gate execution if absent. */
export type RequiredTool = 'browser-mcp' | 'surface-mcp' | 'cdp' | 'static-analysis';

/** Surface scoping. */
export type RequiredSurface = 'web' | 'api' | 'static-source';

/** What auth shape the detector needs to do its work. */
export type RequiredRole =
  | { kind: 'none' }
  | { kind: 'any-authenticated' }
  | { kind: 'specific'; roles: string[] };

/** What page context the detector needs (parallel to RequiredSurface but at finer grain). */
export type RequiredPageContext =
  | { kind: 'any-route' }
  | { kind: 'route-pattern'; pattern: string }
  | { kind: 'specific-routes'; routes: string[] };

/** Input contract the harness checks before running. */
export type DetectorRequires = {
  phases: RequiredPhase[];
  tools: RequiredTool[];
  surface: RequiredSurface;
  role: RequiredRole;
  pageContext: RequiredPageContext;
};

/** Cluster assertion line (one entry in expected-clusters.jsonl). */
export type ClusterAssertion =
  | {
      kind: BugKind;
      expect: 'fires';
      minClusterSize: number;
      match: { page?: string; role?: string; signaturePrefix?: string };
      severity: 'critical' | 'major' | 'minor' | 'info';
    }
  | {
      kind: BugKind;
      expect: 'silent';
      reason: string;
      match?: { page?: string; role?: string };
    };

/** Fixture pointer for this detector. May be shared across N detectors. */
export type DetectorFixture = {
  /** Relative path under fixtures/detector-calibration/, e.g. "xss-mini" or shared "v21-idor-mini". */
  path: string;
  /** Which kinds this fixture serves. The harness asserts every kind appears in the fixture's
   *  expected-clusters.jsonl as either a 'fires' or 'silent' line. */
  servesKinds: BugKind[];
};

/** The contract. One per wired BugKind. Linked from DETECTOR_REGISTRY via the new `harness` field. */
export type DetectorContract = {
  kind: BugKind;
  requires: DetectorRequires;
  fixture: DetectorFixture;
  /** Default budget for a single-detector run against this fixture (ms). Tier 1 hard cap is 30_000. */
  defaultBudgetMs: number;
  /** Human-readable note (one sentence). What this detector watches for. */
  note: string;
};

/** Frozen registry of contracts. Lockstep test enforces 1:1 with `status: 'wired'` rows in DETECTOR_REGISTRY. */
export const DETECTOR_CONTRACTS: ReadonlyArray<DetectorContract> = [/* populated incrementally */];
```

### 4.2 Registry change

Add an OPTIONAL `harness` flag to `DetectorRegistryEntry` so V56 lands incrementally:

```ts
// In packages/cli/src/detectors/registry.ts
export type DetectorRegistryEntry = {
  // ... existing fields ...
  /** V56: true once a DetectorContract entry exists for this kind. Lockstep enforces this. */
  harness?: boolean;
};
```

Lockstep enforcement (extends `registry.lockstep.test.ts`):

- Every `status: 'wired'` row with `harness: true` MUST have exactly one `DetectorContract` entry. (Failure = test fail.)
- Every `DetectorContract` entry MUST correspond to a `status: 'wired'` registry row. (Failure = test fail.)
- After V56.6 closes, the optionality of `harness` is removed: every wired kind MUST have `harness: true` and a contract. The lockstep test gate-flips at that point.

### 4.3 Why a separate `DETECTOR_CONTRACTS` array (not a field on the registry entry)

- Keeps the registry shape backward-compatible during phased migration (V56.1 → V56.6).
- Decouples "this kind is wired" (registry) from "this kind has a callable harness" (contract). A kind can be wired and still lack a harness during the migration window.
- Type-safe lockstep is enforceable as static contract: `assert<typeof contract.kind extends BugKind>(...)` at compile time.

---

## 5. MCP tool: `bughunt_run_detector`

New write-side MCP tool. Lives at `packages/mcp/src/tools/run-detector.ts`. Registered in `packages/mcp/src/server.ts` alongside existing tools.

### 5.1 Input schema (Zod)

```ts
const InputSchema = z.object({
  /** One BugKind or array. Array form lets agents target a category like all V21 IDOR kinds. */
  kind: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),

  /** Where to run. */
  target: z.object({
    appBaseUrl: z.string().url(),
    surfaceMcpUrl: z.string().url().optional(),
    browserMcpUrl: z.string().url().optional(),
    /** Auth shape — mirrors V55 BrowserLogin discriminated union. */
    auth: z.union([
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('cookie'), cookie: z.string() }),
      z.object({ kind: z.literal('bearer'), token: z.string() }),
      z.object({ kind: z.literal('form'), loginUrl: z.string().url(), username: z.string(), password: z.string() }),
    ]).optional(),
  }),

  /** Optional scoping. */
  scope: z.object({
    routes: z.array(z.string().min(1)).optional(),
    roles: z.array(z.string().min(1)).optional(),
    surfaces: z.array(z.enum(['web', 'api', 'static-source'])).optional(),
    maxTests: z.number().int().min(1).max(500).optional(),
  }).optional(),

  /** Per-call budget. Hard-stop at this wallclock; no soft overrun (fixes B1 from session-resume). */
  budgetMs: z.number().int().min(1_000).max(600_000).default(60_000),

  /** If true, run the V54 resetCommand on the target before invoking. */
  reset: z.boolean().default(false),
});
```

Justification of choices:

- `kind: string | string[]` — single-kind for "did my fix take?", array for "rerun all V21 IDOR kinds." Inputs match the agent ergonomics described in the strategic frame.
- `scope.surfaces` — multi-surface case (V53). Agent can scope to web-only or api-only.
- `budgetMs` — explicit, hard-stop. The B1 blocker (web surface 107% overrun) is rooted in soft budget. V56 makes the per-call budget a hard kill.
- `reset` — explicit, off by default. Resets are expensive; only opt-in.

### 5.2 Output schema

```ts
type Output = {
  clusters: BugCluster[];                     // emitted from runCluster phase
  telemetry: {
    plannedTests: number;
    runTests: number;
    skippedTests: number;                     // sum of phase-level skips
    durationMs: number;                       // wallclock
    perDetectorElapsed: Record<string, number>;  // BugKind → ms (for the array-kind case)
    budgetExceeded: boolean;                  // true if hard-stopped
    phasesRun: RequiredPhase[];               // actual phases the harness executed
  };
  warnings: string[];                         // e.g. "kind 'jwt_weak_alg' requires browser auth but auth.kind is none — skipped"
};
```

### 5.3 Tool semantics

1. Validate `kind` against `DETECTOR_CONTRACTS`. Unknown kinds → `toolErr` with code `unknown_detector_kind`.
2. For each kind, check `requires` against `target` + `scope`:
   - If a required tool is absent (e.g. needs `browser-mcp`, no `browserMcpUrl`): warn, skip the kind.
   - If `requires.role.kind === 'specific'` and `auth` is missing/insufficient: warn, skip.
3. If `reset: true`: invoke V54 `resetCommand` via the configured surface/browser adapter. Failures → `toolErr` (cannot guarantee state).
4. Boot a minimal in-memory `RunOptions`-equivalent for the harness — NOT a full `runCommand`. The harness calls phase functions directly with a slim adapter set.
5. Run phases per `requires.phases`. Hard-stop at `budgetMs` (uses `AbortController` propagated to camofox-mcp + surface-mcp adapters).
6. Collect emitted detections, run `cluster` phase to dedupe, return clusters + telemetry.
7. NEVER persist to the run store. The harness is ephemeral. (The existing `bughunter run` is the path that persists.)

### 5.4 Errors (typed, discriminated union)

```ts
type RunDetectorError =
  | { code: 'unknown_detector_kind'; kind: string }
  | { code: 'reset_failed'; cause: string }
  | { code: 'auth_required'; missingFor: BugKind[] }
  | { code: 'tool_unavailable'; tool: RequiredTool; for: BugKind }
  | { code: 'budget_too_low'; minMs: number }
  | { code: 'internal'; message: string };
```

All errors return via `toolErr`. Warnings (non-fatal) accumulate in `output.warnings`.

---

## 6. Minimal fixture format

Lives under `fixtures/detector-calibration/<fixture-name>/`. Mirrors the existing `bughunter-self-deliberate-bugs` and V44 bench-app conventions.

### 6.1 Layout

```
fixtures/detector-calibration/
  xss-mini/
    app/                       # minimal Express OR Vite OR static — whatever the detector needs
      package.json
      server.js                # if Node app; or src/main.ts if Vite, etc.
    bin/
      up.sh                    # boots; mirrors bughunter-self-deliberate-bugs/bin/up.sh
      down.sh                  # tears down; reads .pid file
      reset.sh                 # fresh state; SHOULD invoke V54 resetCommand on the booted app
    expected-clusters.jsonl    # one ClusterAssertion per line
    contract.json              # references to BugKinds this fixture serves; redundant w/ DETECTOR_CONTRACTS but explicit
    README.md                  # what's planted, why, port, surfaces

  v21-idor-mini/               # SHARED fixture: serves multiple kinds
    ...
    expected-clusters.jsonl    # has lines for idor_horizontal, idor_horizontal_read, idor_horizontal_mutate, idor_vertical_role_escalate, idor_vertical_suspicious
```

### 6.2 `bin/up.sh` template

Mirror `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/bin/up.sh`:
- `set -euo pipefail`
- Resolve `FIXTURE_ROOT` from `BASH_SOURCE`
- `check_port_free <port>` — exit 2 if port is taken
- Start app (background), write `.pid` file
- `wait_for_port <port>` with 30 retries, 1s sleep
- Trap INT/TERM → call `down.sh`

### 6.3 `contract.json`

```json
{
  "fixture": "xss-mini",
  "serves": ["xss_reflected", "xss_dom"],
  "port": 9970,
  "boots": "node app/server.js",
  "resetCommand": { "kind": "http", "method": "POST", "path": "/__bughunter_reset" }
}
```

### 6.4 Sharing fixtures across kinds

A single fixture can serve N detectors when those detectors share an app shape. Examples:

- `v21-idor-mini`: 2 roles + 1 resource. Serves: `idor_horizontal`, `idor_horizontal_read`, `idor_horizontal_mutate`, `idor_vertical_role_escalate`, `idor_vertical_suspicious`.
- `xss-mini`: one form, one search-param-reflecting page, one DOM-sink page. Serves: `xss_reflected`, `xss_dom`.
- `i18n-mini`: one route with locale-stress targets. Serves: all `i18n_*` kinds.

The fixture's `expected-clusters.jsonl` MUST contain one or more lines per served kind (`fires` or `silent`). The harness asserts: every kind in `contract.json.serves` appears in `expected-clusters.jsonl`.

### 6.5 `expected-clusters.jsonl` format

Each line is a JSON object matching `ClusterAssertion`:

```jsonl
{"kind":"xss_reflected","expect":"fires","minClusterSize":1,"match":{"page":"/search","role":"member"},"severity":"critical"}
{"kind":"xss_dom","expect":"fires","minClusterSize":1,"match":{"page":"/profile"},"severity":"critical"}
{"kind":"xss_stored","expect":"silent","reason":"Not planted in xss-mini; lives in xss-stored fixture."}
```

### 6.6 Assertion semantics

- For each `expect: 'fires'` line, the harness must observe ≥1 cluster matching `kind` AND partial-matching `match` fields. If absent → fixture FAILS.
- For each `expect: 'silent'` line, the harness must observe 0 clusters matching `kind` + `match`. Any match → fixture FAILS.
- Unmentioned kinds: ignored (not a failure if they fire — only kinds enumerated in the fixture's `contract.json.serves` are scored).

---

## 7. Test harness CLI: `bughunter test-detector`

New CLI command. Lives at `packages/cli/src/cli/test-detector.ts`.

### 7.1 Signature

```bash
bughunter test-detector <kind|all> [--target <baseUrl>] [--verbose] [--no-up] [--keep]
```

| Flag | Effect |
|---|---|
| `<kind>` | A specific BugKind, OR the literal string `all`. Required. |
| `--target <baseUrl>` | Skip booting the bundled fixture; run against this URL instead. Useful when the fixture is already up. |
| `--verbose` | Stream per-test telemetry to stdout. |
| `--no-up` | Assume the fixture is already running on its declared port. |
| `--keep` | After the run, leave the fixture up (skip `down.sh`). |

### 7.2 Behavior

1. Resolve the contract for `<kind>` (or list all contracts if `all`).
2. For each unique fixture (deduplicated when sharing): run `bin/up.sh` (unless `--no-up`).
3. Construct the `bughunt_run_detector` input from the contract's `requires` and the fixture's `contract.json`.
4. Invoke the harness in-process (not over MCP — the CLI is the same package).
5. Compare emitted clusters to `expected-clusters.jsonl`. Print PASS / FAIL per kind. On FAIL, print the diff (`expected fires X@/foo, observed silent` or `expected silent X, observed fires X@/foo`).
6. Run `bin/down.sh` (unless `--keep`).
7. Exit 0 if all PASS; exit 1 if any FAIL; exit 2 on infrastructure errors.

### 7.3 Output (machine-readable)

When invoked with `--json`, emit:

```ts
type TestDetectorOutput = {
  passed: boolean;
  results: Array<{
    kind: BugKind;
    fixture: string;
    status: 'PASS' | 'FAIL' | 'SKIPPED';
    elapsedMs: number;
    diff?: { expected: ClusterAssertion[]; observed: BugCluster[] };
  }>;
};
```

---

## 8. Tiered self-test runner

Replaces the entrypoint of `bughunter self-test` with a tier dispatcher. The existing self-test runner (`packages/cli/src/cli/self-test.ts`) becomes Tier 3.

### 8.1 CLI

```bash
bughunter self-test --tier <1|2|3|all> [--bail] [--json]
```

### 8.2 Tier definitions

| Tier | What runs | Latency target | Parallelizable | Failure gate |
|---|---|---|---|---|
| 1 | All `bughunter test-detector <k>` runs, one per fixture in `fixtures/detector-calibration/` | <5 min for 30 fixtures | Yes (fixture-port-disjoint) | Tier 1 fail → Tier 2/3 do NOT run |
| 2 | Phase-level smoke: 6 micro-tests against ONE shared minimal fixture (validate, discover, plan, execute, classify, emit) | <2 min | Sequential | Tier 2 fail → Tier 3 does NOT run |
| 3 | Existing comprehensive-bench self-test (V54) — the 17-hour scan | up to 17h | No | — |
| `all` | 1 → 2 → 3 with gating | sum | — | — |

### 8.3 Tier 2 phase smoke

Tier 2 takes a single fixture (`fixtures/detector-calibration/_phase-smoke/`) wired to exercise each phase end-to-end. Each phase emits a deterministic marker; the test asserts the marker appeared. If `runDiscover` skipped a route silently, Tier 2 catches it before Tier 3 ever boots.

This directly addresses the smoke #18/#19/#20 regression mode where API runs but is unauthenticated, or cookies are obtained but not propagated — Tier 2 would have surfaced both within minutes.

### 8.4 Parallelism

Tier 1 fixture ports are disjoint (declared in each fixture's `contract.json`). The runner uses `p-limit` (or equivalent already present) at `min(8, fixtureCount)`. Each fixture's `bin/up.sh` already does port-conflict detection, so port collisions surface as a fixture-level FAIL, not a runner crash.

### 8.5 Backwards compatibility

`bughunter self-test` (no `--tier` flag) behaves as Tier 3 (the existing comprehensive-bench run). Adding the flag gradually adopts the tiered runner without breaking existing CI invocations.

---

## 9. Migration plan (phased; only V56.1+V56.2 ship within V56)

Each phase shippable independently. Lockstep gate flips at V56.6.

| Phase | Scope | Detectors | Coders | Done when |
|---|---|---|---|---|
| **V56.1** | Harness infra: `DetectorContract` type, lockstep extension, MCP tool, CLI, tier runner, fixture format | 0 (infra only) | 1–2 | All harness pieces compile; lockstep optional; existing self-test still passes as Tier 3 |
| **V56.2** | First 10 high-value detectors | xss_reflected, xss_dom, sql_injection, command_injection, path_traversal, missing_csp_header, sensitive_data_in_url, hardcoded_credentials_in_source, vulnerable_dependency_high, auth_bypass_via_unauthed_route | 5 (parallel; one per 2 fixtures) | All 10 fixtures + assertions; `bughunter test-detector --all` PASS in <5 min |
| V56.3 | 20 perf + a11y detectors | slow_lcp, high_cls, slow_inp, unbounded_list_render, n_plus_one_api_calls, request_dedup_missing, request_cancellation_missing, main_thread_blocked, oversized_bundle, excessive_re_renders, axe_color_contrast_strong, keyboard_trap, focus_lost_after_action, image_missing_alt, form_input_unlabeled, interactive_element_missing_accessible_name, memory_leak_suspected, memory_leak_attributed, hydration_mismatch, accessibility_critical | 5 | All 30 fixtures (cumulative) PASS in <8 min |
| V56.4 | 20 nav + browser-platform + i18n | nav_state_corruption, nav_resubmit_on_back, nav_refresh_double_mutation, nav_form_state_lost, nav_form_state_stale, service_worker_stale, web_worker_error, iframe_postmessage_unguarded, shadow_dom_a11y_violation, permission_denied_unhandled, subresource_integrity_violation, coop_coep_violation, trusted_types_violation, i18n_currency_format_broken, i18n_date_format_ambiguous, i18n_long_string_overflow, i18n_pluralization_broken, i18n_rtl_layout_break, i18n_timezone_display_wrong, hallucinated_route | 5 | 50 fixtures cumulative |
| V56.5 | data-integrity + clock + race + multi-context | clock_*, race_condition_*, data_integrity_*, money_math_precision, cache_staleness, idempotency_key_violation, audit_log_missing_for_mutation, soft_delete_consistency, multi_user_inconsistent_snapshot, multi_context_state_divergence, visibility_change_state_loss | 5 | 70+ fixtures cumulative |
| V56.6 | Lockstep flip — `harness: true` is REQUIRED for all `status: 'wired'` rows | remaining ~50 detectors | 5 | Lockstep test fails CI if any wired kind lacks a contract |

V56 closes after V56.2. V56.3+ are tracked as separate ticket-rollups (still under the V56 umbrella) and do not block any other spec.

---

## 10. Acceptance criteria

V56 is done when ALL of the following hold:

1. **MCP tool exists.** `POST /mcp` with `bughunt_run_detector` returns clusters for a known kind. Cold-call latency <60s on `xss-mini` fixture.
2. **30 detectors have minimal fixtures + assertions.** V56.1+V56.2 detectors all pass `bughunter test-detector <kind>` against their fixtures.
3. **Tier 1 self-test runs in <5 min** for the 30 fixtures on a single 8-core machine.
4. **Existing comprehensive-bench self-test continues unchanged.** `bughunter self-test --tier 3` (or bare `bughunter self-test` for back-compat) produces identical output to today's run on the same fixture.
5. **Lockstep test extended.** `registry.lockstep.test.ts` enforces 1:1 between `DETECTOR_CONTRACTS` entries and `harness: true` registry rows.
6. **README documents per-detector MCP.** `/root/BugHunter/README.md` has a "Per-detector MCP" section with 3+ examples (single-kind, multi-kind, scoped-to-route).
7. **Hard-budget enforcement.** `bughunt_run_detector` with `budgetMs: 30000` against a fixture that would naturally take 60s returns within 31s with `telemetry.budgetExceeded: true`. (Direct fix for B1.)
8. **Auth propagation verified end-to-end.** A fixture with cookie auth + a kind requiring auth (e.g. `idor_horizontal`) demonstrates `Cookie:` header on outbound requests via the harness's action log. (Direct fix for B2.)
9. **No regression in existing tools.** All existing MCP tools (`bughunt_clusters`, `bughunt_cluster_detail`, etc.) continue to pass their tests.

---

## 11. Migration / backwards compatibility

- `bughunter run` batch path: unchanged. Same flags, same output, same store layout.
- Existing read-side MCP tools: unchanged. `bughunt_clusters`, `bughunt_cluster_detail`, `bughunt_runs_list`, `bughunt_diff`, etc. continue to work against historical run output.
- Existing `bughunter self-test` (no `--tier`): aliases to `--tier 3` for back-compat.
- DETECTOR_REGISTRY: gains an OPTIONAL `harness: boolean` field. Existing entries are unaffected; new lockstep checks only fire when `harness: true`.
- Internal regression net (V56.1+) replaces the existing self-test gradually. The existing self-test is Tier 3; nothing about it changes structurally.

---

## 12. Test strategy

| Layer | What's tested | Where |
|---|---|---|
| Unit | `DetectorContract` shape; `ClusterAssertion` parsing; assertion-matcher; budget hard-stop logic | `packages/cli/src/detectors/contracts.test.ts` |
| Unit | MCP tool input schema validation (Zod) | `packages/mcp/src/tools/run-detector.test.ts` |
| Unit | Tier runner gating logic (Tier 1 fail blocks Tier 2) | `packages/cli/src/cli/self-test-tiered.test.ts` |
| Lockstep | `DETECTOR_CONTRACTS` ↔ `DETECTOR_REGISTRY[harness:true]` 1:1 | `packages/cli/src/detectors/registry.lockstep.test.ts` (extended) |
| Integration | Each per-detector fixture + harness produces expected clusters | `packages/cli/src/cli/test-detector.test.ts` (parameterized over fixtures) |
| Integration | `bughunt_run_detector` MCP call end-to-end against `xss-mini` | `packages/mcp/src/tools/run-detector.integration.test.ts` |
| Smoke (CI) | `bughunter self-test --tier 1` runs cleanly | CI workflow `.github/workflows/tier1.yml` |
| Smoke (CI nightly) | `bughunter self-test --tier 3` continues passing | existing nightly workflow |

Per the project guidance: write tests alongside implementation, run them after writing, do not submit unrun tests.

---

## 13. Failure modes / explicit non-goals

### 13.1 Out of scope (deferred)

- **V57:** per-detector budget calibration — defaults are educated guesses in V56; tuning happens after we have telemetry from V56.2+ runs in CI.
- **V58:** multi-detector composition rules — e.g. "run detector X then Y to detect compound bug Z." V56 is strictly single-kind invocations (or array-of-singles).
- **Detector versioning:** if we change `xss_reflected`'s detection logic in v0.50, we don't migrate fixtures gracefully. Out of scope; revisit if it becomes a problem.

### 13.2 Known failure modes V56 does not solve

- **Fixture rot:** real apps drift from fixture shape. Mitigation: fixtures are minimal (one-page Express apps), so churn is bounded.
- **Detector logic depending on production data:** static-analysis kinds (e.g. `vulnerable_dependency_high`) rely on the target's `package.json`. Fixture has its own. Acceptable.
- **Cross-kind interaction:** if two kinds in an array-call collide (e.g. one mutates state, the next reads it), behavior is undefined. V56 documents this and defers to V58.
- **Hard-stop side effects:** killing a phase mid-execute may leave the target in an inconsistent state. The fixture's `bin/reset.sh` is the recovery path. Caller must invoke `reset: true` on the next call.

---

## 14. Strategic implications

V56 changes BugHunter's category. Today it's a security-scanner-with-an-MCP. After V56 it's a callable bug-hunting toolkit — every detector becomes a primitive that other agents (SurfaceMCP, ClaudeMCP, Aspect's CI pipeline, future code-review bots) consume mid-task. The 17-hour comprehensive scan stays as the safety net; the targeted MCP call becomes the daily driver during development. This is the difference between "I run BugHunter on Friday night and read the report Monday" and "I just changed CSP — let me ask BugHunter if it broke something."

Operationally, V56 also fixes the recall trajectory's root cause. The smoke-#14-to-#20 regression was invisible at the run level because the failure attributed to "recall went down" without telling us which subsystem failed. Tier 1 + per-detector fixtures turn that into "the auth-propagation fixture failed" — minutes-to-attribute, not days.

---

## 15. Task breakdown (agent-sized, parallel-safe)

Sized per "agent-sized = ~30 min human equivalent", max 3 files per task, independently testable. Each task has explicit READ-FIRST file list and DO-NOT prohibitions per the spec-writing rules.

### V56.1 — Infra (sequential blockers)

| # | Title | Assignee | Deps | Files | Test command | Done when |
|---|---|---|---|---|---|---|
| 1.1 | Add `DetectorContract` types | @coder | — | `packages/cli/src/detectors/contracts.ts` (new), `packages/cli/src/detectors/contracts.test.ts` (new) | `npx vitest run contracts.test.ts` | Types compile; ≥3 unit tests for `ClusterAssertion` parsing pass |
| 1.2 | Add `harness?: boolean` to registry entry; extend lockstep | @coder | 1.1 | `packages/cli/src/detectors/registry.ts` (modify), `packages/cli/src/detectors/registry.lockstep.test.ts` (modify) | `npx vitest run registry.lockstep.test.ts` | Lockstep passes with 0 contracts (harness optional); fails if a contract has no registry entry |
| 1.3 | Fixture format scaffolding (`_phase-smoke` + template `up.sh`/`down.sh`/`reset.sh` + `contract.json` schema) | @coder | 1.1 | `fixtures/detector-calibration/_phase-smoke/` (new tree), `fixtures/detector-calibration/_template/` (new tree) | `bash fixtures/detector-calibration/_phase-smoke/bin/up.sh && curl localhost:<port> && bash bin/down.sh` | Up boots, port responds, down cleans pid; tree mirrors `bughunter-self-deliberate-bugs/bin/up.sh` style |
| 1.4 | MCP tool `bughunt_run_detector` skeleton (Zod schema + envelope + skip when no contracts) | @coder | 1.1 | `packages/mcp/src/tools/run-detector.ts` (new), `packages/mcp/src/tools/run-detector.test.ts` (new), `packages/mcp/src/server.ts` (1-line register call) | `npx vitest run run-detector.test.ts` | Tool registers; returns `toolErr unknown_detector_kind` for any kind (since no contracts yet) |
| 1.5 | Harness executor (per-phase invoker with hard budget abort) | @coder | 1.1, 1.4 | `packages/cli/src/harness/executor.ts` (new), `packages/cli/src/harness/executor.test.ts` (new) | `npx vitest run executor.test.ts` | AbortController fires at `budgetMs`; phase calls return `{ aborted: true }`; no leaked timers |
| 1.6 | CLI `bughunter test-detector` skeleton | @coder | 1.5 | `packages/cli/src/cli/test-detector.ts` (new), `packages/cli/src/cli/test-detector.test.ts` (new), `packages/cli/src/cli.ts` (modify; register subcommand) | `npx vitest run test-detector.test.ts` | `bughunter test-detector --help` lists flags; `bughunter test-detector unknown_kind` exits 1 with clear error |
| 1.7 | Tiered self-test runner | @coder | 1.6 | `packages/cli/src/cli/self-test-tiered.ts` (new), `packages/cli/src/cli/self-test-tiered.test.ts` (new), `packages/cli/src/cli/self-test.ts` (modify entrypoint dispatch) | `npx vitest run self-test-tiered.test.ts` | `--tier 3` matches existing self-test output; `--tier 1` runs cleanly with 0 fixtures (no-op pass) |
| 1.8 | README per-detector section + 3 examples | @coder | 1.4 | `README.md` (modify) | manual review | Section exists with single-kind, multi-kind, scoped-to-route examples |

### V56.2 — First 10 detectors (parallelizable; 5 coders × 2 fixtures each)

| # | Title | Assignee | Files | Test |
|---|---|---|---|---|
| 2.1 | xss-mini fixture + contract for xss_reflected, xss_dom | @coder-A | `fixtures/detector-calibration/xss-mini/` + add 2 entries to `DETECTOR_CONTRACTS` + flip `harness: true` on 2 registry rows | `bughunter test-detector xss_reflected` PASS |
| 2.2 | sqli-mini fixture + contract for sql_injection | @coder-A | `fixtures/detector-calibration/sqli-mini/` + 1 contract entry | `bughunter test-detector sql_injection` PASS |
| 2.3 | command-injection-mini fixture + contract | @coder-B | `fixtures/detector-calibration/command-injection-mini/` + 1 contract entry | `bughunter test-detector command_injection` PASS |
| 2.4 | path-traversal-mini fixture + contract | @coder-B | `fixtures/detector-calibration/path-traversal-mini/` + 1 contract entry | `bughunter test-detector path_traversal` PASS |
| 2.5 | csp-mini fixture + contract for missing_csp_header | @coder-C | `fixtures/detector-calibration/csp-mini/` + 1 contract entry | `bughunter test-detector missing_csp_header` PASS |
| 2.6 | sensitive-data-url-mini fixture + contract | @coder-C | `fixtures/detector-calibration/sensitive-data-url-mini/` + 1 contract entry | `bughunter test-detector sensitive_data_in_url` PASS |
| 2.7 | hardcoded-creds-mini fixture (static-analysis surface) + contract | @coder-D | `fixtures/detector-calibration/hardcoded-creds-mini/` + 1 contract entry | `bughunter test-detector hardcoded_credentials_in_source` PASS |
| 2.8 | vuln-dep-mini fixture (static-analysis surface) + contract | @coder-D | `fixtures/detector-calibration/vuln-dep-mini/` + 1 contract entry | `bughunter test-detector vulnerable_dependency_high` PASS |
| 2.9 | auth-bypass-mini fixture + contract for auth_bypass_via_unauthed_route | @coder-E | `fixtures/detector-calibration/auth-bypass-mini/` + 1 contract entry | `bughunter test-detector auth_bypass_via_unauthed_route` PASS |
| 2.10 | Tier 1 wiring: extend `self-test-tiered.ts` to enumerate `fixtures/detector-calibration/*/contract.json` | @coder-E | `packages/cli/src/cli/self-test-tiered.ts` (modify) | `bughunter self-test --tier 1` PASS in <5min |

Each V56.2 task touches at most: 1 fixture tree + 1 line in `DETECTOR_CONTRACTS` + 1 field flip in `DETECTOR_REGISTRY` + 0 phase code. Fully parallel-safe (port-disjoint, file-disjoint).

---

## 16. Resolved decisions (Brad, 2026-05-04)

1. **V56.6 lockstep gate-flip:** Single PR for the remaining ~50 contracts. **However**, V56.6 acceptance criteria MUST include explicit per-contract correctness verification — not just "lockstep test passes." Each newly-added contract requires the reviewer to confirm its `requires` block, fixture pointer, and expected-cluster shape match what the detector actually produces. Add a checklist to the V56.6 PR template.

2. **Tier 2 fixture:** `fixtures/detector-calibration/_phase-smoke/` is the canonical location. Underscore-prefix marks it as a meta-fixture (not a detector fixture).

3. **Persistence:** MCP-emitted clusters from `bughunt_run_detector` ARE persisted to the run store, but tagged with `runMode: 'detector-call'` (vs the existing `runMode: 'full-scan'`). This makes them queryable via `bughunt_clusters` and `bughunt_runs_list` while keeping them distinguishable from full-scan runs in the consumer's history. Update the run-store schema in V56.1 to include `runMode` on every run record.

4. **Hard-budget mechanism:** Ship V56 with `AbortController` propagation. Bump camofox-mcp to enforce `AbortSignal` compliance and add a runtime check at MCP-tool startup that warns if any registered adapter doesn't honor signals. **TODO (file as separate spec, V57+):** comprehensive adapter audit + behavior-test suite for signal compliance across all current and future adapters. Acceptable to ship V56 with this audit deferred.

All four resolved. V56.1 is unblocked.
