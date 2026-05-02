# SPEC — v0.20 "Network-fault injection palette"

**Status:** Draft 1 — open questions outstanding · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Sibling specs:** `SPEC_V16_PEN_TESTING.md` (palette+classifier addition pattern), `SPEC_V07_XSS.md` · **Predecessor:** v0.18 JWT-aware login verify · **External dep risk:** camofox-mcp v0.1 has no network-conditioning surface — see § 6.

This spec adds an **opt-in network-fault test mode** that injects degraded-network conditions during action execution and observes how the UI handles them. Modern apps lean on optimistic UI, retries, and offline modes, none of which BugHunter currently exercises. "Works on fast connection" hides the most common error-handling failures: infinite loaders, silent dropped requests, optimistic state never rolling back, retry storms hammering the server. Three new BugKinds, an eight-variant fault palette, and per-(role, mutating-action) scheduling. The detection signals come from BOTH the client (UI state delta in the post-state observation window) and the request side (retry-storm rate over the asyncMaxWait window).

---

## 1. Objective

Add a fault-injection runner that wraps mutating UI actions with one of eight network faults, then classifies the resulting client-side and request-side behaviour. Three new BugKinds:

| Kind | Invariant tested |
|---|---|
| `network_fault_unhandled` | Under a fault, the UI shows an explicit error state OR retries OR rolls back. None of those firing post-fault is the bug. |
| `network_fault_optimistic_no_revert` | Under a fault, the UI initially renders the success state (optimistic) but never reverts when the request fails or never completes. |
| `infinite_loading` | A loading spinner / skeleton / `aria-busy="true"` region is present at action time and persists past `asyncMaxWaitMs` after the fault. No success, no error, just spinning. |

The runner is **opt-in** (`config.networkFaults.enabled`, default `false`), **mutating-action-only by default** (read-only navigation skipped), and **same-shape collapsed** (one fault test per (role, collapsed-form-or-button signature, fault variant)). Default per-test cost is bounded at `asyncMaxWaitMs * 1.5` (default 30s × 1.5 = 45s) to ensure forward progress. A typical run with 50 mutating actions × 8 fault variants is bounded to ~50 × 8 × 45s = 5h, which is why same-shape collapsing and per-tool opt-out are first-class.

**In scope:**
- Eight fault variants (table § 4) wrapped around mutating actions.
- Three new `BugKind`s with cluster signatures + priority slots.
- A `NetworkFaultRunner` orchestrating fault → action → observe → restore per test.
- Browser-side fault injection via the camofox adapter, **gated by a capability check** (§ 6).
- Per-(role, action) scheduling with same-shape collapse.
- Retry-storm detector: count post-fault same-endpoint requests; flag if >`retryStormThresholdRps`.
- Telemetry on `summary.json.networkFaults` (faults attempted / succeeded / skipped / detections by kind).
- CLI flag `--network-faults`; config block `networkFaults`.
- Per-tool opt-out: `networkFaults.toolDenylist` to skip specific endpoints (e.g. payments, OAuth handshake).

**Out of scope (deferred):**
- WebSocket / SSE fault injection — paired with WebSocket discovery, deferred to v0.21.
- DNS-level faults (resolution failure) — Playwright/Camoufox doesn't expose a DNS hook on Firefox; punt to v0.21 if a real target needs it.
- Cross-origin fault scoping — v0.20 faults all in-flight requests during the action's window. Per-host scoping is in v0.21.
- Mid-response truncation that's not "after N bytes" — v0.21.
- API-direct-call fault testing (only the UI path runs faults; API direct-calls don't exercise UI handling). Out of scope on principle.
- Read-only navigation fault testing — too noisy, low yield, off by default. Opt in via `networkFaults.includeNavigation = true`.
- Stateful fault sequences ("fail first, succeed second") — useful for retry-storm tests but adds matrix complexity. Defer to v0.21 once `intermittent` data shows the gap.

**Acceptance target on a synthetic fixture:**
A new fixture `fixtures/network-faults-bad/` ships four buggy routes (one per BugKind shape):
- A todo-add form with optimistic UI that never reverts on fail → `network_fault_optimistic_no_revert`.
- A button whose click triggers a fetch with no error UI → `network_fault_unhandled`.
- A list page whose loading skeleton never resolves under offline → `infinite_loading`.
- A retry-on-failure loop with no backoff → cluster a `network_fault_unhandled` finding tagged with `retryStormDetected: true`.

Smoke must produce ≥1 finding per BugKind with the correct fault variant and proof field. Negative smoke on TraiderJo / Aspectv3: zero findings expected on routes the apps already test (manual verification required after first run; non-blocking for spec acceptance).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union, `BugDetection`, `PostState`, `BugHunterConfig`. **Extend** — three new BugKind variants, new `networkFaultContext` field on BugDetection (mirror `injectionContext` from v0.16). |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. Slot the three new kinds (see § 5). |
| `packages/cli/src/cluster/signature.ts` | Cluster-signature derivation. Add three new cases (see § 7). |
| `packages/cli/src/phases/execute.ts` | `executeUiTest` and the `withTab` wrapper. The fault runner wraps **inside** `withTab` so that the fault tooling and cleanup are bound to the tab's lifetime. |
| `packages/cli/src/phases/plan.ts` | Test plan generation. The planner emits one network-fault TestCase per (role, mutating-action, fault-variant) post-collapse. |
| `packages/cli/src/adapters/browser-mcp.ts` | `BrowserMcpAdapter` interface + `TabScope`. Extend with optional `applyNetworkFault(spec): Promise<{applied:boolean, reason?:string}>` and `clearNetworkFault(): Promise<void>`. **Optional** because camofox-mcp v0.1 doesn't ship the underlying tools — see § 6. |
| `packages/cli/src/security/pen-test-runner.ts` | Pattern for an opt-in, telemetry-emitting runner that lives alongside execute. Mirror its shape — config struct + result struct + `run*()` function. |
| `packages/cli/src/security/injection-palette.ts` | Pattern for a discriminated-union variant table. Mirror in a new `network-fault-palette.ts`. |
| `SPEC.md` § 3.5.1 | Priority hierarchy rule — single occurrence emits one canonical kind. The fault runner must respect this. |
| `SPEC.md` § 8 | Config schema. Add `networkFaults` block. |
| `/opt/camofox-mcp/index.ts` (read-only, external) | Camofox MCP tool list. Confirm: navigate / snapshot / click / type / scroll / screenshot / evaluate / list_tabs / close_tab. **No network conditioning, no fetch interception.** This is the v0.20 dependency surface. |
| `/root/.openclaw/extensions/camofox-browser/server.js` (read-only, external) | The Express server camofox-mcp wraps. Uses Playwright Firefox via Camoufox. Playwright Firefox supports `BrowserContext.setOffline()` and `page.route()` — but neither is currently exposed via HTTP. v0.20 needs these endpoints added. |

### 2.2 Patterns to follow

- **Opt-in, telemetry-emitting runner.** Mirror `runPenTests` (v0.16). The fault runner is invoked AFTER plan, BEFORE execute schedules begin — it generates a separate phase whose results are merged into the main TestResult stream.
- **Capability check at validate phase.** If `networkFaults.enabled === true` but the camofox adapter's `applyNetworkFault` is undefined OR returns `{applied:false}` on a probe call, ABORT the run with an explicit error (don't silently skip — silent skipping is the most painful failure mode for opt-in features).
- **Action observation reuses execute's MutationObserver + network capture pipeline.** No new observation infra. The fault runner injects the fault, calls the existing `executeUiTestInner`, then classifies the result in light of `expectedOutcome: 'expected_failure'` (see § 5.4).
- **Discriminated-union returns** for the runner: `{ ok: true; finding: BugDetection } | { ok: true; finding: null } | { ok: false; reason: string }`.
- **Per-test cleanup is mandatory.** Every fault test must restore the tab to a no-fault state in `finally`. Leaked fault state poisons subsequent tests in the same browser context. Use `withTab` so the tab is destroyed even if cleanup fails.

### 2.3 DO NOT

- Do **not** plant network faults during read-only navigation by default. Only mutating-action-bound test cases get faults. Opt in via `networkFaults.includeNavigation`.
- Do **not** create a new browser adapter or duplicate `CamofoxBrowserMcpAdapter`. Extend with optional methods.
- Do **not** silently degrade if camofox lacks the underlying tools. Validate at startup; abort with a clear "camofox-mcp v≥0.2 required" error.
- Do **not** classify a fault test's downstream 5xx as `network_5xx` — the fault is the cause, and `expectedOutcome: 'expected_failure'` carries that signal. The classifier MUST be taught to suppress `network_5xx` and `network_4xx_unexpected` when the parent TestCase's `faultInjected !== undefined`.
- Do **not** run fault tests against tools tagged `sideEffectClass: 'external'` (Stripe, SendGrid, etc.) — already excluded from happy-palette tests; reuse the existing skip logic.
- Do **not** retry fault tests. A flaky fault test (`reRunForFlakes`) doubles cost. Opt out by skipping fault tests in the rerun pass; mark them `flakySkipped: true` for traceability.

---

## 3. Architecture decisions

### 3.1 Where the fault runner lives in the pipeline

```
plan        — generates network-fault TestCases tagged faultVariant + faultExpectedFailure
execute     — runs them via the standard executeUiTest path; the executor sees
              tc.faultInjected !== undefined and wraps the action in
              applyNetworkFault → action → clearNetworkFault.
classify    — sees expectedOutcome: 'expected_failure' and faultInjected !== undefined.
              Suppresses network_5xx / network_4xx_unexpected for that test result.
              Runs three new detectors: unhandled, optimistic-no-revert, infinite-loading.
cluster     — uses the cluster signatures of § 7.
```

The fault runner is NOT a new phase. It's a **planner output + executor branch + classifier extension**, mirroring how XSS canaries (v0.7) and pen-testing (v0.16) layered new behaviour on the existing pipeline. This keeps the resume-validity, artifact-budget, and stop-and-emit logic untouched.

### 3.2 Browser-adapter capability extension

`BrowserMcpAdapter` gains two optional methods:

```ts
export type NetworkFaultSpec =
  | { kind: 'offline' }
  | { kind: 'slow_3g' }
  | { kind: 'high_latency'; latencyMs: number }
  | { kind: 'timeout_at_request' }
  | { kind: 'timeout_at_response' }
  | { kind: 'intermittent'; dropEveryN: number }
  | { kind: 'server_5xx'; status: 500 | 502 | 503 }
  | { kind: 'malformed_response'; mode: 'truncated_json' | 'wrong_content_type' };

export type ApplyNetworkFaultResult =
  | { applied: true }
  | { applied: false; reason: 'tool_not_available' | 'fault_unsupported' | string };

interface BrowserMcpAdapter {
  // ... existing methods ...
  /**
   * v0.20: install a network fault on the tab's browser context.
   * Optional — older camofox-mcp builds don't ship this tool.
   * Implementations MUST be idempotent — calling apply twice replaces the spec.
   */
  applyNetworkFault?(fault: NetworkFaultSpec): Promise<ApplyNetworkFaultResult>;
  /** v0.20: remove any network fault. Idempotent. Always succeeds (or throws transport). */
  clearNetworkFault?(): Promise<void>;
}
```

The same two methods appear on `TabScope` so the executor can apply faults from inside `withTab(...)`.

### 3.3 Classifier integration

Three new detectors live under `packages/cli/src/classify/` (mirror `request-hygiene.ts` style):
- `classify/network-fault-unhandled.ts`
- `classify/network-fault-optimistic-revert.ts`
- `classify/infinite-loading.ts`

Each is a pure function that takes `(preState, postState, faultSpec, expectedOutcome): BugDetection | null`. They run only when `tc.faultInjected !== undefined`, which the classifier can read off the TestCase via `TestResult.testId → testCase` lookup (already wired through emit).

### 3.4 Retry-storm detection

Counted off the existing `postState.networkRequests` array. Group by normalized endpoint; if any endpoint has >`retryStormThresholdRps` requests/sec over the post-action window, attach `retryStormDetected: true` to the `networkFaultContext` (as a flag, not its own BugKind — it's a co-symptom of `network_fault_unhandled`). Default threshold: 10 req/sec. Tunable via config.

### 3.5 Cost control

Three layers:

1. **Same-shape collapse.** A fault test inherits the same collapsed signature as its underlying action; one fault test per (role, fault-variant, collapsed-action-signature). 50 buttons sharing a signature → 1 fault test per variant per role, not 50.
2. **Per-action wall-clock cap.** Hard cap = `asyncMaxWaitMs * 1.5` (default 45s). The executor enforces it via existing per-test 30s default — for faults specifically, the cap is `Math.min(asyncMaxWaitMs * 1.5, 60_000)`. Beyond that, mark `infrastructure_failure` and move on. This prevents `timeout_at_response` from running indefinitely.
3. **Bounded fault matrix.** `networkFaults.maxFaultTests` (default 200, per role). When exceeded, sampling is uniform-random over (action, variant) pairs.

### 3.6 Reset semantics between fault tests

After every fault test:
- `clearNetworkFault()` called in `finally`.
- `withTab` closes the tab unconditionally; a fresh tab is born for the next test.
- Tab close is the strongest cleanup boundary available — Playwright's offline / route state is per-context, but per-tab closure prevents stale state from leaking even if our cleanup is buggy.
- The next test in the queue (fault or happy-path) gets a clean browser context.

Acceptance: a happy-path test scheduled IMMEDIATELY after a fault test must observe zero residual fault behaviour. This is verifiable in a unit test against a mocked adapter (verify `clearNetworkFault` was called) and in the integration smoke (alternate fault and happy-path on the synthetic fixture; confirm happy passes cleanly).

---

## 4. Network-fault palette

Eight variants, named `kind` on `NetworkFaultSpec` (§ 3.2). Each defines the on-the-wire behaviour, expected client signal under a correctly-handling app, and our detection rule.

| Variant | On-wire effect | Correct client behaviour | Bug if observed |
|---|---|---|---|
| `offline` | All requests fail with `net::ERR_INTERNET_DISCONNECTED` (or platform equivalent). Sets browser context to offline. | Show offline banner OR error toast OR queue+retry on reconnect. | No DOM error text, no error region, no rollback of optimistic state. |
| `slow_3g` | 400 kbps down/up, 400ms RTT, no packet loss. Throughput throttled, but requests complete. | Either succeed (slowly) or show progress UI. | If request would have completed in <1s on fast: now takes 4-10s. Skeleton/spinner showing is correct. Bug = no progress indicator. (Detection here is weak; this variant's main job is to surface flakiness on real-world slow paths, not on its own.) |
| `high_latency` | Add `latencyMs` (default 5000ms) artificial delay before request hits server. | Show loading state during the delay. | No loading state OR optimistic state shown then never reverted (request still pending past asyncMaxWait). |
| `timeout_at_request` | Drop the request before it leaves the browser; client never sees a response and never sees a connection. | Time out and show error after some configured client timeout. | Spinner forever (no client timeout configured). |
| `timeout_at_response` | Let request go; intercept response; never deliver it. Browser sees pending request. | Same as above — should client-timeout. | Spinner forever. |
| `intermittent` | Drop every Nth same-endpoint request. Default N=2 (drop every other). | Retry with backoff — 1st fails, 2nd succeeds, etc. | No retry: 1st fails, UI errors out. Retry storm: 50 retries in 1s. |
| `server_5xx` | Intercept response; rewrite to status 500/502/503 with realistic JSON shape (`{"error": "Internal server error"}` for 500; nginx-shaped HTML for 502; `Retry-After: 30` header for 503). | Show error UI; respect `Retry-After` if 503. | No error UI; or 503 ignored (retry storm without backoff). |
| `malformed_response` | Intercept response; either truncate JSON mid-object OR change `Content-Type` to `text/plain`. | Catch the parse error; show error UI. | Unhandled exception in console (parse error bubbles up); or silent failure with no UI feedback. |

### 4.1 Per-variant defaults

```ts
const DEFAULT_FAULT_PALETTE: NetworkFaultSpec[] = [
  { kind: 'offline' },
  { kind: 'high_latency', latencyMs: 5000 },
  { kind: 'timeout_at_response' },
  { kind: 'server_5xx', status: 500 },
  { kind: 'intermittent', dropEveryN: 2 },
  { kind: 'malformed_response', mode: 'truncated_json' },
];
```

The `slow_3g` and `timeout_at_request` variants are NOT in the default subset — they overlap with `high_latency` and `timeout_at_response` respectively, and exist for completeness. Users opt them in via `networkFaults.variants`.

---

## 5. Bug classification additions

### 5.1 BugKind extension

```ts
export type BugKind =
  // ... existing v0.1-v0.18 ...
  // v0.20 network-fault kinds
  | 'network_fault_unhandled'
  | 'network_fault_optimistic_no_revert'
  | 'infinite_loading';
```

### 5.2 BugDetection field extension

```ts
export type NetworkFaultContext = {
  /** The fault variant that was applied. */
  faultVariant: NetworkFaultSpec['kind'];
  /** Spec of the fault, e.g. for serialisation. */
  faultSpec: NetworkFaultSpec;
  /** Endpoint(s) the action triggered, normalized. */
  affectedEndpoints: string[];
  /** True if post-fault same-endpoint request rate exceeded retryStormThresholdRps. */
  retryStormDetected: boolean;
  /** Observed post-fault req/sec on the busiest endpoint. */
  observedRetryRateRps: number;
  /**
   * Detection proof.
   * 'no_error_ui_no_rollback': UI showed no error and no rollback for asyncMaxWaitMs.
   * 'optimistic_state_persisted': pre-action and observed-success states diverged then never converged on failure.
   * 'spinner_persists': aria-busy or known-loading-class present at action-time AND still present at asyncMaxWaitMs.
   */
  proof: 'no_error_ui_no_rollback' | 'optimistic_state_persisted' | 'spinner_persists';
};
```

Add as `networkFaultContext?: NetworkFaultContext` on `BugDetection`. Mirrors `injectionContext` (v0.16) and `headerContext` (v0.5) shape.

### 5.3 Detection rules

#### `detectNetworkFaultUnhandled(preState, postState, fault, expectedOutcome): BugDetection | null`
- Fires when: `expectedOutcome === 'expected_failure'`, `fault.kind` is one of `offline | timeout_at_request | timeout_at_response | server_5xx | malformed_response | intermittent`, AND none of the following are true in `postState`:
  - `domErrorTextDetected === true` (existing dom-error-text classifier output)
  - `consoleErrors.length > preState.consoleErrorCount` AND at least one console error mentions a network/fetch keyword (`fetch`, `network`, `XMLHttpRequest`, `aborted`, `failed`)
  - The DOM has `[role="alert"]`, `[data-testid*="error"]`, or `.error` elements that weren't there pre-action.
  - URL changed (the SPA navigated to an error route).
- Proof: `no_error_ui_no_rollback`. Sets `retryStormDetected` from the request-rate computation.

#### `detectOptimisticNoRevert(preState, postState, fault, optimisticSnapshot): BugDetection | null`
- Requires an **intermediate snapshot** taken at action-fire + 200ms (the "optimistic window"). Captured by the executor whenever `tc.faultInjected !== undefined`.
- Fires when:
  - The intermediate snapshot's diff against pre-state suggests success (e.g. a new row in a list, a status badge changing to "saved", spinner present then absent)
  - AND post-state (at asyncMaxWaitMs) is identical to the intermediate (not reverted to pre-state, not transitioned to error)
  - AND no error UI appears.
- Proof: `optimistic_state_persisted`. The intermediate snapshot is captured into a separate artifact `optimistic/<occurrenceId>.html` for review.

#### `detectInfiniteLoading(preState, postState, fault): BugDetection | null`
- Fires when:
  - Pre-state had no spinner.
  - Action triggered a spinner indicator (any of: `[aria-busy="true"]`, `[role="progressbar"]`, common loading classnames `.loading`, `.spinner`, `.skeleton`).
  - Post-state (at asyncMaxWaitMs) STILL has the spinner indicator AND no error UI AND no success indicator.
- Proof: `spinner_persists`.

The three detectors are independent — a single fault test can fire one or more. Priority hierarchy (§ 5.4) collapses them to one canonical.

### 5.4 Priority hierarchy slotting

The three new kinds slot into `KIND_PRIORITY` like this (added to `phases/classify.ts`):

```
... unhandled_exception, xss_*, network_5xx, react_error, hydration_mismatch,
    surface_call_failed, network_4xx_unexpected, 404_for_linked_route, ...

    // v0.20 network-fault kinds: above visual_anomaly / missing_state_change,
    // below network_4xx_unexpected (which we suppress under fault anyway).
    network_fault_optimistic_no_revert,    // most actionable — UI lied to user
    network_fault_unhandled,
    infinite_loading,
    ... idor_*, dom_error_text, missing_state_change, ...
```

**Suppression rule:** When the parent TestCase has `faultInjected !== undefined`:
- `network_5xx` and `network_4xx_unexpected` detections are dropped (the fault caused them; they're not bugs in their own right).
- `surface_call_failed` from the underlying API tool is dropped for the same reason.
- `console_error` is KEPT only if the message indicates an unhandled-promise rejection or a parse error (these would be bugs even under fault — the app should handle them). Pure "fetch failed" console errors are dropped.
- `unhandled_exception` is KEPT — an exception is always a bug, regardless of fault context.

Implemented as a pre-priority filter in `classify.ts`: see existing `applyPriorityFilter` for the pattern.

---

## 6. Camofox-mcp dependency status (CRITICAL)

**As of 2026-04-30, camofox-mcp v0.1 (`/opt/camofox-mcp/index.ts`) does NOT expose any network-conditioning or fetch-interception tools.** The wrapped Camoufox browser server (`/root/.openclaw/extensions/camofox-browser/server.js`) does not expose corresponding endpoints either, even though the underlying Playwright Firefox supports the primitives.

### 6.1 What's missing

| Capability needed | Playwright API | Currently exposed? |
|---|---|---|
| Set offline | `BrowserContext.setOffline(true)` | No |
| Throttle / latency | Playwright Firefox: limited; needs CDP shim or `page.route()` + sleep | No |
| Intercept request | `page.route(pattern, handler)` | No |
| Drop / fulfill / modify response | `route.abort()` / `route.fulfill()` | No |

**CDP note.** The original task brief mentioned `Network.emulateNetworkConditions` and `Fetch.requestPaused` from the Chrome DevTools Protocol. CDP is **Chromium-only**. Camofox is Firefox-based (Camoufox = Firefox fork). The right primitives here are Playwright's cross-browser `BrowserContext.setOffline()` and `page.route()`, which Playwright Firefox supports natively. v0.20 is implemented in terms of Playwright APIs, NOT CDP. If we ever switch to a Chromium-based browser MCP, the implementation can swap to CDP transparently.

### 6.2 Required camofox-mcp changes (not part of this BugHunter PR)

To unblock v0.20, the camofox-browser server needs four new endpoints, and camofox-mcp needs four new tools. Filed as a sibling task; not in scope for this BugHunter spec, but BugHunter's v0.20 implementation depends on them landing first.

**camofox-browser HTTP endpoints (file: `/root/.openclaw/extensions/camofox-browser/server.js`):**

```
POST /tabs/:tabId/network-fault
  Body: { fault: NetworkFaultSpec }
  Behaviour: install context.setOffline(true) for offline; install page.route()
             handlers for the rest. Idempotent (replace previous fault).
  Response: { ok: true, applied: <boolean>, reason?: string }

DELETE /tabs/:tabId/network-fault
  Behaviour: clear setOffline + remove route handlers.
  Response: { ok: true }
```

**camofox-mcp tools (file: `/opt/camofox-mcp/index.ts`):**

```
network_fault — register on the MCP server. Wraps POST /tabs/:tabId/network-fault.
  Input: { tabId, fault: NetworkFaultSpec }
clear_network_fault — wraps DELETE /tabs/:tabId/network-fault.
  Input: { tabId }
```

### 6.3 BugHunter validation behaviour when camofox is too old

In `phases/validate.ts`:
- If `config.networkFaults?.enabled === true`:
  - Probe the camofox adapter: call `applyNetworkFault({kind:'offline'})` against a throwaway tab, then `clearNetworkFault()`.
  - If `applyNetworkFault` is undefined OR returns `{applied:false, reason:'tool_not_available'}`:
    ```
    Abort with: "networkFaults.enabled = true but camofox-mcp v0.1 does not
    support network-fault injection. Required: camofox-mcp ≥ v0.2 with the
    network_fault tool. See SPEC_V20_NETWORK_FAULTS.md § 6."
    ```
  - **Do NOT silently skip.** Opt-in features that silently skip frustrate users more than features that fail loudly. If the user asked for fault testing, demand the dependency.

### 6.4 Fallback path (rejected)

A fallback via `evaluate(navigator.serviceWorker.register('fault-sw.js'))` was considered. Rejected because:
- ServiceWorker scope is per-origin, not per-tab — would leak across tests.
- Many SPAs (Next.js dev) already register their own SW, conflicting with ours.
- Camoufox stealth mode may block SW registration entirely.
- Complexity vs benefit: implementing the camofox-mcp endpoints is ~150 lines; the SW fallback is ~600 lines plus failure modes.

---

## 7. Cluster signature additions

In `cluster/signature.ts`:

```ts
case 'network_fault_unhandled': {
  const action = detection.triggeringAction?.kind ?? '';
  const variant = detection.networkFaultContext?.faultVariant ?? '';
  return `network_fault_unhandled|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
}
case 'network_fault_optimistic_no_revert': {
  const action = detection.triggeringAction?.kind ?? '';
  const variant = detection.networkFaultContext?.faultVariant ?? '';
  return `network_fault_optimistic_no_revert|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
}
case 'infinite_loading': {
  const action = detection.triggeringAction?.kind ?? '';
  const variant = detection.networkFaultContext?.faultVariant ?? '';
  return `infinite_loading|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
}
```

Variant is part of the signature so that a "form X under offline" cluster is distinct from "form X under server_5xx". This is intentional — fixes for offline (showing "you're offline") differ from fixes for 5xx (showing "server unavailable"). Two clusters, two fixes.

**Cross-kind link.** After clustering, link `network_fault_unhandled` ↔ `network_fault_optimistic_no_revert` ↔ `infinite_loading` clusters that share `(pageRoute, selectorClass, action)` — they're the same root cause expressed under different fault variants. Use the existing `relatedClusterIds` mechanism (§ 3.6 of SPEC.md).

---

## 8. Interface contract additions

### 8.1 CLI

```
bughunter run [...] [--network-faults] [--no-network-faults]
  --network-faults              Enable v0.20 fault injection. Sets config.networkFaults.enabled = true.
                                Aborts validate phase if camofox-mcp lacks the underlying tool.
  --no-network-faults           Force-disable even if config has it on (debug aid).
```

No new subcommands. Telemetry is part of `summary.json`.

### 8.2 Config (`BugHunterConfig`)

Append to the config interface in `packages/cli/src/types.ts`:

```ts
export type NetworkFaultsConfig = {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Variants to run. Default: DEFAULT_FAULT_PALETTE (six of eight). */
  variants?: NetworkFaultSpec[];
  /**
   * toolIds whose fault tests are skipped (e.g. payment endpoints). Glob-supported.
   * Always-skipped: tools tagged sideEffectClass='external' (from SurfaceMCP).
   */
  toolDenylist?: string[];
  /** Hard cap on fault tests per role across the whole run. Default: 200. */
  maxFaultTests?: number;
  /**
   * Post-fault same-endpoint requests/sec threshold above which retryStormDetected fires.
   * Default: 10.
   */
  retryStormThresholdRps?: number;
  /**
   * Per-test wall-clock cap for fault tests, in ms. Capped at min(asyncMaxWaitMs * 1.5, 60000).
   * Default: derived from asyncMaxWaitMs.
   */
  perTestMaxMs?: number;
  /**
   * Include read-only navigation actions in fault scheduling. Default: false (mutating-only).
   */
  includeNavigation?: boolean;
};

export type NetworkFaultsTelemetry = {
  enabled: boolean;
  faultsAttempted: number;
  faultsSucceeded: number;
  faultsSkipped: { reason: string; count: number }[];
  detectionsByKind: Record<string, number>;
  retryStormsDetected: number;
  durationMs: number;
};

// In BugHunterConfig:
networkFaults?: NetworkFaultsConfig;
```

### 8.3 TestCase extension

```ts
export type TestCase = {
  // ... existing fields ...
  /**
   * v0.20: when set, the executor wraps the action in applyNetworkFault → action → clearNetworkFault
   * and the classifier applies fault-suppression rules (§ 5.4).
   */
  faultInjected?: NetworkFaultSpec;
};
```

The TestCase planning function (§ 9 task 4) emits one fault-injected TestCase per (collapsed-action-signature, role, variant). Same `expectedOutcome: 'expected_failure'` as a `null`-palette mutation test.

### 8.4 BrowserMcpAdapter extension

Per § 3.2 above. Both `BrowserMcpAdapter` and `TabScope` gain optional `applyNetworkFault` / `clearNetworkFault` methods.

---

## 9. Edge cases

### EC-1. camofox-mcp version skew (capability missing at runtime)
Validate phase probes `applyNetworkFault({kind:'offline'})` and refuses to start the run if it isn't supported. Hard fail with a clear error pointing to § 6. No silent skipping. (Already covered in § 6.3.)

### EC-2. Fault crashes the browser context
Camoufox / Playwright crashes happen. If `applyNetworkFault` throws OR a subsequent action throws `BrowserMcpError('transport')`, treat as `infrastructure_failure`, not a bug. Tab is closed via `withTab`'s `finally`; counter increments toward the 20-consecutive-infra-failure abort threshold.

### EC-3. Retry storm hammers a real server
The runner runs against local dev only (per SPEC.md § 2 boundaries). Retry storm load is bounded by `perTestMaxMs` (45s default). Worst case: 100 req/sec for 45s = 4500 requests. Local dev tolerates this. For unattended runs against shared dev servers, set `retryStormThresholdRps` low and `perTestMaxMs` low.

### EC-4. Action triggers no network requests at all
Some "click" actions (e.g. an in-page state toggle) make zero requests. Fault has no observable effect. Detector returns null for all three kinds. The fault test's TestResult is a clean pass with `secondaryObservations: [{kind: 'observation', detail: 'no_network_requests_during_action'}]` for diagnostic. Counted as `faultsSkipped: { reason: 'no_network_requests' }` in telemetry.

### EC-5. SPA uses optimistic UI correctly (success then revert on fail)
The `optimistic_no_revert` detector is comparing intermediate snapshot to post-state. If the post-state shows a revert (success indicator gone, error toast present), no finding. Documented as the happy path.

### EC-6. Action navigates away mid-fault
URL change during a fault test is the cleanest possible signal — the SPA has at least one error path (a navigation). Not a bug. Detector returns null.

### EC-7. Spinner is permanent design (e.g. /loading route)
False positive risk for `infinite_loading`. Mitigation: detector requires the spinner to be NEW (post-action), not present in pre-state. Pre-state spinner with same selector → no finding.

### EC-8. The fault test runs but `clearNetworkFault` fails
The next test runs in a fresh tab via `withTab`. Stale browser-context state can persist across tabs in the same context. Mitigation: each fault test gets a fresh BROWSER CONTEXT, not just a fresh tab. Currently `withTab` reuses the same context. **This requires a new helper:** `withFreshContext` in the adapter, or document that the camofox adapter's session-key is rotated per fault test. **OPEN QUESTION 1.**

### EC-9. `intermittent` variant: which Nth request to drop?
Counted across all requests on the tab during the action's window. N=2 means odd requests dropped, even pass. Stateful — the runner maintains a counter on the camofox-side (server.js implementation). On clear, counter resets.

### EC-10. `malformed_response` truncation point
Default: cut at 50% of response bytes. For JSON, this almost always lands mid-string-or-mid-object → parse error. For HTML, truncation at 50% breaks the tree but browsers are lenient — may not produce a clean detection. Documented as best-effort; the variant's primary target is JSON APIs.

### EC-11. `server_5xx` 503 with `Retry-After`
Correctly handled: the runner emits a 503 with `Retry-After: 30`. Apps that respect it should not retry within 30s. Apps that ignore it and retry → retry-storm signal fires. Spec compliance gate.

### EC-12. Same fault TestCase happens to also trip a non-suppressed detector
E.g. a fault test runs and ALSO causes a hydration mismatch (because the response was malformed). `hydration_mismatch` is NOT in the suppression list (it's an app bug regardless of fault context). It fires; priority hierarchy picks the canonical kind. If `hydration_mismatch` outranks `network_fault_unhandled` → cluster as hydration with `secondaryObservations: [{kind:'network_fault_unhandled', detail:...}]`.

### EC-13. Happy-path test scheduled immediately after fault test
Fresh tab via `withTab` + adapter-side `clearNetworkFault` in `finally`. The classifier in this test sees no `faultInjected` on the TestCase — runs the standard rules.

### EC-14. Reset semantics for `intermittent` counter across tests
Each test gets a fresh tab. The counter MUST live tab-scoped (not context-scoped) on the camofox server side. If implementation puts it context-scoped, two parallel tests share the counter — broken. Camofox-mcp endpoint contract: counter is keyed `(contextId, tabId)`. **OPEN QUESTION 2.**

### EC-15. CSRF-protected mutating action under offline
Action POST won't even leave the browser — offline catches it before the CSRF check. Behaviour expected: error UI. No new edge.

### EC-16. Fault test on an action that requires re-auth
If session expired and the fault is `offline`, the relogin attempt also fails. Ambiguous: is the bug "no error UI" or "stale auth handling"? Mitigation: skip fault tests when SurfaceMCP reports `authState.stale === true` for the role at fault-test scheduling time. Tagged `faultsSkipped: { reason: 'auth_stale' }`.

### EC-17. SPA service workers caching the request
Cached responses bypass our `page.route()` interception. For `offline`, the cache may still serve. Documented as a real-world concern; the test reports `secondaryObservations: [{kind:'observation', detail:'response_from_service_worker_cache'}]` if the request didn't cross the route handler. **OPEN QUESTION 3** — Playwright Firefox doesn't trivially expose "did this go through the cache?". May require a heuristic via `evaluate(performance.getEntries())`.

---

## 10. Acceptance criteria

| Criterion | Verifier |
|---|---|
| `npx tsc --noEmit` clean in both packages | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Unit tests for the eight palette variants (template, default subset selection, denylist filter) | `npx vitest run network-fault-palette` |
| Unit tests for the three detectors against synthetic preState/postState fixtures | `npx vitest run classify/network-fault*` |
| Unit tests for cluster signatures (three new cases) | `npx vitest run cluster/signature` |
| Unit test for classifier suppression rules under fault context | `npx vitest run classify` |
| Unit test verifying `clearNetworkFault` is called in `finally` even if action throws | `npx vitest run phases/execute` |
| Validate phase aborts with `camofox-mcp ≥ v0.2 required` if `applyNetworkFault` is undefined | `npx vitest run phases/validate` |
| Integration test against `fixtures/network-faults-bad/` produces ≥1 finding per BugKind with correct `faultVariant` and `proof` | `npx vitest run integration/network-faults-smoke` |
| Same-shape collapse: 50 buttons sharing a signature → 1 fault test per (variant, role) | `npx vitest run phases/plan` |
| Negative smoke on Aspectv3 with `networkFaults.enabled = true`: zero spurious findings on routes that show explicit error UI | manual smoke (post-merge) |
| Telemetry: `summary.json.networkFaults` block populated with attempts / detections / retryStorms / duration | `jq` |
| Per-tool denylist honored: a tool listed in `toolDenylist` has zero fault tests | unit test |
| Reset semantics: a happy-path test scheduled directly after a fault test passes cleanly with no residual fault behaviour | integration test |

---

## 11. Files to touch / add

### To touch (existing)
- `packages/cli/src/types.ts` — three new BugKinds; `NetworkFaultSpec`; `NetworkFaultContext` on BugDetection; `faultInjected` on TestCase; `NetworkFaultsConfig` + `NetworkFaultsTelemetry`; append to `BugHunterConfig`.
- `packages/cli/src/phases/classify.ts` — add the three new kinds to `KIND_PRIORITY`; add suppression rule for fault-context test results.
- `packages/cli/src/cluster/signature.ts` — three new cases; cross-kind link extension.
- `packages/cli/src/phases/plan.ts` — emit fault-injected TestCases per (collapsed-action-signature, role, variant) when `networkFaults.enabled`.
- `packages/cli/src/phases/execute.ts` — when `tc.faultInjected !== undefined`, wrap action in apply/clear; capture intermediate snapshot at action+200ms; pass `faultSpec` and `optimisticSnapshot` to classifiers.
- `packages/cli/src/phases/validate.ts` — capability probe + abort path.
- `packages/cli/src/adapters/browser-mcp.ts` — add optional `applyNetworkFault` / `clearNetworkFault` on adapter + `TabScope`; implementation calls camofox-mcp's `network_fault` / `clear_network_fault` tools.
- `packages/cli/src/cli/run.ts` — `--network-faults` / `--no-network-faults` flag wiring.
- `packages/cli/src/phases/emit.ts` — populate `summary.json.networkFaults` from runner telemetry.

### To create (new)
- `packages/cli/src/security/network-fault-palette.ts` — variant table, default subset, palette type re-exports.
- `packages/cli/src/security/network-fault-runner.ts` — config + telemetry types + runner-level helpers (cost capping, denylist filter, intermediate snapshot timing).
- `packages/cli/src/classify/network-fault-unhandled.ts`
- `packages/cli/src/classify/network-fault-optimistic-revert.ts`
- `packages/cli/src/classify/infinite-loading.ts`
- `packages/cli/src/security/network-fault-palette.test.ts`
- `packages/cli/src/security/network-fault-runner.test.ts`
- `packages/cli/src/classify/network-fault-unhandled.test.ts`
- `packages/cli/src/classify/network-fault-optimistic-revert.test.ts`
- `packages/cli/src/classify/infinite-loading.test.ts`
- `fixtures/network-faults-bad/` — synthetic buggy fixture (Express + minimal SPA pages exercising all three BugKinds).
- `tests/integration/network-faults-smoke.test.ts` — end-to-end against the fixture.

### Outside this PR (sibling dependency)
- `/opt/camofox-mcp/index.ts` — register `network_fault` / `clear_network_fault` tools.
- `/root/.openclaw/extensions/camofox-browser/server.js` — add `POST/DELETE /tabs/:tabId/network-fault` endpoints implemented via Playwright `BrowserContext.setOffline()` + `page.route()`.

---

## 12. Negative requirements

- Do **not** ship the camofox-mcp / camofox-browser changes in this PR. They're a sibling change with their own review cycle. BugHunter's PR depends on them but does NOT carry them.
- Do **not** add fault testing to API direct-call tests. Faults exercise UI behaviour; API tests don't have UI to exercise.
- Do **not** retry fault tests under `reRunForFlakes`. Mark them `flakySkipped: true`.
- Do **not** count `network_5xx` / `network_4xx_unexpected` as bugs when the parent TestCase has `faultInjected !== undefined`. The fault is the cause; the response code is the symptom.
- Do **not** silently skip when camofox lacks the underlying tool. Hard-fail validate. (See § 6.3.)
- Do **not** treat `faults_skipped: { reason: 'no_network_requests' }` as an infrastructure failure. It's a clean diagnostic output.
- Do **not** retry the fault apply call. If it fails, the test is `infrastructure_failure`.

---

## 13. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add three `BugKind` variants + `NetworkFaultSpec` + `NetworkFaultContext` + `faultInjected` on TestCase + `NetworkFaultsConfig` / `NetworkFaultsTelemetry` | `types.ts` | none |
| 2 | Implement `network-fault-palette.ts` with eight variants + default subset + denylist filter + unit tests | `security/network-fault-palette.ts`, `*.test.ts` | 1 |
| 3 | Add `applyNetworkFault` / `clearNetworkFault` to `BrowserMcpAdapter` + `TabScope` (calls into camofox-mcp's new tools) | `adapters/browser-mcp.ts` | 1 |
| 4 | Plan-phase emission of fault-injected TestCases (collapsed) | `phases/plan.ts`, `phases/plan.test.ts` | 1, 2 |
| 5 | Execute-phase fault wrapping + intermediate snapshot capture | `phases/execute.ts`, tests | 3, 4 |
| 6 | Three new classify detectors (pure functions) + unit tests | `classify/network-fault-*.ts`, `classify/infinite-loading.ts`, tests | 1 |
| 7 | Classifier suppression rules under fault context + KIND_PRIORITY slotting | `phases/classify.ts`, tests | 1, 6 |
| 8 | Cluster signatures for three new kinds + cross-kind link | `cluster/signature.ts`, tests | 1 |
| 9 | Validate-phase capability probe + abort path | `phases/validate.ts`, tests | 3 |
| 10 | Telemetry on `summary.json.networkFaults` | `phases/emit.ts`, types | 5, 6 |
| 11 | CLI flag wiring (`--network-faults` / `--no-network-faults`) | `cli/run.ts` | 1 |
| 12 | Synthetic fixture `fixtures/network-faults-bad/` + integration smoke | `fixtures/network-faults-bad/`, `tests/integration/network-faults-smoke.test.ts` | 1-11 |
| 13 | Manual smoke on Aspectv3 / TraiderJo (zero-or-real findings audit) | (manual) | 1-12 |
| Sibling | camofox-mcp `network_fault` / `clear_network_fault` tools | `/opt/camofox-mcp/index.ts`, `/root/.openclaw/extensions/camofox-browser/server.js` | none (parallel work) |

---

## 14. Definition of Done

A reviewer can:

```bash
cd /root/Aspectv3
# Set .bughunter/config.json: { "networkFaults": { "enabled": true } }
node /root/BugHunter/packages/cli/dist/cli/main.js run --network-faults --max-bugs 100 --budget 3600000
```

…and observe:
- Validate phase confirms camofox-mcp supports `network_fault`; aborts otherwise with the documented error.
- Plan phase emits fault-injected TestCases collapsed by signature; projection includes them.
- Execute phase runs fault tests with `withTab` + apply / clear; intermediate snapshot artifacts written to `optimistic/<occurrenceId>.html` for `_no_revert` candidates.
- Classify phase suppresses `network_5xx` / `network_4xx_unexpected` for fault-injected results; emits the three new BugKinds where appropriate.
- `summary.json.networkFaults` block reports faults attempted / succeeded / skipped / detections by kind / retry storms detected / duration.
- Synthetic fixture smoke captures one finding per BugKind with the correct `faultVariant` and `proof`.
- A happy-path test running directly after a fault test passes cleanly (no residual fault state).

---

## 15. Risks + escape hatches

- **Risk: false positives on apps with custom error UI patterns the detectors don't recognise.** Mitigation: detectors use multiple signals (DOM text + role=alert + console + URL change). User can extend `domErrorTextRegex` (existing v0.5 config). Escape: `--no-network-faults` to disable entirely.
- **Risk: real-world dev servers can't survive a retry storm.** Mitigation: `retryStormThresholdRps` low; `perTestMaxMs` low; opt-in only. Document trust model: "local dev with reset between runs."
- **Risk: camofox-mcp dependency lands late.** Mitigation: BugHunter's v0.20 PR can ship to main with the validate-phase abort path; `--network-faults` flag is dormant until the dep lands. CI test `network-faults-smoke` is gated behind `process.env.CAMOFOX_NETWORK_FAULT === '1'` until upstream tools land.
- **Risk: Playwright Firefox `page.route()` doesn't intercept service-worker-served requests.** Mitigation: documented as EC-17. Diagnostic-only signal in v0.20.
- **Escape hatch:** `bughunter run --no-network-faults` bypasses the entire phase regardless of config.

---

## 16. Killer-demo runbook

```bash
# 1. Synthetic fixture (assumes the camofox-mcp dep has landed)
cd /root/BugHunter/.claude/worktrees/<wt> && \
  npx vitest run tests/integration/network-faults-smoke
# Expect ≥1 finding per BugKind with proof field.

# 2. Real-app smoke on Aspectv3
cd /root/Aspectv3
# In .bughunter/config.json:
#   "networkFaults": { "enabled": true, "maxFaultTests": 50 }
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --network-faults --max-bugs 200 --budget 3600000

# 3. Verify telemetry + findings
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.networkFaults' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
jq '.byKind | (.network_fault_unhandled // 0) + (.network_fault_optimistic_no_revert // 0) + (.infinite_loading // 0)' \
  /root/Aspectv3/.bughunter/runs/$RUN/summary.json
```

---

## 17. Open questions

1. **Fresh browser CONTEXT vs fresh TAB between fault tests (EC-8, EC-14).** Currently `withTab` reuses the parent context. Faults installed via `BrowserContext.setOffline()` are context-scoped, not tab-scoped, so cross-tab leakage is real. Options: (a) rotate session-key per fault test (heaviest, most correct), (b) document that the underlying camofox-mcp endpoint installs faults TAB-scoped via `page.route()` only and never uses context-level setOffline (limits the `offline` variant fidelity but isolates), (c) accept context-scoped offline and serialize fault tests (no parallelism). My recommendation: (b) — keep all fault types page-scoped via route handlers; for `offline`, simulate by aborting all requests in the route handler instead of `setOffline()`. Trades a tiny bit of fidelity for clean isolation. Wants confirmation.

2. **Intermittent counter scoping (EC-14).** Counter MUST be tab-scoped, not context-scoped. Implementation note for the camofox-mcp PR. Spec says tab-scoped; flagging as confirmable open question because it's a contract the camofox-mcp implementer must honor.

3. **Service-worker cache observability (EC-17).** Playwright Firefox doesn't expose "this response came from SW cache." Heuristic via `performance.getEntries()` filtering on `transferSize === 0` is approximate. Should v0.20 surface a warning when the cache likely served the response, or just emit findings as-is and document the failure mode? My recommendation: surface as `secondaryObservations` only; not a blocker.

4. **Default `perTestMaxMs` formula.** Currently `min(asyncMaxWaitMs * 1.5, 60_000)`. Should `intermittent` get a different (longer) cap, since it expects multiple round-trips? Possibly `min(asyncMaxWaitMs * 3, 90_000)` for that variant only. Wants telemetry-driven tuning.

5. **Retry-storm threshold default.** 10 req/sec is arbitrary. Real apps with WebSocket-shaped polling might naturally exceed this on a working endpoint. Should the threshold be RELATIVE to the pre-fault baseline rate ("3x normal")? Probably yes for v0.21; v0.20 ships with the absolute threshold for simplicity.

6. **Should `network_fault_optimistic_no_revert` REQUIRE the intermediate snapshot to differ from pre-state?** If the SPA is fast enough, the +200ms snapshot may show the action hasn't even fired yet. Consider sliding-window capture (snapshot at +100ms AND +500ms; pick the one that differs from pre-state). Adds capture cost.

7. **Should we ship `slow_3g` and `timeout_at_request` in the default palette despite overlap?** Spec keeps them OFF by default; users opt in via `variants`. Inviting feedback from the first integration smoke before deciding.
