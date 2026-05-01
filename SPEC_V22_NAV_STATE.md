# SPEC — v0.22 "Browser navigation-state transitions"

**Status:** Draft 1 — ready for `@coder` decomposition · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.9 form-submit + state-nav (TestCase shape), v0.11 discovery/execute DOM consistency, v0.16 pen-testing (mutating-action surface), camofox MCP. **Sibling:** v0.7 auth-flows (deep-link-no-auth re-authentication leans on the auth machinery v0.7 introduced).

This spec adds a new test mode that injects **browser navigation transitions** (back / forward / refresh / deep-link / history-pushState corruption) during or after action sequences, and a small family of bug kinds whose root cause is "client-side state diverged from URL or server state because of a nav transition." BugHunter today walks an action sequence linearly per test and never replays nav-history transitions. The bugs in this class — back-after-checkout shows old cart, refresh duplicates a POST, back-after-form-fill loses the inputs, deep-link into auth-gated route renders a half-empty UI — ship constantly in vibe-coded SPAs. They're deterministic, cluster cleanly, and yield real fixes.

When a phrase appears in **bold** in a Done-when clause, the verifier (test or human) should look for it literally.

---

## 1. Problem Statement

Modern SPAs maintain client-side state (Zustand, Redux, React Query cache, route-loader data) loosely coupled to the URL. Pressing **back** after a mutation, **refreshing** mid-form-submit, or **forward**-after-back causes the URL to change without the in-memory state catching up — or, worse, causes the in-memory state to be re-applied against a server that already saw the mutation. Well-known in QA literature, under-tested in CI, over-represented in the bug ledgers of every Next/Vite/Remix app shipped this year.

V22 introduces a **nav-state test mode**. The planner generates one nav-state test per (role, mutating UI action) and per (role, form), drawn from a fixed transition palette. The executor drives history transitions via camofox primitives. The classifier compares pre-transition observable state against post-transition state, scoped to per-transition invariants. Detections cluster by (route, transition, observable-mismatch).

In scope: mutating UI actions discovered via the existing DOM walker and form discovery. API-direct surfaces have no nav history and are excluded.

## 2. Boundaries

**In scope (v0.22)**
- Six new transition kinds: `refresh-mid-mutation`, `back-after-mutation`, `forward-after-back`, `back-after-form-fill`, `deep-link-into-auth-gated`, `history-state-corruption` (last is flag-gated).
- Five new bug kinds (§4): `nav_state_corruption`, `nav_resubmit_on_back`, `nav_refresh_double_mutation`, `nav_form_state_lost`, `nav_form_state_stale`.
- Planner generation per (role, mutating UI action) and per (role, form). API tests are excluded.
- Executor extension: a new `Action.kind: 'nav_transition'` carrying a `transition` payload; an `interimState` capture between the seed action and the transition.
- Classifier extension: per-transition invariant comparator that turns the pre/interim/post state delta into one canonical BugKind.
- Cluster signature additions covering the new kinds.
- Config additions: `enableNavState`, per-transition default-on/flag-on flags, `navStateMaxDepth`, per-route opt-out.
- Interaction with existing `resetPolicy`: documented; nav-state tests run within the existing reset interleaving and do not introduce a new reset frequency.

**Out of scope (v0.22)**
- Cross-tab nav state (target=_blank, window.open). Out of scope; defer to v0.23 if real evidence surfaces.
- Native navigation API (`window.navigation.navigate`, `intercept`) — Chrome-only experimental; defer.
- Service-Worker offline-cache nav state — separate signal, separate spec.
- BFCache (back-forward cache) explicit detection. We test the *behaviour*; we do not introspect whether the browser used BFCache or re-rendered. If a target relies on BFCache disable (`Cache-Control: no-store`), we report the same bugs against that flow regardless.
- Multi-step nav chains beyond depth 2 (back/forward/back). The palette is intentionally fixed at depth ≤ 2; longer chains are noise.
- API-tests carrying `nav_transition` actions. API tests have no history.
- Server-rendered Next.js page-transitions checks (paired with v0.20's RSC scope when that lands).
- Auto-fix coverage. Auto-fix already handles new BugKinds via the existing `/bughunt fix` skill — no skill changes here. The architect agent invoked by the skill is responsible for understanding the new fix-hint shape.

**External dependencies**
- camofox MCP — all transitions are driven through `TabScope.evaluate` and `TabScope.navigate`. No new MCP tool required.
- Existing v0.9 `TestCase.stateContext` shape — nav-state tests reuse it for state-page seeds.
- Existing v0.16 mutating-action classification on actions — the planner only seeds nav-state tests against actions whose `expectedOutcome === 'success'` and whose underlying tool is `sideEffectClass: 'mutating'` (or whose `surface_call_failed`-eligible button is on a form whose API call is mutating).

## 3. Architecture Decisions

### 3.1 Transition driver: `Action.kind = 'nav_transition'`

A new `ActionKind: 'nav_transition'` keeps the schema-additive principle intact. Every transition is one TestCase; the action carries:

```ts
type NavTransition =
  | { kind: 'refresh' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'back_then_forward' }
  | { kind: 'deep_link_no_auth'; capturedUrl: string }
  | { kind: 'history_corrupt'; pushStates: Array<{ state: unknown; url?: string }> };

type Action = /* … existing … */ & {
  kind: ActionKind;
  /** Set only when kind === 'nav_transition'. */
  transition?: NavTransition;
  /**
   * Set only when kind === 'nav_transition'. The "seed" action that runs *before*
   * the transition. The seed itself is a fully-typed Action of any other kind.
   * The executor runs the seed first, captures interimState, then drives the transition.
   */
  navSeed?: Action;
};
```

**Why one new ActionKind instead of one per transition.** The classifier dispatches on `transition.kind` once at observation time. Five new ActionKinds would force five new branches across `executeUiTestInner`, `action-log.ts`, `replay.ts`, `cluster.ts`. The discriminated `transition` field localises the dispatch.

**Why nest the seed action.** Linked test pairs (seed + follow-up referencing testId) break the 1-action-per-test invariant downstream relies on — same argument as V09 §3.2 for not splitting submit into fill+submit. Inlining a fill loop in the transition handler would duplicate V09's `runFormSubmit`. The nested-seed approach reuses V09's helper verbatim — the transition handler calls back into the same action switch with the seed.

### 3.2 Camofox primitives — no new MCP tools

Camofox v0.1 has no native `page.goBack()` / `page.goForward()` / `page.reload()`. All transitions reduce to existing primitives:

| Transition | Camofox driver |
|---|---|
| `refresh` | `scope.evaluate('location.reload()')` then await `scope.snapshot()` settle |
| `back` | `scope.evaluate('history.back()')` then settle |
| `forward` | `scope.evaluate('history.forward()')` then settle |
| `back_then_forward` | back → settle → forward → settle (depth 2; no further chaining) |
| `deep_link_no_auth` | After seed: capture `location.href`; logout via `surfaceMcp.logout()` (existing v0.7 helper) on the same browser context; `scope.navigate(capturedUrl)` from the now-unauth context |
| `history_corrupt` | Sequence of `scope.evaluate('history.pushState(<state-N>, "", <url-N>)')` calls back-to-back, then settle |

Settle is the existing 250 ms delay (v0.9 state-establishment), plus a `MutationObserver`-quiet check capped at `asyncMaxWaitMs` (existing 30 s default). No new wait knob.

**Why `location.reload()` over a new MCP tool.** Works on every camofox version, persists the tab, triggers the same reload path users hit. In-flight `fetch` requests may be aborted by the reload — that is precisely the signal `nav_refresh_double_mutation` watches for. The executor captures in-flight network entries from the seed action (existing network log) before the reload fires.

### 3.3 Three-phase observation model

Today's executor captures `preState` (before action) and `postState` (after action settle). Nav-state tests need a third capture:

```
preState   ← captured before navSeed runs (existing path)
[ run navSeed via the existing action switch ]
interimState ← NEW: captured after navSeed settles, before transition fires
[ run transition via §3.2 driver ]
postState  ← captured after transition settles (existing path, reused)
```

`interimState` carries:
- `url` (current URL after the seed ran)
- `domSignature` (a SHA-1 over the visible-text content of the main region; same hash function existing classifier uses for `dom_signature` deltas)
- `inFlightRequests` (network entries that haven't completed yet — list of `{method, path, startedAtMs}`)
- `formSnapshot` (when the seed was a `submit` with a populated form: the field-name → typed-value map; value-only, not the DOM state)
- `mutationCompletionSignal` (one of `'response-200ish' | 'response-error' | 'still-pending' | 'no-network'`)

`interimState` is added to `TestResult` as an optional field; it's only populated for `nav_transition` test cases. Existing test results are unaffected.

The classifier's per-transition comparator (§5) consumes `(preState, interimState, postState)` plus the `transition.kind` to emit one canonical bug kind.

### 3.4 Planner — generation and budget

For each (role, page) yielded by the existing planner loop, after V09's per-page test-case factories run:

```
For each candidate seed action ∈ page:
  if seed.action.kind === 'submit'      → generate back-after-form-fill
  if seed.action mutating-success         → generate refresh-mid-mutation, back-after-mutation
  if back-after-mutation generated        → also generate forward-after-back
  if page.role !== 'public' && page.depth ≤ navStateDeepLinkMaxDepth
                                          → generate one deep-link-no-auth per page (not per action)
  if config.enableHistoryCorruption       → generate history-state-corruption (one per route)
```

A "candidate seed action" is an existing `TestCase` from the same (role, page) bucket whose `action.expectedOutcome === 'success'` (palette `happy` for forms; click-runner-classified mutating buttons for clicks). `null` / `edge` / `out_of_bounds` palettes are excluded — we want a state-changing seed, not a known-failing one.

**Same-shape collapsing.** Existing element-collapse keys (V09 + element-collapse.ts) already collapse same-shape mutating buttons. Nav-state tests are generated **after** collapsing, so a 14-row "Delete" button list still produces one nav-state test per role, not 14.

**Mutating-API cross-reference.** For UI mutating buttons whose form-cross-ref already resolved a `surface_call`-mutating tool, we tag the seed's resolved tool on `TestCase.metadata.resolvedToolId` so the comparator can correlate `interimState.inFlightRequests` against it. If unresolved, we still test — the network log alone is enough for `nav_refresh_double_mutation` detection (count of method+path matches across the boundary).

**Budget.** Per (role, page) with N mutating-success seeds and M forms:

```
Default-on transitions: 2N (back-after-mutation + forward-after-back) + M (back-after-form-fill) + 1 (deep-link-no-auth, per page, not per action)
Flag-on transitions (refresh-mid-mutation): N more
Flag-on transitions (history-corruption): 1 per route
```

Worst case on a 30-page app with 5 mutating actions per page: 30 × (10 + 5 + 1) = 480 default-on nav-state tests added. Acceptable on top of the existing 4-palette × N-action baseline. The plan-phase budget calculator (SPEC §3.4.4) already prints projected runtime; nav-state tests count as `ui` budget, not `api`.

**Refresh-mid-mutation default.** *Off*. Racy by nature: the reload must fire before the mutation completes, which depends on server latency, so false-positive rate is higher. Opt in via `enableNavStateRefreshRace`. Other transitions are deterministic enough to ship default-on (when `enableNavState=true`).

### 3.5 Executor — transition driver

`executeUiTestInner` gains a top-level branch when `tc.action.kind === 'nav_transition'`:

```
1. Existing pre-action setup runs (preSnapshot, onPageBaseline, MutationObserver).
2. Recurse: dispatch tc.action.navSeed via the existing action switch. Same scope, same headers, same URL.
   The seed's settle window is a SHORT version (max 5s, not 30s) so we don't miss the
   "mid-mutation" window for refresh-mid-mutation.
3. Capture interimState (§3.3).
4. Drive the transition (§3.2 table). Each transition is its own short helper at the bottom of execute.ts.
5. Existing postSnapshot + classifier path runs.
```

Critical: between step 2 and step 3, refresh-mid-mutation specifically does NOT wait for the seed's settle. It captures `inFlightRequests` from the live network monitor and immediately fires `location.reload()`. The test's success criterion is "what did the app do when the user pulled the rug?" — a settled mutation makes the test pointless.

**Retry policy.** Zero. A failed transition `evaluate()` becomes an infra failure via the existing outer try/catch. A flaky transition is more likely a bug than a camofox glitch.

**Timeout.** Existing per-test 30 s ceiling unchanged: seed (≤ 5 s short-settle) + transition (≤ 30 s settle) fit in budget.

### 3.6 Classifier — per-transition invariant comparator

A new module `packages/cli/src/classify/nav-state.ts` exposes:

```ts
classifyNavTransition(
  pre: PreState,
  interim: InterimState,
  post: PostState,
  transition: NavTransition,
): BugDetection[];
```

The comparator dispatches on `transition.kind`:

| Transition | Detection rule (one-line) |
|---|---|
| `refresh` | If `interim.mutationCompletionSignal === 'still-pending'` AND `post.networkRequests` contains a *second* match of the same `method + normalized-path` from `interim.inFlightRequests` → `nav_refresh_double_mutation`. Else if `post.domSignature === pre.domSignature && interim.domSignature !== pre.domSignature` → `nav_state_corruption` (state existed mid-flight, refresh erased it). |
| `back` | If `post.networkRequests` includes a method matching `interim.inFlightRequests` with method∈{POST,PUT,PATCH,DELETE} → `nav_resubmit_on_back`. Else if `post.url === pre.url` AND `post.domSignature !== interim.domSignature && post.domSignature !== pre.domSignature` (a third state) → `nav_state_corruption`. |
| `forward` | (Only generated as `back_then_forward`; see next row.) |
| `back_then_forward` | Compare `post.url` against `interim.url`. If equal but `post.domSignature !== interim.domSignature` → `nav_state_corruption`. The forward-step's expected invariant is "same URL → same observable view as before back." |
| `back-after-form-fill` | Pre = empty form on /form. NavSeed = `fill` (NEW seed kind for this transition; not a `submit` — we deliberately do NOT submit). Then navigate-away (transition fires a `scope.navigate` to a different in-app URL captured from page.links[0]). Then back. If `post.url === pre.url` AND form fields are empty (per `formSnapshot` re-read) → `nav_form_state_lost`. If form fields are populated but their derived state (validation, computed-fields) is missing or wrong → `nav_form_state_stale`. |
| `deep_link_no_auth` | Expected outcome: clean redirect to login OR explicit "please log in" UI. Bug if `post.url === transition.capturedUrl` (URL unchanged) AND `post.domSignature` differs from a known-good login-page signature AND no auth modal selector is present → `nav_state_corruption` (auth-gated route rendering without auth). Sub-case: post-state contains `dom_error_text` matches → that takes priority via §6.1. |
| `history_corrupt` | If post.url does not match the *last* pushState's url → `nav_state_corruption`. If `post.domSignature !== pre.domSignature && pushStates.length > 1` → secondary observation only (rapid pushState legitimately changes views in some apps). |

The comparator returns zero or one BugDetection per transition. Multiple secondary observations attach to that detection.

**Why per-transition invariants, not "any DOM diff is a bug."** False-positive avoidance. SPAs legitimately mutate state on navigation (React Query refetches on back). The comparator fires only on specific invariant violation.

### 3.7 Reset interaction (§3.10 of SPEC.md)

Nav-state tests are state-mutating by nature. The seed action mutates state; the transition exercises browser-side replay; the post-state inspection examines the result. Reset interleaving:

| ResetPolicy | Behaviour |
|---|---|
| `transactional` | Seed mutation runs inside the run-level transaction; rolled back at run end. No special handling. |
| `per-test` | Reset fires *before* the nav-state test, just like any other test. The seed's mutation is then rolled back at the next reset (i.e. before the next test). |
| `per-page` (default) | Reset fires at page-group start. All nav-state tests for that (role, page) run within one reset window. Mutations from one nav-state test are visible to the next in the same group; this is acceptable (tests are independent in their seed action) but documented. **If a project has tight cross-test-mutation invariants, switch to `per-test`.** |
| `per-run` | Reset fires once. Same caveat as per-page, scaled. |

Documented in `BugHunterConfig.resetPolicy`'s JSDoc with a v0.22 note. **No new reset policy** — the existing four cover the spectrum.

### 3.8 Forbidden interactions

- **Server actions.** `surface_call`-eligible server actions are still executed via the form-submit path (V09); nav-state tests inherit that path. No new server-action-specific carve-outs.
- **External-side-effect tools.** Excluded as seeds — same as V09 / SPEC.md §3.3 external skip-list. We don't refresh-the-checkout-page mid-Stripe-call.
- **API-direct tests.** Never receive `nav_transition` actions. Planner enforces `tc.action.via === 'ui'` for all nav-state tests.

## 4. Bug classification additions

Five new BugKinds, slotted into the existing union in `types.ts`:

```ts
export type BugKind =
  /* … existing … */
  // v0.22 nav-state kinds
  | 'nav_state_corruption'
  | 'nav_resubmit_on_back'
  | 'nav_refresh_double_mutation'
  | 'nav_form_state_lost'
  | 'nav_form_state_stale';
```

| Kind | Definition | Default severity |
|---|---|---|
| `nav_state_corruption` | Observable state (URL, DOM, render) doesn't match the URL after a nav transition. Catch-all for the family. | `mid` |
| `nav_resubmit_on_back` | Back-button triggers a POST/PUT/PATCH/DELETE resubmit. Classic browser-form-resubmit bug. | `high` |
| `nav_refresh_double_mutation` | Refresh during a pending mutation results in the mutation being applied twice (server saw two writes for the same intent). | `high` |
| `nav_form_state_lost` | Back navigation to a form loses the user's typed input when the framework should have preserved it (BFCache contract). | `low` |
| `nav_form_state_stale` | Back navigation preserves form values but discards their derived/validated state, presenting the user with phantom validation errors or stale computed fields. | `mid` |

### 4.1 Priority hierarchy (slot into SPEC.md §3.5.1)

A single nav-state occurrence often emits a primary nav-state kind plus secondary observations like `console_error` or `network_5xx` (e.g. a back-after-mutation that double-fires AND triggers a 5xx). Without a slotting rule those would compete with the canonical kind. Slot order, top-down:

```
1. unhandled_exception
2. network_5xx
3. react_error
4. surface_call_failed
5. nav_resubmit_on_back              ← v0.22 NEW
6. nav_refresh_double_mutation       ← v0.22 NEW
7. network_4xx_unexpected
8. 404_for_linked_route
9. nav_state_corruption              ← v0.22 NEW
10. nav_form_state_stale             ← v0.22 NEW
11. dom_error_text
12. missing_state_change
13. nav_form_state_lost              ← v0.22 NEW
14. console_error
15. accessibility_critical
```

Rationale: the two double-write kinds are the most damaging — slot above generic 4xx because the symptom is a write, not just an HTTP shape. `nav_state_corruption` is mid-priority (observable but not destructive). `nav_form_state_lost` is UX-grade.

### 4.2 Cluster signature additions (SPEC.md §3.6)

| Kind | Signature components |
|---|---|
| `nav_state_corruption` | `pageRoute` + `transition.kind` + `mismatchKind` (`url` / `dom` / `render-empty`) + `seed.action.kind` |
| `nav_resubmit_on_back` | `pageRoute` + `endpoint` (method + normalized path of the resubmitted request) |
| `nav_refresh_double_mutation` | `pageRoute` + `endpoint` (method + normalized path of the doubled request) |
| `nav_form_state_lost` | `pageRoute` + `formSignature` (existing v0.9 hash) |
| `nav_form_state_stale` | `pageRoute` + `formSignature` + `staleField` (the first field whose derived state mismatched) |

`mismatchKind` and `staleField` are new optional fields on the cluster signature; they're already accommodated by the existing signature.ts pattern (per-kind discriminated payloads). No schema migration to `bugs.jsonl`.

## 5. Nav-transition palette

| Transition | Default | Seed action | Driver primitive | Detector | Cluster sig |
|---|---|---|---|---|---|
| `refresh-mid-mutation` | flag (`enableNavStateRefreshRace`) | mutating click or submit (happy palette) | `scope.evaluate('location.reload()')` AFTER seed-fire, BEFORE seed-settle | network log: same `(method, path)` appears twice across the reload boundary | `nav_refresh_double_mutation` |
| `back-after-mutation` | on (when `enableNavState`) | mutating click or submit (happy) | `scope.evaluate('history.back()')` AFTER full seed-settle | (a) network log: post-back includes a write method matching interim in-flight; OR (b) post-DOM mismatches both interim and pre | `nav_resubmit_on_back` / `nav_state_corruption` |
| `forward-after-back` | on | mutating click or submit (happy) | back → 250 ms → forward (depth 2 chain) | post.url == interim.url but post.domSignature ≠ interim.domSignature | `nav_state_corruption` |
| `back-after-form-fill` | on | `fill` (NEW: typed inputs without submit) | navigate to `page.links[0]`, then `history.back()` | (a) form fields empty → lost; (b) fields present but validation/derived stale → stale | `nav_form_state_lost` / `nav_form_state_stale` |
| `deep-link-into-auth-gated` | on | none (no seed; the URL is the seed) | logout via existing v0.7 auth helper, then `scope.navigate(capturedUrl)` from the unauth context | redirect-to-login OR explicit-auth-modal observed → no bug. Else → `nav_state_corruption` | `nav_state_corruption` |
| `history-state-corruption` | flag (`enableHistoryCorruption`) | none | sequence of conflicting `history.pushState({...}, '', '/route-a')` and `('/route-b')` calls | post.url ≠ last pushState's url, or post.dom inconsistent with post.url | `nav_state_corruption` |

**Why `back-after-form-fill` uses a `fill` seed without `submit`.** The bug it catches is "user typed; navigated away to read another page; came back." Submitting first would invalidate the form (server processes, redirects, etc.) and remove the fill-preservation question. The new `fill` seed is a `kind: 'submit'` Action with a sentinel that V09's `runFormSubmit` honours: if `action.fillOnly === true`, stop after the fill loop, do not call the submit script. This sentinel is added to `Action`:

```ts
type Action = /* … */ & {
  /** v0.22: fill-only mode for submit actions used as nav-state seeds. */
  fillOnly?: boolean;
};
```

V09's `runFormSubmit` gets one new branch:

```ts
async function runFormSubmit(scope, formSelector, input, fillOnly = false) {
  // existing fill loop
  if (fillOnly) return;
  // existing submit script
}
```

Two-line change in V09's helper. No new ActionKind.

## 6. Interface contract additions

### 6.1 CLI flags (`bughunter run`)

```
--enable-nav-state                      Enable nav-state test generation (default: false)
--nav-state-refresh-race                Also generate refresh-mid-mutation tests (default: false; implies --enable-nav-state)
--enable-history-corruption             Generate history-state-corruption tests (default: false; implies --enable-nav-state)
--nav-state-skip-route <pattern>        Comma-separated route globs to skip (e.g. "checkout/*,/payment")
--nav-state-deep-link-max-depth <n>     Cap deep-link-no-auth tests at routes ≤ n hops from root (default: 3)
```

`--enable-nav-state` is the master toggle. The other flags imply it. With it off, none of the new code paths run; existing behaviour preserved bit-identically.

### 6.2 Config schema (`.bughunter/config.json`)

Add to `BugHunterConfig`:

```ts
type BugHunterConfig = /* … existing … */ & {
  /** v0.22: master toggle for nav-state tests. Default false. */
  enableNavState?: boolean;
  /**
   * v0.22: include refresh-mid-mutation tests. Racy by nature; off by default
   * even when enableNavState is true. Implies enableNavState.
   */
  enableNavStateRefreshRace?: boolean;
  /**
   * v0.22: include history-state-corruption tests. Advanced diagnostic; off by
   * default. Implies enableNavState.
   */
  enableHistoryCorruption?: boolean;
  /**
   * v0.22: route globs to exclude from nav-state generation. Useful for
   * intentionally back-button-blocked routes (checkout, payment, multi-step
   * wizards). Globs match against `tc.page` (the route key, not state-page synthetic).
   */
  navStateSkipRoutes?: string[];
  /**
   * v0.22: max depth (URL hops from root) at which deep-link-no-auth tests
   * are generated. Routes deeper than this are skipped to avoid combinatorial
   * blow-up on deeply-nested admin UIs. Default 3.
   */
  navStateDeepLinkMaxDepth?: number;
};
```

CLI flag → config precedence: flag > config > default. Standard pattern.

### 6.3 Action / TestCase type additions

Already detailed in §3.1 and §5. Summary:

- New `ActionKind`: `'nav_transition'`.
- New optional `Action.transition: NavTransition` (set iff `kind === 'nav_transition'`).
- New optional `Action.navSeed: Action` (set iff `kind === 'nav_transition'`).
- New optional `Action.fillOnly: boolean` (set iff `kind === 'submit'` AND used as a nav-state seed for `back-after-form-fill`).
- New optional `TestResult.interimState: InterimState` (set iff `tc.action.kind === 'nav_transition'`).

`InterimState` lives in `types.ts` next to `PreState`/`PostState`:

```ts
export type InterimState = {
  url: string;
  domSignature: string;          // SHA-1 over visible-text of <main>
  inFlightRequests: Array<{ method: string; path: string; startedAtMs: number }>;
  formSnapshot?: Record<string, string>;  // populated when seed is a fill or submit
  mutationCompletionSignal: 'response-200ish' | 'response-error' | 'still-pending' | 'no-network';
};
```

### 6.4 Action-log + replay

The action-log writer (v0.9 §5) already records the `Action` verbatim. The new `transition` and `navSeed` fields are JSON-serialisable and pass through unchanged. Replay (`bughunter replay <occurrenceId>`) gains a `nav_transition` branch that mirrors the executor: run the seed, fire the transition.

## 7. Edge cases

1. **Apps that block back via `beforeunload`.** The browser shows a confirm dialog. Camofox auto-confirms (existing v0.1 behaviour). The transition completes; if the app's own JS prevented the transition (`pushState` re-trapping), we'll see `post.url === pre.url` AND `post.domSignature === pre.domSignature` — *no bug*. The comparator's invariant requires a state delta to fire any nav-state kind. Document in spec; no special handling.

2. **SPAs with custom history (Next.js App Router, Remix).** The Next App Router intercepts `history.back()` via its own listener. Our `evaluate('history.back()')` triggers the listener AND the underlying browser back. The visible behaviour is what we want to test — what the user sees. Don't try to introspect the framework's history stack.

3. **Refresh during file upload.** The seed is a `submit` with a file input. Camofox's file-upload primitive (v0.1) completes the upload then submits; `mutationCompletionSignal === 'response-200ish'` likely. Refresh-mid-mutation will rarely catch this race because file uploads are too long. **Document: refresh-mid-mutation is most useful on small mutations (< 1 s server time).** Don't auto-skip for file forms — let it fire; false-negative rate is acceptable.

4. **Back-button hijacked by modal close.** A common pattern: a modal `pushState`'s a fake history entry on open; back closes the modal instead of leaving the page. Our seed action might open a modal; back-after-mutation then closes the modal and surfaces the underlying page. The comparator sees `post.domSignature !== interim.domSignature` (modal closed) and `post.url === pre.url` — fires `nav_state_corruption` falsely. **Mitigation:** the planner skips back-after-mutation seeds whose action's post-state DOM gained a `[role="dialog"]` or `[aria-modal="true"]` element (read from the seed's existing TestResult.postState if available). If the seed hasn't been executed yet (planner runs before execute), we can't pre-skip; the mitigation degrades to a runtime check inside the comparator: if `interim.domSignature` indicates a modal-open ancestor, downgrade `nav_state_corruption` to `secondaryObservations` only.

5. **Deep-link-no-auth on a public route.** Some routes are *intentionally* public despite living under an auth layout. If the planner can't tell, the test runs and the comparator sees the public page render — no bug, no false positive. Public-route detection: use the existing v0.7 role-discovery output; routes accessible to the `'public'`/`'anonymous'` role are skipped at planner time.

6. **Logout helper unavailable.** v0.7 introduced the auth helpers. If a target's SurfaceMCP config lacks a logout plan, deep-link-no-auth is skipped with a warning per page (`discovery_skipped: nav_state_no_logout_plan`). This isn't a bug — it's a config gap. Logged once per role, not per page.

7. **History.pushState rapid-fire.** Some frameworks (Reach Router pre-React-Router-v6) throttle pushState. Our `history-state-corruption` test doesn't await between pushStates; if the framework drops some, post.url may equal `pushStates[i].url` for some `i < last`. Document: `history-state-corruption` is a diagnostic, not a regression detector. Treat its findings as `severity: low` advisories.

8. **Forward-after-back where back legitimately invalidated state.** Email-thread apps (Gmail) routinely show "this thread is no longer in inbox" after archive-then-back-then-forward. The comparator's invariant — "same URL → same DOM" — would false-positive on this. **Mitigation:** the comparator only fires `nav_state_corruption` for forward-after-back when `interim.url === post.url` AND `interim.domSignature` and `post.domSignature` differ in a load-bearing region (the `<main>` or `[role="main"]` element). It does NOT fire on differences inside a message-list, comment-thread, or any element with `aria-live` (those are by definition stale-tolerant). Documented as a heuristic: "if the only difference is inside an `aria-live` region, no bug."

9. **Forms with `autocomplete="off"` and `back-after-form-fill`.** Browser default is to discard inputs. **No bug, by spec.** Comparator skips `nav_form_state_lost` when the form element carries `autocomplete="off"`. Documented.

10. **Multi-step wizards.** `back-after-mutation` on step 2 of 3 navigates back to step 1. App may re-render step 1 from server data; if client-side wizard state was held in memory, it's lost. Whether this is a bug depends on the app's UX contract. **Default: not a bug** — comparator only fires when the route URL is the wizard's stable URL AND the visible UI shows step 1 with the user's prior step-1 inputs missing despite the URL being wizard-step-1. Rare; we err on the side of false-negatives over false-positives for wizards.

11. **`enableNavState=false` (default).** Zero new code paths execute. Existing behaviour bit-identical. Verified by the existing test suite passing without nav-state-related changes.

12. **`navStateSkipRoutes` overlapping with `excludedRoutes`.** Already-excluded routes never produce TestCases, so there's nothing for nav-state to seed. The skip list is additive, not a separate exclusion mechanism.

13. **A single occurrence trips both `nav_resubmit_on_back` AND `network_5xx`.** Priority hierarchy (§4.1): `network_5xx` wins. The nav-state observation is recorded as `secondaryObservations` on the canonical `network_5xx` cluster. This is correct — a 5xx is the higher-signal symptom; the nav-resubmit is the cause but the cluster is keyed on the symptom.

14. **State-page seeds (V09).** Nav-state tests against state-page-discovered actions inherit the seed's `stateContext` verbatim. The transition fires from the state-established DOM. Back-after-mutation on `/?setTab=trades` clicks the trade-create button, then fires `history.back()` — which navigates back to the *previous URL the browser visited*, almost certainly `about:blank` or the prior tab URL. Mitigation: when `tc.stateContext !== undefined`, skip nav-state generation for `back-after-mutation` and `forward-after-back` (history isn't meaningful on a state-page). Refresh-mid-mutation and deep-link-no-auth still apply — refresh re-runs the state-establishment; deep-link captures the post-establishment URL. Documented.

## 8. Acceptance Criteria

1. `npx tsc --noEmit` clean across packages.
2. `npx eslint . --max-warnings 0` clean.
3. `npx vitest run` green. New test coverage required:
   - Per transition: classifier comparator returns the expected BugKind on a fixture pre/interim/post triple.
   - Comparator returns zero detections when invariants are satisfied (negative tests for each transition).
   - Modal-open false-positive guard: comparator downgrades `nav_state_corruption` when interim DOM contains `[role="dialog"]`.
   - `aria-live` false-positive guard: comparator does not fire `nav_state_corruption` when the only DOM diff is inside an `aria-live` element.
   - Planner: no nav-state TestCases generated when `enableNavState === false`.
   - Planner: with `enableNavState === true`, every (role, page) with a mutating action emits exactly the expected number of nav-state TestCases per the §3.4 generation table.
   - Planner: routes matched by `navStateSkipRoutes` produce zero nav-state TestCases.
   - Planner: deep-link-no-auth respects `navStateDeepLinkMaxDepth`.
   - Planner: state-page seeds (V09) skip back-after-mutation and forward-after-back, but still emit refresh-mid-mutation when the racy flag is on.
   - Executor: `nav_transition` branch dispatches the seed via the existing action switch; `interimState` populated; transition driver invoked.
   - Executor: `fillOnly: true` on a `submit` seed runs the fill loop and skips the submit script (V09 helper).
   - Cluster signature: `nav_resubmit_on_back` keys on `(pageRoute, endpoint)`; two occurrences with same endpoint cluster to one entry.
   - Priority hierarchy: an occurrence triggering both `nav_resubmit_on_back` and `network_5xx` clusters under `network_5xx`; nav-state observation is in `secondaryObservations`.
   - Action-log replay: `bughunter replay <occurrenceId>` for a `nav_transition` test re-fires seed → transition in order.
4. **Manual smoke against TraiderJo** (a known mutating-action-rich SPA):
   - With `--enable-nav-state`, smoke produces ≥ 1 cluster of `nav_state_corruption` OR `nav_form_state_lost` (TraiderJo's profile-form back-fill behaviour is suspected from prior smokes).
   - No regression in cluster counts of pre-existing kinds.
   - Plan-phase budget calculator output explicitly names the nav-state TestCase delta (`+N nav-state tests`).
5. **No new emoji** anywhere in code or comments.
6. **No `as any`.** Discriminated union on `Action.transition.kind` enforced via `assertNever` in the executor's transition switch.
7. **Functions max 40 lines.** The transition driver in `executeUiTestInner` is one switch + per-transition helper; each helper is its own function.
8. **Files max 300 lines.** New `classify/nav-state.ts` and `phases/nav-transition-runner.ts` budgeted ≤ 300 each. `execute.ts` already over budget; the new branch dispatches into `nav-transition-runner.ts` to avoid further bloat.

## 9. Files to touch / add

**Create:**
- `packages/cli/src/phases/nav-transition-runner.ts` — the per-transition driver (roughly 1 helper per transition kind, plus the `runNavTransition` dispatcher).
- `packages/cli/src/phases/nav-transition-runner.test.ts` — fixture-driven unit tests for each transition.
- `packages/cli/src/classify/nav-state.ts` — the comparator (`classifyNavTransition`).
- `packages/cli/src/classify/nav-state.test.ts` — pre/interim/post triple fixtures per transition.
- `SPEC_V22_NAV_STATE.md` (this file).

**Modify:**
- `packages/cli/src/types.ts` — add `'nav_transition'` to `ActionKind`; add optional `transition`, `navSeed`, `fillOnly` to `Action`; add `InterimState` type; add `interimState?` to `TestResult`; add five new BugKinds.
- `packages/cli/src/phases/plan.ts` — generate nav-state TestCases per §3.4 after the existing per-page factories. Respect `enableNavState`, `navStateSkipRoutes`, `navStateDeepLinkMaxDepth`. Skip state-page seeds for back/forward.
- `packages/cli/src/phases/plan.test.ts` — extend with nav-state generation tests.
- `packages/cli/src/phases/execute.ts` — add the `nav_transition` branch in `executeUiTestInner`; capture `interimState`; dispatch into `runNavTransition`. Pass `fillOnly` through to `runFormSubmit`.
- `packages/cli/src/phases/form-submit-runner.ts` (V09) — add the `fillOnly` short-circuit.
- `packages/cli/src/phases/classify.ts` — wire `classifyNavTransition` into the post-state classification chain. Apply priority hierarchy slot per §4.1.
- `packages/cli/src/cluster/signature.ts` — add the five new BugKind signature components (§4.2).
- `packages/cli/src/cluster/signature.test.ts` — extend with nav-state cluster fixtures.
- `packages/cli/src/repro/replay.ts` — add the `nav_transition` branch (recurse into seed dispatch + fire transition).
- `packages/cli/src/repro/replay.test.ts` — extend with a nav_transition replay fixture.
- `packages/cli/src/cli/run.ts` — wire the four new CLI flags.
- `packages/cli/src/config.ts` — extend Zod schema with the four new config fields.
- `packages/cli/src/config.test.ts` — extend.
- `bughunt.md` skill — add a brief note that nav-state findings are auto-fix-eligible (no orchestration change; the existing architect/coder dispatch handles the new BugKinds).

**Touch (read-only)**:
- `packages/cli/src/adapters/browser-mcp.ts` — confirms `evaluate`, `navigate`, `cookies` are sufficient. No changes.
- `packages/cli/src/discovery/crawler.ts` — confirms `DiscoveredPage.stateContext` shape unchanged.

## 10. Definition of Done

A reviewer can:

```bash
cd /tmp/TraiderJo                                  # any mutating-action-rich SPA
npx bughunter run --enable-nav-state --max-runtime 600000
```

…and observe:

- `summary.json` shows a non-zero `byKind` count for at least one of the five new BugKinds.
- `state.json.testCases` contains entries with `action.kind === 'nav_transition'`, `action.transition.kind` populated, and `action.navSeed` populated.
- `bugs.jsonl` cluster signatures for nav-state kinds match §4.2.
- The plan-phase log explicitly names `nav-state: +N tests` in the projection.
- Without `--enable-nav-state`, smoke output is bit-identical to a v0.21 baseline run on the same project (no spurious nav-state TestCases, no test-count drift).
- `bughunter replay <occurrenceId>` for a `nav_transition` occurrence executes seed → transition in the same order as the original run; the action-log file shows both steps.

…and from a Claude session:

- `/bughunt fix` orchestrates per-cluster architect+coder dispatch on nav-state clusters, same as any other BugKind. The architect agent reads the new fix-hint shape (the action's `transition.kind` plus the cluster signature) and writes a focused fix spec without skill changes.

---

## 11. Open Questions

1. **`back-after-form-fill` — should we exercise BOTH `<input>` and `<textarea>` and rich-text editors?** Today's `runFormSubmit` types into `[name="..."]` selectors which work on inputs and textareas. Rich-text (Slate, ProseMirror) won't preserve typed content because the text isn't in a `name`-d field. Worth checking pre-flight; punt to v0.23 unless TraiderJo smoke surfaces it.

2. **Should `refresh-mid-mutation` have a configurable race-window?** The current design fires `location.reload()` immediately after the seed dispatches. On fast servers this races *after* the response. A `--nav-state-refresh-delay-ms` flag could insert a delay between dispatch and reload (e.g. 200 ms — long enough for the request to leave the client, short enough to land before the response). Defer until a real target shows the race window matters.

3. **Should `deep-link-into-auth-gated` capture the URL during a *normal* test or run a dedicated capture pass?** Current design: capture during a normal post-auth run, store in run-state, then run the deep-link test in a second pass. Adds a phase. Alternative: capture lazily — for each (role, route) in the planner output, just construct `appBaseUrl + route` and use that as the deep-link target without an actual capture. The lazy approach is cheaper; the captured-URL approach is more realistic (catches query-param state, fragments). Lean towards lazy for v0.22; revisit if false-negative rate is high.

4. **Should `history-state-corruption` be excluded entirely from default planner generation, even with `--enable-nav-state`?** Currently behind its own flag. If real targets never show this bug class, drop it in v0.23. Keeping it lets us measure.

5. **Per-cluster fix-hints: do we mention the seed action's role in the fix?** A `nav_resubmit_on_back` cluster's root cause is usually "POST handler is not idempotent" or "form is not redirected post-submit." The fix-hint should quote the seed's `action.selector` and the `endpoint` from the resubmit. Add a `fixHints` template per nav-state kind in `cluster/normalize.ts`. Defer the exact wording to the implementer; spec only requires that fix-hints reference the transition kind.

6. **Should `nav_form_state_stale` be split into `nav_form_validation_stale` and `nav_form_computed_stale`?** Today they cluster on `(pageRoute, formSignature, staleField)` regardless. If real targets show different fix patterns for the two sub-classes, split in v0.23. For v0.22, one kind covers both.
