# SPEC — v0.24 "Deferred perf detector wiring"

**Status:** Draft 1 — ready for `@coder` (Sonnet) assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-05-01 · **Predecessor / depends on:** PR #53 (`fix/audit-cleanup`) commit `0d711f8` "wire dead v0.6 perf classifiers" — V24 closes the 5 detectors that commit explicitly deferred · **Sibling:** `SPEC_PATH_TO_EXHAUSTIVE.md` §9 Phase A item 1.

This spec wires the last 5 already-implemented-but-unwired detector functions into the production code path. Each detector has an exported function with passing unit tests on `main`, but no runner ever calls it on real input. The audit (`fix(audit): wire dead v0.6 perf classifiers …`) wired 5/14; this spec wires the remaining 5/14, after which every advertised `BugKind` (modulo `csrf_missing_on_mutating_route` and `hallucinated_route`, both tracked elsewhere) has a wired production path. No detector logic changes. Plumbing only.

---

## 1. Objective

Wire the following 5 BugKinds so they fire on real input from `executeUiTest`, not synthetic-only fixtures:

| BugKind | Detector (exists today) | Missing plumbing |
|---|---|---|
| `request_cancellation_missing` | `classifyCancelMissing(har, navigationEvents)` at `packages/cli/src/classify/request-hygiene.ts:134` | Surface `NavigationEvent[]` from `CdpSession.drain()` through `PerfArtifacts` into the post-drain block in `runTest`. |
| `unbounded_list_render` | `classifyUnboundedList(domSnapshot, pageRoute, threshold?)` at `packages/cli/src/classify/unbounded-list.ts:102` | Capture raw post-action `document.documentElement.outerHTML` inside `executeUiTestInner` and pass through into the post-drain block. |
| `dom_error_text` | `classifyDomErrorText(domSnippet, pageRoute, selectorClass)` + `CHECK_DOM_ERROR_SCRIPT` at `packages/cli/src/classify/dom-error-text.ts:21` and `:8` | Run `CHECK_DOM_ERROR_SCRIPT` via `scope.evaluate` pre-action and post-action inside `executeUiTestInner`; emit when error text appears post but not pre; flip `postState.domErrorTextDetected` so `classifyMissingStateChange` can consume it. |
| `hydration_mismatch` | `classifyReactErrors(errors, pageRoute)` at `packages/cli/src/classify/react.ts:31` (uses `isHydrationError` at `:23`) | Replace the `classifyConsoleErrors` call at `packages/cli/src/phases/execute.ts:669` with `classifyReactErrors`. |
| `accessibility_critical` (delta path) | `classifyA11yDelta(preViolations, postViolations, pageRoute)` at `packages/cli/src/classify/accessibility.ts:25` | Capture pre-action `AXE_RUN_SCRIPT` result inside `executeUiTestInner`; capture post-action again; call `classifyA11yDelta`. Gated on `--a11y` flag (existing). |

**In scope:** wiring + minimal type extensions (NavigationEvent on PerfArtifacts; outerHTML field on TestResult or threaded through), one new fixture for end-to-end proof of each kind, one production-path integration test per kind, signature parity verification.

**Out of scope (defer):**
- Changing detector logic, thresholds, or signature outputs.
- New axe-core injection — `AXE_RUN_SCRIPT` already loads from `window.axe`; the existing `onPageBaseline` hook injects it once per page (`execute.ts:148`). V24 reuses the same script.
- New console capture — `__bhConsoleErrors` (V19) remains the source. V24 only changes the classifier consuming it.
- `csrf_missing_on_mutating_route` and `hallucinated_route` plumbing — both flagged by audit, tracked separately in V25.
- Removing dead detectors — none are dead after V24; further pruning is a separate exercise.
- Adding new BugKinds to `KIND_PRIORITY`. All 5 are already present (`packages/cli/src/phases/classify.ts:21`, `:50`, `:54`, `:72`, `:75`).

**Acceptance target on a synthetic fixture:**

A new fixture `fixtures/v24-deferred-bugs/` exhibits each of the 5 BugKinds. Running BugHunter against it with `--enable-perf --a11y` produces (from `summary.json.byKind`):
- `request_cancellation_missing >= 1`
- `unbounded_list_render >= 1`
- `dom_error_text >= 1`
- `hydration_mismatch >= 1`
- `accessibility_critical >= 1`

Plus: `npx tsc --noEmit` clean, `npx eslint . --max-warnings 0` clean, all existing unit tests still pass.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/phases/execute.ts:225-274` (`runTest`) | Post-drain block where vitals/longTasks/rerenders/n+1/dedup are wired (commit `0d711f8`). V24 adds 2 more classifier calls here — `classifyCancelMissing` (uses `navigationEvents`) and `classifyUnboundedList` (uses `outerHTML`). |
| `packages/cli/src/phases/execute.ts:386-720` (`executeUiTestInner`) | Where pre/post evaluate calls live. V24 adds: pre-action `CHECK_DOM_ERROR_SCRIPT`, pre-action `AXE_RUN_SCRIPT` (when `enableA11y`), post-action `outerHTML` capture, post-action `CHECK_DOM_ERROR_SCRIPT`, post-action `AXE_RUN_SCRIPT`. |
| `packages/cli/src/phases/execute.ts:669` (`classifyConsoleErrors` call) | Replace with `classifyReactErrors` to surface `hydration_mismatch`. |
| `packages/cli/src/adapters/cdp-session.ts:57` (`NavigationEvent`) and `:233-240` | NavigationEvent capture **already exists** via `page.on('framenavigated', ...)`. `drain()` already returns `navigationEvents` at `:292`. V24 only needs to surface it through `PerfCollector → PerfArtifacts → runTest`. |
| `packages/cli/src/perf/perf-collector.ts:74-81` (the `PerfArtifacts` build inside `drain`) | Add `navigationEvents` field. The CDP session already returns it; today the collector drops it on the floor. |
| `packages/cli/src/types.ts:657-665` (`PerfArtifacts` type) | Add `navigationEvents: NavigationEvent[]`. NavigationEvent is currently exported only from `adapters/cdp-session.ts`; either re-export from `types.ts` or import-and-reference. |
| `packages/cli/src/classify/request-hygiene.ts:134-176` (`classifyCancelMissing`) | Detector signature: `(har: HarLog, navigationEvents: NavigationEvent[]) => BugDetection[]`. Returns `[]` when `navigationEvents.length < 2`, so a single-page test never produces false positives. |
| `packages/cli/src/classify/unbounded-list.ts:102-138` (`classifyUnboundedList`) | Detector signature: `(domSnapshot: string, pageRoute: string, threshold?: number) => BugDetection[]`. `domSnapshot` is raw HTML; the detector parses regex-style. Empty-string input returns `[]` immediately (`:107`). |
| `packages/cli/src/classify/dom-error-text.ts:1-33` | `CHECK_DOM_ERROR_SCRIPT` (`:8-19`) returns `{found: boolean, text?: string}`. `classifyDomErrorText` (`:21`) takes a raw snippet and emits a single detection if regex matches. |
| `packages/cli/src/classify/react.ts:31-51` (`classifyReactErrors`) | Replaces `classifyConsoleErrors` for the post-action console pass. Splits on `isHydrationError` (`:23`) → emits `hydration_mismatch` for hydration cases, `react_error` otherwise. **Note:** plain `console_error` (not React-related) is **not** emitted by `classifyReactErrors` — coder must keep `classifyConsoleErrors` for non-React errors OR extend `classifyReactErrors` to fall through to `console_error`. **Decision: extend.** See §3.4. |
| `packages/cli/src/classify/accessibility.ts:13-23` (`AXE_RUN_SCRIPT`) and `:25-42` (`classifyA11yDelta`) | Script returns `{ violations: A11yViolation[] }`. Delta keeps only critical/serious violations new in `post`. `pageRoute` is the third arg. |
| `packages/cli/src/cluster/signature.ts:13, 25, 169-186, 33` | Verify all 5 kinds resolve to a non-empty signature. (See §5 — confirmed.) |
| `packages/cli/src/phases/classify.ts:21, 50, 54, 72, 75` (`KIND_PRIORITY`) | All 5 kinds already in the priority hierarchy. No edit needed. |
| `packages/cli/src/types.ts:147-154` (`PostState`) | `domErrorTextDetected: boolean` is already a field. V24 wires the actual flip; today it's hardcoded `false` at `execute.ts:665`. |
| `packages/cli/src/classify/state-change.ts:18` | Consumes `postState.domErrorTextDetected`. After V24 wiring, `classifyMissingStateChange`'s "is there a toast?" branch sees the truth. |

### 2.2 Patterns to follow

- **Glue location.** Per-occurrence performance-style classifiers go in `runTest`'s post-drain block (`execute.ts:251–292` on `fix/audit-cleanup`). DOM-side and console-side classifiers go inside `executeUiTestInner` because they need `scope.evaluate` access. Do not move existing classifier calls — only add.
- **Catch-and-degrade.** Every `scope.evaluate` call uses `.catch(err => { log.debug(…); return null; })` like the XSS-observer drain at `execute.ts:628`. Failure is a no-op for that occurrence — never abort the test.
- **Threshold respect.** Use `runState.config.perf?.…` thresholds where present, falling back to detector defaults. Mirror the pattern at `execute.ts:277-289` (post-drain wiring of vitals/longTasks). `classifyUnboundedList` uses default `ROW_THRESHOLD = 100`; `classifyCancelMissing` uses no threshold.
- **Bounded snapshot capture.** `outerHTML` for unbounded-list detection can be huge. Cap at 2 MiB before passing into `classifyUnboundedList`. The detector already returns `[]` on empty string; on truncation, just trim mid-tag — the regex is forgiving and a falsely-low row count is a false-negative, not a false-positive.
- **Discriminated returns.** `classifyReactErrors` returns `Array<{ kind: 'react_error' | 'hydration_mismatch'; … }>`. Don't introduce a parallel union; reuse the existing `BugDetection`. The new branch in `classifyReactErrors` (extending to also produce `console_error`) keeps the same return type.
- **Test mirrors.** New unit tests sit alongside the production-path test in `execute.integration.test.ts` (or a new `execute.v24.test.ts` if cleaner — coder's call). Mirror the existing `request-hygiene.test.ts` shape for plumbing tests.

### 2.3 DO NOT

- Do **not** create a new collector or adapter. Reuse `CdpSession`, `PerfCollector`, and `TabScope`.
- Do **not** change `CHECK_DOM_ERROR_SCRIPT`, `AXE_RUN_SCRIPT`, or any classifier function body.
- Do **not** add a new flag for the dom_error_text or hydration_mismatch wiring — these are always-on (cheap; pre/post `scope.evaluate` of a small script).
- Do **not** add a new flag for `unbounded_list_render` — it piggybacks on `--enable-perf` (no perf collector, no production path).
- Do **not** touch `KIND_PRIORITY` ordering. The existing positions are intentional (hydration_mismatch above surface_call_failed; accessibility_critical at the bottom).
- Do **not** merge the pre-action `CHECK_DOM_ERROR_SCRIPT` and `AXE_RUN_SCRIPT` into one call — they have different cost profiles and different flag gates.
- Do **not** capture the pre-action axe baseline via the existing `onPageBaseline` (that runs once per page; V24 needs per-occurrence). Run a **second** axe scan inside `executeUiTestInner` per action.
- Do **not** copy/paste `classifyConsoleErrors` into `classifyReactErrors`. Extend the existing function so non-React text falls through to `kind: 'console_error'`. See §3.4.
- Do **not** widen the `EvaluateResult.value` type. It's `unknown`; narrow it explicitly at every call site.

---

## 3. Per-detector wiring spec

### 3.1 `request_cancellation_missing`

**Detector (do not touch):** `classifyCancelMissing(har: HarLog, navigationEvents: NavigationEvent[]): BugDetection[]` at `packages/cli/src/classify/request-hygiene.ts:134`.

**Input plumbing (new):**

1. **`packages/cli/src/types.ts:657-665`** — extend `PerfArtifacts`:
   ```ts
   import type { NavigationEvent } from '../adapters/cdp-session.js'; // or re-export here
   export type PerfArtifacts = {
     occurrenceId: string;
     webVitals: WebVitalSample[];
     longTasks: LongTaskSample[];
     heapSamples: HeapSample[];
     renderEvents: RenderEvent[];
     navigationEvents: NavigationEvent[];           // ← NEW (V24)
     cdpConsoleErrors?: ConsoleError[];
   };
   ```
   Resolve the import cycle: `NavigationEvent` exported from `adapters/cdp-session.ts`. `types.ts` currently does not import from adapters; add one targeted `import type` line. If lint forbids, re-export NavigationEvent from `types.ts` and adjust the cdp-session source of truth. Coder's call; either is acceptable.

2. **`packages/cli/src/perf/perf-collector.ts:74-81`** — populate `navigationEvents` in `drain()`:
   ```ts
   const perf: PerfArtifacts = {
     occurrenceId,
     webVitals: injectionFailed ? [] : drained.webVitals,
     longTasks: injectionFailed ? [] : drained.longTasks,
     heapSamples: heapSampling ? [...heapSamples] : [],
     renderEvents: injectionFailed ? [] : drained.renderEvents,
     navigationEvents: [...drained.navigationEvents],   // ← NEW (V24)
     cdpConsoleErrors: drained.consoleErrors,
   };
   ```
   The CDP session already collects these via `page.on('framenavigated', …)` at `cdp-session.ts:233`. Currently dropped at `perf-collector.ts:81`.

3. **`packages/cli/src/phases/execute.ts:248`** — update the `.catch` fallback to include the new field (avoid TS error):
   ```ts
   return { perf: { occurrenceId: result.occurrenceId, webVitals: [], longTasks: [], heapSamples: [], renderEvents: [], navigationEvents: [] }, har: { … } };
   ```

**Glue (new) — insert in `execute.ts` post-drain block, after the existing `dedupBugs` line on `fix/audit-cleanup` (~line 287):**

```ts
const cancelBugs = classifyCancelMissing(har, perf.navigationEvents);
const allPerfBugs = [...vitalsBugs, ...longTaskBugs, ...rerenderBugs, ...nplusOneBugs, ...dedupBugs, ...cancelBugs];
```

**Acceptance test:**

- Unit test (already passes): `packages/cli/src/classify/request-hygiene.test.ts` — `classifyCancelMissing` cases at `:153`, `:168`, `:181`. No change.
- Plumbing test (new): `packages/cli/src/phases/execute.v24.test.ts` — mock a `PerfArtifacts` with two `navigationEvents` and a HAR entry that started before nav 2 and completed after; assert `result.bugs` contains a `request_cancellation_missing` detection.
- Production-path test (new): `tests/integration/v24-deferred-bugs.test.ts` — see §8.

---

### 3.2 `unbounded_list_render`

**Detector (do not touch):** `classifyUnboundedList(domSnapshot: string, pageRoute: string, threshold?: number): BugDetection[]` at `packages/cli/src/classify/unbounded-list.ts:102`.

**Input plumbing (new):**

The detector needs raw HTML, not a parsed snapshot. `scope.snapshot()` returns the parsed-element format, not HTML. The cleanest source is a single `scope.evaluate('document.documentElement.outerHTML')` after the action.

1. **`packages/cli/src/phases/execute.ts:606`** — `executeUiTestInner`. After the existing `postSnapshot = await scope.snapshot()…`, add:
   ```ts
   // V24: capture raw outerHTML for unbounded_list_render. Capped at 2 MiB.
   const outerHtmlEval = await scope.evaluate(
     '(function(){var s=document.documentElement.outerHTML||"";return s.length>2097152?s.slice(0,2097152):s;})()'
   ).catch(err => {
     log.debug('v24: outerHTML capture failed', { err: String(err), occurrenceId });
     return null;
   });
   const outerHtml: string = typeof outerHtmlEval?.value === 'string' ? outerHtmlEval.value : '';
   ```

2. **TestResult plumbing.** `classifyUnboundedList` is a pure detector and produces `BugDetection[]` — call it directly inside `executeUiTestInner` (next to the other DOM-derived classifiers around line 669-673), not in `runTest`. The post-drain block in `runTest` does not have access to `outerHtml`.

   ```ts
   // V24: wire unbounded_list_render
   const unboundedBugs = classifyUnboundedList(outerHtml, tc.page);
   bugs.push(...unboundedBugs);
   ```

   Place this after `classifyConsoleErrors` (~line 669) and after `missingChange` (~line 672). Order does not matter for clustering; for readability, group with the other DOM-classifier calls.

**Cost note.** A 2 MiB outerHTML capture on every UI action is noticeable but bounded. The eval call is < 50 ms on typical pages. The eval truncates server-side so we never ship more than 2 MiB over the MCP wire. Unbounded-list detection is gated on `--enable-perf` because the cost only makes sense in a perf-enabled run; **but** `classifyUnboundedList` is a static-DOM detector, not a perf detector. Coder's call: gate on `enablePerf` to keep cost off the default path, OR run unconditionally because the detector is cheap and the DOM is captured anyway. **Decision: gate on `enablePerf`** — see §7 (open question O-2 default).

**Acceptance test:**

- Unit test (already passes): `packages/cli/src/classify/unbounded-list.test.ts`.
- Plumbing test (new): mock a `TabScope` whose `evaluate` returns an HTML string with 150 `<tr>` rows; assert `result.bugs` contains an `unbounded_list_render` detection with `evidence.rowCount === 150`.
- Production-path test: see §8.

---

### 3.3 `dom_error_text`

**Detector (do not touch):** `classifyDomErrorText(domSnippet, pageRoute, selectorClass)` at `packages/cli/src/classify/dom-error-text.ts:21`. Script `CHECK_DOM_ERROR_SCRIPT` at `:8`.

**Input plumbing (new):**

`CHECK_DOM_ERROR_SCRIPT` returns `{ found: boolean, text?: string }`. We compare pre vs post: emit a `dom_error_text` detection only when `post.found === true && pre.found === false`. (If error text was already present pre-action — e.g. a static "Failed to load" pre-existing on the page — it's not the action's fault.)

1. **`packages/cli/src/phases/execute.ts:404-405`** — `executeUiTestInner`, just before or after `preSnapshot`:
   ```ts
   // V24: pre-action DOM error-text probe.
   const preErrEval = await scope.evaluate(CHECK_DOM_ERROR_SCRIPT).catch(err => {
     log.debug('v24: pre dom-error-text eval failed', { err: String(err), occurrenceId });
     return null;
   });
   const preDomErrFound = (preErrEval?.value as { found?: boolean } | null | undefined)?.found === true;
   ```

2. **`packages/cli/src/phases/execute.ts:606`** — after `postSnapshot`:
   ```ts
   // V24: post-action DOM error-text probe.
   const postErrEval = await scope.evaluate(CHECK_DOM_ERROR_SCRIPT).catch(err => {
     log.debug('v24: post dom-error-text eval failed', { err: String(err), occurrenceId });
     return null;
   });
   const postErrPayload = postErrEval?.value as { found?: boolean; text?: string } | null | undefined;
   const postDomErrFound = postErrPayload?.found === true;
   const postDomErrText = postErrPayload?.text ?? '';
   ```

3. **`packages/cli/src/phases/execute.ts:660-668`** — `postState`. Update `domErrorTextDetected: false` to the real value:
   ```ts
   const postState: PostState = {
     url: tc.page,
     title: '',
     consoleErrors: postConsoleErrors,
     networkRequests: [],
     domErrorTextDetected: postDomErrFound,    // ← was hardcoded false
     mutationObserverWindowMs: mutWindowMs,
   };
   ```

4. **Emission.** Add the classifier call in the same block as `classifyConsoleErrors` (~line 669):
   ```ts
   // V24: emit dom_error_text only if it appeared post-action and was not already present pre-action.
   if (postDomErrFound && !preDomErrFound) {
     const detection = classifyDomErrorText(postDomErrText, tc.page, '');
     if (detection !== null) bugs.push(detection);
   }
   ```

**Cost.** Two `scope.evaluate` calls per UI occurrence (~5-10 ms each). Always-on; not flag-gated. Acceptable.

**Acceptance test:**

- Unit test (already passes): no test exists for `classifyDomErrorText` today — add one in a new file `packages/cli/src/classify/dom-error-text.test.ts`. (4 cases: empty, no match, "failed to" matches, mixed-case "Something Went Wrong" matches.)
- Plumbing test (new): mock a `TabScope.evaluate` that returns `{found:false}` first then `{found:true, text:'Something went wrong'}`; assert one `dom_error_text` detection. A second test where pre returns `{found:true}` asserts zero detections.
- Production-path test: see §8.

---

### 3.4 `hydration_mismatch`

**Detector (do not touch):** `classifyReactErrors(errors: ConsoleError[], pageRoute: string)` at `packages/cli/src/classify/react.ts:31`. Splits on `isHydrationError(text)` at `:23`.

**Decision.** Today, `execute.ts:669` calls `classifyConsoleErrors` (`classify/console.ts:13`). That function emits `react_error` for any React-pattern match and `console_error` for everything else, but **never** emits `hydration_mismatch`. `classifyReactErrors` emits `hydration_mismatch` and `react_error` but **never** emits `console_error` for plain non-React errors.

We need both. Two options:

- **Option A (use both):** call `classifyReactErrors(errors, page)` and ALSO call `classifyConsoleErrors(non-react-errors, page)`. Risk of double-counting if filters disagree.
- **Option B (extend classifyReactErrors):** add a final fallthrough that emits `kind: 'console_error'` for `errors.filter(e => !isReactError(e.text))`. Single call site, single source of truth.

**Decision: B.** Extend `classifyReactErrors` to also emit `console_error` for non-React text. Mirror the existing `classifyConsoleErrors` behaviour.

**Plumbing:**

1. **`packages/cli/src/classify/react.ts:31-51`** — extend `classifyReactErrors`:
   ```ts
   export function classifyReactErrors(errors: ConsoleError[], pageRoute: string): BugDetection[] {
     return errors.map(e => {
       if (isHydrationError(e.text)) {
         return { kind: 'hydration_mismatch' as const, rootCause: e.text, stackTrace: e.stack, pageRoute };
       }
       if (isReactError(e.text)) {
         return { kind: 'react_error' as const, rootCause: e.text, stackTrace: e.stack, pageRoute };
       }
       return { kind: 'console_error' as const, rootCause: e.text, stackTrace: e.stack, pageRoute };
     });
   }
   ```

2. **`packages/cli/src/phases/execute.ts:19`** — swap import:
   ```ts
   // - import { classifyConsoleErrors } from '../classify/console.js';
   // + import { classifyReactErrors } from '../classify/react.js';
   ```

3. **`packages/cli/src/phases/execute.ts:669`** — replace call:
   ```ts
   bugs.push(...classifyReactErrors(postConsoleErrors, tc.page));
   ```

4. **`packages/cli/src/classify/console.ts`** — leave file untouched. The `classifyConsoleErrors` function is still imported by tests and may be used by other callers (verify with `grep -r classifyConsoleErrors packages/`). If only execute.ts uses it, mark as unused but do **not** delete (V24 is non-destructive).

5. **Update `classifyReactErrors` tests:** `packages/cli/src/classify/react.test.ts` — add a case for plain `console_error` fallthrough. Mirror `classifyConsoleErrors`'s plain-error test.

**Cost.** No runtime cost — same loop, same input. Pure rewiring.

**Acceptance test:**

- Unit test (extended): `react.test.ts` — add (a) plain-error returns `console_error`, (b) "Hydration failed because…" returns `hydration_mismatch`, (c) generic React Warning returns `react_error`.
- Plumbing test (new in `execute.v24.test.ts`): mock `__bhConsoleErrors` to contain a hydration message; assert `result.bugs[0].kind === 'hydration_mismatch'`.
- Regression check: any test that was checking `classifyConsoleErrors` output for plain errors continues to pass — `classifyReactErrors` produces the same shape for those cases.

---

### 3.5 `accessibility_critical` (delta path)

**Detector (do not touch):** `classifyA11yDelta(preViolations, postViolations, pageRoute)` at `packages/cli/src/classify/accessibility.ts:25`. Filters to critical/serious only.

**Existing state.** `execute.ts:148` calls `classifyA11yBaseline` once per page in `onPageBaseline`. That hook fires before the first action on each page. It does **not** capture per-action delta; it only emits the baseline list once.

**Decision.** Per-action delta runs an axe scan twice per UI action when `enableA11y || a11yStrict`:
- pre-action axe → `preViolations: A11yViolation[]`
- post-action axe → `postViolations: A11yViolation[]`
- `classifyA11yDelta(pre, post, pageRoute)` emits one detection per new critical/serious violation.

**Cost.** axe-core is heavy (~200-400 ms/scan on a typical page). Two scans per action × N actions × M pages can dominate runtime. Gate strictly on `enableA11y` (`--a11y` already exists, also implied by `--a11y-strict`). Default is OFF. When ON, document expected runtime impact.

**Plumbing:**

1. **`packages/cli/src/phases/execute.ts:404`** — `executeUiTestInner` needs to know whether `enableA11y` is on. The flag currently lives on `ExecuteOptions` (`execute.ts:56`) but is consumed only inside `runExecute`'s `onPageBaseline` (`execute.ts:133`). Thread the flag into `executeUiTest` → `executeUiTestInner` as a new `enableA11y?: boolean` parameter, OR pass through a lightweight options bag. **Decision: add a new positional parameter.** Mirrors existing parameter-bag style of `executeUiTest`.

   Update signatures:
   ```ts
   async function executeUiTest(tc, browser, surface, runId, paths, extraHeaders?, appBaseUrl?, visionEnabled?, …, asyncMaxWaitMs?, enableA11y?: boolean): Promise<TestResult>
   async function executeUiTestInner(scope, tc, runId, occurrenceId, start, appBaseUrl?, artifactPaths, actionLog, visionEnabled?, …, asyncMaxWaitMs?, enableA11y?: boolean): Promise<TestResult>
   ```

   Update the call site at `runTest` (~line 241): pass `opts.enableA11y` (already destructured from `runExecute` at line 104; if not, add).

2. **Pre-action axe (new), inside `executeUiTestInner` after `preSnapshot`:**
   ```ts
   // V24: pre-action a11y delta capture. Gated on enableA11y || a11yStrict.
   let preA11yViolations: A11yViolation[] = [];
   if (enableA11y === true) {
     const preAxeRes = await scope.evaluate(AXE_RUN_SCRIPT).catch(err => {
       log.debug('v24: pre axe-run failed', { err: String(err), occurrenceId });
       return null;
     });
     const v = (preAxeRes?.value as { violations?: unknown } | null | undefined)?.violations;
     preA11yViolations = Array.isArray(v) ? (v as A11yViolation[]) : [];
   }
   ```

3. **Post-action axe (new), after `postSnapshot`:**
   ```ts
   let postA11yViolations: A11yViolation[] = [];
   if (enableA11y === true) {
     const postAxeRes = await scope.evaluate(AXE_RUN_SCRIPT).catch(err => {
       log.debug('v24: post axe-run failed', { err: String(err), occurrenceId });
       return null;
     });
     const v = (postAxeRes?.value as { violations?: unknown } | null | undefined)?.violations;
     postA11yViolations = Array.isArray(v) ? (v as A11yViolation[]) : [];
   }
   ```

4. **Emission, alongside other DOM-derived classifier calls (~line 669):**
   ```ts
   if (enableA11y === true) {
     bugs.push(...classifyA11yDelta(preA11yViolations, postA11yViolations, tc.page));
   }
   ```

**Acceptance test:**

- Unit test (already passes): no test exists for `classifyA11yDelta` today — add one in `packages/cli/src/classify/accessibility.test.ts`. Cases: same violations pre/post → 0 detections; new critical violation post → 1 detection; new minor violation post → 0 detections (filter).
- Plumbing test (new): mock pre-axe returns `[]`, post-axe returns `[{id:'aria-name', impact:'critical', …}]`; assert one `accessibility_critical` detection.
- Production-path test: see §8.

---

## 4. Cluster signature parity check

Per `packages/cli/src/cluster/signature.ts`:

| Kind | Signature | File:line |
|---|---|---|
| `request_cancellation_missing` | `${method}:${normalizePath(url)}:request_cancellation_missing` | `:182-186` |
| `unbounded_list_render` | `${pageRoute}:${containerSelector}:unbounded_list_render` | `:169-172` |
| `dom_error_text` | `${kind}|${pageRoute}|${selectorClass}|${actionKind}` | `:25-28` |
| `hydration_mismatch` | `${kind}|${msgNorm}|${stackFp}` | `:13-18` |
| `accessibility_critical` | `${kind}|${pageRoute}|${selectorClass}` | `:33-34` |

All 5 produce non-empty signatures. **No edit needed.** Coder must verify by running `node -e "console.log(require('./dist/...').clusterSignature({kind:'…'}))"` for each kind on a synthetic detection — ship one assertion per kind in the unit test layer (helper exists in `cluster/signature.test.ts`).

`KIND_PRIORITY` (`phases/classify.ts:14`) — all 5 already present:

- `hydration_mismatch` (line 21, position 6)
- `dom_error_text` (line 50)
- `accessibility_critical` (line 54)
- `unbounded_list_render` (line 72)
- `request_cancellation_missing` (line 75)

No edit needed.

---

## 5. CLI / config

No new flags. V24 reuses existing flags:

| Detector | Gate flag |
|---|---|
| `request_cancellation_missing` | `--enable-perf` (existing — implied by `PerfArtifacts` being populated) |
| `unbounded_list_render` | `--enable-perf` (decision §3.2) |
| `dom_error_text` | always on (cheap, ~10 ms total) |
| `hydration_mismatch` | always on (no runtime cost) |
| `accessibility_critical` (delta) | `--a11y` (existing; implied by `--a11y-strict`) |

If user passes `--all`, both `--enable-perf` and `--a11y` are set, so all 5 fire. Document this in CLI help (`packages/cli/src/cli/main.ts:46-47`):

```
--a11y                 Enable accessibility_critical baseline + delta checks
                       Delta runs axe pre/post each UI action; adds ~400ms/action.
```

**Decision: no new `--enable-a11y-delta` flag.** `--a11y` already gates the kind; splitting baseline vs delta into separate flags is configuration noise. If the cost becomes problematic, V25 can introduce `--a11y-light` to disable delta. Document the cost in CLI help so users opt-in informed.

---

## 6. Edge cases

### EC-1. NavigationEvent capture only valid when CDP session is active.
`perfCollector` is only present when `--enable-perf` is set (`run.ts:332`). When absent, the post-drain block doesn't execute, so `classifyCancelMissing` doesn't run — correct. The detector itself returns `[]` when `navigationEvents.length < 2` (e.g. single-page test) so no false positives.

### EC-2. axe-core not loaded on the page.
`AXE_RUN_SCRIPT` at `:14-23` returns `{ violations: [] }` if `window.axe` is undefined. The `onPageBaseline` hook injects axe via `scope.evaluate(AXE_RUN_SCRIPT)` once per page, but in V24 we also call axe BEFORE the first per-page baseline runs. Order: `executeUiTestInner` runs after the inner state-context steps and after `onPageBaseline`. **Verify**: `executeUiTestInner` calls `onPageBaseline(scope, tc.page)` at line 466 before the action. Then the V24 pre-axe call runs after that — axe is loaded. **Confirmed safe.**

If axe injection itself fails (CSP blocks, target page broke axe), pre/post axe both return `[]`, delta is `[]`, no detection. Logged as debug.

### EC-3. `outerHTML` is huge (DOM is enormous).
Capped at 2 MiB at the eval source. Truncation may cut a `<tr>` mid-tag; the regex parser in `unbounded-list.ts:29` matches tag-prefix only, so truncation under-counts but never over-counts. False-negatives are acceptable on monstrous DOMs (the kind we want to flag is exactly the kind that would fit in 2 MiB).

### EC-4. `dom_error_text` pre-action match disqualifies post-action match.
By design. If "Something went wrong" was already on the page before the action ran, we don't blame the action. EC-2 in V07 covers a future enhancement: track WHICH text appeared, not just `found:boolean`. Out of scope for V24.

### EC-5. `hydration_mismatch` and `react_error` for the same console message.
`classifyReactErrors` checks `isHydrationError` first (`:36-40`). A hydration error is exclusively `hydration_mismatch`. The priority hierarchy (`KIND_PRIORITY`) places `hydration_mismatch` (position 6) above `react_error` (position 5)... wait — that's reversed. Position 5 (`react_error`) is *higher* priority than position 6 (`hydration_mismatch`). **Coder verify and flag in PR description.** If `applyPriorityFilter` is called on a single occurrence with both detections, it picks `react_error`. Since `classifyReactErrors` only emits ONE kind per error (the early-return), this race never happens — but cross-occurrence clustering still puts react_error above hydration_mismatch. **Decision: leave KIND_PRIORITY unchanged.** A hydration error is functionally a react error subclass; if a user disables react_error suppression, they probably want both. Document but do not edit.

### EC-6. `accessibility_critical` baseline + delta double-count.
`onPageBaseline` (`:148-153`) emits a baseline detection for axe violations on first visit. The V24 delta, on the same first visit, sees the same violations in pre AND post (because pre runs after `onPageBaseline` already saw them). `classifyA11yDelta` filters by `preIds.has(v.id)` — same violation in pre and post → not in delta. **No double-count.**

But: cluster signature for baseline (`accessibility_critical|pageRoute|selectorClass`) and delta (same shape) are identical for the same violation. So if the action introduces a NEW violation post, it clusters separately from the baseline. **Confirmed clean.**

### EC-7. `unbounded_list_render` on a page with virtualization.
Detector handles this at `:110-115` — global virtualization signals (`data-virtualized`, `react-window`, `react-virtual`, `tanstack-virtual`, `virtual-list`) skip all checks. False-positive rate on virtualized lists: zero by design. False-negative rate when virtualization is custom (some homegrown windowing): unknown — out of scope; document.

### EC-8. `framenavigated` fires for sub-frames (iframes).
`cdp-session.ts:233-240` already filters `frame === page.mainFrame()`. Sub-frame navigations (oauth popups, embedded checkout) don't pollute the navigationEvents array. **Confirmed correct.**

### EC-9. Extra-axe runs and INP measurement.
INP relies on event-handler timing. If axe runs between a click and INP capture, axe's main-thread work could inflate INP. V24's pre-axe runs BEFORE the action, so the click-to-INP window is clean. V24's post-axe runs AFTER drain (well after INP would have been captured by web-vitals). **Confirmed: no INP corruption.**

### EC-10. `outerHTML` capture races a still-rendering SPA.
Post-action waits for the MutationObserver window to close (`mutWindowMs`). Then `postSnapshot` runs. Then V24 outerHTML capture runs. Timing: a synchronously-rendered list is in the DOM by the time outerHTML runs. Async-loaded rows (e.g., a table that fetches in `useEffect` and appends rows over 5s) may be incomplete at outerHTML time. Detector under-counts. Acceptable: V24 doesn't claim coverage of streaming-rendered lists. Document.

### EC-11. `enableA11y` set but axe-core not loadable.
`onPageBaseline` (`:133-152`) is the only injector today. It calls `scope.evaluate(AXE_RUN_SCRIPT)` which is a NO-OP if `window.axe` is undefined — it returns `{ violations: [] }` from the script's own check (`accessibility.ts:16: if (!window.axe) return …`). axe is injected via the project's app code, not by BugHunter. Confirm with the Aspectv3 fixture and document: V24 assumes axe is loadable on the SUT (vibe-coded apps that load axe via dev dependency, or test-only injection via the page hook).

If we want axe injection to be BugHunter's responsibility, that's a separate spec (V25). Out of scope.

---

## 7. Acceptance criteria

| # | Criterion | Verifier |
|---|---|---|
| 1 | All 5 BugKinds fire on `fixtures/v24-deferred-bugs/` with `--enable-perf --a11y` | `jq '.byKind' summary.json` shows all 5 ≥ 1 |
| 2 | Plumbing tests for each kind pass | `npx vitest run packages/cli/src/phases/execute.v24.test.ts` |
| 3 | New `dom-error-text.test.ts` passes (4 cases) | `npx vitest run packages/cli/src/classify/dom-error-text.test.ts` |
| 4 | Extended `accessibility.test.ts` passes (3 cases for delta) | `npx vitest run packages/cli/src/classify/accessibility.test.ts` |
| 5 | Extended `react.test.ts` passes (3 cases incl. console_error fallthrough) | `npx vitest run packages/cli/src/classify/react.test.ts` |
| 6 | All existing unit tests still pass (no regression in `classifyConsoleErrors`-related tests) | `npx vitest run` |
| 7 | `npx tsc --noEmit` clean across the monorepo | `tsc` |
| 8 | `npx eslint . --max-warnings 0` clean | `eslint` |
| 9 | `npm run build` clean | `tsc -b` |
| 10 | A `--enable-perf --a11y` smoke against `fixtures/vite-crawl-app/` regression-detects nothing new (zero false positives on a clean app) | manual run, compare to pre-V24 baseline |
| 11 | NavigationEvent now appears in `runs/<id>/perf/<occId>.json` artifact | `jq '.navigationEvents | length' runs/<id>/perf/<occId>.json` ≥ 0 (`>0` after at least one in-action navigation) |

False-positive bound: V24 must not increase the false-positive rate on Aspectv3 by more than 5%. Coder runs Aspectv3 smoke pre-V24 and post-V24; diffs `summary.json.byKind`; documents in PR description.

---

## 8. Files to touch / add

### Files to modify

| File | Change | Lines (approx) |
|---|---|---|
| `packages/cli/src/types.ts` | Add `navigationEvents: NavigationEvent[]` to `PerfArtifacts`. Import `NavigationEvent` type. | ~3 |
| `packages/cli/src/perf/perf-collector.ts` | Pass `drained.navigationEvents` into the `perf` literal at `:74-81`. | ~2 |
| `packages/cli/src/phases/execute.ts` | (a) Swap `classifyConsoleErrors` import for `classifyReactErrors`. (b) Add pre/post `CHECK_DOM_ERROR_SCRIPT` evals + `dom_error_text` emission. (c) Add post-action `outerHTML` eval + `classifyUnboundedList` call. (d) Add pre/post `AXE_RUN_SCRIPT` evals + `classifyA11yDelta` call. (e) Add `classifyCancelMissing(har, perf.navigationEvents)` to post-drain block. (f) Update perf drain `.catch` fallback to include `navigationEvents: []`. (g) Thread `enableA11y` into `executeUiTest`/`executeUiTestInner`. (h) Replace `domErrorTextDetected: false` with the real value. | ~80 |
| `packages/cli/src/classify/react.ts` | Extend `classifyReactErrors` to fall through to `console_error` for non-React text. | ~5 |
| `packages/cli/src/classify/react.test.ts` | Add a console_error fallthrough test case. | ~10 |
| `packages/cli/src/cli/main.ts` | Update `--a11y` help text to mention delta-pass cost. | ~2 |

### Files to create

| File | Purpose |
|---|---|
| `packages/cli/src/classify/dom-error-text.test.ts` | Unit test for `classifyDomErrorText` (4 cases). Today no test file exists for this classifier. |
| `packages/cli/src/classify/accessibility.test.ts` | Unit test for `classifyA11yDelta` (3 cases). Today no test file exists for this classifier. |
| `packages/cli/src/phases/execute.v24.test.ts` | Plumbing tests: 5 cases, one per detector, asserting that with mocked TabScope + mocked PerfArtifacts the right BugKind lands in `result.bugs`. Use the same mock pattern as existing `execute`-adjacent tests. |
| `fixtures/v24-deferred-bugs/` | Synthetic vibe-coded app (Vite + React) with:<br>• `/long-list` route — renders 200 `<tr>` rows un-virtualized → `unbounded_list_render`<br>• `/error-toast` route — clicking the button reveals a `<div>Something went wrong</div>` → `dom_error_text`<br>• `/hydration` route — server-renders one tree, client-renders another → `hydration_mismatch` console error<br>• `/cancel` route — click triggers two fetches and a router.push() before either finishes → `request_cancellation_missing`<br>• `/a11y` route — clicking the button removes the only `aria-label`-bearing element, introducing a critical axe violation → `accessibility_critical`<br>Plus `MUST_DISCOVER.json` listing all 5 routes. Plus `surfacemcp.config.json` for SurfaceMCP discovery. |
| `tests/integration/v24-deferred-bugs.test.ts` | Smoke test that boots the v24 fixture with vite, runs BugHunter against it with `--enable-perf --a11y`, asserts `summary.json.byKind` contains all 5 kinds with count ≥ 1. May be skipped in CI if the test infra doesn't have headless browser access — mark `describe.skipIf(!process.env.HAS_BROWSER)`. |

### Files NOT to touch

- `packages/cli/src/classify/request-hygiene.ts` — detector body unchanged.
- `packages/cli/src/classify/unbounded-list.ts` — detector body unchanged.
- `packages/cli/src/classify/dom-error-text.ts` — detector + script unchanged.
- `packages/cli/src/classify/accessibility.ts` — detector + script unchanged.
- `packages/cli/src/classify/console.ts` — leave file. `classifyConsoleErrors` is no longer called by `execute.ts` after V24, but other callers may exist; do not delete.
- `packages/cli/src/cluster/signature.ts` — all 5 kinds already covered.
- `packages/cli/src/phases/classify.ts` — all 5 kinds already in `KIND_PRIORITY`.
- `packages/cli/src/adapters/cdp-session.ts` — NavigationEvent + `framenavigated` listener already correct.

---

## 9. Negative requirements

- Do **not** modify any of the 5 detector function bodies.
- Do **not** add a new `--enable-a11y-delta` flag — `--a11y` is sufficient.
- Do **not** unconditionally run axe pre/post actions when `--a11y` is unset — that wastes runtime.
- Do **not** capture `outerHTML` on every UI action when `--enable-perf` is unset — that wastes runtime and bandwidth.
- Do **not** delete `classifyConsoleErrors` from `console.ts`. If it has no other callers after V24, leave it as a future cleanup pass; V24 is non-destructive.
- Do **not** add a new collector or adapter. All input sources already exist.
- Do **not** widen `EvaluateResult.value`'s `unknown` type. Narrow at every call site with explicit typecasts AND runtime guards (`Array.isArray`, `typeof === 'string'`, etc.).
- Do **not** allow `as any`. Use `unknown` and narrow.
- Do **not** thread more than one new positional parameter through `executeUiTest`/`executeUiTestInner`. Coder may bundle into a single `extras: { enableA11y?: boolean }` if more than one is needed in future, but for V24 only `enableA11y` is added — single parameter is acceptable.
- Do **not** push to remote. The PR is gated on user acceptance after smoke run.

---

## 10. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Extend `PerfArtifacts` with `navigationEvents` field | `types.ts`, `perf-collector.ts` | none |
| 2 | Wire `classifyCancelMissing` in post-drain block | `execute.ts` (post-drain ~line 287) | 1 |
| 3 | Add post-action `outerHTML` eval + `classifyUnboundedList` call | `execute.ts` (executeUiTestInner) | none |
| 4 | Add pre/post `CHECK_DOM_ERROR_SCRIPT` evals; flip `domErrorTextDetected`; emit `dom_error_text` | `execute.ts` (executeUiTestInner) | none |
| 5 | Extend `classifyReactErrors` to fall through to `console_error` | `react.ts`, `react.test.ts` | none |
| 6 | Replace `classifyConsoleErrors` with `classifyReactErrors` in execute.ts | `execute.ts:19,669` | 5 |
| 7 | Thread `enableA11y` into `executeUiTest`/`executeUiTestInner`; add pre/post `AXE_RUN_SCRIPT` evals; emit `accessibility_critical` delta | `execute.ts` (signatures + body) | none |
| 8 | Add unit tests: `dom-error-text.test.ts`, `accessibility.test.ts` | new files | 4, 7 |
| 9 | Add plumbing tests in `execute.v24.test.ts` | new file | 2, 3, 4, 6, 7 |
| 10 | Build the `fixtures/v24-deferred-bugs/` vite app with 5 buggy routes | new files | none |
| 11 | Add `tests/integration/v24-deferred-bugs.test.ts` end-to-end | new file | 9, 10 |
| 12 | Update CLI help for `--a11y` to mention delta cost | `main.ts:46-47` | 7 |
| 13 | Manual smoke against Aspectv3, regression-check `summary.json.byKind` | (manual) | 1-12 |
| 14 | Manual smoke against `fixtures/v24-deferred-bugs`, confirm all 5 kinds fire | (manual) | 10, 1-12 |

Each task is single-concern, ≤3 files, independently testable.

---

## 11. Definition of Done

- [ ] All tasks 1-14 complete.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx eslint . --max-warnings 0` clean.
- [ ] `npx vitest run` passes (all existing + new tests).
- [ ] `npm run build` clean.
- [ ] Manual smoke on `fixtures/v24-deferred-bugs/` shows `byKind` contains all 5 deferred BugKinds with count ≥ 1.
- [ ] Manual smoke on `fixtures/vite-crawl-app/` (or Aspectv3) shows no more than 5% increase in `byKind` total counts vs pre-V24 baseline (false-positive bound).
- [ ] PR description includes:
  - Pre-V24 / post-V24 `byKind` diff on Aspectv3 smoke.
  - Pre-V24 / post-V24 `summary.json.runtimeMs` diff on Aspectv3 smoke (axe delta cost).
  - Confirmation that hydration_mismatch fires before react_error in `KIND_PRIORITY` is documented but unchanged.
  - Clear note: `classifyConsoleErrors` is no longer called from execute.ts but is retained for forward-compat.
- [ ] No `as any`. No silent `catch (e) {}`. Every `evaluate` failure is logged at debug level.
- [ ] Audit can re-run: every BugKind in the union (modulo `csrf_missing_on_mutating_route` and `hallucinated_route`, scoped to V25) reports "wired" via `bughunter detectors --status wired` (when that command exists in Phase B).

---

## 12. Risks + escape hatches

- **Risk: axe runs nearly double UI-action runtime.** A 200-action smoke at 400 ms/scan = +160 s. Mitigation: gate on `--a11y` (not default). Document in CLI help. If a user wants axe-baseline-only without delta, they'd need a `--no-a11y-delta` flag — defer to V25 if requested.
- **Risk: `outerHTML` capture leaks PII into perf artifacts on disk.** The HTML may contain user data. Today's `perfArtifacts` write goes to `runs/<id>/perf/<occurrenceId>.json`. V24 stores `navigationEvents` only (URLs); `outerHTML` is consumed in-memory for `classifyUnboundedList` and discarded. **Confirm: do not persist `outerHTML` to disk.** Coder must verify the post-action capture is consumed and not stored.
- **Risk: hydration_mismatch fires on every render of a hot-reloaded dev page.** Dev-mode warnings are noisier than prod. Acceptable: BugHunter targets vibe-coded apps mid-development; surfacing dev-mode hydration mismatches is the point. Document expected dev-mode signal.
- **Risk: `request_cancellation_missing` fires on a benign keep-alive HEAD that completes after a user-driven nav.** The detector at `:158` filters out `entry.response.status === 0` (failed/canceled). Real-world keep-alives return 200. Re-evaluate detection precision if false-positive rate exceeds 10% on the calibration corpus (V24 doesn't introduce that corpus; Phase F).
- **Escape hatch:** If any detector produces unmanageable noise on real targets, add a CLI suppression `--suppress-kind <kind>` flag (out-of-scope for V24 — Phase B). Until then, document the risk in PR.

---

## 13. Open questions

1. **`unbounded_list_render` gate: `--enable-perf` or always-on?** §3.2 picks `--enable-perf` to keep cost off the default path. The detector itself is cheap (regex pass over a string); the cost is the `outerHTML` capture (~20-50 ms/action). Coder may flip to always-on if smoke shows < 1% wall-clock overhead on Aspectv3 — flag in PR.

2. **Re-export `NavigationEvent` from `types.ts`?** §3.1 leaves the choice to the coder. Pro: types.ts stays the single import surface for cross-module types. Con: cross-module circular import risk (types.ts already imports from adapters? — verify). **Conservative default: `import type` from cdp-session into types.ts.** If lint flags the cycle, re-export.

3. **Is `classifyConsoleErrors` (`console.ts:13`) still needed after V24?** After §3.4, no caller in `execute.ts` invokes it. Only test imports remain. **Decision: leave it.** Removal is a separate cleanup. Flag in PR for a follow-up.

4. **Pre-action axe runs after `onPageBaseline`. Should V24 axe-baseline replace `onPageBaseline`'s axe call?** No — `onPageBaseline` runs once per page (cheap, surfaces baseline issues), V24 runs per action (expensive, surfaces deltas). Different shape; keep both.

5. **Should the dom-error-text pre/post comparison consider WHICH text matches, not just `found:boolean`?** EC-4 flags this. For V24, use boolean-only. If a vibe-coded app has a static "Failed to load" header that's always present, V24 won't flag a click that adds another "Failed to" elsewhere — false-negative. Acceptable for v0.24; address in V25 if needed.

6. **`KIND_PRIORITY` puts `react_error` (5) above `hydration_mismatch` (6).** EC-5 confirms this is irrelevant in practice (single-kind emission per error). Coder verifies and notes in PR; user may swap positions in V25 if desired.

7. **Fixture app at `fixtures/v24-deferred-bugs/` — Vite + React, or framework-free?** Fast-iteration recommendation: Vite + React, mirroring `fixtures/vite-crawl-app/`. Reuses existing test infra. Coder's call.

8. **Should `executeUiTestInner`'s parameter list be refactored into a single options object before V24 adds `enableA11y`?** It already has 13 positional params. **Defer to a separate refactor.** V24 adds one more — total 14 — and a follow-up spec can refactor to an options bag. Premature refactor under V24 expands the diff and risk.

---

## 14. Killer-demo runbook

```bash
# 1. Build
cd /root/BugHunter && npm run build

# 2. Boot the V24 fixture
cd /root/BugHunter/fixtures/v24-deferred-bugs && \
  npm install && \
  npm run build && \
  nohup npx vite preview --port 5780 > /tmp/v24-fixture.log 2>&1 & disown
sleep 4 && curl -sS http://127.0.0.1:5780/ | head -3

# 3. Boot SurfaceMCP for the fixture
cd /root/BugHunter/fixtures/v24-deferred-bugs && \
  nohup node /root/SurfaceMCP/dist/cli/main.js serve > /tmp/v24-surfacemcp.log 2>&1 & disown
sleep 5 && curl -sS http://127.0.0.1:3107/health

# 4. Run BugHunter
cd /root/BugHunter/fixtures/v24-deferred-bugs && \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --enable-perf --a11y --max-bugs 100 --budget 600000

# 5. Verify
RUN=$(ls -t .bughunter/runs/ | head -1)
jq '.byKind | with_entries(select(.key | IN("request_cancellation_missing","unbounded_list_render","dom_error_text","hydration_mismatch","accessibility_critical")))' \
  .bughunter/runs/$RUN/summary.json
# Expect each of the 5 keys with count ≥ 1.
```

If all 5 kinds fire, V24 is functionally complete. Run regression smoke on Aspectv3 next.

---

## 15. Author notes (for future-self / V25)

V24 closes the dead-detector audit's last 5 items. After V24:

- 14/14 deferred perf+UI detectors are wired (ignoring `csrf_missing_on_mutating_route` and `hallucinated_route` which need own-spec runners).
- The `bughunter detectors` command (Phase B) will report `wired` for every BugKind in the perf+UI families.
- Phase A item 1 is complete.
- Next up (Phase A item 2): wire `csrf_missing_on_mutating_route` (V25) and `hallucinated_route` (V26).
- `classifyConsoleErrors` is unused after V24 — V25 may delete `classify/console.ts` if no other caller surfaces.

End of spec.
