# Spec V11 — Discovery↔Execute DOM Consistency

Branch: `spec/v11-dom-consistency`
Worktree: `/tmp/bughunter-spec-v11`
Target repo: `/root/BugHunter` (consumer-side fix)
Coordinated repo: SurfaceMCP — **no changes required this spec** (see §3 verdict).

---

## §1. Objective + Boundaries

### 1.1 Objective
Eliminate the dominant remaining BugHunter infra-failure class on TraiderJo: **`submit: form_not_found (formSelector=form:nth-of-type(1))`** (32/52 infra failures, run `zloytwqlufbt4z670pfru98k`).

The fix has two parts, both in `packages/cli`:

1. **Wait for the form before submitting.** Replace the fixed 250 ms `stateSettleMs`/post-trigger sleep with an explicit "form-present" poll bounded by `asyncMaxWaitMs`. If the form never appears, emit a *typed* infra reason (`form_never_rendered`) instead of the generic `form_not_found`, and fail fast (≤2 s) so we don't burn budget on dead state pages.
2. **Skip submit tests for unreachable forms per role.** When a state page's form is gated on a successful authenticated API call (e.g., `useMyProfile`) and the role under test is anonymous, the form will never render. Detect this at *plan* time using a per-(role,page) "form-presence probe" that runs once before submit tests are queued, and gate submit-kind tests on the probe result.

### 1.2 In scope
- `packages/cli/src/phases/execute.ts` — state re-establishment + submit branch.
- `packages/cli/src/phases/form-submit-runner.ts` — return typed reasons; bounded wait.
- `packages/cli/src/phases/plan.ts` (or a new `form-reachability-probe.ts`) — per-role probe.
- `packages/cli/src/discovery/crawler.ts` — record discovery-time form-render latency for telemetry only (informational; no behaviour change).
- `packages/cli/src/types.ts` — extend infra failure detail with `form_never_rendered` reason.
- Unit tests for the new wait helper + probe filter.

### 1.3 Out of scope (explicit)
- **No changes to SurfaceMCP, camofox-mcp, or the DOM walker.** The walker's `nth-of-type(i+1)` selector is fragile in theory (cause E in the brief) but is **not the cause of these 32 failures** — see §3.4. A separate spec will harden selectors when telemetry shows multi-form pages mis-fire.
- **No per-role browser context isolation.** Anon role currently runs with the owner's cookie jar (camofox shares context across tabs). Carving out a separate browser context is a larger architectural change and is deferred.
- **No new BugKind.** `form_never_rendered` is an infra reason, not a user-visible bug.
- **No retry of the trigger click.** If `clickByHint` returns `clicked: true`, we trust it and only debate whether the form rendered.

---

## §2. Existing Code Map

### 2.1 Files you MUST read before writing any code (in order)

| Path | Why |
| --- | --- |
| `/root/BugHunter/packages/cli/src/phases/execute.ts` lines 383–500 | `executeUiTestInner`: state re-establishment block (lines 409–431) + submit branch (lines 463–469). The 250 ms sleep on line 430 is the racy wait. |
| `/root/BugHunter/packages/cli/src/phases/form-submit-runner.ts` (whole file, 113 lines) | `runFormSubmit`, `buildFillSubmitScript`. Currently returns `'form_not_found'` when `document.querySelector(formSelector)` is null. This is where the typed reason + bounded wait must land. |
| `/root/BugHunter/packages/cli/src/discovery/crawler.ts` lines 263–293 | State navigation: `navigate → clickByHint → 250 ms → collectDomOnly`. Mirror its primitives in execute. |
| `/root/BugHunter/packages/cli/src/discovery/dom-walker.ts` (whole file) | `collectDomOnly`, `walkDom`. Confirms `formSelector = form:nth-of-type(i+1)` per form. **Do not change.** |
| `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` lines 258–266, 411–496 | `evaluateClickByText` (text→element resolution) and `clickByHintForTab` (testId→ariaLabel→text fallback). Confirms text-only matches click the first visible match. |
| `/root/BugHunter/packages/cli/src/types.ts` lines 282–340, 770–840 | `DiscoveredForm`, `DiscoveredPage`, `BugHunterConfig`. The probe wires through `BugHunterConfig.asyncMaxWaitMs` (defaulted to 30000 in `config.ts:157`). |
| `/root/BugHunter/packages/cli/src/phases/plan.ts` | UI submit test generation. The probe gate slots in here. |

### 2.2 Patterns to follow

- **Single-evaluate page interaction.** The v0.10 fix moved fill+submit into one `scope.evaluate()` round-trip (`form-submit-runner.ts:71-106`). Match that style for the new wait: do the form-present poll inside the page (a single `evaluate` with a 100 ms inner-loop and a 2 s deadline), not host-side polling. One round-trip, one deadline.
- **Typed errors via reason strings.** `runFormSubmit` already throws `Error('submit: <reason> (formSelector=…)')`. Add a new reason `form_never_rendered` and surface it in the infra failure `detail`; don't introduce an `Error` subclass.
- **State-page primitives must match across discovery + execute.** Both must call the same `clickByHint(triggerHint)` and the same wait helper. Extract the wait helper so it's shared.
- **Plan-time probes consume one tab.** Look at `phases/auth-flow.ts:90-140` — it does a one-shot login probe before the main run. Use the same shape: a top-level `phases/form-reachability-probe.ts` that runs once after discovery, before plan, and produces a `Map<RolePageKey, ProbeResult>` consumed by plan.

### 2.3 DO NOT
- **Do not** change `dom-walker.ts`. Its `nth-of-type` selector is correct for single-form pages, which is what we have on TraiderJo. (Future selector-hardening is a separate spec.)
- **Do not** create a new `wait-for-element.ts` utility — co-locate the wait inside `form-submit-runner.ts` and re-use its `EvaluateResult` shape.
- **Do not** add a new `BrowserMcpAdapter` method. The page-side script does the polling.
- **Do not** introduce a new TabScope or per-role browser context.
- **Do not** loosen the `formSelector` (e.g., to `'form'` without the `:nth-of-type`). The selector is part of the test-case identity.
- **Do not** retry the trigger click. If `clicked: true`, it clicked. The race is the *render*, not the click.
- **Do not** bump `stateSettleMs` globally. That just shifts the race.

---

## §3. Investigation Findings

### 3.1 Method
1. Read `dom-walker.ts`, `crawler.ts`, `execute.ts`, `form-submit-runner.ts`, `browser-mcp.ts`.
2. Loaded `state.json`, `infrastructure.jsonl`, `action-logs/*.json`, `screenshots/*.png` from run `zloytwqlufbt4z670pfru98k`.
3. Cross-referenced TraiderJo `src/components/Navbar.tsx`, `src/ui/App.tsx`, `src/features/profile/components/ProfileEditor.tsx`, `src/features/profile/pages/ProfileSettingsPage.tsx`, `src/ui/components/AlpacaIntegration.tsx`, `src/ui/pages/SettingsTab.tsx`.
4. Inspected screenshot `af5qtoa5w555sboz30lt0i5w.png` for the actual DOM at submit time.
5. Counted submits per page/role/outcome from `state.json.testResults`.

### 3.2 Empirical breakdown of the 32 form_not_found failures

- **All 32 are on `/?setTab=profile`.** (Settings page, which has 4 named fields, hit 0 form_not_found failures.)
- **Role split:** 1 owner, 31 anon.
- **Total submit attempts on the Profile tab:** 78. Of those: 32 infra (form_not_found), 46 non-infra (mostly `focus_lost_after_action`). Zero passed.
- **Settings tab submit attempts:** 2 infra (form_not_found) — see footnote¹. So the failure is overwhelmingly a Profile-tab phenomenon.

¹ The two settings-tab form_not_found failures are anon role attempting to submit `<form>` in `AlpacaIntegration` while logged out; same root cause as Profile (form gated on auth).

### 3.3 Source-side facts (verified)

1. **TraiderJo has only 3 `<form>` tags total** in source: `ProfileEditor` (Profile tab), `Onboarding` (separate route), `AlpacaIntegration` (Settings tab). On the Profile tab there is exactly **one** `<form>` rendered, so `form:nth-of-type(1)` is structurally correct. The selector is not the bug.
2. **Profile tab routing:** Navbar `Profile` button calls `setTab('profile')`. AppShell remaps `'profile' → 'myprofile'`. App.tsx renders `<ProfileSettingsPage>` only on `tab === 'myprofile'`, which renders `<ProfileEditor>`.
3. **`ProfileEditor` is gated on `useMyProfile()`:**
   - While `loading === true` → renders only a spinner; no `<form>` in DOM.
   - On `error !== null` → renders an error banner; **no `<form>`** in DOM. Permanently.
   - Only when `data` is loaded does the `<form onSubmit={handleSubmit}>` mount.
4. **`useMyProfile` requires a valid session and CSRF token.** The screenshot for `af5qtoa5w555sboz30lt0i5w` (an *owner-role* attempt) shows the live DOM at submit time: the page has rendered `Missing or invalid CSRF token` — i.e., even owner can fail to load the form when CSRF state isn't established in a fresh tab.
5. **Discovery vs execute tab semantics differ:**
   - Discovery walks one persistent tab; navigates to `/`, clicks Profile, settles 250 ms, evaluates DOM. By the time execute kicks in, the SPA + browser cache may have warmed the API; useMyProfile resolves quickly.
   - Execute opens a **fresh tab per test** via `withTab` (`browser-mcp.ts:419-431`). Each fresh tab reloads `/`, clicks Profile, sleeps 250 ms — and `useMyProfile`'s fetch may still be in flight, *or* may have errored on CSRF.

### 3.4 Verdict on the brief's hypotheses

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| **A.** Trigger click matches the wrong element (text-only collision). | **No.** | `evaluateClickByText` (`browser-mcp.ts:258`) prefers exact-match text on `button, a, [role="button"], [role="tab"], [role="link"]`. TraiderJo has exactly one button with text content `Profile` (`Navbar.tsx:35`). |
| **B.** 250 ms post-click settle is racy vs lazy form hydration. | **Partially yes — owner role.** | The 1 owner-role form_not_found is best explained by useMyProfile's network call missing the 250 ms window in a fresh tab. |
| **C.** `form:nth-of-type(1)` matches a different form on execute. | **No.** | Profile tab has exactly one `<form>` in source; state.json corroborates `forms count: 1`. |
| **D.** Form is conditionally rendered based on focus/scroll/window state. | **No.** | `ProfileEditor` renders unconditionally on `data` truthy; no scroll/focus gate. |
| **E.** `dom-walker.ts` walks the full document, indexing across multiple parents. | **Latent risk, not this run's cause.** | `document.querySelectorAll('form')` does return a flat list, and `:nth-of-type(N)` is parent-relative — so on a page with multiple parents each having their own `<form>`, the selector is bogus. But TraiderJo's Profile tab has one form. Spec a follow-up only when telemetry shows multi-form pages. |
| **F (new).** Form is gated on an authenticated API call that fails for anon and races for owner. | **YES — primary cause.** | 31/32 failures are anon role. anon has no session for `/me/profile`; useMyProfile errors; `<form>` never mounts. CSRF screenshot evidence shows owner can also miss the window. |

### 3.5 Root cause (one paragraph)
The Profile tab's `<form>` is conditionally mounted by `ProfileEditor` only after `useMyProfile()` returns a non-error response. For the **anon role** the API call always errors (no session), so the form never mounts — yet planning still emits 31 anon submit tests against the discovered `form:nth-of-type(1)` selector, all of which fail with `form_not_found`. For the **owner role** the API call usually resolves but in a fresh `withTab` browser tab can race the 250 ms `stateSettleMs` and occasionally fail with CSRF / hydration errors before the form mounts. The discovered form selector is correct; what's wrong is (a) executing submit tests on (role, page) pairs where the form is structurally unreachable, and (b) waiting a fixed 250 ms for an asynchronous hydration that needs a poll.

---

## §4. Design Choice (architect picks ONE — rationale required)

### 4.1 Options considered
- **Option 1: Bump `stateSettleMs` globally to 2000 ms.** Cheap. Doesn't help anon role (form never mounts). Wastes 1750 ms × N tabs of execute time.
- **Option 2: Per-role browser context isolation + auth-flow per role.** Correct long-term fix. ~3 weeks of work. Out of scope.
- **Option 3 (CHOSEN): Form-reachability probe at plan time + bounded form-present poll at execute time.**

### 4.2 Chosen design
1. **Plan-time probe (`phases/form-reachability-probe.ts`).** After discovery and before plan, for each `(role, page)` pair where `page.kind === 'state' && page.forms.length > 0`, open one tab as that role, run the same trigger sequence (`navigate(baseRoute) → clickByHint(triggerHint) → wait-for-form(formSelector, asyncMaxWaitMs=2000)`), record `{ probed: true, formPresent: bool, latencyMs: number, reason?: string }`. Cache results in a `Map<string, ProbeResult>` keyed by `${role}::${pageRoute}::${formSelector}`. Budget: 1 probe per (role, state-page-with-form) — for TraiderJo's 11 state pages × 2 roles, that's ≤22 probes × ≤2 s = ≤44 s. Plan filters submit tests where `formPresent === false`, emitting a skip reason `form_unreachable_for_role` (counted in `skipReasons`, not `infrastructureFailureCount`).
2. **Execute-time bounded wait (modify `runFormSubmit`).** Replace the immediate `document.querySelector(formSelector)` null-check with an in-page poll: 100 ms intervals up to `2000 ms` (configurable via `asyncMaxWaitMs`). Done inside the existing `evaluate` round-trip — no host-side loop. On timeout, return `{ ok: false, reason: 'form_never_rendered' }` (typed); host throws `Error('submit: form_never_rendered (formSelector=…)')`. The submit test reports an infra failure with the new reason, distinguishing real "selector wrong" failures from "we waited 2 s and the form never appeared" failures.
3. **Symmetry of state-establishment.** Extract the `clickTriggerAndWaitForForm(scope, triggerHint, formSelector, asyncMaxWaitMs)` helper used by both the probe and `executeUiTestInner`'s state re-establishment. This guarantees discovery, probe, and execute all use the same primitive.

### 4.3 Rationale
- **Addresses both subcauses of failure F** (anon never-renders + owner race) with one piece of infrastructure (the wait helper) plus one filter (the probe).
- **Costs ≤44 s** of extra runtime for TraiderJo (vs ~400 s wasted today on the 32 doomed tests + their retries).
- **No false negatives.** If the probe says `formPresent === false`, plan skips submit tests for that (role, page); we don't lose any passing tests because they would have failed anyway.
- **Falsifiable in CI.** The probe results land in `state.json.discovery.probe` — easy to assert.
- **Clean cross-cutting.** No new BrowserMcp method. No SurfaceMCP coordination. One new file (`form-reachability-probe.ts`), three modified files.
- **Forward-compatible.** When per-role contexts arrive, the probe will run once per role's real context and remain correct.

### 4.4 Key signatures

```ts
// packages/cli/src/phases/form-submit-runner.ts (modified)

export type FormSubmitReason =
  | 'form_never_rendered'
  | 'form_not_found'        // legacy — emitted only if asyncMaxWaitMs <= 0
  | 'file_field_unsettable'
  | 'submit_failed'
  | 'page_eval_threw'
  | 'no_result'
  | 'unknown';

export async function runFormSubmit(
  scope: FormSubmitScope,
  formSelector: string,
  input: Record<string, unknown>,
  opts?: { asyncMaxWaitMs?: number },   // default 2000
): Promise<void>;

export function buildFillSubmitScript(
  formSelector: string,
  input: Record<string, string>,
  asyncMaxWaitMs: number,
): string;
```

```ts
// packages/cli/src/phases/form-reachability-probe.ts (new)

export type ProbeKey = `${string}::${string}::${string}`; // role::pageRoute::formSelector

export type ProbeResult =
  | { probed: true; formPresent: true;  latencyMs: number }
  | { probed: true; formPresent: false; latencyMs: number; reason: 'trigger_not_found' | 'form_never_rendered' | 'navigate_failed' };

export async function runFormReachabilityProbes(opts: {
  browser: BrowserMcpAdapter;
  appBaseUrl: string;
  pages: DiscoveredPage[];
  roles: string[];
  runId: string;
  extraHeaders?: Record<string, string>;
  asyncMaxWaitMs: number;             // default 2000
  perProbeTimeoutMs: number;          // default 5000
  budgetMs: number;                   // default 60000
}): Promise<{ results: Map<ProbeKey, ProbeResult>; telemetry: { probesRun: number; skippedByBudget: number; durationMs: number } }>;

export function probeKey(role: string, pageRoute: string, formSelector: string): ProbeKey;
```

```ts
// packages/cli/src/phases/plan.ts (modified — gate logic)

function shouldEmitSubmitTest(
  role: string,
  page: DiscoveredPage,
  form: DiscoveredForm,
  probes: Map<ProbeKey, ProbeResult> | undefined,
): { emit: boolean; skipReason?: string };
```

---

## §5. Edge Cases

| # | Case | Behaviour |
| --- | --- | --- |
| 1 | Page has 0 forms | No submit tests emitted today; no change. Probe is not run. |
| 2 | Page has multiple forms | Probe runs once per form (per role × page × formSelector). Independent results. |
| 3 | Page is `kind === 'url'` (not state) | Probe is **not** run. The fresh tab navigates directly to the URL and we trust the form is present (matches today's behaviour for URL pages). |
| 4 | Form is on a `kind === 'state'` page but renders synchronously | Probe completes in <100 ms; `formPresent: true`; submit tests run as today (with the new bounded wait, which is a no-op when the form is already there). |
| 5 | Form renders sync for owner, never for anon | Probe records both. Plan emits owner submits, skips anon submits with `skipReason: 'form_unreachable_for_role'`. |
| 6 | Trigger click fails during probe | `formPresent: false; reason: 'trigger_not_found'`. Plan skips with `skipReason: 'state_trigger_not_reproducible'`. (Note: this *is* a finding — the page is in `state.json` but execute can't reach it. Logged at `WARN`, but not an infra failure: today's behaviour also doesn't fault discovery here.) |
| 7 | Probe times out (form never appears within 2 s) | `formPresent: false; reason: 'form_never_rendered'`. Plan skips with `skipReason: 'form_never_renders_within_async_budget'`. |
| 8 | Probe budget exhausted | Remaining (role, page, form) tuples get `probed: false`. Plan **defaults to emit** for those — preserves coverage. (Risk: re-introduces some form_not_found failures, but bounded by `MAX_CONSECUTIVE_INFRA_FAILURES`.) |
| 9 | `asyncMaxWaitMs` config absent | Default 2000 ms (probe) / 2000 ms (execute wait). |
| 10 | `asyncMaxWaitMs` set to 0 | Disable the wait — fall back to legacy `'form_not_found'`. Useful for negative tests. |
| 11 | Multiple rapid trigger clicks (probe + execute back-to-back, same tab) | Probe and execute use **separate tabs** via `withTab`. No state pollution. |
| 12 | Form briefly mounts then unmounts (e.g., re-fetch) | The wait helper checks `document.querySelector(formSelector)` per tick; first non-null wins. We accept this. (Today's behaviour also accepts the first-rendered snapshot.) |
| 13 | A `form` selector hits a different `<form>` than discovery saw | Probe + execute will both find *some* form and pass; we don't compare field schema. (Selector-fidelity hardening is the future spec — see brief's hypothesis E.) |
| 14 | Discovery captured 0 forms but execute has 1 | No submit tests planned; probe not relevant. |
| 15 | Two different `(role, page, formSelector)` triples that share results | Each is probed independently. No memoisation across tuples. |
| 16 | Probe phase exceeds `budgetMs` | Probe phase aborts; remaining tuples get `probed: false`; plan emits anyway. Telemetry records `skippedByBudget`. |
| 17 | `asyncMaxWaitMs` very long (e.g., 30 s) | Probe still capped at `perProbeTimeoutMs` (5 s default). The 30 s only applies to *execute* — and execute's first form-found check exits early. |
| 18 | Async fetch resolves *between* probe and execute (or vice versa) | Probe is a hint, not a guarantee. The execute-side bounded wait remains the safety net. |
| 19 | All probes time out (broken backend) | Plan skips all submit tests with `form_unreachable_for_role`. This is acceptable: a broken backend is a separate signal. |
| 20 | Probe runs as a non-logged-in user but app login state was set before discovery | Camofox shares cookies across tabs; the probe runs in the *same* context as discovery (i.e., as the logged-in role). This is a known limitation — see §1.3. |

---

## §6. Test Plan

### 6.1 Unit tests (new file `form-submit-runner.test.ts` extension)

| Test | Setup | Assert |
| --- | --- | --- |
| `runFormSubmit waits for form to appear` | Stub scope.evaluate to return `{ ok: true, via: 'button', missingFields: [] }` after 600 ms. | Resolves; no throw; called once (in-page poll handles the wait). |
| `runFormSubmit times out with form_never_rendered` | Stub scope.evaluate to return `{ ok: false, reason: 'form_never_rendered' }` once. | Throws `Error('submit: form_never_rendered (formSelector=form:nth-of-type(1))')`. |
| `runFormSubmit honours asyncMaxWaitMs=0 (legacy mode)` | Stub returns `{ ok: false, reason: 'form_not_found' }`. | Throws `Error('submit: form_not_found (…)')` — backwards compat. |
| `buildFillSubmitScript produces a 2 s polled IIFE` | `asyncMaxWaitMs: 2000` | Output contains `setInterval` or equivalent + a 2000 ms deadline, and a `form_never_rendered` branch. |
| `buildFillSubmitScript with asyncMaxWaitMs=0 has no poll` | `asyncMaxWaitMs: 0` | Output is the v0.10 immediate-querySelector script unchanged. |

### 6.2 Unit tests (new file `form-reachability-probe.test.ts`)

| Test | Setup | Assert |
| --- | --- | --- |
| `skips url-kind pages` | DiscoveredPage with `kind: 'url'`. | `results.size === 0`. |
| `probes once per (role, state-page, formSelector)` | 2 roles × 3 state pages × 1 form. | `telemetry.probesRun === 6`; result map has 6 keys. |
| `records formPresent: true when form mounts within asyncMaxWaitMs` | Mock browser whose evaluate returns form-present after 300 ms. | `results.get(key).formPresent === true`; latencyMs in [200, 600]. |
| `records form_never_rendered on timeout` | Mock browser whose evaluate never returns the form. | `results.get(key) === { probed: true, formPresent: false, latencyMs: ~2000, reason: 'form_never_rendered' }`. |
| `records trigger_not_found on click failure` | Mock browser.clickByHint returns `{ clicked: false }`. | `result.reason === 'trigger_not_found'`. |
| `aborts when budgetMs exhausted` | budgetMs: 100, perProbeTimeoutMs: 200, 5 probes. | At most 1 probe runs; remainder absent (so plan defaults to emit). |
| `runs sequentially within a single tab` (no parallel) | 3 probes; assert tab open/close ordering. | Each probe owns its own `withTab`; no overlap. |

### 6.3 Plan filter tests (extend `plan.test.ts`)

| Test | Setup | Assert |
| --- | --- | --- |
| `emits submit tests when probe missing (legacy / pre-probe)` | `probes: undefined`. | All submit tests emitted (no regression). |
| `skips submit tests when probe says formPresent: false` | `probes` map with `formPresent: false`. | No submit test emitted; skip reason recorded as `form_unreachable_for_role`. |
| `emits submit tests for owner, skips for anon (asymmetric)` | Probe owner→true, anon→false on same page. | Owner submit emitted; anon submit skipped. |

### 6.4 Smoke acceptance (TraiderJo)

Run `bughunter run --project /tmp/TraiderJo --runId v11-smoke-001` after all tasks complete.

| Metric | Today | Target | Rationale |
| --- | --- | --- | --- |
| Total `form_not_found` infra failures | 32 | **< 10** | Hard acceptance — see §9. |
| Total `form_never_rendered` infra failures | 0 | ≤ 5 | New typed reason replaces some `form_not_found`; should be small (only when probe disagrees with execute). |
| `skipReasons` containing `form_unreachable_for_role` | 0 | ≥ 25 | The 31 anon-role profile submits get filtered here. |
| `state.json.discovery.probe.telemetry.probesRun` | absent | ≥ 11 | One probe per state-page-with-form per role; expect ~22. |
| Total tests run | 170 | ≥ 140 | We strip the 31 doomed anon submits but should not collapse below ~140; otherwise we've broken planning. |
| Total clusters | 32 | 32 ± 5 | The real-bug clusters (`focus_lost_after_action`, `missing_state_change`, etc.) should be unaffected. |

### 6.5 Verification gate
```bash
cd /root/BugHunter
pnpm -C packages/cli typecheck
pnpm -C packages/cli lint --max-warnings 0
pnpm -C packages/cli test
pnpm -C packages/cli build
```
All four must pass with zero warnings before merge.

---

## §7. Negative Requirements

- **No** `as any`, `// @ts-expect-error`, `// eslint-disable` other than the existing pattern at `phases/execute.ts:237` (already justified).
- **No** new files outside `packages/cli/src/phases/form-reachability-probe.ts` and its co-located `.test.ts`.
- **No** changes to `dom-walker.ts`, `crawler.ts` beyond the optional latency-telemetry write.
- **No** changes to `BrowserMcpAdapter` interface.
- **No** changes to SurfaceMCP, camofox-mcp, or any external service.
- **No** new `BugKind`. `form_never_rendered` is an infra reason string, not a bug.
- **No** parallel probes in v11. Sequential only — keeps the budget bound predictable.
- **No** retry of `clickByHint` on `clicked: true`. Same reason as today.
- **No** writing to `state.json` outside the existing `runState` flow.
- **No** function over 40 lines. **No** file over 300 lines (form-reachability-probe.ts target: ≤180 lines).
- **No** mutation of `DiscoveredPage` shape. Probe results live in their own map, attached to `runState.probes` (new optional field on `RunState`).

---

## §8. Task Breakdown (≤6 tasks)

### Task 1 — Bounded form-present wait inside `runFormSubmit`
**Assignee:** @coder
**Depends on:** none
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts`
**Files to create:** none
**Test:** `pnpm -C packages/cli test form-submit-runner`
**Done when:**
- `buildFillSubmitScript` accepts an `asyncMaxWaitMs: number` parameter; when > 0, the IIFE polls `document.querySelector(formSelector)` every 100 ms until it returns non-null or the deadline elapses; on timeout returns `{ ok: false, reason: 'form_never_rendered' }`.
- When `asyncMaxWaitMs <= 0`, behaviour is byte-identical to today (returns `'form_not_found'` immediately).
- `runFormSubmit` accepts `opts?: { asyncMaxWaitMs?: number }` (default 2000). Throws `Error('submit: form_never_rendered (formSelector=…)')` on the new reason. All existing tests pass without modification.
- 5 new tests in §6.1 land green.
**DO NOT:** Change `runFormSubmit`'s call site signature (just add an optional parameter). DO NOT introduce host-side polling.

### Task 2 — `form-reachability-probe.ts` and unit tests
**Assignee:** @coder
**Depends on:** Task 1
**Files to modify:** none
**Files to create:** `packages/cli/src/phases/form-reachability-probe.ts`, `packages/cli/src/phases/form-reachability-probe.test.ts`
**Test:** `pnpm -C packages/cli test form-reachability-probe`
**Done when:**
- File exports `runFormReachabilityProbes`, `probeKey`, `ProbeResult`, `ProbeKey` per signatures in §4.4.
- For each `(role, page, form)` tuple where `page.kind === 'state'`, opens a fresh tab via `browser.withTab`, navigates to `page.stateContext.baseRoute`, calls `clickByHint(page.stateContext.triggerHint)`, then runs the same IIFE built by `buildFillSubmitScript(formSelector, {}, asyncMaxWaitMs)` to detect form presence (passing empty input means it'll early-exit on first `querySelector` non-null and never actually fill/submit — see Task 4 for the dedicated detector if review prefers it).
- Sequential, not parallel. Honours `budgetMs`. Records `latencyMs` from trigger-click to form-found.
- 7 new tests in §6.2 land green.
**DO NOT:** Use `Promise.all` or batch tabs. DO NOT mutate any input.

### Task 3 — Wire probe into discover→plan pipeline
**Assignee:** @coder
**Depends on:** Task 2
**Files to modify:** `packages/cli/src/cli/run.ts` (or wherever discover→plan→execute is sequenced — check `phases/run.ts` first), `packages/cli/src/phases/plan.ts`, `packages/cli/src/types.ts` (extend `RunState` with `probes?: Map<ProbeKey, ProbeResult>`).
**Files to create:** none
**Test:** `pnpm -C packages/cli test plan`
**Done when:**
- After discover, before plan, `runFormReachabilityProbes` is invoked when `browser !== undefined && config.browserLogin?.enabled !== false`. Results stored in `runState.probes`.
- `plan.ts` passes `runState.probes` to its UI submit-test generator.
- Submit tests are **skipped** for `(role, page, form)` triples where the probe says `formPresent: false`. Each skipped test contributes one entry to `skipReasons` with reason `form_unreachable_for_role` (use exact string, no template).
- 3 new plan filter tests in §6.3 land green. Existing plan tests still pass.
**DO NOT:** Skip submit tests when `runState.probes` is undefined (legacy / opt-out path). DO NOT change emitted `TestCase` shape.

### Task 4 — Extract shared `clickTriggerAndWaitForForm` helper
**Assignee:** @coder
**Depends on:** Task 1, Task 2
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts` (add `waitForFormPresent(scope, formSelector, asyncMaxWaitMs): Promise<{ present: boolean; latencyMs: number }>` if not already there from Task 1), `packages/cli/src/phases/form-reachability-probe.ts` (use it), `packages/cli/src/phases/execute.ts` (use it in the state re-establishment block to replace the fixed 250 ms sleep with a form-present check **only when `tc.action.kind === 'submit'` AND `tc.stateContext !== undefined`** — for non-submit actions, keep today's 250 ms sleep).
**Files to create:** none
**Test:** `pnpm -C packages/cli test execute`
**Done when:**
- One helper is shared by execute, probe, and the runFormSubmit prelude.
- For submit-on-state-page, the 250 ms sleep is gone; replaced by a form-present poll bounded by `config.asyncMaxWaitMs ?? 2000`.
- For non-submit actions on state pages, the existing 250 ms sleep remains (no behaviour change).
- All execute-phase unit tests still pass; one new test asserts the bounded wait runs for submit-kind actions.
**DO NOT:** Change non-submit action behaviour. DO NOT remove `tc.stateContext` re-establishment.

### Task 5 — Telemetry, summary, and skip-reason wiring
**Assignee:** @coder
**Depends on:** Task 3, Task 4
**Files to modify:** `packages/cli/src/phases/run.ts` (or equivalent), `packages/cli/src/types.ts` (`RunState.discovery` to include `probe?: { telemetry, results }`), summary writer.
**Files to create:** none
**Test:** `pnpm -C packages/cli test summary`
**Done when:**
- `state.json.discovery.probe.telemetry` lands with `{ probesRun, skippedByBudget, durationMs }`.
- `state.json.skipReasons` includes per-tuple `form_unreachable_for_role` entries.
- `summary.json` reports a new line: `formReachabilityProbes: { run: N, formPresent: M, formAbsent: K }`.
- Summary unit test updated.
**DO NOT:** Add probe results to the *bug* output; they're discovery telemetry, not bugs.

### Task 6 — TraiderJo smoke verification + telemetry-only discovery latency
**Assignee:** @qa (with @coder support if needed)
**Depends on:** Tasks 1–5
**Files to modify:** `packages/cli/src/discovery/crawler.ts` (one-line change: after `walkResult = await collectDomOnly(browser)` for state items, also log discovery-time form-present latency for each form via `waitForFormPresent` with budget 0 — i.e., a single tick — to capture "did the form happen to be present at the 250 ms snapshot?" telemetry; this is **informational only** and does not gate anything).
**Files to create:** none
**Test:** Run `bughunter run --project /tmp/TraiderJo` and verify §6.4 metrics.
**Done when:**
- Smoke run produces `< 10` `form_not_found` *or* `form_never_rendered` infra failures combined.
- `skipReasons` includes ≥ 25 `form_unreachable_for_role` entries.
- `state.json.discovery.probe.telemetry.probesRun >= 11`.
- All 32 *real* clusters (focus_lost, missing_state_change, etc.) still surface — no regression in non-form-related buckets.
**DO NOT:** Tune `asyncMaxWaitMs` to mask failures. If the goal isn't met, escalate to @architect for a follow-up spec.

---

## §9. Acceptance

The TraiderJo smoke run after Task 6 produces:

- **< 10** combined `form_not_found` + `form_never_rendered` infra failures (down from 32).
- **≥ 25** entries in `skipReasons` with reason `form_unreachable_for_role`.
- **≥ 11** entries in `state.json.discovery.probe.telemetry.probesRun`.
- **No regressions** in unrelated bug clusters (focus_lost_after_action count stable ±2; visual_anomaly count stable ±1; SEO clusters identical).
- **All four verification gates green** (typecheck, lint, test, build).

If <10 is not met, the PR is blocked pending a follow-up architect investigation. Probe budget can be raised but only with telemetry justifying it.

---

## §10. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Probe phase adds 30–60 s to every run, frustrating fast iteration | Med | Cap at `budgetMs: 60000`; expose as config; degrade gracefully to "no probe → emit all" when budget hit. |
| Probe runs in the *logged-in* browser context (camofox shares cookies); anon probes report `formPresent: true` because the form actually does mount when authenticated | High | This is the known limitation in §1.3. Document it. The bounded execute-side wait (Task 1) catches the remaining cases — anon execute opens its own tab but still inherits the cookie jar, so behaviour matches the probe. The plan filter is therefore conservative: it only skips when the form is unreachable *given the current shared-cookie behaviour*. When per-role contexts arrive, this gets stricter automatically. |
| `form_never_rendered` becomes a noise cluster of its own | Low | It's an infra reason, not a BugKind, and the probe filters most cases up-front. Telemetry tracks it. |
| Probe times out spuriously on slow CI | Low | `asyncMaxWaitMs` is configurable; CI can raise to 5000. |
| Sharing the `buildFillSubmitScript` IIFE for both detection and submit conflates concerns | Med | Task 4 extracts a dedicated `waitForFormPresent` IIFE rather than passing empty input through the submit script. Cleaner. |
| Future `nth-of-type` collisions on multi-form pages still bite us | Med | Future spec (`v12-stable-form-selectors`) — out of scope here. Telemetry from Task 6 will tell us when it matters. |
| Plan-filter regression silently drops legitimate submit tests | High | 3 unit tests in §6.3 + smoke metric `≥ 140 tests run`. If we drop below, fail the smoke. |
| Probe causes server-side rate limit on `/me/profile` | Low | Probes are sequential and one-shot per (role, page); same API call discovery already makes. |
| Per-role context isolation (deferred) bit-rots this code | Low | When per-role contexts arrive, the probe semantics get stronger, not different. No code rewrite needed. |

---

## §11. Killer-Demo Runbook

After all tasks complete:

```bash
# 1. Land the spec branch + tasks 1-5
cd /tmp/bughunter-spec-v11
git log --oneline spec/v11-dom-consistency

# 2. Build the CLI
cd /root/BugHunter
pnpm -C packages/cli build

# 3. Smoke run on TraiderJo
cd /tmp/TraiderJo
bughunter run --project . --runId v11-smoke-001 --budget-ms 1200000

# 4. Verify acceptance metrics
RUN_DIR=/tmp/TraiderJo/.bughunter/runs/v11-smoke-001
python3 -c "
import json
inf = [json.loads(l) for l in open('$RUN_DIR/infrastructure.jsonl')]
form_fail = [f for f in inf if 'form_not_found' in f['detail'] or 'form_never_rendered' in f['detail']]
print(f'form_not_found+form_never_rendered: {len(form_fail)} (target < 10)')

state = json.load(open('$RUN_DIR/state.json'))
skip = state.get('skipReasons', [])
unreach = [s for s in skip if 'form_unreachable_for_role' in s.get('reason','')]
print(f'form_unreachable_for_role skips: {len(unreach)} (target >= 25)')

probe = state.get('discovery',{}).get('probe',{}).get('telemetry',{})
print(f'probesRun: {probe.get(\"probesRun\",0)} (target >= 11)')
print(f'durationMs: {probe.get(\"durationMs\",0)} ms')
"

# 5. Compare cluster counts
python3 -c "
import json
state = json.load(open('$RUN_DIR/state.json'))
print(f'clusters: {state[\"clusterCount\"]} (target 32 ± 5)')
print(f'tests run: {len(state[\"testResults\"])} (target >= 140)')
"

# 6. If all green: open PR from spec/v11-dom-consistency → main
gh pr create --title "v11: form-reachability probe + bounded form-present wait" \
  --body "$(cat /root/BugHunter/SPEC_V11_DISCOVERY_EXECUTE_DOM_CONSISTENCY.md | head -50)"
```

Demo narrative for the screen-share:

1. **Before:** show `infrastructure.jsonl` from `zloytwqlufbt4z670pfru98k` — 32 `form_not_found` failures, all on `/?setTab=profile`, mostly anon.
2. **The smoking gun:** open `screenshots/af5qtoa5w555sboz30lt0i5w.png` — DOM shows "Missing or invalid CSRF token" instead of the form. The form was never going to mount.
3. **The fix:** show `state.json.discovery.probe` from the v11 run — 22 probes, 11 say `formPresent: true`, 11 say `formPresent: false` (the anon entries). The 11 false ones produce `skipReasons` instead of executing.
4. **The math:** 32 → 0 (or close to 0) form_not_found failures. The 31 anon submits never run. The 1 owner race is caught by the bounded wait.
5. **The takeaway:** *we stopped testing the untestable.* Coverage didn't drop — the skipped tests would all have failed identically. We freed ~5 minutes of execute time and kept clusters of *real* bugs (focus_lost, missing_state_change) clean.

---

End of spec.
