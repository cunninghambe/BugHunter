# SPEC — v0.34 "Per-run coverage report"

**Status:** Draft 1 — ready for `@coder` assignment after V26 lands · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** V26 (`DETECTOR_REGISTRY` + per-kind metadata at `packages/cli/src/detectors/registry.ts`). Sibling: V30 (read-side MCP parity), V32 (severity calibration). Phase: C (trust) of `SPEC_PATH_TO_EXHAUSTIVE.md` §9.

This spec adds a single artifact, `coverage.json`, written next to `bugs.jsonl` and `summary.json` on every run. For every declared `BugKind`, the file states whether the detector is wired (V26 registry), whether the input the detector consumes was observed during the run, how many clusters fired, and a derived four-state status. A new CLI command `bughunter coverage <runId>` formats the report; an MCP tool `bughunt_coverage` provides V30 read-side parity. The user-visible promise: when somebody asks "why didn't BugHunter flag X," the answer is mechanical, not anecdotal.

---

## 1. Objective

Emit `coverage.json` next to existing per-run artifacts (`bugs.jsonl`, `summary.json`, `infra.jsonl`). For every `BugKind` in the union, classify it into one of four states:

| status | Meaning | User action |
|---|---|---|
| `fired` | Detector wired, input observed, ≥1 cluster minted | none — kind is healthy |
| `input-absent` | Detector wired, but no input ever reached classify (e.g. `excessive_re_renders` requires React render events; if perf was disabled or the SPA isn't React, the detector never sees data) | enable the input source (perf, vision, a11y, dom-error-script, …) or accept the absence |
| `detector-dead` | Detector listed in registry but `wired === false` (V26 marks it stub/TODO) | open a BugHunter issue — this is a BugHunter bug |
| `detector-deferred` | Detector is intentionally unimplemented in the current release (e.g. `xss_stored` placeholder, `idor_vertical_role_escalate` deferred) | none — advertised gap, link to the spec that will fix it |

**In scope:**
- `coverage.json` schema + emit hook in the existing emit phase.
- Per-kind status derivation algorithm consumed exclusively by the emit phase (no detector-side rewrites).
- `bughunter coverage <runId>` CLI command — pretty-prints the four buckets, exit code is informational only.
- `bughunt_coverage` MCP tool — same payload as the CLI, JSON only.
- Documentation update in `README.md` describing how to interpret the four statuses.

**Out of scope (deferred):**
- Cross-run coverage history (Phase D — needs `bugIdentity` + history DB).
- Per-route coverage breakdown (a route may have collected perf input; the run as a whole still satisfies "input observed"). Defer to V35 if real demand surfaces.
- Severity weighting of coverage (V32 owns severity).
- Suggesting fixes for `input-absent` (e.g. "add `perf: { enabled: true }` to your config") — V35 once we have a settled diagnostic story.
- Coverage as a CI gate (no `--fail-on-detector-dead` flag; coverage is reported, not enforced).
- Counting **cluster-suppressed** kinds as fired vs not-fired (suppression is a triage state, not a detector state — V31 owns suppression).

**Acceptance target (Aspectv3):**
After running `bughunter run`, `coverage.json` exists alongside `summary.json`, every kind in `BugKind` appears exactly once in `byKind`, and the bucket counts in `summary` add up to the total kind count.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/detectors/registry.ts` (V26) | Source of truth for `detectorWired` and `detectorDeferred`. Import `DETECTOR_REGISTRY` and `DetectorMetadata`. **Do not duplicate** the registry. |
| `packages/cli/src/types.ts` (lines 23-97) | Single canonical `BugKind` union. Any new coverage code derives the kind list from here, not from a hard-coded array. |
| `packages/cli/src/phases/emit.ts` | The only place `summary.json` and `bugs.jsonl` are written today. Add `coverage.json` here, after `writeJsonFile(paths.summaryFile, …)`. |
| `packages/cli/src/store/filesystem.ts` | `runPaths` returns `{ bugsFile, summaryFile, infraFile }`. Extend to add `coverageFile`. **Do not** invent a parallel path-builder. |
| `packages/cli/src/types.ts` (line 859: `RunState`) | `RunState.discovery`, `runState.testResults`, perf telemetry, vision telemetry — these tell the emit phase whether each input source was observed. |
| `packages/cli/src/cli/main.ts` | CLI command registration. Add `coverage` next to `replay`/`status`/`list`. |
| `packages/cli/src/cli/list.ts` | The closest existing read-side CLI command. Mirror its shape: take a `runId` (or `--latest`), read JSON from disk, format to stdout. |
| `packages/mcp/src/tools.ts` | Add `bughunt_coverage` next to `bughunt_latest_bugs`. Follow the existing `toolOk/toolErr` pattern. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | This spec's section/format reference. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §6.4 | Strategic context for what coverage is for. |

### 2.2 Patterns to follow

- **Single source of truth.** `coverage.json` is computed entirely from `(BugKind union, DETECTOR_REGISTRY, RunState, clusters)`. No new state, no detector-side reporting.
- **Discriminated `status` enum.** Use a literal-string union for `status` (`'fired' | 'input-absent' | 'detector-dead' | 'detector-deferred'`); avoid booleans. Force exhaustiveness via `assertNever` in the formatter.
- **JSON shape stability.** Treat `coverage.json` as a public contract from day one — the MCP tool returns it verbatim. Version the file as `version: 1` so future changes are signalled.
- **Pretty-print pattern.** Mirror `cli/list.ts`: header line, four sections (one per status), kind names in stable alphabetical order within each section.
- **MCP tool shape.** Mirror `bughunt_latest_bugs`: zod input schema, synchronous file read, return `toolOk(coverage)`. No long-poll, no job model.
- **Exhaustive kind iteration.** `Object.keys(DETECTOR_REGISTRY)` is the single iteration source; the `BugKind` union is verified to match the registry by a TS-level test (V26 already enforces this; this spec relies on it).

### 2.3 DO NOT

- Do **not** create a new directory for coverage. Add `coverage.ts` to `packages/cli/src/phases/` next to `emit.ts`.
- Do **not** re-implement the `BugKind` union or duplicate kind names in coverage code. Import from `types.ts`.
- Do **not** change the `BugKind` union, `BugCluster` shape, or `summary.json` shape. Coverage is additive.
- Do **not** include coverage data inside `summary.json`. Separate file. `summary.json` stays bug-counts-only.
- Do **not** infer "input observed" from cluster presence — that conflates "fired" and "input-absent." Use `RunState` telemetry directly.
- Do **not** make `bughunter coverage` mutate state — read-only by contract.
- Do **not** add a fail-on-coverage CI flag. V32 owns severity-driven gating; coverage is informational.
- Do **not** include suppressed clusters in the `clustersEmitted` count (V31 hasn't shipped, but if a cluster is `verdict === 'suppressed'`, it still fired a detector; count it as fired).
- Do **not** add a new MCP tool surface (i.e. no `coverage_full`, `coverage_summary`). One tool, one payload.

---

## 3. Schema — `coverage.json`

Written to `<projectDir>/.bughunter/runs/<runId>/coverage.json` immediately after `summary.json` in `runEmit`. Stable, additive shape.

```ts
// packages/cli/src/phases/coverage.ts
export type CoverageStatus =
  | 'fired'              // detector wired, input observed, ≥1 cluster
  | 'input-absent'       // detector wired, no input observed for this kind
  | 'detector-dead'      // wired=false in DETECTOR_REGISTRY (BugHunter bug)
  | 'detector-deferred'; // explicitly deferred to a future release

export type CoverageEntry = {
  detectorWired: boolean;       // from DETECTOR_REGISTRY[kind].wired
  inputObserved: boolean;       // from per-kind input predicate (§4)
  clustersEmitted: number;      // ≥0
  status: CoverageStatus;
  /** When status is 'detector-deferred', the spec ID that owns the gap. */
  deferredTo?: string;          // e.g. 'V08' for memory_leak_attributed
  /** Free-form, ≤120 chars. Surfaces as "why is this status?" tooltip. */
  reason?: string;
};

export type Coverage = {
  version: 1;
  runId: string;
  generatedAt: string;          // ISO timestamp, matches summary.json semantics
  byKind: Record<BugKind, CoverageEntry>;
  summary: {
    kindsTotal: number;                   // |BugKind|
    kindsWiredAndFired: number;           // status === 'fired'
    kindsWiredButInputAbsent: number;     // status === 'input-absent'
    kindsDead: number;                    // status === 'detector-dead'
    kindsDeferred: number;                // status === 'detector-deferred'
  };
};
```

Invariant: `summary.kindsTotal === sum(four bucket counts) === |BugKind|`. The emit phase enforces this with an `assert(...)` at write time; if it ever fails, that's a BugHunter bug (registry drifted from union).

---

## 4. Per-kind status derivation algorithm

Pseudocode that the emit phase runs once per kind. Order matters — the first matching predicate wins.

```ts
function deriveStatus(
  kind: BugKind,
  meta: DetectorMetadata,            // DETECTOR_REGISTRY[kind] — V26
  inputObserved: boolean,            // §4.2 input predicates
  clustersEmitted: number,
): CoverageStatus {
  // 1. Registry says detector is intentionally unimplemented.
  if (meta.deferred === true) return 'detector-deferred';

  // 2. Registry says detector was supposed to be wired but isn't (BugHunter bug).
  if (meta.wired === false) return 'detector-dead';

  // 3. Detector is wired AND fired ≥1 cluster.
  //    NB: clusters > 0 implies input was observed; we don't double-check.
  if (clustersEmitted > 0) return 'fired';

  // 4. Detector wired, no clusters, no input — the SPA didn't exhibit the conditions
  //    the detector consumes (e.g. perf disabled, no React, no DOM error script ran).
  if (!inputObserved) return 'input-absent';

  // 5. Detector wired, input observed, no clusters → also 'fired' bucket?
  //    No — this means the detector saw inputs and chose not to mint clusters
  //    (i.e. the SPA was clean for this kind). That's still "fired" semantically:
  //    detector ran, evaluated inputs, returned zero findings.
  return 'fired';
}
```

### 4.1 Why "input observed but zero clusters" is `fired`, not `input-absent`

The user question coverage answers is "did the detector get a chance to run, or not?" Detector ran on real data and emitted no clusters means the app is clean for that kind — the detector did its job. `input-absent` is reserved for "detector never even saw data," which is a configuration / data-collection problem, not a clean-bill-of-health.

### 4.2 Per-kind input predicates (`inputObserved`)

Each kind declares which `RunState` field gates "input observed." Stored alongside the registry in V26 (one field per kind: `inputSource: InputSource`). The emit phase walks the registry, calls the predicate per kind, and caches the result. Six input-source families cover the entire `BugKind` union (V26 enumerates them; V34 just consumes):

| `inputSource` | Predicate (sketch — V26 owns the precise check) | Kinds it gates |
|---|---|---|
| `console-and-runtime` | `runState.testResults?.some(t => t.preState !== undefined)` — every test produces a pre/post console error count | `console_error`, `react_error`, `unhandled_exception`, `dom_error_text`, `404_for_linked_route`, `network_5xx`, `network_4xx_unexpected`, `missing_state_change`, `surface_call_failed`, `hallucinated_route` |
| `perf` | `runState.config.perf?.enabled !== false && counters.perfSummary !== undefined` | `slow_lcp`, `slow_inp`, `high_cls`, `unbounded_list_render`, `n_plus_one_api_calls`, `request_dedup_missing`, `request_cancellation_missing`, `main_thread_blocked`, `oversized_bundle`, `excessive_re_renders`, `memory_leak_suspected`, `memory_leak_attributed` |
| `a11y` | `runState.config.a11y?.enabled === true` (axe-core injection ran on at least one page) | `axe_color_contrast_strong`, `keyboard_trap`, `focus_lost_after_action`, `image_missing_alt`, `form_input_unlabeled`, `interactive_element_missing_accessible_name`, `accessibility_critical` |
| `seo` | `runState.config.seo?.enabled === true` | `seo_title_missing`, `seo_title_duplicate_across_routes`, `seo_meta_description_missing`, `seo_canonical_missing`, `seo_h1_missing_or_multiple`, `seo_robots_blocking_crawl` |
| `security-static` | `runState.config.staticAnalysis?.enabled !== false` and at least one source file matched the project glob | `vulnerable_dependency_high`, `hardcoded_credentials_in_source`, `swallowed_error_empty_catch`, `stack_trace_leak_in_response`, `sensitive_data_in_url` |
| `security-dynamic` | A test was planned with `palette: 'security'` (i.e. probe + pen-test palettes ran) | `xss_reflected`, `xss_dom`, `csrf_missing_on_mutating_route`, `missing_csp_header`, `permissive_cors`, `cookie_security_flags`, `open_redirect`, `idor_horizontal`, `idor_vertical_role_escalate`, `auth_bypass_via_unauthed_route`, `no_rate_limit_on_login`, `auth_session_fixation`, `password_reset_token_reuse`, `sql_injection`, `command_injection`, `path_traversal`, `jwt_weak_alg` |
| `vision` | `counters.vision !== undefined && counters.vision.called > 0` | `visual_anomaly` |
| `race` | `counters.raceConditions !== undefined` | `race_condition_double_submit`, `race_condition_click_navigate`, `race_condition_optimistic_revert`, `race_condition_interleaved_mutations`, `race_condition_cross_tab` |

All predicates compose into `inputObservedByKind: Record<BugKind, boolean>`, computed once at the start of `runEmit`.

---

## 5. CLI command — `bughunter coverage <runId>`

### 5.1 Syntax

```
bughunter coverage <runId>          # named run
bughunter coverage --latest         # most recent run
bughunter coverage <runId> --json   # machine-readable; emits coverage.json verbatim
bughunter coverage <runId> --dead   # only the detector-dead bucket
bughunter coverage <runId> --kind slow_lcp  # one row, full detail
```

Implementation lives at `packages/cli/src/cli/coverage.ts`, registered alongside `replay` / `status` in `cli/main.ts`.

### 5.2 Output (default, pretty-printed)

```
=== Coverage for run <runId> ===
Total kinds:    87
Fired:          22  (detector wired, input observed)
Input absent:   41  (detector wired, no input — opt-in subsystem off, or SPA didn't exhibit input)
Detector dead:   2  (BugHunter bug — please file an issue)
Deferred:       22  (advertised gap, see deferredTo column)

Detector dead (2):
  excessive_re_renders     — wired=false in registry  (file BugHunter issue)
  memory_leak_suspected    — wired=false in registry  (file BugHunter issue)

Deferred (22):
  xss_stored               → V08 (stored XSS via persisted DOM-text checks)
  idor_vertical_role_escalate → V07 (cross-role IDOR replay)
  ...

Input absent (41) — pass --verbose to list:
  perf:      12 kinds   (enable: pass --perf to bughunter run)
  vision:     1 kind    (enable: configure VISION_API_KEY)
  ...

Fired (22) — pass --verbose to list with cluster counts.
```

`--verbose` lists every kind in every bucket. `--json` emits the entire `coverage.json` file unchanged so it can be piped into `jq`.

### 5.3 Exit code

- `0` always (coverage is informational, not a gate).
- An error on read (missing file, malformed JSON) emits `code: 'coverage_unavailable'` to stderr and exits `1`.

---

## 6. MCP tool — `bughunt_coverage`

### 6.1 Signature

```ts
server.tool(
  'bughunt_coverage',
  'Get the per-detector coverage report for a BugHunter run. Returns the contents of coverage.json verbatim.',
  {
    project: z.string().min(1).describe('Path to the project directory'),
    runId: z.string().min(1).optional().describe('Specific runId; omit for the most recent run.'),
  },
  async (args) => {
    try {
      const runIds = listRunIds(args.project).sort().reverse();
      const runId = args.runId ?? runIds[0];
      if (runId === undefined) return toolErr('no_runs', 'No BugHunter runs found for project');
      const filePath = `${args.project}/.bughunter/runs/${runId}/coverage.json`;
      if (!fs.existsSync(filePath)) {
        return toolErr('coverage_unavailable', `coverage.json missing for run ${runId} (run predates V34)`);
      }
      const coverage = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return toolOk(coverage);
    } catch (e) { return toolErr('error', String(e)); }
  }
);
```

### 6.2 Why a single tool, not three (full / summary / by-kind)

The full coverage payload is bounded by the `BugKind` count (≤ ~150 entries forever — we will not exceed this). One JSON blob ≤ 30KB. The MCP client filters / paginates its own way. No need for tool-side variants.

---

## 7. Edge cases

### EC-1. `BugKind` not in `DETECTOR_REGISTRY`
V26 enforces a TS-level check that the registry covers every union member. If the build is somehow broken and a kind is missing, `runEmit` fails fast with `coverage_registry_drift` infra failure — the run is otherwise preserved (`summary.json` and `bugs.jsonl` are written before coverage). No partial `coverage.json`.

### EC-2. Kind in `DETECTOR_REGISTRY` not in `BugKind`
Same fast-fail. V26's TS-level check is bidirectional — orphans on either side are compile errors.

### EC-3. Partial perf — vitals collected but long-tasks failed
Input source `perf` is binary by design (the whole subsystem is wired or it isn't). Per-kind partial input is V35's problem; V34 reports the subsystem as "input observed" if any perf data exists. `clustersEmitted === 0` for `main_thread_blocked` then resolves as `fired` (clean) rather than `input-absent`. Acceptable for v0.34; flag if calibration shows false-clean bills.

### EC-4. Opt-in-only kind never enabled
Example: `vision` requires `VISION_API_KEY`. If it's not set, every `visual_anomaly` row in `byKind` reports `inputObserved: false`, status `input-absent`. The pretty-printer hints at the enable mechanism. Not a bug.

### EC-5. Run aborted mid-execute (infra-fail-fast)
`runEmit` is still called for partial runs (this was a v0.5 invariant). In that case, perf telemetry may exist but be partial; vision may have been called once before abort. We compute coverage on whatever inputs were observed up to abort. The `coverage.json` file exists; its `summary` reflects the partial run. Document in the CLI output: `(partial run — coverage may overstate input-absent)`.

### EC-6. Cluster collision merged two kinds into one
The cluster phase reduces N raw detections into M ≤ N clusters; collisions can drop a lower-priority kind in favour of a higher one. Coverage counts the surviving cluster's kind. The dropped kind reports `clustersEmitted: 0` despite having had a detection. Treat this as `fired` if input was observed (the detector ran, clusters were just merged out under priority). NB: future severity work (V32) may want to expose "collided-but-detected" telemetry — out of scope here.

### EC-7. Same kind appears under multiple input sources
`stack_trace_leak_in_response` could come from console-and-runtime OR static-analysis depending on detection path. V26's registry assigns one canonical `inputSource` per kind. If both inputs are valid, prefer the dynamic one (more specific signal). V26 owns the assignment; V34 consumes.

### EC-8. Suppressed clusters (V31, future)
A cluster verdict of `suppressed` still represents detector firing. Count it as fired. Coverage doesn't dedupe by suppression. (V31 will own the suppression view; coverage stays detector-centric.)

### EC-9. Static-analysis kind on a project with no source globs matching
Static glob is `src/**/*.{ts,tsx,js,jsx}` by default. Vibe-coded apps sometimes live under `app/` or `client/`. If zero files match, `inputObserved: false` for the static kinds. Output hints: "0 source files matched `staticAnalysis.frontendSourceGlob`."

### EC-10. Reading coverage.json from a pre-V34 run
Older runs don't have the file. CLI: `code: 'coverage_unavailable'`. MCP: `toolErr('coverage_unavailable', …)`. Don't fabricate coverage from `summary.json` — that would understate `input-absent` (no way to tell from `summary.json` whether perf was off vs perf clean).

### EC-11. Future kinds added to the union mid-spec
Once `BugKind` gains a kind (V35+), V26's registry must add an entry the same PR — that's a V26-enforced rule. V34 is then automatically correct because it iterates the registry.

---

## 8. Test plan

### 8.1 Unit tests (`packages/cli/src/phases/coverage.test.ts`)

- `deriveStatus` returns `detector-deferred` when `meta.deferred === true`, regardless of clusters / input.
- `deriveStatus` returns `detector-dead` when `meta.wired === false`.
- `deriveStatus` returns `fired` when `wired && clustersEmitted > 0`.
- `deriveStatus` returns `fired` when `wired && inputObserved && clustersEmitted === 0` (clean bill).
- `deriveStatus` returns `input-absent` when `wired && !inputObserved && clustersEmitted === 0`.
- `inputObservedByKind` correctly maps perf-disabled config to `false` for all perf kinds.
- `inputObservedByKind` correctly maps a vision run with `called > 0` to `true` for `visual_anomaly`.
- The summary counts add up to the kind total (invariant).
- Round-trip: synthesize a coverage object, write it, read it, assert equality.

### 8.2 Emit-phase integration test (`packages/cli/src/phases/emit.test.ts`)

- Run `runEmit` with a synthetic `RunState` and three clusters (two distinct kinds). Assert `coverage.json` exists, has the right two kinds in `fired`, and the rest spread across the other three buckets correctly.
- Assert `summary.json` is unchanged from pre-V34 schema.

### 8.3 CLI test (`packages/cli/src/cli/coverage.test.ts`)

- `bughunter coverage <runId>` reads the file and emits the expected pretty-print.
- `--json` emits the file verbatim.
- `--latest` picks the most recent run via `listRunIds`.
- `--kind <kind>` emits exactly one row.
- Missing file → exit 1, stderr contains `coverage_unavailable`.

### 8.4 MCP test (`packages/mcp/src/tools.test.ts`)

- `bughunt_coverage` returns `toolOk` with the verbatim file contents when present.
- Missing file → `toolErr('coverage_unavailable', …)`.
- Missing run (empty runs dir) → `toolErr('no_runs', …)`.

### 8.5 Smoke (manual, on Aspectv3)

```bash
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
node /root/BugHunter/packages/cli/dist/cli/main.js coverage "$RUN"
node /root/BugHunter/packages/cli/dist/cli/main.js coverage "$RUN" --json | jq '.summary'
# Expect: kindsTotal === 87 (or whatever |BugKind| is at landing)
# Expect: kindsTotal === fired + input-absent + dead + deferred
```

---

## 9. Negative requirements

- Do **not** modify `bugs.jsonl` shape.
- Do **not** modify `summary.json` shape.
- Do **not** wire coverage as a CI gate. (V32 owns gating.)
- Do **not** persist coverage data outside the run dir (no global `~/.bughunter/coverage.db`).
- Do **not** log credentials or path-internals in the pretty-print.
- Do **not** infer `inputObserved` from cluster presence — use `RunState` telemetry exclusively.
- Do **not** add a new `coverage` phase to the pipeline. It's a sub-step inside `runEmit`.
- Do **not** add functions ≥ 40 lines. The four-line `deriveStatus`, the ~30-line `buildCoverage` builder, and a small formatter.
- Do **not** add a runtime dep. Native JSON + the existing `runPaths`/`writeJsonFile` helpers.
- Do **not** retry on coverage write failure. If the FS is hostile, the run already has bigger problems; surface the error and exit.

---

## 10. Files to touch

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `coverage.ts` with `Coverage` types, `deriveStatus`, `inputObservedByKind`, `buildCoverage` | `packages/cli/src/phases/coverage.ts` (new) | V26 registry |
| 2 | Extend `runPaths` to expose `coverageFile` | `packages/cli/src/store/filesystem.ts` | none |
| 3 | Hook `buildCoverage` + write into `runEmit` after `summary.json` | `packages/cli/src/phases/emit.ts` | 1, 2 |
| 4 | Coverage-phase unit tests | `packages/cli/src/phases/coverage.test.ts` (new) | 1 |
| 5 | Emit-phase integration test for `coverage.json` | `packages/cli/src/phases/emit.test.ts` (new — file may exist; check) | 3 |
| 6 | Add `bughunter coverage` CLI command | `packages/cli/src/cli/coverage.ts` (new), `packages/cli/src/cli/main.ts` (registration) | 3 |
| 7 | Add CLI unit tests | `packages/cli/src/cli/coverage.test.ts` (new) | 6 |
| 8 | Add `bughunt_coverage` MCP tool | `packages/mcp/src/tools.ts` | 3 |
| 9 | Add MCP unit tests | `packages/mcp/src/tools.test.ts` (existing) | 8 |
| 10 | Document the four statuses + the `coverage` command | `README.md` (Coverage section) | 6 |

Total ≈ 6 new files, 4 edits. Estimated 30-min agent slices each.

---

## 11. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| Every BugHunter run writes `coverage.json` next to `summary.json` | `ls .bughunter/runs/<runId>/coverage.json` exists |
| `coverage.json.byKind` has exactly one entry per `BugKind` | `jq '.byKind \| keys \| length' coverage.json` equals `|BugKind|` |
| Bucket counts sum to total kinds | `jq '.summary.kindsWiredAndFired + .summary.kindsWiredButInputAbsent + .summary.kindsDead + .summary.kindsDeferred == .summary.kindsTotal' coverage.json` is `true` |
| `bughunter coverage <runId>` prints all four buckets | manual or scripted check on Aspectv3 |
| `bughunt_coverage` MCP tool returns the file verbatim | MCP integration test |
| Coverage emit failure does NOT prevent `summary.json` from being written | unit test |
| `npx tsc --noEmit` clean | tsc |
| `npx eslint . --max-warnings 0` clean | eslint |
| All new tests green | `npm test` |
| Pre-V34 runs still readable; CLI gracefully reports `coverage_unavailable` | regression run on Aspectv3 historical run dir |

---

## 12. Risks + escape hatches

- **Risk: V26 registry slips.** Coverage depends entirely on V26 having the registry. If V26 lands stub-only, V34 must wait. Document `Depends on: V26` at the top of this spec; reject the V34 PR until V26 is on `main`.
- **Risk: input-source enumeration is wrong for a kind.** Predicates are heuristic. Mitigation: V26's registry assigns the canonical `inputSource`; V34 is just the consumer. If a kind's predicate is wrong, fix it in V26, V34 follows free.
- **Risk: coverage.json file size grows unbounded.** It's `O(|BugKind|)`. Even at 200 kinds with full metadata, ≤ 50KB. Not a problem.
- **Risk: pretty-printer drifts from the JSON shape.** Use a single formatter that walks `coverage.json` — never reach into `RunState` from the formatter. Enforced by unit test that round-trips.
- **Escape hatch:** if V26's registry is unstable, ship V34 as registry-agnostic for two release cycles (every kind reports `detectorWired: true` until V26 lands). Coverage still works for fired vs input-absent; dead/deferred are perma-zero. Acceptable temporary state.

---

## 13. Killer-demo runbook (Aspectv3)

```bash
# 1. Run BugHunter (with V26 + V34 on main)
cd /root/Aspectv3 && node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 200 --budget 2400000 --a11y --seo

# 2. Inspect coverage
RUN=$(ls -t .bughunter/runs/ | head -1)
node /root/BugHunter/packages/cli/dist/cli/main.js coverage "$RUN"

# 3. Confirm via MCP
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bughunt_coverage","arguments":{"project":"/root/Aspectv3","runId":"'"$RUN"'"}}}' | \
  node /root/BugHunter/packages/mcp/dist/server.js

# 4. Sanity check the invariant
jq '.summary.kindsTotal == (.summary.kindsWiredAndFired + .summary.kindsWiredButInputAbsent + .summary.kindsDead + .summary.kindsDeferred)' \
  .bughunter/runs/$RUN/coverage.json
# Expect: true
```

Expected: every `BugKind` accounted for in exactly one bucket; perf and vision kinds in `input-absent` if those subsystems were off; `xss_stored` in `detector-deferred`; no kinds in `detector-dead` after V26 lands.

---

## 14. Open questions

1. **Should `inputObserved` track per-route granularity?** V34 says no — run-level binary. A route that lacks perf data on one page but has it on another still reports input observed. Defer per-route to V35 if calibration shows noise. (Lean: stay run-level; per-route reads as over-engineered for the user question coverage answers.)

2. **Should `detector-deferred` include `deferredTo`?** Yes, when known — pulled from V26's registry (`meta.deferredToSpec?: string`). Some detectors may be deferred without a target spec; in that case omit. The pretty-printer already handles missing `deferredTo`.

3. **Should the CLI exit non-zero when `kindsDead > 0`?** Tempting (the user might want to fail CI when BugHunter has dead detectors). Argue against: that's BugHunter's bug, not the user's app's bug; user CI shouldn't fail on it. Argue for: it's the only way the gap gets surfaced. Compromise: stay exit-0; add `--strict` later if real demand surfaces.

4. **Coverage as part of `summary.json` for backward compat?** Considered. Rejected: `summary.json` is already overloaded, and a separate file is easier to evolve, easier to delete when migrating, and easier to gate behind feature flags. One file, one purpose.

5. **Rolling coverage trend (this run vs last run)?** Phase D (cross-time) work. V34 stays single-run. Once `bugIdentity` and history DB exist (V35+), `bughunter coverage --diff <prev>` becomes natural.

6. **Should V34 expose `--kind <kind> --why` to explain the status verbosely?** Tempting for UX, but the four-status enum + `reason` field already gives enough signal. Defer to V36 if user feedback surfaces confusion.
