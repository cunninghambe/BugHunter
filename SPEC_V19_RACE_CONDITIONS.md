# SPEC — v0.19 "Race-condition / interleaved-action detection"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** v0.5 synthetic stubs (`race_double_submit`, `optimistic_update_divergence`), v0.16 pen-testing palette · **Sibling:** v0.18 JWT login verify.

This spec adds an **interleaved-action test mode** so BugHunter can surface concurrency bugs — the bug class every modern SPA ships and zero tests in BugHunter today exercise. Today's executor walks (role × route × element) serially per role, with a single mutation palette per input. Concurrency bugs (double-submit, click-then-navigate, optimistic-UI rollback under network failure, two interleaved mutations on the same record, cross-tab divergence) are invisible. v0.19 adds a second palette dimension — the **interleaving palette** — applied per (role, mutating-action), with a separate observation model (pre/inter/post, not just pre/post) and a new `race_condition_*` kind family.

---

## 1. Objective

Detect concurrency bugs by deliberately interleaving actions and observing that the application converges to a correct, declared state. Five interleaving patterns, one new `BugKind` family with five sub-classifiers, one new palette, and a small set of executor primitives.

| Pattern | What we fire | Bug if |
|---|---|---|
| `double_submit` | Same mutating action twice with sub-100ms gap | Both succeed AND produce duplicate observable state (DOM row count or API list length doubles), AND the action's `toolId` is NOT in `idempotentToolIds`. |
| `click_then_navigate` | Mutating action, then `router.push` / link-click before the response arrives | Navigation lands on stale data (toast missing, list not updated post-refetch), OR the in-flight mutation silently fails post-unmount with no console error AND no retry. |
| `optimistic_revert` | Mutating action under forced network failure (`browser.routeFulfill('/api/...', { status: 500 })`) | UI shows a success state at `t=300ms` AND fails to revert to pre-state at `t=5000ms`, with no error toast / `dom_error_text` / console error surfaced to the user. |
| `interleaved_mutations` | Two distinct mutations on the same resource within a 100ms window (same role, same context) | Final state is order-dependent in a way the API hasn't declared (`toolMeta.commutativityHint` absent or `'non_commutative'`); divergence reproduces ≥3 of 5 trials. |
| `cross_tab` (opt-in) | Same role, two `BrowserContext`s, mutate same resource simultaneously | After both responses, one tab's view of the resource diverges from the other's by ≥1 field; no `storage` event / refetch reconciles within 5s. |

**Not goals:**
- Detecting *server-side* race conditions where the server stores wrong state but the UI eventually reconciles (still a bug, but tracked under a separate `data_integrity_*` family in v0.20).
- Stress / load testing. We fire each interleaving once (or 5x for `interleaved_mutations` reproducibility), not thousands.
- Discovering distributed-systems anomalies (eventual consistency, vector clocks). One server, one DB.

**In scope:**
- Five interleaving patterns above, gated per-pattern via config.
- One new `BugKind` family `race_condition_*` with five sub-kinds (one per pattern), slotted in the priority hierarchy.
- A new **interleaving palette** distinct from the input-mutation palette: applies per (role, mutating-action), not per input.
- New `RaceObservation` shape: pre, inter (sampled at fixed offsets), post.
- Executor primitive: `runInterleaved(plan: InterleavingPlan): Promise<RaceObservation[]>` — deterministic, no race-of-races inside the harness itself.
- Cluster signature additions per sub-kind.
- Telemetry on `summary.json.raceConditions`.
- Idempotent-API hint list (`idempotentToolIds`) so we don't false-positive `double_submit` on `PUT /api/users/:id`.
- Re-run-for-flakes integration: race tests run with `consensusRuns: 3` minimum (overrides global re-run setting).

**Out of scope (deferred):**
- WebSocket / SSE race conditions — paired with SurfaceMCP's WS scope; v0.20.
- Optimistic-UI **success** path correctness without forced failure (we only test the revert path; the success path is exercised by the existing happy palette).
- Three-way interleavings (A, B, C); combinatorial explosion not justified by typical app surfaces.
- Worker / SharedWorker / ServiceWorker interleavings; v0.20.
- Promise.all-spread regressions inside one render; covered by v0.6 perf if it manifests as `n_plus_one`.
- IndexedDB transaction races; niche, defer.

**Acceptance target on a synthetic fixture (`fixtures/race-bad/`):**
A minimal Express + React app with one route per sub-kind, each with a known race bug. Smoke run produces ≥1 finding per sub-kind with the correct `raceContext` field (pattern, gapMs, observationOffsets). On TraiderJo / Aspectv3: at most 1 finding per app, manually triaged; ≥80% must be confirmed real bugs (low-noise threshold).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` already lists `race_double_submit` and `optimistic_update_divergence` as v0.5 stubs. **Replace** these with the new `race_condition_*` family; do not add a parallel set. Keep a back-compat type alias `OldRaceKinds = 'race_double_submit' \| 'optimistic_update_divergence'` if any persisted JSONL still references them. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` — slot the five new sub-kinds **above** `idor_horizontal` but **below** `unhandled_exception` (race bugs are critical, but a thrown exception trumps them). |
| `packages/cli/src/cluster/signature.ts` | Existing `race_double_submit` and `optimistic_update_divergence` cases — replace with the five new sub-kind cases per § 5. |
| `packages/cli/src/phases/plan.ts` | Test-case minting. Add a second pass: after the input-mutation palette generates per-(role, action) cases, the **interleaving planner** consumes the resulting *happy*-palette case set and emits race tests. |
| `packages/cli/src/phases/execute.ts` | `drainQueue` (line 276+). Race tests share the browser-pool budget but use a NEW path: `executeRaceTest` — they cannot run in `runUiTest` because that path assumes a single fire-and-observe. |
| `packages/cli/src/adapters/browser-mcp.ts` | Browser primitives. Add `routeFulfill(pattern, response)` for forced network failure (camofox supports route interception via the underlying Playwright API; verify SurfaceMCP-side adapter exposes it). |
| `packages/cli/src/security/injection-palette.ts` | **Pattern only** — same-shape "palette" type discriminated by kind. Mirror this discriminated union for `InterleavingVariant`. Do NOT extend `injection-palette.ts` itself; race tests are not injection. |
| `packages/cli/src/types.ts` `SyntheticConfig` | Already has `raceDoubleSubmit?: { intervalMs?: number }` — **deprecate** (keep for one minor release; emit a warning at config-load if set; route to the new `RaceConditionsConfig`). |

### 2.2 Patterns to follow

- **Discriminated union for `InterleavingVariant`.** Mirror the v0.16 injection palette shape: `{ kind: 'double_submit' | 'click_then_navigate' | 'optimistic_revert' | 'interleaved_mutations' | 'cross_tab'; ... }`.
- **Discriminated-union returns** for the runner: `{ ok: true; observations: RaceObservation[] } | { ok: false; reason: string }`.
- **Multi-point observation.** A `RaceObservation` is `{ offsetMs: number; url: string; consoleErrorCount: number; domSnapshot: string; toastVisible: boolean; targetSelectorState: 'pre' | 'optimistic' | 'final' | 'reverted' | 'errored' }`. Capture at `[0, 100, 300, 1000, 5000]` ms by default.
- **Idempotent-API skip.** Before emitting a `double_submit` test, check `toolMeta.toolId` against `config.raceConditions.idempotentToolIds` AND the SurfaceMCP `idempotencyHint` field if present. If matched, skip with `skipReason: 'idempotent_by_config'` or `'idempotent_by_hint'`.
- **No global mutable state.** Each race test gets its own `BrowserContext` (or a freshly-reset one if pool-managed).
- **Reset between race tests.** Race tests *always* run with `resetPolicy: 'per-test'`-equivalent semantics (override the user's policy for race tests only). Documented; user can disable via `config.raceConditions.skipResetBetweenRaceTests = true` (not recommended).

### 2.3 DO NOT

- Do **not** fan out the matrix uncontrollably. The interleaving palette applies per **distinct (role, mutating-action)** — i.e. consume the input-collapsed case set, do NOT regenerate from raw elements.
- Do **not** re-use the input-mutation palette variants. A race test always uses **happy** input on both fires.
- Do **not** mutate two *unrelated* resources for `interleaved_mutations`. The two actions must target the same resource (heuristic: same `toolMeta.path` after `:id` normalization, OR two writes to the same form on the same page).
- Do **not** treat a *single* run as conclusive. `interleaved_mutations` requires `consensusRuns >= 3`; 1-of-3 reproducibility downgrades to `flaky`, excluded from auto-fix.
- Do **not** use `setTimeout(0)` to "interleave." Use real concurrency: two `Promise`s started without awaiting between them, with a measured gap.
- Do **not** run race tests against the API directly in v0.19. UI-only. The UI is where the optimistic-update / unmount / storage-event symptoms surface; an API-only race test is just two HTTP calls.
- Do **not** count a 409 Conflict as a finding for `interleaved_mutations`. 409 is the server *correctly* rejecting the second writer — that's the contract working.
- Do **not** plant `double_submit` against any `toolId` matching the prefix `*/login`, `*/signup`, `*/payment*` — these are sensitive and the user should opt in explicitly via `aggressiveRaceTargets`.

---

## 3. Architecture decisions

### 3.1 Planner changes (`packages/cli/src/phases/plan.ts`)

After the existing same-shape input-mutation pass:

```text
1. Run existing input-mutation planner. Output: TestCase[] (per role × action × palette).
2. Filter to (role, mutating-action) tuples where palette === 'happy' AND
   action.via === 'ui' AND the action's resolved toolMeta has
   sideEffectClass === 'mutating'.
3. Same-shape collapsing on the filtered set: collapse signature is
   (role, formSignature || elementSignature, toolId).
4. For each surviving tuple, emit one TestCase per enabled InterleavingVariant.
   - double_submit:           1 case
   - click_then_navigate:     1 case (target = first link on the same page)
   - optimistic_revert:       1 case
   - interleaved_mutations:   1 case (paired with a sibling action when ≥2
                              mutating actions exist on the same form/page;
                              skip if no pair)
   - cross_tab (opt-in):      1 case
5. Cap total race tests at config.raceConditions.maxTests (default 200).
   Order by (sub-kind priority, role priority, route priority).
```

The race-test count is bounded: ≤5 cases × distinct (role, action) tuples × 1 (no palette fanout) ≤ 5 × ~50 ≈ 250. With cap at 200, this is well below the input-mutation matrix.

### 3.2 Executor changes (`packages/cli/src/phases/execute.ts`)

A race test is **not** a regular `runUiTest`. Add `executeRaceTest(testCase, ctx): Promise<TestResult>`:

- Acquires one fresh `BrowserContext` from the browser pool (count toward `concurrency`, not `apiConcurrency`).
- Logs in as `testCase.role`.
- Runs `runInterleaved(plan: InterleavingPlan)` per the variant:
  - `double_submit`: locate the action selector; fire `click()` twice in the same microtask, sub-100ms gap. Record observations at `[0, 50, 200, 1000]`.
  - `click_then_navigate`: fire action; immediately fire `browser.navigate(targetRoute)`. Observations at `[0, 100, 300, 2000]`.
  - `optimistic_revert`: register `browser.routeFulfill(toolPath, { status: 500, body: '{"error":"forced"}' })` BEFORE firing the action. Fire action. Observations at `[0, 300, 1000, 5000]`. Unregister route after.
  - `interleaved_mutations`: fire actionA + actionB in the same microtask. Observations at `[0, 100, 500, 2000]`. Repeat `consensusRuns` times (default 3); a finding requires ≥2 of 3 runs to diverge in the same way (`raceContext.consensusVotes >= 2`).
  - `cross_tab`: open second context, login same role, navigate to same page, fire actionA in tab1 and actionB in tab2 in the same microtask. Observations at `[0, 500, 2000, 5000]` per tab.
- Returns `TestResult` with `bugs: BugDetection[]` populated by the per-variant detector (§ 3.4).
- Per-test timeout 60s (twice the regular per-test timeout — race tests sample at 5s).

### 3.3 Classifier changes (`packages/cli/src/phases/classify.ts`)

- Add five new entries to `KIND_PRIORITY`, slotted between `xss_*` and `network_5xx`. Race conditions can manifest *without* a thrown exception or 5xx; if they happen alongside one, the higher-priority kind wins.
- `applyPriorityFilter` is unchanged. Race detections that lose the priority race become `secondaryObservations`.

### 3.4 Per-variant detectors (`packages/cli/src/security/race-detectors.ts`, new)

Each detector is a pure function `(plan, observations) => Detection | null`:

- `detectDoubleSubmit(plan, obs)`: Find post-state DOM (or API list response if observable). If `toolId` is idempotent → null. Else: count occurrences of the planted resource identifier (`raceNonce`) in the post-state. Two = bug. Proof: `proof: 'duplicate_state', count: 2`.
- `detectClickThenNavigate(plan, obs)`:
  - Stale-data branch: post-navigation page lacks the expected change (no toast, target list unchanged, no refetch network call within 2s) → bug. Proof: `'stale_post_navigation'`.
  - Silent-fail branch: in-flight request returned non-2xx OR was aborted, AND no console error AND no error toast appeared on the destination route → bug. Proof: `'silent_post_unmount_failure'`.
- `detectOptimisticRevert(plan, obs)`: At `t=300ms`, target selector shows success state (e.g. row added). At `t=5000ms`, after the forced-fail response, target still shows success state AND no error toast / `dom_error_text` AND no console error → bug. Proof: `'no_revert_after_failure'`.
- `detectInterleavedMutations(plan, obs[])`: Across `consensusRuns`, compare final post-state targetSelectorState. If ≥2 of 3 runs produce divergent final states (different field values, different row counts) AND server response was 2xx for both → bug. Proof: `'order_dependent_final_state'`. Single-run divergence is downgraded to `flaky` per § 4.3.
- `detectCrossTab(plan, obs[])`: Compare tab1 and tab2 post-state for the same resource, after both responses settled + 5s settle. If field-level divergence persists AND no `storage` event was logged AND tab2 didn't refetch → bug. Proof: `'cross_tab_no_reconcile'`.

### 3.5 Interleaving palette schema

```ts
// packages/cli/src/security/interleaving-palette.ts (new)

export type InterleavingVariant =
  | { kind: 'double_submit'; gapMs: number }                                // default 50
  | { kind: 'click_then_navigate'; targetRoute: string; preFireDelayMs: number } // default 0
  | { kind: 'optimistic_revert'; forcedStatus: number; forcedBody: string }     // default 500 / "{}"
  | { kind: 'interleaved_mutations'; siblingActionId: string; gapMs: number; consensusRuns: number }
  | { kind: 'cross_tab'; settleMs: number };                                // default 5000
```

The palette is a *constructor* — the planner picks variants from the enabled set and parameterizes from config. There is no "list of canary payloads" because race tests have no payload — they have an interleaving recipe.

---

## 4. Bug classification additions

### 4.1 New `BugKind` family

```ts
| 'race_condition_double_submit'
| 'race_condition_click_navigate'
| 'race_condition_optimistic_revert'
| 'race_condition_interleaved_mutations'
| 'race_condition_cross_tab'
```

The **two existing v0.5 stub kinds** (`race_double_submit`, `optimistic_update_divergence`) are **removed** from the active union. A migration step in `packages/cli/src/store/run-state.ts` rewrites old JSONL on read:

| Old | New |
|---|---|
| `race_double_submit` | `race_condition_double_submit` |
| `optimistic_update_divergence` | `race_condition_optimistic_revert` |

### 4.2 Priority hierarchy slotting (§ 3.5.1)

Race kinds slot between `xss_stored` and `network_5xx`:

```
1. unhandled_exception
2. xss_dom
3. xss_reflected
4. xss_stored
5. race_condition_double_submit          ← new
6. race_condition_optimistic_revert      ← new
7. race_condition_interleaved_mutations  ← new
8. race_condition_cross_tab              ← new
9. race_condition_click_navigate         ← new (lowest of family — flake-prone)
10. network_5xx
... (rest of existing hierarchy)
```

Rationale: a race bug is critical (data corruption / silent failure), but if it co-occurs with a thrown exception or XSS exec, the exception/XSS is the higher-leverage report. Click-then-navigate is bottom-of-family because it's the most flake-prone (timing-sensitive).

### 4.3 Flakiness handling

Race tests are inherently more timing-sensitive than other tests. The existing `reRunForFlakes` mode (§ 5 EC-13 in main spec) is **upgraded** for race kinds:

- Default `consensusRuns: 3` for `interleaved_mutations` (built into the variant).
- For all other race sub-kinds: if the first run produces a finding AND `reRunForFlakes !== false`, re-run twice more. Finding stands only if reproduced ≥2 of 3 times. 1-of-3 → mark `flaky: true`, exclude from auto-fix.
- `--strict` disables consensus voting; every detection ships.

`flaky` clusters land in `bugs.jsonl` with a `flaky: true` flag and are excluded from `bugs_attempted_fix` in the summary.

---

## 5. Cluster signature additions (`packages/cli/src/cluster/signature.ts`)

```ts
case 'race_condition_double_submit': {
  const tool = detection.endpoint ?? '';
  return `race_condition_double_submit|${tool}|${detection.raceContext?.gapMs ?? ''}`;
}
case 'race_condition_click_navigate': {
  const route = detection.pageRoute ?? '';
  const target = detection.raceContext?.navigateTarget ?? '';
  const proof = detection.raceContext?.proof ?? '';
  return `race_condition_click_navigate|${route}|${target}|${proof}`;
}
case 'race_condition_optimistic_revert': {
  const tool = detection.endpoint ?? '';
  return `race_condition_optimistic_revert|${tool}`;
}
case 'race_condition_interleaved_mutations': {
  const tool = detection.endpoint ?? '';
  const sibling = detection.raceContext?.siblingToolId ?? '';
  return `race_condition_interleaved_mutations|${tool}|${sibling}`;
}
case 'race_condition_cross_tab': {
  const tool = detection.endpoint ?? '';
  return `race_condition_cross_tab|${tool}`;
}
```

`gapMs` and `siblingToolId` keep clusters distinct when the same endpoint is exercised under different timings or paired with different siblings — useful for triage but bounded (only the configured gaps and the planner-paired siblings).

---

## 6. Interleaving palette (table form)

| Variant | Fires | Default gap | Observation offsets (ms) | Detector | Cluster signature |
|---|---|---|---|---|---|
| `double_submit` | actionA, actionA | 50ms | [0, 50, 200, 1000] | `detectDoubleSubmit` | `endpoint + gapMs` |
| `click_then_navigate` | actionA, navigate(linkN) | 0ms | [0, 100, 300, 2000] | `detectClickThenNavigate` | `pageRoute + target + proof` |
| `optimistic_revert` | actionA (with `routeFulfill 500`) | n/a | [0, 300, 1000, 5000] | `detectOptimisticRevert` | `endpoint` |
| `interleaved_mutations` | actionA, actionB (same resource) | 0ms, ×3 runs | [0, 100, 500, 2000] | `detectInterleavedMutations` | `endpoint + siblingToolId` |
| `cross_tab` | actionA(tab1), actionA(tab2) | 0ms | [0, 500, 2000, 5000] (per tab) | `detectCrossTab` | `endpoint` |

All variants fire **happy**-palette inputs only. No `null` / `edge` / `out_of_bounds` interleavings — the input mutation pass already exhaustively covers those linearly.

---

## 7. Interface contract — CLI / config

### 7.1 New config block

```ts
export type RaceConditionsConfig = {
  /** Master switch. Default: false (opt-in; race tests are 60s each + flake-prone). */
  enabled?: boolean;
  /** Which sub-patterns to run. Default: ['double_submit','click_then_navigate','optimistic_revert','interleaved_mutations']. cross_tab is opt-in. */
  variants?: Array<InterleavingVariant['kind']>;
  /** Cap on total race test cases. Default: 200. Bounded by the planner via same-shape collapse. */
  maxTests?: number;
  /** ToolIds known to be safely idempotent (PUT-by-id, DELETE-by-id, etc.). Skips double_submit on these. */
  idempotentToolIds?: string[];
  /** ToolId glob patterns considered too sensitive to race-test without explicit opt-in. */
  aggressiveRaceTargets?: string[];                           // user-supplied glob list
  /** Override gap for double_submit. Default: 50ms. */
  doubleSubmitGapMs?: number;
  /** Override forced status for optimistic_revert. Default: 500. */
  optimisticRevertForcedStatus?: number;
  /** Consensus runs for interleaved_mutations. Default: 3. */
  consensusRuns?: number;
  /** When true, skip the per-test reset before each race test (NOT RECOMMENDED). Default: false. */
  skipResetBetweenRaceTests?: boolean;
  /** Concurrency cap for race tests specifically. Default: min(2, config.concurrency). */
  raceConcurrency?: number;
};
```

Attached to `BugHunterConfig` as `raceConditions?: RaceConditionsConfig`.

### 7.2 CLI flag additions (`bughunter run`)

```
--race-conditions             Shorthand for raceConditions.enabled = true
--no-race-conditions          Disable even if config has enabled = true
--race-variants <list>        Comma-separated subset of variants
--race-cross-tab              Enable cross_tab variant (also requires enabled)
--race-strict                 Disable consensus voting (every detection ships)
```

No new top-level command. Race tests are part of `bughunter run`.

### 7.3 New types in `packages/cli/src/types.ts`

```ts
export type RaceObservation = {
  offsetMs: number;
  url: string;
  consoleErrorCount: number;
  /** SHA1 of the target selector's outerHTML, truncated to 12 chars. Empty if selector not found. */
  targetSelectorHash: string;
  toastVisible: boolean;
  /** 'pre' = unchanged from baseline; 'optimistic' = success state shown; 'final' = persisted change present;
      'reverted' = post-failure revert detected; 'errored' = error state present. */
  targetSelectorState: 'pre' | 'optimistic' | 'final' | 'reverted' | 'errored';
  /** Captured when a network request matching the action's tool path completed. */
  responseStatus?: number;
};

export type RaceDetectionContext = {
  /** Variant kind that produced this finding. */
  variantKind: InterleavingVariant['kind'];
  gapMs?: number;
  navigateTarget?: string;
  forcedStatus?: number;
  siblingToolId?: string;
  /** For interleaved_mutations consensus voting. */
  consensusVotes?: number;
  consensusTotal?: number;
  /** Per-detector proof discriminator. */
  proof:
    | 'duplicate_state'
    | 'stale_post_navigation'
    | 'silent_post_unmount_failure'
    | 'no_revert_after_failure'
    | 'order_dependent_final_state'
    | 'cross_tab_no_reconcile';
  /** Up to 200-char snippet of the divergence evidence. */
  evidence: string;
  /** Whether this detection survived consensus voting. */
  flaky?: boolean;
};
```

`BugDetection.raceContext?: RaceDetectionContext` — populated for the five new kinds.

### 7.4 Telemetry addition to `summary.json`

```ts
raceConditions?: {
  enabled: boolean;
  variantsRun: InterleavingVariant['kind'][];
  testsAttempted: number;
  testsSucceeded: number;             // ran to completion, regardless of finding
  testsTimedOut: number;
  testsSkipped: { reason: string; count: number }[];
  detectionsByKind: Record<string, number>;
  flakyDetections: number;
  durationMs: number;
};
```

### 7.5 SurfaceMCP-side hint (optional, nice-to-have)

If SurfaceMCP exposes `idempotencyHint?: 'idempotent' | 'non_idempotent' | 'unknown'` on `ToolMeta` (NOT in v0.1; track as v0.2 if user demand), the planner consumes it to pre-skip `double_submit` tests. Until then, the user supplies `idempotentToolIds` manually.

---

## 8. Edge cases (false-positive sources especially)

### EC-1. Real but flaky finding (1-of-3 reproduces)
Marked `flaky: true`, excluded from auto-fix, surfaced separately in the summary.

### EC-2. Idempotent endpoint NOT in `idempotentToolIds`
False-positive `double_submit`. Mitigation: planner logs the race-test list at run start so user can copy back-compat-safe tools into config. Phase-2: consume SurfaceMCP `idempotencyHint`.

### EC-3. UI debounces double-click client-side
Both clicks fire to the DOM, but only one reaches the network. Detector sees one network request → no duplicate state → no finding. The debounce IS the fix.

### EC-4. Server idempotency-by-DB-constraint
Second response is a 200 but no new row. DOM count doesn't double. No finding. Correct.

### EC-5. `interleaved_mutations` has no sibling action on the same form/page
Skip the variant for this (role, action) with `skipReason: 'no_sibling_for_interleave'`.

### EC-6. Optimistic-UI library writes to `localStorage` before failure
Detector ONLY checks the visible DOM. localStorage divergence is a separate cluster (`data_integrity_*`, v0.20).

### EC-7. `click_then_navigate` target route is itself broken (404 / render-error)
Existing classifier (`404_for_linked_route`, `react_error`) handles it. Race detector returns null when `obs[*].consoleErrorCount` increased OR target route returned non-2xx — defers to the standard classifier.

### EC-8. `cross_tab` with sessionStorage-scoped auth (per-tab token)
Tab2 gets a different session → not the same-user race scenario. Detector requires `sessionId(tab1) === sessionId(tab2)`, else skip with `skipReason: 'per_tab_session'`.

### EC-9. `optimistic_revert` `routeFulfill` collides with unrelated in-flight requests
Matcher MUST be scoped to (method + path + requestBody hash). Without scoping, unrelated GETs get 500'd and the regular classifier mis-fires.

### EC-10. Browser-MCP doesn't support `routeFulfill`
Skip `optimistic_revert` with `skipReason: 'no_route_fulfill_support'`. Do NOT fall back to network-throttling — nondeterministic timing is the source of the worst flakiness.

### EC-11. Action is fully synchronous client-side (no network)
`double_submit` detector still checks DOM duplicate-state. `optimistic_revert` is N/A → skip with `skipReason: 'no_network_action'`.

### EC-12. `resetPolicy === 'per-run'` with race tests enabled
Refuse to start with a clear error: "race tests require per-test or per-page reset". User picks: change policy or disable race tests. No silent override.

### EC-13. Sibling-pairing heuristic mis-pairs (e.g. `PATCH /users/:id` vs `PATCH /users/:id/avatar`)
Tighten heuristic to *exact* normalized path equality (no prefix match). For real cross-resource races, user supplies `pairedToolIds: [['toolA', 'toolB']]` explicitly.

### EC-14. Action triggers external service
Existing `sideEffectClass: 'external'` skip-list applies — never reaches the planner's `mutating`-action filter.

---

## 9. Acceptance criteria

| Criterion | Verifier |
|---|---|
| All new unit tests pass (palette, planner, executor primitive, detectors) | `npm test -- race-conditions` |
| Synthetic fixture `fixtures/race-bad/` produces ≥1 finding per sub-kind with correct `raceContext` | `npm test -- tests/integration/race-smoke` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| `summary.json.raceConditions` block populated when enabled | `jq '.raceConditions' summary.json` |
| Idempotent endpoint listed in config does NOT produce `race_condition_double_submit` finding | unit test on planner skip + integration |
| `interleaved_mutations` finding requires ≥2-of-3 consensus (1-of-3 marked `flaky: true`, excluded from auto-fix) | unit test on detector |
| Race tests run sequentially against the **browser** pool (not API), capped at `raceConcurrency` (default 2) | integration test counting parallel `browser.evaluate` calls |
| Old `race_double_submit` JSONL records are read-time migrated to `race_condition_double_submit` (back-compat) | unit test in `store/run-state.ts` |
| `--no-race-conditions` flag overrides `config.raceConditions.enabled = true` | CLI test |
| `resetPolicy: 'per-run'` + `raceConditions.enabled: true` aborts validate phase with clear error | validate-phase unit test |
| `optimistic_revert` `routeFulfill` is scoped to (method + path + body hash) — unrelated GETs still pass through | unit test on browser-mcp adapter |

---

## 10. Files to touch / add (under `packages/cli/src/`)

### Files to create

| File | Why |
|---|---|
| `packages/cli/src/security/interleaving-palette.ts` | `InterleavingVariant` discriminated union + planner helpers (`plansForActionTuple`, `pairSiblings`). |
| `packages/cli/src/security/interleaving-palette.test.ts` | Unit tests for variant construction and sibling pairing. |
| `packages/cli/src/security/race-detectors.ts` | The five pure-function detectors. |
| `packages/cli/src/security/race-detectors.test.ts` | Unit tests with synthetic observations. |
| `packages/cli/src/phases/race-runner.ts` | `executeRaceTest(testCase, ctx)` + `runInterleaved(plan)` primitive. Wraps the browser-MCP adapter; orchestrates observation sampling. |
| `packages/cli/src/phases/race-runner.test.ts` | Unit + integration tests against a mock browser. |
| `fixtures/race-bad/` | Express + minimal React client demonstrating one bug per sub-kind. |
| `tests/integration/race-smoke.test.ts` | End-to-end smoke against `fixtures/race-bad/`. |

### Files to modify

| File | Change |
|---|---|
| `packages/cli/src/types.ts` | (a) Remove `race_double_submit` and `optimistic_update_divergence` from active `BugKind` union; (b) add five `race_condition_*` kinds; (c) add `RaceObservation`, `RaceDetectionContext`, `RaceConditionsConfig`; (d) add `raceContext?: RaceDetectionContext` to `BugDetection`; (e) add `raceConditions?` to `BugHunterConfig`; (f) add `raceConditions?` to `RunSummary`; (g) deprecate `SyntheticConfig.raceDoubleSubmit`. |
| `packages/cli/src/phases/plan.ts` | Add second pass: filter mutating-action happy-palette cases; emit race tests per enabled variant. |
| `packages/cli/src/phases/plan.test.ts` | Unit tests for the second pass: same-shape collapsing, sibling pairing, idempotent-tool skip, cap at `maxTests`. |
| `packages/cli/src/phases/execute.ts` | Route `testCase.action.kind === 'race'` (new sub-kind on `Action`?) — actually, **keep `Action` shape stable**: race test cases set `testCase.formSignature` plus a new `testCase.race?: { variant: InterleavingVariant }` field. Executor branches on `testCase.race !== undefined` → `executeRaceTest`. |
| `packages/cli/src/phases/classify.ts` | Add five entries to `KIND_PRIORITY`; no change to `applyPriorityFilter`. |
| `packages/cli/src/cluster/signature.ts` | Replace v0.5 stub cases with five new sub-kind cases (§ 5). |
| `packages/cli/src/cluster/signature.test.ts` | Replace stub-kind tests with new sub-kind tests. |
| `packages/cli/src/adapters/browser-mcp.ts` | Add `routeFulfill(scope, response): Promise<UnregisterFn>` (returns an unregister function for cleanup). Verify SurfaceMCP exposes this; if not, add to SurfaceMCP separately and gate this entire feature behind it. |
| `packages/cli/src/adapters/browser-mcp.test.ts` | Tests for `routeFulfill` scope-narrowing. |
| `packages/cli/src/cli/run.ts` | Wire new flags (`--race-conditions`, `--no-race-conditions`, `--race-variants`, `--race-cross-tab`, `--race-strict`). |
| `packages/cli/src/phases/validate.ts` | Add the `resetPolicy === 'per-run' AND raceConditions.enabled` guard. |
| `packages/cli/src/phases/emit.ts` | Populate `summary.raceConditions` telemetry. |
| `packages/cli/src/store/run-state.ts` | Read-time migration: `race_double_submit` → `race_condition_double_submit`, etc. |
| `packages/cli/src/cli/init.ts` | If `--no-interactive` is off, prompt to add a starter `idempotentToolIds: []`. |

---

## 11. Negative requirements

- Do **not** add a sixth interleaving variant in v0.19 (no double-tap-then-tab-switch, no triple-fire, etc.). Variants ship one at a time, validated against real apps before adding more.
- Do **not** retry on consensus failure with bigger gaps. If `gapMs: 50` doesn't repro, the bug isn't reliably reproducible at our chosen window — that's a `flaky` finding, not "try harder."
- Do **not** depend on `playwright-test` for interleaving. Use the camofox MCP primitives. The runner is ours.
- Do **not** treat `interleaved_mutations` consensus failure (1-of-3) as silent skip. It's a `flaky` finding, surfaced in `bugs.jsonl` + `summary.flakyDetections`. Flaky detections are a real signal even if we can't auto-fix them.
- Do **not** instrument app code (no React DevTools hooks, no monkey-patching `fetch`). The detector reads only observable state.
- Do **not** ship `cross_tab` enabled-by-default. It requires a second auth context, doubles the cost per test, and the false-positive risk (per-tab auth, sessionStorage) is high. Opt-in via `--race-cross-tab`.
- Do **not** count race tests against the v0.1 `--max-bugs 200` cluster cap separately. They share the same cluster budget; the budget is for *clusters*, not *tests*.

---

## 12. Risks + escape hatches

- **Slow tests (5s settle × 200 = 17min)**: `raceConcurrency` default 2 → ~8.5min; raise to 4 if browser pool allows; `--budget` time-boxes.
- **False-positive flood on flake-prone apps**: consensus voting (≥2-of-3 default), flaky findings excluded from auto-fix, `--race-strict` only for power users.
- **`routeFulfill` unsupported by browser-MCP**: validate-phase capability check skips `optimistic_revert` with `no_route_fulfill_support`; other four variants continue.
- **Race tests outpace reset**: validate-phase guard refuses `per-run` + race; document `per-test` on transactional DBs.
- **Escape hatch**: `--no-race-conditions` disables everything, regardless of config.

## 13. Killer-demo runbook

```bash
# Synthetic fixture
cd /root/BugHunter && npm test -- tests/integration/race-smoke
# Expect ≥1 finding per sub-kind.

# Aspectv3 opt-in (low-noise)
cd /root/Aspectv3
# .bughunter/config.json: "raceConditions": { "enabled": true, "idempotentToolIds": [...] }
node /root/BugHunter/packages/cli/dist/cli/main.js run --race-conditions --max-bugs 50 --budget 1800000

RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.raceConditions, (.byKind | with_entries(select(.key | startswith("race_condition_"))))' \
   /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Expect ≤2 findings, ≥80% real after triage.
```

---

## 14. Open questions

1. **Should `race_condition_click_navigate` be split into two sub-kinds?** The spec defines two `proof` discriminators (`stale_post_navigation` vs `silent_post_unmount_failure`) under a single kind. They have different fix shapes — stale-data is usually a refetch issue; silent-fail is usually missing-`AbortController`. Reviewers may prefer splitting into two kinds for cleaner clusters at the cost of a sixth race kind.

2. **Should `cross_tab` use real `BroadcastChannel` / `storage` event observation, or just compare DOM snapshots?** The spec uses DOM-snapshot diff plus a network-refetch check. Adding `storage` event observation (via injected listener at page-load) would distinguish "the app *attempted* to reconcile" vs "no reconciliation logic exists at all" — useful for fix-hint generation, but adds an instrumentation surface. Defer or include?

3. **Is `consensusRuns: 3` enough, or should it be `5` for high-value targets?** 3 is the minimum for majority voting; 5 reduces the false-positive rate further at 67% more cost. Currently spec says 3 default, user-overridable via config — is the default right?

4. **Does the planner pair siblings within `interleaved_mutations` automatically, or require explicit `pairedToolIds` config?** The spec auto-pairs on same-form / same-page heuristics with same-resource normalization (EC-15). Auto-pairing is convenient but mis-pairs are possible. Auto-pair-with-explicit-override is the chosen middle ground; reviewers may prefer explicit-only.

5. **Should `optimistic_revert` also test the "intermittent network" case (delay + success)?** A real optimistic-UI bug surfaces as much under slow-success as under fail. Currently spec only forces failure. Adding a delayed-success case doubles the variant to two parameterizations. Defer to v0.20?

6. **Migration of v0.5 stub kinds — keep both unions or one?** Spec says remove the old kinds and migrate JSONL on read. Alternative: keep both kinds in the union for one minor release; emit a deprecation note in `bughunter list`. The migration approach is cleaner; the union-coexistence approach is less risky for users with stored historical runs.

7. **Should race tests appear in the planner's `Projected: N tests · est. duration` summary?** Yes — they're real tests with real cost. The budget-calculator helper (§ 3.4.4 in main spec) needs an explicit added-cost-per-race-test (≈ 8s including reset). Confirm in implementation.
