# SPEC — v0.40 "Multi-context coordination (N-tab / N-user / lifecycle)"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** v0.19 race conditions (`cross_tab` variant — N=2 special case) · **Sibling:** v0.21 IDOR cross-user · **Phase:** E (path-to-exhaustive §3.5).

This spec generalises v0.19's `cross_tab` interleaving (a single-action, N=2 special case) into a real **multi-context orchestrator** that can spawn N camofox `BrowserContext`s, possibly with N distinct roles, fire coordinated actions across them, and observe whether the application converges to a consistent declared state. v0.19's `cross_tab` covers two-tab same-role same-action divergence. v0.40 adds three distinct bug families that the two-tab path cannot express:

1. **N-way state divergence** — `>2` clients editing the same record, exposing CRDT/last-write-wins/lost-update bugs that don't manifest at N=2.
2. **Lifecycle-event state loss** — fire `visibilitychange` / `pageshow` / `pagehide` / `freeze` mid-action; verify the app re-syncs (or never lost state).
3. **Multi-user inconsistent-snapshot reads** — roleA mutates resource X mid-stream while roleB reads X; verify roleB never sees a torn or in-flight snapshot.

These are **expensive** tests. N parallel contexts × per-context login × 5-30s settle windows blow up runtime quickly. v0.40 is **opt-in** behind `--multi-context <N>` (default disabled; recommended `N=3` for SaaS apps with concurrent collaboration). Per-test timeout, total cap, and consensus voting all stricter than v0.19 race tests.

---

## 1. Objective

Detect three coordination/lifecycle bug families by orchestrating N parallel browser contexts under deliberate timing, role, and lifecycle perturbations.

| BugKind | Pattern | Bug if |
|---|---|---|
| `multi_context_state_divergence` | N contexts (same role) mutate the same resource within a coordinated window. After all responses settle + 5s, every context's view of the resource diverges in a way the app declares non-commutative AND no `storage` event / refetch reconciled the divergence. | Final field-level state across the N tabs differs by ≥1 field that the app's `non_commutative_fields` config (or default heuristic) flags as authoritative. Reproduces ≥`ceil(consensusRuns/2 + 1)` of `consensusRuns` (default 3-of-5). |
| `visibility_change_state_loss` | One context, fire a mutating action; mid-action (between request-fire and response-arrival) dispatch a lifecycle event from `{visibilitychange (hidden→visible), pageshow, pagehide, freeze, resume}`. Observe pre-event state and post-event-plus-settle state. | After the lifecycle event, observable state regresses to pre-action OR loses a field present pre-event OR fails to reconcile the response that arrived during/after the event. |
| `multi_user_inconsistent_snapshot` | RoleA fires a multi-step / streaming mutation against resource X. RoleB (different auth context) issues a read on resource X at three offsets: pre-mutation, mid-mutation, post-mutation. | RoleB's mid-mutation read returns a torn state — fields from before partially overlaid with fields from after, AND the API has no `ETag`/`If-Match`/`X-Snapshot-Version` header in the response indicating it returned a transactionally-consistent snapshot. |

**Not goals:**
- Two-tab single-action same-role race — already covered by v0.19 `cross_tab`.
- Three-or-more-way **server**-side state (vector clocks, distributed transactions) — out of scope for a UI-walker.
- Replacing v0.21 IDOR — V40 is about *consistency under concurrent access*, not *authorization escape*. V40 explicitly verifies that roleB's read SUCCEEDS (auth allows it); V21 verifies roleB's read should FAIL (auth should reject it).
- Stress / load testing. N is bounded at 8 by config; default 3.
- Three-way client interleavings of *distinct actions* (combinatorial explosion). v0.40 fires the **same logical action** across N contexts (state-divergence pattern) or **paired reader/writer** (multi-user snapshot pattern).
- WebSocket / SSE coordination — defers to v0.20 / future.

**In scope:**
- One new orchestrator: `packages/cli/src/phases/multi-context-runner.ts`.
- Three new BugKinds (one per pattern), slotted in `KIND_PRIORITY` between race kinds and `network_5xx`.
- A barrier-synchronized N-context spawner that minimizes inter-context fire-time skew.
- A multi-role auth setup that logs in N contexts (1..K distinct roles + filler same-role contexts up to N).
- Lifecycle-event injection primitives (`dispatchLifecycle(scope, kind)`).
- Cluster signatures per kind.
- Telemetry on `summary.json.multiContext`.
- CLI flag `--multi-context <N>` plus per-pattern toggles.

**Out of scope (deferred):**
- `BroadcastChannel` instrumentation — record-only check that no broadcast event was posted is fine for v0.40; deeper "did the app *attempt* to reconcile" telemetry defers to v0.41.
- IndexedDB consistency probes — niche; defer.
- Worker / SharedWorker / ServiceWorker coordination — defers to browser-platform v-spec (path-to-exhaustive §3.1).
- Mid-stream injection of arbitrary network faults during multi-context (v0.20 handles single-context network faults).
- N>8 — not justified; bounded at 8 to cap cost and prevent OOM under camofox.

**Acceptance target on synthetic fixture (`fixtures/multi-context-bad/`):**
A minimal Express + React app with one route per BugKind, each with a known coordination bug. Smoke run with `--multi-context 3 --multi-context-cross-role` produces ≥1 finding per sub-kind with the correct `multiContextContext` field (N, perPatternConfig, role-set fingerprint, observation offsets). On a real SaaS target (TraiderJo / Aspectv3): at most 3 findings, ≥80% must be confirmed real bugs after triage.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union, `BugDetection`, `BugHunterConfig`, `RunSummary`. Add 3 new kinds, `MultiContextConfig`, `MultiContextDetectionContext`, `MultiContextObservation`, optional `multiContextContext?` on `BugDetection`. |
| `packages/cli/src/phases/race-runner.ts` | **The architectural precedent.** Read end-to-end. The new runner reuses `withTab`, `captureAtOffsets`, `classifyTargetState`, `consensus voting`, and the discriminated-union dispatch shape. Do NOT extend race-runner in place — multi-context is a separate phase, not a fifth-and-sixth race variant. |
| `packages/cli/src/phases/race-runner.test.ts` | Mock-browser pattern + observation-fixture pattern. Mirror for `multi-context-runner.test.ts`. |
| `packages/cli/src/security/race-detectors.ts` | Detector signature `(plan, observations) => Detection \| null`. Mirror three new pure-function detectors in `packages/cli/src/security/multi-context-detectors.ts`. |
| `packages/cli/src/adapters/browser-mcp.ts` | `withTab`, `openTab`, `closeTabExplicit`. **N>2 implication:** the adapter currently maintains one `currentTabId` field. `withTab` already opens an isolated tab without mutating that field, but verify Promise.all of N concurrent `withTab` calls is safe (the only shared mutable state is `currentTabId`, which `openTab`/`withTab` do NOT touch). |
| `packages/cli/src/discovery/browser-login.ts` | `loginInBrowser`. The multi-context runner needs to log in N contexts where some carry roleA, others roleB. Need a per-tab login helper; adapter has TabScope but not a per-scope login wrapper. **NEW HELPER:** `loginInTabScope(scope, role, plan)`. |
| `packages/cli/src/phases/plan.ts` | Test-case minting. Multi-context tests are **not** an extension of v0.19's race-test pass; they are a third planner pass with their own filter. Read the v0.19 second-pass for shape. |
| `packages/cli/src/phases/execute.ts` | Routing: `testCase.race?.variant` triggers race-runner. **Add:** `testCase.multiContext?: { kind: ... }` triggers multi-context-runner. Branch is mutually exclusive with `testCase.race`. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY`. Three new entries between `race_condition_*` and `network_5xx`. |
| `packages/cli/src/cluster/signature.ts` | Three new cluster-signature cases. |
| `packages/cli/src/cli/run.ts` | New CLI flags `--multi-context`, `--multi-context-cross-role`, `--multi-context-lifecycle`, `--multi-context-snapshot`. |
| `packages/cli/src/phases/validate.ts` | Capability checks: requires `routeFulfill` is NOT used (v0.40 does not force-fail responses); requires `--multi-context >= 2`; requires browser pool capacity ≥ N+1. |
| `SPEC_V19_RACE_CONDITIONS.md` | Full v0.19 spec for shape + decisions. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §3.5 + §9 Phase E | The strategic context. |

### 2.2 Patterns to follow

- **Discriminated union** for the variant: `MultiContextVariant = { kind: 'state_divergence' | 'lifecycle_state_loss' | 'inconsistent_snapshot' } & ...`. Mirror v0.19's `InterleavingVariant` shape exactly.
- **Discriminated-union returns** for the runner: `{ ok: true; observations: PerContextObservations[] } | { ok: false; reason: string }`.
- **Barrier synchronization** for N-context fire-points: build a single `Promise<void>` "fire-gate" resolved exactly once after all N contexts have logged in and navigated. All N action fires `await` the gate, then race to call `click()`. Skew is bounded by event-loop overhead, typically <5ms.
- **Per-context observation arrays** — `RaceObservation[]` per context, indexed by context number. Same `RaceObservation` shape as v0.19 (re-export — do not redefine).
- **Reset between multi-context tests is mandatory.** Refuse to start with `resetPolicy: 'per-run'` (same guard as v0.19 §EC-12). Multi-context tests carry stronger correctness requirements than race tests because state-divergence detection is meaningless if the resource's pre-state isn't fresh.
- **No global mutable state in the runner.** Each multi-context test allocates its own N tabs from `withTab`. The adapter's `currentTabId` is never read or written by the multi-context runner — it operates exclusively through `TabScope`s.
- **Cap N at 8.** Hard constant in `validate.ts`. Anything higher is rejected at validate-time.

### 2.3 DO NOT

- Do **not** extend `race-runner.ts` with multi-context variants. Different runner, different lifecycle, different cost model. Co-locating them creates two failure modes that interact poorly under timeout and consensus.
- Do **not** reuse `cross_tab` of v0.19 for the N=2 special case. v0.40's `state_divergence` AT N=2 has different defaults (different consensus, different settle window, different observation offsets). They are intentionally separate kinds for triage clarity.
- Do **not** include `routeFulfill` in any v0.40 path. v0.40 does not force network failures; it tests *successful* concurrent operations and observes whether the app converges. Mixing forced-fail (v0.19 `optimistic_revert`) with N-way contexts compounds nondeterminism unacceptably.
- Do **not** instrument app code (no React DevTools hooks, no patched `fetch`, no injected `BroadcastChannel` listener registered into app code). `evaluate` reads observable state only. The optional `BroadcastChannel`-was-posted check uses a passive `BroadcastChannel` instance opened on the **same** name from inside `evaluate` — non-mutating.
- Do **not** mix N>2 with `--race-cross-tab`. Race tests and multi-context tests run in separate phases of `execute`; multi-context tests run AFTER race tests, never in parallel. They share the browser pool budget but NOT the same test slot.
- Do **not** test mutating actions cross-role for `state_divergence`. State-divergence is same-role same-action (with same auth / same row visibility) — cross-role breaks the precondition that all N contexts can see the same record. Cross-role belongs to `inconsistent_snapshot` only.
- Do **not** auto-pair distinct mutating actions across contexts ("A on tab1, B on tab2, C on tab3"). All N contexts fire the **same** action against the **same** resource for `state_divergence`. The interesting variation is the *value* applied (different field overrides per context) and the *gap* between fires.
- Do **not** count multi-context tests against `--max-bugs` cluster cap separately. They share the budget; cap is per-cluster, not per-test.
- Do **not** plant `state_divergence` against any `toolId` matching the prefix `*/login`, `*/signup`, `*/payment*`, `*/oauth*`, `*/auth/*`. Sensitive endpoints must be opted in via `aggressiveMultiContextTargets`.
- Do **not** test `state_divergence` if the action's `toolMeta.commutativityHint === 'commutative'`. Commutative ops (set-based, idempotent appends with stable IDs) are designed for divergence-free convergence.
- Do **not** capture screenshots from N tabs by default — too much disk. Optional via `--multi-context-screenshots`.
- Do **not** persist the per-context cookie jar separately. The browser pool already isolates contexts; cookies are scoped per-context and discarded on `closeTabExplicit`.
- Do **not** add a fourth pattern in v0.40. Each pattern ships validated against real apps before adding more.

---

## 3. Architecture decisions

### 3.1 Orchestrator outline (`packages/cli/src/phases/multi-context-runner.ts`)

```text
executeMultiContextTest(testCase, ctx) -> TestResult
  1. Validate variant against capabilities (lifecycle support, ≥N+1 browser pool slots).
  2. Build context-to-role mapping per variant:
       - state_divergence:        all N contexts map to testCase.role (same role).
       - lifecycle_state_loss:    N=1 (single context); N param ignored or rejected ≥2.
       - inconsistent_snapshot:   N=2 by definition (writer + reader); two roles.
  3. Acquire N TabScopes via Promise.all of N withTab(initialUrl) calls.
  4. Per-tab login: loginInTabScope(scope, role, plan). Done in parallel.
  5. Per-tab navigate to testCase.page.
  6. Build a fire-gate (Promise<void> + resolveFireGate fn).
  7. Per variant:
       - state_divergence:        each tab awaits the gate, then fires click(selector).
                                  Capture observations at [0, 100, 500, 2000, 5000] per tab.
                                  After settle, compare final targetSelectorHash + outerHTML
                                  field set across tabs.
       - lifecycle_state_loss:    fire action on the single tab; midActionSleep(); inject
                                  the configured lifecycle event via evaluate; capture
                                  observations at [0, 100, lifecycleAt, lifecycleAt+200,
                                  lifecycleAt+1000, lifecycleAt+5000].
       - inconsistent_snapshot:   tab1=writer, tab2=reader. Writer fires multi-step or
                                  streaming mutation. Reader polls GET resource at
                                  [pre, mid (writer-fire+settleDelay/2), post (writer-fire+
                                  settleDelay)]. Observations per offset.
  8. Run pure detector function on observations.
  9. If consensus voting enabled and detection != null, re-run up to consensusRuns-1 more
     times (re-acquire fresh tabs, re-login, repeat) and require >= consensusVotes match.
  10. Per-test timeout 120s (multi-context tests sample at 5s settle and may need 3-of-5
      consensus runs, so 5s × 5 + per-step overhead ≈ 60s + retry overhead ≤ 120s).
```

### 3.2 Why a separate runner?

- **Different lifecycle.** Race tests run one tab per test (cross_tab is the lone exception, hard-coded to 2). Multi-context tests run N tabs per test, ALL of which must be alive concurrently. The browser pool's accounting must reserve N+1 slots (the +1 is the orchestrator's bookkeeping tab; in practice it's just N).
- **Different timeout shape.** Race tests have one settle window (5s max). Multi-context state-divergence runs N captures in parallel, each up to 5s, plus consensus retries. Per-test timeout doubles (60s → 120s).
- **Different consensus semantics.** Race `interleaved_mutations` requires 2-of-3 default. Multi-context `state_divergence` with N=3 needs a stricter 3-of-5 (the false-positive risk grows with the number of moving parts; consensus must scale).
- **Different observation shape.** Race produces `RaceObservation[]` per tab. Multi-context produces `RaceObservation[][]` (per-context array). Cluster signatures pull from this 2D shape.
- **Different priority slot.** Multi-context kinds are below race kinds in priority — they're more flake-prone and lower-leverage than the equivalent same-tab race.

### 3.3 Fire-gate pattern

```ts
function makeFireGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

// Per tab:
async function fireOnGate(scope: TabScope, gate: Promise<void>, selector: string): Promise<RaceObservation[]> {
  await gate;
  // Now fire ASAP. Skew between tabs is bounded by event-loop turnaround
  // (~1-5ms). For barrier-quality concurrency, this is sufficient.
  await scope.click(selector);
  return captureAtOffsets(scope, selector, [0, 100, 500, 2000, 5000]);
}

// Orchestrator:
const { gate, release } = makeFireGate();
const promises = scopes.map(scope => fireOnGate(scope, gate, selector));
release();
const observationsByContext = await Promise.all(promises);
```

The release-then-await sequence ensures Node's microtask queue dispatches all N awaits before the actual click work starts. Verified in `multi-context-runner.test.ts` with a mock browser counting fire-time skew.

### 3.4 Per-tab login (`loginInTabScope`)

The existing `loginInBrowser(adapter, plan)` operates against the singleton `currentTabId`. Multi-context needs N concurrent logins, each on a different `TabScope`.

**New helper signature** (added to `discovery/browser-login.ts`):

```ts
export async function loginInTabScope(
  scope: TabScope,
  role: string,
  plan: BrowserLoginPlan,
  options?: { verifyTimeoutMs?: number; verifyPollMs?: number },
): Promise<LoginResult>;
```

Internally factored from `loginInBrowser` — extract the URL-and-form-fill + `verifySuccess` polling into a scope-bound function. The existing `loginInBrowser` becomes a thin adapter that wraps `withTab` + `loginInTabScope`. **Backward-compatible:** existing call sites unchanged.

This factoring is a prerequisite. If it lands as part of this spec, it costs ~30 lines and 4-6 unit tests. Track as Task 1; multi-context-runner depends on it.

### 3.5 Lifecycle event dispatch primitive

```ts
// packages/cli/src/phases/multi-context-runner.ts (or a small shim file)

export type LifecycleEventKind = 'visibilitychange' | 'pageshow' | 'pagehide' | 'freeze' | 'resume';

async function dispatchLifecycle(scope: TabScope, kind: LifecycleEventKind): Promise<void> {
  // Dispatched via evaluate. Real browser-level events (e.g. a real tab switch
  // triggering visibilitychange) are not directly fakeable from camofox MCP;
  // we dispatch the synthetic event on the document + adjust document.hidden /
  // document.visibilityState via Object.defineProperty for the duration the
  // app inspects them.
  switch (kind) {
    case 'visibilitychange':
      // Toggle to hidden, dispatch, toggle back to visible, dispatch.
      await scope.evaluate(`(function(){
        Object.defineProperty(document,'visibilityState',{get:()=> 'hidden',configurable:true});
        Object.defineProperty(document,'hidden',{get:()=> true,configurable:true});
        document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));
      })()`);
      break;
    case 'pagehide':
      await scope.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));`);
      break;
    case 'pageshow':
      await scope.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);
      break;
    case 'freeze':
      // Freeze API is Chromium-only; dispatch as a CustomEvent to verify the app
      // listens for it. Apps that don't bind 'freeze' have nothing to do; not a bug.
      await scope.evaluate(`document.dispatchEvent(new Event('freeze',{bubbles:true}));`);
      break;
    case 'resume':
      await scope.evaluate(`(function(){
        Object.defineProperty(document,'visibilityState',{get:()=> 'visible',configurable:true});
        Object.defineProperty(document,'hidden',{get:()=> false,configurable:true});
        document.dispatchEvent(new Event('resume',{bubbles:true}));
        document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));
      })()`);
      break;
    default:
      assertNever(kind);
  }
}
```

Synthetic-event dispatch is the contract. The detector verifies the app's *listeners* for these events; we are not faking real OS-level page suspension.

### 3.6 Multi-user reader/writer (`inconsistent_snapshot`)

Two contexts: writerCtx (roleA, mutating), readerCtx (roleB, read-only on the same resource).

- Pre-condition: roleB MUST already have read access to resource X (verified by an initial `GET` returning 200 in readerCtx). If readerCtx receives 401/403/404 on the resource pre-write, skip with `skipReason: 'reader_no_access'` — that's an IDOR find for v0.21, not v0.40.
- Writer fires a mutating action that produces ≥2 server-side fields changing.
- Reader polls `GET /api/.../{resourceId}` (or re-navigates to the resource's UI route and reads the rendered DOM) at three offsets:
  - **pre**: before writer fires.
  - **mid**: at writer-fire + settle/2 (≈ settle/2 ms after writer click).
  - **post**: at writer-fire + settle (≈ settle ms after writer click).
- Comparison: tear-detection algorithm in `detectInconsistentSnapshot`:
  - Compute field set diffs `pre→mid`, `mid→post`, `pre→post`.
  - If `mid` contains a strict subset of changed fields versus `post` (i.e. writer's update visible in some but not all updated fields), AND no `ETag`/`If-Match`/`X-Snapshot-Version`/`Last-Modified` header in mid's response, AND `mid` is not a 5xx/server-error response → `proof: 'torn_read'`, finding emitted.
  - If `mid` equals `pre` and `post` differs from both → snapshot is consistent (writer's update either hadn't applied at mid, or applied atomically by post). No finding.
  - If `mid` equals `post` and differs from `pre` → snapshot is consistent (writer's update applied atomically before mid). No finding.

The mid-read MUST go through a *different auth context* — that's the whole point. The reader cannot share writer's session (would defeat snapshot isolation testing).

### 3.7 Cost / runtime budget

| Variant | Default N | Per-test cost | Default cap | Total budget (default) |
|---|---|---|---|---|
| `state_divergence` | 3 | 3 logins (3-8s each) + 5s settle + consensus retries (3 default) ≈ 60-90s | 30 tests | ~30 × 75s ≈ 38 min |
| `lifecycle_state_loss` | 1 | 1 login + 5 lifecycle variants × per-variant 8-12s settle ≈ 60s | 50 tests | ~50 × 30s ≈ 25 min (variants iterated, not all in one test) |
| `inconsistent_snapshot` | 2 (fixed) | 2 logins + reader polling (10-15s window) + consensus 2-of-3 ≈ 45-60s | 30 tests | ~30 × 50s ≈ 25 min |

**Combined uncapped:** ~88 min for default settings. **Combined with `--budget 1800000` (30 min):** the planner caps each variant at floor(budget × variantShare / per-test cost). Default variant shares: state_divergence 40%, lifecycle 30%, snapshot 30%. The cap is enforced at plan time, not run time; users see the projection in `bughunter scope` (path-to-exhaustive §4.1).

**Cost-cap config:**

```ts
multiContext: {
  maxTotalDurationMs: 1800000;  // hard cap; orchestrator aborts cleanly
  maxTestsPerVariant: { state_divergence: 30; lifecycle_state_loss: 50; inconsistent_snapshot: 30 };
  perTestTimeoutMs: 120000;      // 2 min hard per-test
  consensusRunsByVariant: { state_divergence: 5; lifecycle_state_loss: 3; inconsistent_snapshot: 3 };
  consensusVotesRequiredByVariant: { state_divergence: 3; lifecycle_state_loss: 2; inconsistent_snapshot: 2 };
}
```

Stricter consensus on `state_divergence` (3-of-5 vs 2-of-3): more moving parts → higher false-positive risk → more votes required.

### 3.8 Browser-pool integration

Multi-context tests can saturate the browser pool. Add an integer `multiContextConcurrency` (default 1) — by default only ONE multi-context test runs at a time, allowing it to use up to N browser slots. This is the safest setting; users can tune up if their pool is large.

Pool reservation:
- Total slots required = N (per the tests' max N).
- Pool capacity check at validate phase. If pool capacity < N, abort with clear error: "multi-context tests require ≥N browser slots, configure browser pool ≥N".

---

## 4. Bug classification additions

### 4.1 New `BugKind`s (added to `packages/cli/src/types.ts`)

```ts
| 'multi_context_state_divergence'
| 'visibility_change_state_loss'
| 'multi_user_inconsistent_snapshot'
```

### 4.2 Priority hierarchy slotting

Inserted between v0.19 race kinds and `network_5xx` (race kinds higher; multi-context kinds lower). Within v0.40 family, `multi_user_inconsistent_snapshot` is highest (real data-leak shape), then `multi_context_state_divergence`, then `visibility_change_state_loss` (most flake-prone).

```
... (race kinds)
race_condition_click_navigate
multi_user_inconsistent_snapshot   ← new (data-integrity flavor)
multi_context_state_divergence     ← new
visibility_change_state_loss       ← new (flake-prone, lowest of family)
network_5xx
... (rest)
```

### 4.3 Flakiness handling

Multi-context tests are inherently more timing-sensitive than race tests. Defaults override the global `reRunForFlakes` setting:

- `state_divergence`: requires 3-of-5 consensus by default. 2-of-5 → `flaky: true`, excluded from auto-fix.
- `lifecycle_state_loss`: requires 2-of-3 consensus (per-lifecycle-event variant). 1-of-3 → `flaky: true`.
- `inconsistent_snapshot`: requires 2-of-3 consensus. 1-of-3 → `flaky: true`.

`--strict` disables consensus voting (every detection ships) — for power users debugging a specific suspected bug.

`--multi-context-strict-consensus N/M` overrides per-variant consensus rules (e.g. `--multi-context-strict-consensus 4/5` requires 4-of-5 for all variants).

---

## 5. Per-BugKind detector signatures

### 5.1 `detectMultiContextStateDivergence`

```ts
type StateDivergencePlan = {
  variant: { kind: 'state_divergence'; n: number; gapMs: number; settleMs: number };
  toolId: string;
  toolPath: string;
  pageRoute: string;
  /** App-declared field-level commutativity. If absent, default heuristic: any field that's a counter, list, or text-edit is non-commutative. */
  nonCommutativeFields?: string[];
};

function detectMultiContextStateDivergence(
  plan: StateDivergencePlan,
  observationsByContext: RaceObservation[][],
): BugDetection | null;
```

Algorithm:
- Read `targetSelectorHash` at the final offset (5000ms) for each context.
- If all hashes match → all contexts converged → no finding.
- If hashes differ → inspect field-level outerHTML at the final offset (cached during observation).
- Cross-tab reconciliation check: for each pair `(i, j)`, did the app fire a `storage` event OR a refetch network call between `t=2000` and `t=5000`? (Captured via `window.__bh_storage_events` and `window.__bh_fetch_log`, both seeded at navigate-time as passive observers — these instrumentation hooks already exist in v0.19's `seedHooks`.)
- If divergence persists AND no reconciliation event AND ≥1 differing field is in `nonCommutativeFields` (or matches the default-non-commutative heuristic): emit detection. Proof: `'n_way_no_reconcile'`. Evidence: list of (contextIdx, field, value) tuples up to 200 chars.

### 5.2 `detectVisibilityChangeStateLoss`

```ts
type LifecycleStateLossPlan = {
  variant: { kind: 'lifecycle_state_loss'; lifecycleEvent: LifecycleEventKind; midActionDelayMs: number; settleMs: number };
  toolId: string;
  toolPath: string;
  pageRoute: string;
};

function detectVisibilityChangeStateLoss(
  plan: LifecycleStateLossPlan,
  observations: RaceObservation[],
): BugDetection | null;
```

Algorithm:
- `pre` = obs at offset 0 (before fire).
- `optimistic` = obs at offset 100 (after fire, optimistic UI applied).
- `lifecycleAtPlus200` = obs at lifecycleAt+200 (200ms after lifecycle event).
- `final` = obs at lifecycleAt+5000 (5s after lifecycle event).
- Bug-shape A (state regression): `final.targetSelectorHash === pre.targetSelectorHash` AND `optimistic.targetSelectorState === 'optimistic'` AND no error toast at any post-lifecycle offset → action's effect was lost across the lifecycle event. Proof: `'state_lost_post_lifecycle'`.
- Bug-shape B (no error surfaced): network response after lifecycle event was non-2xx OR was aborted, AND no `dom_error_text` AND no console error AND `final.toastVisible === false` → silent failure. Proof: `'silent_failure_post_lifecycle'`.
- Bug-shape C (success+regression): `optimistic.targetSelectorState === 'final'` (response arrived between fire and lifecycle event) AND `final.targetSelectorHash === pre.targetSelectorHash` → app rolled back a successful response on lifecycle. Proof: `'rollback_post_lifecycle'`.

### 5.3 `detectMultiUserInconsistentSnapshot`

```ts
type InconsistentSnapshotPlan = {
  variant: { kind: 'inconsistent_snapshot'; writerSettleMs: number };
  writerToolId: string;
  readerEndpoint: string;
  readerHeaders?: Record<string, string>;
  pageRoute: string;
  resourceId: string;
};

type SnapshotCapture = {
  offsetMs: number;
  responseStatus: number;
  responseBody: unknown;
  headers: { etag?: string; lastModified?: string; xSnapshotVersion?: string; ifMatch?: string };
};

function detectMultiUserInconsistentSnapshot(
  plan: InconsistentSnapshotPlan,
  writerObservations: RaceObservation[],
  readerCaptures: { pre: SnapshotCapture; mid: SnapshotCapture; post: SnapshotCapture },
): BugDetection | null;
```

Algorithm:
- If any of `pre`, `mid`, `post` returned non-2xx → no finding (defer to reachability classifier).
- Compute field-set diffs:
  - `changed_pre_to_post = keys where pre[k] !== post[k]`. If empty → writer didn't change anything observable → no finding (skip with `skipReason: 'writer_noop'`).
  - `changed_pre_to_mid = keys where pre[k] !== mid[k]`. If equals `changed_pre_to_post` → mid is post-state, consistent.
  - If `changed_pre_to_mid` is empty → mid is pre-state, consistent (write hadn't applied yet).
  - Else: mid is neither pre nor post — it's a partial state.
    - If `changed_pre_to_mid ⊂ changed_pre_to_post` (strict proper subset) AND no snapshot-version header in mid → torn read. Proof: `'torn_read'`.
    - If `changed_pre_to_mid` overlaps with but isn't a subset of `changed_pre_to_post` (impossible-state scenario) → also torn but rarer. Proof: `'inconsistent_field_overlay'`.

Importantly: this detector explicitly verifies the *absence* of standard snapshot-isolation primitives. An app that returns `ETag` or `X-Snapshot-Version` is signaling intentional snapshot-aware semantics; even a torn read in that context is the app's contract, not a bug.

### 5.4 Per-variant skip reasons

| Variant | Skip reason | When |
|---|---|---|
| `state_divergence` | `idempotent_by_hint` | toolMeta.commutativityHint === 'commutative' |
| `state_divergence` | `aggressive_target_not_opted_in` | toolId matches sensitive prefix and not in aggressiveMultiContextTargets |
| `state_divergence` | `pool_capacity_insufficient` | pool capacity < N (validate-phase) |
| `lifecycle_state_loss` | `lifecycle_unsupported` | lifecycle event dispatch returns non-true (some browsers gate freeze/resume) |
| `inconsistent_snapshot` | `reader_no_access` | reader's pre-read returns 401/403/404 |
| `inconsistent_snapshot` | `writer_noop` | pre and post field sets are identical |
| `inconsistent_snapshot` | `single_role_run` | only one role present in config — no roleB available |
| All | `consensus_failed` | <required votes; finding marked `flaky` |
| All | `per_test_timeout` | exceeded `perTestTimeoutMs` |

---

## 6. Cluster signature additions (`packages/cli/src/cluster/signature.ts`)

```ts
case 'multi_context_state_divergence': {
  const tool = detection.endpoint ?? '';
  const n = detection.multiContextContext?.n ?? '';
  return `multi_context_state_divergence|${tool}|n=${n}`;
}
case 'visibility_change_state_loss': {
  const tool = detection.endpoint ?? '';
  const lifecycleEvent = detection.multiContextContext?.lifecycleEvent ?? '';
  const proof = detection.multiContextContext?.proof ?? '';
  return `visibility_change_state_loss|${tool}|${lifecycleEvent}|${proof}`;
}
case 'multi_user_inconsistent_snapshot': {
  const writer = detection.endpoint ?? '';
  const reader = detection.multiContextContext?.readerEndpoint ?? '';
  return `multi_user_inconsistent_snapshot|${writer}|${reader}`;
}
```

Including `n` keeps clusters distinct when the same endpoint is exercised under different context counts (useful to triage "this only fails at N=5+"). Including the lifecycle-event kind separates clusters per event type. Reader/writer tool pair separates snapshot-isolation findings per observed pair.

---

## 7. Multi-context orchestration architecture

### 7.1 Phase ordering inside `execute.ts`

```text
execute()
  ├─ runUiTests          (input mutation palette + happy path)
  ├─ runApiTests         (API-only)
  ├─ runRaceTests        (v0.19 race-condition variants, if enabled)
  └─ runMultiContextTests (v0.40, if enabled)  ← new, runs LAST
```

Multi-context runs LAST because:
- It's the most expensive — no point running it if the budget is already exhausted.
- It needs the largest browser-pool window — race tests have already finished, freeing capacity.
- A bug found in earlier phases often precludes the need for multi-context (an app that throws on click doesn't need multi-context state-divergence testing).

The orchestrator checks `ctx.budgetRemainingMs` before each multi-context test; aborts cleanly with `summary.multiContext.aborted = 'budget_exhausted'` if breached.

### 7.2 Variant fan-out

For each surviving (role, mutating-action) tuple from the same-shape collapse:
- `state_divergence`: 1 case per tuple (parameterized by N from `--multi-context`).
- `lifecycle_state_loss`: 1 case per `(tuple, lifecycleEvent)` pair (5 events → 5 cases per tuple).
- `inconsistent_snapshot`: 1 case per `(tuple, paired-reader-tuple)` pair where reader-tuple is on the same resource.

Cap per variant: `multiContext.maxTestsPerVariant`. Order: by tool priority + role priority. Same priority slot rules as v0.19 for tied tests.

### 7.3 Telemetry

```ts
multiContext?: {
  enabled: boolean;
  n: number;
  variantsRun: ('state_divergence' | 'lifecycle_state_loss' | 'inconsistent_snapshot')[];
  testsAttempted: number;
  testsSucceeded: number;
  testsTimedOut: number;
  testsSkipped: { reason: string; count: number }[];
  detectionsByKind: Record<string, number>;
  flakyDetections: number;
  aborted?: 'budget_exhausted' | 'pool_capacity' | 'fatal_error';
  durationMs: number;
};
```

---

## 8. CLI surface

### 8.1 New flags on `bughunter run`

```
--multi-context <N>              Enable; spawn N coordinated contexts (default 1=disabled, max 8).
--no-multi-context               Disable even if config has enabled (overrides config).
--multi-context-cross-role       Enable inconsistent_snapshot variant (requires ≥2 roles configured).
--multi-context-lifecycle        Enable lifecycle_state_loss variant (single context, multiple events).
--multi-context-snapshot         Enable inconsistent_snapshot only (mutually exclusive with cross-role flag — same thing).
--multi-context-variants <list>  Explicit subset, comma-separated.
--multi-context-strict-consensus <N/M>  Override consensus rules for all variants.
--multi-context-screenshots     Capture per-tab screenshots at final offset. Disabled by default (disk cost).
```

### 8.2 New config block (`packages/cli/src/types.ts`)

```ts
export type MultiContextConfig = {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Number of coordinated contexts to spawn for state_divergence. Default: 3, min: 2, max: 8. */
  n?: number;
  /** Which variants to run. Default: all three when enabled. */
  variants?: Array<'state_divergence' | 'lifecycle_state_loss' | 'inconsistent_snapshot'>;
  /** Lifecycle events to test for lifecycle_state_loss. Default: all five. */
  lifecycleEvents?: LifecycleEventKind[];
  /** Total budget cap for multi-context phase. Default: 1800000ms (30 min). */
  maxTotalDurationMs?: number;
  /** Per-variant test cap. Default: { state_divergence: 30, lifecycle_state_loss: 50, inconsistent_snapshot: 30 }. */
  maxTestsPerVariant?: Partial<Record<MultiContextVariant['kind'], number>>;
  /** Per-test timeout. Default: 120000ms. */
  perTestTimeoutMs?: number;
  /** Consensus runs per variant. Default: state_divergence=5, others=3. */
  consensusRunsByVariant?: Partial<Record<MultiContextVariant['kind'], number>>;
  /** Consensus votes required per variant. Default: state_divergence=3, others=2. */
  consensusVotesRequiredByVariant?: Partial<Record<MultiContextVariant['kind'], number>>;
  /** ToolId glob patterns considered too sensitive without explicit opt-in. */
  aggressiveMultiContextTargets?: string[];
  /** Field-level commutativity overrides. Default: read from toolMeta.commutativityHint. */
  nonCommutativeFieldsByTool?: Record<string, string[]>;
  /** Concurrency cap for multi-context tests. Default: 1. */
  multiContextConcurrency?: number;
};
```

Attached to `BugHunterConfig` as `multiContext?: MultiContextConfig`.

### 8.3 Validate-phase guards

- `enabled === true` AND `n < 2` → fatal error: "multi-context requires N ≥ 2".
- `enabled === true` AND `n > 8` → fatal error: "multi-context N > 8 is not supported (compute/memory cap)".
- `resetPolicy === 'per-run'` AND `enabled === true` → fatal: "multi-context tests require per-test or per-page reset".
- `enabled === true` AND `inconsistent_snapshot` in variants AND `<2 roles configured` → warning, skip variant.
- `enabled === true` AND browser-pool capacity < N → fatal: "configure browser pool ≥N".

---

## 9. Edge cases (false-positive sources especially)

### EC-1. Real but flaky finding (≤2-of-5 reproduces for state_divergence)
Marked `flaky: true`, excluded from auto-fix, surfaced separately.

### EC-2. App uses CRDT / OT / yjs / automerge
True commutative semantics. State-divergence is expected to converge. If the app's `toolMeta` declares `commutativityHint: 'commutative'`, planner skips with `skipReason: 'commutative_by_hint'`. If unhinted, default heuristic may false-positive — user must add the hint.

### EC-3. Last-write-wins is the documented contract
Not a bug. The DETECTOR'S non-commutative-field heuristic flags counter / list / text-area; docs declare LWW; user must add the hint. Document this in the killer-demo runbook.

### EC-4. `state_divergence` with N=2 collides with v0.19 `cross_tab`
Different runner, different consensus. By design they may BOTH fire and BOTH cluster on the same root cause. De-duplication step in classify: if a cluster's signature in v0.40 family overlaps with a v0.19 cross_tab cluster on `(toolId, role)`, mark v0.40 cluster as `secondaryObservation` (not duplicate report — but not double-counted in `summary.bugCount`).

### EC-5. `lifecycle_state_loss` with `freeze`/`resume` on non-Chromium browsers
Synthetic event dispatch always succeeds; the app may or may not bind a listener. If app doesn't bind, no observable effect, no finding. Correct behavior.

### EC-6. `visibilitychange` to hidden during pending fetch — app correctly cancels
Some apps cancel pending requests on `visibilitychange`. If response was canceled and UI shows pre-state, the detector should NOT fire for `state_lost_post_lifecycle`. Distinguishing canceled-by-app from lost-by-bug: if there's an `AbortError` in `consoleErrorCount` OR a fetch entry in `window.__bh_fetch_log` with `aborted: true`, the cancel was intentional. Detector checks for these and downgrades the finding to a `secondaryObservation`.

### EC-7. `inconsistent_snapshot` with MVCC database
Most modern DBs return snapshot-consistent reads at row-level. A real torn read at the API surface usually means the API stitched together multiple queries non-transactionally. Detector specifically targets this: it reads JSON fields, not DOM, so the `mid` capture's body shape vs `pre`/`post` is the canonical diagnosis.

### EC-8. `inconsistent_snapshot` reader's session expires mid-run
Reader gets 401 at `mid` or `post`. Detector skips with `skipReason: 'reader_session_lost'` rather than emit a false torn read.

### EC-9. Pool exhaustion mid-run
N+1 contexts attempted; pool returns insufficient capacity. Each test acquires its own; orchestrator observes timeout and emits `aborted: 'pool_capacity'`. No partial findings emitted from the failed test.

### EC-10. Lifecycle event fires AFTER response arrived
Race condition on race condition. Detector observes `lifecycleAt+200` and finds `targetSelectorState === 'final'`; if `final.targetSelectorHash === lifecycleAt+200.targetSelectorHash` → no regression → no finding. Detector relies on the at-event boundary observation, not the final-only.

### EC-11. State-divergence with auto-refresh polling
Some apps poll their resource every Ns. If poll interval < settle window (5s), all N tabs converge on the polled refresh. Detector sees uniform final state → no finding. Correct: app's reconciliation works.

### EC-12. State-divergence under offline mode
If contexts are simulated offline by the test harness (not v0.40's job), divergence is expected. v0.40 explicitly does NOT manipulate network; an app that's offline is an integration smoke failure, not a multi-context bug.

### EC-13. `inconsistent_snapshot` on streaming responses (chunked transfer)
Mid-poll might catch a partial JSON parse. Reader uses standard `fetch().json()` — fails on partial. Detector treats parse failure as 5xx-equivalent and skips with `skipReason: 'reader_parse_failed'`. Streaming-response correctness is a separate v0.41 concern.

### EC-14. Sibling-pairing for `inconsistent_snapshot` reader
Heuristic: pair (writerToolId, readerToolId) where readerToolId is the simplest GET on the same resource shape (e.g. `GET /api/users/:id` paired with `PATCH /api/users/:id`). If multiple GETs match (`/api/users/:id` and `/api/users/:id/profile`), pair with the broadest one. User can override via `multiContext.snapshotPairs: [{ writer, reader }]`.

### EC-15. Multi-tab session cookie collision
SaaS apps often sync session via shared cookie domain. N contexts opened via `withTab` get separate browser-context cookie jars (camofox isolates per-context). They CAN share a session if the user logs in N times with the same role. Same-role login N times is fine; the app is supposed to handle multiple active sessions per user. This is a common production scenario, not an edge case.

### EC-16. `state_divergence` action mutates a list (append)
Lists are non-commutative when ordering matters. If app uses stable IDs and idempotent appends (e.g. UUID-keyed), N contexts appending produce N-record convergent state. If app uses auto-increment IDs and re-orders by insert time, N contexts produce N-record divergent state (different orderings on different tabs). The non-commutative-fields heuristic flags lists by default; toolMeta opt-out for stable-ID lists.

### EC-17. Camofox MCP doesn't expose `dispatchEvent` reliably for `freeze`
Validate-phase capability check evaluates a probe: `(typeof Event!=='undefined' && typeof document.dispatchEvent==='function')`. If false → skip lifecycle variant. (Practically always true.)

### EC-18. Hot-reload during test
Dev-server hot-reload can fire mid-test, invalidating contexts. Existing v0.16 hot-reload-detector applies: if any context's `__bh_hot_reload` flag was set during the test, skip with `skipReason: 'hot_reload_during_test'`.

---

## 10. Acceptance criteria

| Criterion | Verifier |
|---|---|
| All new unit tests pass (variants, planner, runner, three detectors, fire-gate) | `npm test -- multi-context` |
| Synthetic fixture `fixtures/multi-context-bad/` produces ≥1 finding per sub-kind with correct `multiContextContext` field | `npm test -- tests/integration/multi-context-smoke` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| `summary.json.multiContext` block populated when enabled | `jq '.multiContext' summary.json` |
| Default disabled — `bughunter run` with no flag does NOT run multi-context | smoke + assertion |
| `--multi-context 3` enables; `--no-multi-context` disables when config has `enabled: true` | CLI test |
| `--multi-context 9` is rejected at validate phase | validate-phase test |
| `--multi-context 3` AND `resetPolicy: 'per-run'` aborts validate phase with clear error | validate-phase test |
| Browser pool capacity < N → fatal validate error | validate-phase test |
| `state_divergence` requires 3-of-5 consensus by default; 2-of-5 marked `flaky` | unit test on consensus voting |
| Sensitive prefix toolId NOT in `aggressiveMultiContextTargets` produces no finding | planner test |
| `commutativityHint: 'commutative'` skips `state_divergence` with reason `'commutative_by_hint'` | planner test |
| Per-test timeout (120s) interrupts a stalled test cleanly with `testsTimedOut += 1` | integration test |
| Fire-gate skew under N=4 is bounded (<50ms p95) | integration test counting per-context fire timestamps |
| `inconsistent_snapshot` with reader 401 at `pre` skips with `'reader_no_access'` | unit test |
| `inconsistent_snapshot` with `pre === post` (no-op writer) skips with `'writer_noop'` | unit test |
| `lifecycle_state_loss` with the lifecycle event fired AFTER response arrived produces no finding when `final` state is consistent | unit test |
| `multi_context_state_divergence` cluster signature includes `n` | signature test |
| Multi-context phase aborts when `budgetRemainingMs <= 0` and emits `aborted: 'budget_exhausted'` | integration test |

---

## 11. Files to touch / add (under `packages/cli/src/`)

### Files to create

| File | Why |
|---|---|
| `packages/cli/src/security/multi-context-variants.ts` | `MultiContextVariant` discriminated union + planner helpers (`plansForActionTuple`, `pairSnapshotReader`). |
| `packages/cli/src/security/multi-context-variants.test.ts` | Unit tests for variant construction, sibling pairing for snapshot reader. |
| `packages/cli/src/security/multi-context-detectors.ts` | The three pure-function detectors. |
| `packages/cli/src/security/multi-context-detectors.test.ts` | Unit tests with synthetic observations. |
| `packages/cli/src/phases/multi-context-runner.ts` | `executeMultiContextTest(testCase, ctx)` + fire-gate + N-context orchestration + lifecycle dispatch. |
| `packages/cli/src/phases/multi-context-runner.test.ts` | Unit + integration tests against a mock browser. |
| `fixtures/multi-context-bad/` | Express + minimal React client demonstrating one bug per sub-kind (LWW counter for state-divergence; visibility-change abort bug for lifecycle; non-transactional read endpoint for snapshot). |
| `tests/integration/multi-context-smoke.test.ts` | End-to-end smoke against `fixtures/multi-context-bad/`. |

### Files to modify

| File | Change |
|---|---|
| `packages/cli/src/types.ts` | Add 3 new `BugKind`s; add `MultiContextConfig`, `MultiContextVariant`, `MultiContextDetectionContext`, `MultiContextObservation` (= `RaceObservation` re-export); add `multiContextContext?: MultiContextDetectionContext` to `BugDetection`; add `multiContext?` to `BugHunterConfig`; add `multiContext?` to `RunSummary`. |
| `packages/cli/src/discovery/browser-login.ts` | Extract `loginInTabScope(scope, role, plan, opts)` helper; refactor `loginInBrowser` to use it. |
| `packages/cli/src/discovery/browser-login.test.ts` | Unit tests for `loginInTabScope`. |
| `packages/cli/src/phases/plan.ts` | Third pass: filter mutating-action happy-palette tuples; emit multi-context tests per enabled variant. |
| `packages/cli/src/phases/plan.test.ts` | Unit tests for the third pass. |
| `packages/cli/src/phases/execute.ts` | Branch on `testCase.multiContext !== undefined` → `executeMultiContextTest`. Phase ordering: race-tests → multi-context-tests. |
| `packages/cli/src/phases/classify.ts` | Add 3 entries to `KIND_PRIORITY`; secondary-observation rule for v0.19 `cross_tab` overlap. |
| `packages/cli/src/cluster/signature.ts` | Replace empty/default cases with three new sub-kind cases (§ 6). |
| `packages/cli/src/cluster/signature.test.ts` | Add tests for new sub-kind signatures. |
| `packages/cli/src/cli/run.ts` | Wire new flags. |
| `packages/cli/src/phases/validate.ts` | Add multi-context guards (N range, reset policy, pool capacity, lifecycle support probe). |
| `packages/cli/src/phases/emit.ts` | Populate `summary.multiContext` telemetry. |
| `packages/cli/src/cli/init.ts` | If `--no-interactive` is off, optionally prompt for `multiContext.aggressiveMultiContextTargets` starter list. |

---

## 12. Negative requirements

- Do **not** ship a fourth multi-context pattern in v0.40 (no four-way operational transform, no multi-context+route-fulfill compound, no multi-context+xss compound). One pattern per bug-shape; ship validated.
- Do **not** retry on consensus failure with bigger N. If `N=3` doesn't reproduce divergence, the bug isn't reliably reproducible; it's flaky, not "try harder".
- Do **not** mix v0.19 race tests with v0.40 multi-context tests inside a single test case. Distinct phases, distinct lifecycles.
- Do **not** treat `flaky` multi-context findings as silent skip. Surface in `bugs.jsonl` + `summary.flakyDetections`. Flaky multi-context detection is itself a real signal even if not auto-fixable.
- Do **not** instrument app code (no monkey-patches, no React hooks). Detectors read observable state via `evaluate`.
- Do **not** ship `inconsistent_snapshot` enabled-by-default. It requires a second auth role, doubles cost, and false-positive risk on poorly-instrumented `ETag` headers is real. Opt-in via `--multi-context-cross-role` or `multiContext.variants` config.
- Do **not** persist per-tab cookie jars or tokens beyond the test's lifetime.
- Do **not** count multi-context tests against `--max-bugs` cluster cap separately. Shared budget.
- Do **not** support N>8. Hard-cap.
- Do **not** plant aggressive variants on auth/payment/oauth endpoints without explicit opt-in.
- Do **not** force-fail responses (no `routeFulfill`). Multi-context tests are honest-success-path coordination tests; mixing with forced failures breaks the test contract.
- Do **not** screenshot per-tab by default. Disk-budget guard.

---

## 13. Risks + escape hatches

- **Slow tests (38min default budget)**: enforce `maxTotalDurationMs` cap; budget-aware planner emits projection in `bughunter scope`; users see cost upfront. Default disabled — opt-in.
- **False-positive flood on flake-prone apps**: stricter consensus voting (3-of-5 default for state_divergence vs 2-of-3 for race), flaky findings excluded from auto-fix.
- **N parallel logins overwhelm rate-limit**: per-tab login uses existing rate-limit-discovery telemetry; if a 429 is observed during multi-context login, skip the test and emit `skipReason: 'rate_limited_during_login'`.
- **Browser-pool starvation**: `multiContextConcurrency: 1` default; one multi-context test at a time. Users with large pools tune up.
- **Lifecycle synthetic events don't exercise real freeze/resume**: documented limitation. Synthetic dispatch verifies the listener path, not the real OS suspend. A v0.41 enhancement could integrate Playwright's `context.setOffline()` + tab-suspend simulation.
- **`state_divergence` false-positives on LWW-by-design apps**: `commutativityHint` opt-out; default heuristic has known false-positive shape; documented in killer-demo runbook.
- **Escape hatch**: `--no-multi-context` disables everything regardless of config. `--multi-context 1` is treated as disabled.

---

## 14. Killer-demo runbook

```bash
# Synthetic fixture
cd /root/BugHunter && npm test -- tests/integration/multi-context-smoke
# Expect ≥1 finding per sub-kind in fixtures/multi-context-bad.

# SaaS app opt-in (low-noise, 3 contexts default)
cd /root/Aspectv3
# .bughunter/config.json: "multiContext": { "enabled": true, "n": 3,
#   "aggressiveMultiContextTargets": ["/api/users/*", "/api/projects/*"],
#   "variants": ["state_divergence", "lifecycle_state_loss"] }
node /root/BugHunter/packages/cli/dist/cli/main.js run --multi-context 3 \
  --multi-context-lifecycle --max-bugs 50 --budget 3600000

RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.multiContext, (.byKind | with_entries(select(.key | startswith("multi_context_") or startswith("visibility_change_") or startswith("multi_user_inconsistent_"))))' \
   /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Expect ≤3 findings, ≥80% real after triage.

# Cross-role snapshot probe (requires a second role configured)
node /root/BugHunter/packages/cli/dist/cli/main.js run --multi-context 3 \
  --multi-context-cross-role --max-bugs 50 --budget 3600000

# Strict mode (debugging a specific bug)
node /root/BugHunter/packages/cli/dist/cli/main.js run --multi-context 3 \
  --multi-context-strict-consensus 5/5
```

---

## 15. Definition of Done

- [ ] All Tasks below complete and reviewed.
- [ ] `npx tsc --noEmit` and `npx eslint . --max-warnings 0` pass.
- [ ] All new unit tests + integration smoke pass.
- [ ] Synthetic fixture `fixtures/multi-context-bad/` produces correct findings per kind.
- [ ] `summary.json.multiContext` populated under `--multi-context 3`.
- [ ] Killer-demo runbook reproduces clean output on Aspectv3 (≤3 findings, ≥80% triaged real).
- [ ] No regressions in existing v0.19 race-runner tests.
- [ ] `bughunter scope` (path-to-exhaustive §4.1, when implemented) reflects multi-context test counts.
- [ ] Documentation block in `packages/cli/src/types.ts` describing the three new BugKinds.

---

## 16. Task breakdown (agent-sized)

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Extract `loginInTabScope` from `loginInBrowser`; backward-compat shim | `discovery/browser-login.ts`, `discovery/browser-login.test.ts` | none |
| 2 | Add 3 new `BugKind`s + `MultiContextConfig` + `MultiContextDetectionContext` types | `types.ts` | none |
| 3 | Implement `MultiContextVariant` discriminated union + planner helpers | `security/multi-context-variants.ts`, `.test.ts` | 2 |
| 4 | Implement three pure-function detectors with unit tests against synthetic observations | `security/multi-context-detectors.ts`, `.test.ts` | 2,3 |
| 5 | Implement `multi-context-runner.ts` orchestrator (fire-gate, lifecycle dispatch, N-context spawning, consensus voting) with mocked-browser tests | `phases/multi-context-runner.ts`, `.test.ts` | 1,2,3,4 |
| 6 | Add planner third pass (multi-context test minting, cap enforcement) | `phases/plan.ts`, `phases/plan.test.ts` | 3 |
| 7 | Wire executor branch on `testCase.multiContext` + phase ordering after race-tests | `phases/execute.ts` | 5,6 |
| 8 | Add three entries to `KIND_PRIORITY` + secondary-observation overlap rule for v0.19 `cross_tab` | `phases/classify.ts` | 2 |
| 9 | Add three new cluster-signature cases | `cluster/signature.ts`, `cluster/signature.test.ts` | 2 |
| 10 | Validate-phase guards (N range, reset policy, pool capacity, lifecycle support probe) | `phases/validate.ts` | 2 |
| 11 | CLI flags + arg parsing | `cli/run.ts` | 2 |
| 12 | Telemetry block in `summary.multiContext` | `phases/emit.ts` | 5 |
| 13 | Build `fixtures/multi-context-bad/` (Express + React) with one deliberate bug per sub-kind | `fixtures/multi-context-bad/**` | none (parallelizable with 5+) |
| 14 | End-to-end integration smoke against fixture | `tests/integration/multi-context-smoke.test.ts` | 5,6,7,11,13 |
| 15 | Killer-demo runbook + Aspectv3 manual smoke | manual | 14 |

---

## 17. Open questions

1. **N=2 collision with v0.19 `cross_tab` — same kind or distinct?** Spec says distinct (`multi_context_state_divergence` is its own kind even at N=2; v0.19 `cross_tab` is its own kind). Reviewers may prefer collapsing v0.19 `cross_tab` into `multi_context_state_divergence` at N=2 — simplifies the priority hierarchy at the cost of a v0.19 type-migration. Defer to implementation review.

2. **Lifecycle-event variant — five events as one BugKind, or split?** Spec uses one kind with `lifecycleEvent` in cluster signature. Splitting into 5 kinds (one per event) would clutter the `BugKind` union but enable per-event severity. Lean unified-with-discriminator; revisit if any single event proves fundamentally different in fix-shape.

3. **Default N — 3 or 4?** 3 is the minimum to expose N-way divergence beyond pairwise. 4 catches more (e.g. consensus algorithms that work at N=3 but break at N=4 due to even-vote tie-breaking) but costs ~33% more. Lean N=3 default, document N=4 as a recommended override for collaborative-editing apps.

4. **Synthetic lifecycle dispatch vs real Playwright `context.suspend()`?** Real suspend is more authentic but Playwright support varies; synthetic events are universal and verify the listener-binding path which is the most common bug shape. Lean synthetic for v0.40; real-suspend as v0.41 enhancement.

5. **Reader-role default for `inconsistent_snapshot`?** Spec auto-pairs writer+reader from the same-resource heuristic (EC-14). Reviewers may prefer requiring explicit `multiContext.snapshotPairs` config. Auto-pair-with-explicit-override is the chosen middle ground.

6. **Pool-capacity check at validate vs runtime?** Spec checks at validate. If pool is shared with other test phases and has variable capacity at runtime, validate-time check may be optimistic. Lean validate-time + runtime fallback (pool acquire timeout ⇒ test skip with `pool_capacity_insufficient`).

7. **`window.__bh_storage_events` instrumentation seed-time vs login-time?** Spec assumes seed-time (existing v0.19 hooks). If those hooks aren't running on multi-context tabs (each `withTab` may be a fresh context without seed), need to re-seed per tab. Confirm in implementation; if re-seed needed, add `seedHooks(scope)` helper.

8. **Should `state_divergence` test all N contexts firing at gap=0, or stagger?** Spec: gap=0 (all fire on the same gate release). Staggering at e.g. 50ms intervals could expose race conditions that gap=0 doesn't (e.g. server's first-write-wins vs race-into-write-lock). Defer to v0.41; gap=0 is the most-extreme stress case.

9. **Cost projection in `bughunter scope`?** Path-to-exhaustive §4.1 is unimplemented; this spec assumes it lands first (or at minimum, document the projected runtime in the run-start log). Track separately.
