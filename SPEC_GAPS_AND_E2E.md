# Gaps + E2E Harness Spec — BugHunter v0.1

Source: full smoke run against `/root/spoonworks` on 2026-04-26 (run id `qhh5qba24hjqgrtvay27hcdh` — 631 tests, 50 clusters, 4 infra failures, 0.6% infra failure rate, 12 min). Two implementation gaps surfaced after `SPEC_SMOKE_FIXES.md` § 7 (Question A) and § 9 (run summary) had nominally landed. This spec also adds a regression-grade e2e harness so future work cannot silently regress the stack.

The stack: BugHunter (CLI, this repo) → SurfaceMCP (introspection MCP server, sister repo) → camofox-mcp (browser MCP daemon, third repo on `:3104`) → app under test (`fixtures/nextjs-app` for the e2e harness; `/root/spoonworks` for smokes).

---

## 1. Problem statements

### 1.A `relatedClusterIds` annotation produces 0 matches in production

`SPEC_SMOKE_FIXES.md` § 7 specced cross-kind cluster annotation (`404_for_linked_route` ↔ `surface_call_failed` linking via mutual `relatedClusterIds`). The implementation landed (`packages/cli/src/phases/cluster.ts:96` calls `annotateRelatedClusters(clusters)`; `routeKeyOf` extracts a path from each kind), and the existing unit test (`packages/cli/tests/cluster-related.test.ts`) passes. **It does not work in production.**

The smoke run produced these two related clusters on the same toolId `0928801337a9` (= `POST /api/admin/alerts/oversell/:id/resolve`):

| Cluster | Kind | rootCause |
|---|---|---|
| `qb0cldg15el8v2b78mdxj71z` | `404_for_linked_route` | `"Page links to 0928801337a9 which returned 404"` |
| `cw6rx3riehago2sy9k9tm9mb` | `surface_call_failed` | `"surface_call failed with status 404 for tool 0928801337a9"` |

Neither carries `relatedClusterIds`. They should.

### 1.B `mutationObserverWindowMs` is 0 on every test result

Every one of the 631 occurrences in `qhh5qba24hjqgrtvay27hcdh/bugs.jsonl` reports `postState.mutationObserverWindowMs: 0` — including UI-via tests that produced `missing_state_change` bugs. The MutationObserver instrumentation is therefore either (i) failing to install in the page, (ii) failing to read back its captured state, or (iii) being installed-and-read but the captured value is being discarded by the cluster phase before persistence. Investigation below shows it's **(iii) compounded by (i)** — both must be fixed.

### 1.C No regression gate

Both repos have unit/integration tests, but nothing exercises the *cross-process* stack (BugHunter ↔ SurfaceMCP ↔ camofox-mcp ↔ app under test) end-to-end. The smoke against `/root/spoonworks` is a manual operation. After this spec lands, the only way to know whether new BugHunter or SurfaceMCP work has broken the stack is to re-run that 12-minute smoke by hand. That is not sustainable as a regression gate. The repos already ship a fixture Next.js app at `/root/SurfaceMCP/fixtures/nextjs-app/` — use it.

---

## 2. Root causes (file:line citations against the actual current code on `spec/smoke-fixes`)

### 2.A Why `relatedClusterIds` doesn't link the smoke clusters

`packages/cli/src/phases/cluster.ts:164-196` defines `routeKeyOf` and `extractEndpointFromFixHints`.

For `404_for_linked_route` (line 165-172):

```ts
const match = /links to (\S+) which returned/.exec(cluster.rootCause);
if (match?.[1]) return normalizePath(match[1]);
```

The regex `\S+` captures whatever sits between `"links to "` and `" which returned"`. In the smoke, that is `0928801337a9` (a 12-hex toolId). `normalizePath` (`packages/cli/src/classify/network.ts:53-56`) would only convert numeric segments and >=8-hex segments embedded in a `/`-prefixed path; the bare toolId has no leading `/`, so `normalizePath('0928801337a9')` returns `0928801337a9` unchanged. The route key is therefore the bare toolId.

For `surface_call_failed` (line 174-180):

```ts
const parts = cluster.occurrences[0]
  ? extractEndpointFromFixHints(cluster)
  : null;
return parts;
```

`extractEndpointFromFixHints` (line 184-196) tries to recover `METHOD /path` or `/path` from the fix hint string. The fix hint generated for this kind by `generateFixHints` (line 216-218) is:

```
surface_call failed for tool 0928801337a9. Check API validation and response handling.
```

`detection.endpoint` was meant by `SPEC_SMOKE_FIXES.md` § 7.5 to be `"METHOD /normalized/path"`. `packages/cli/src/phases/execute.ts:355-361` does compute that shape — **when `toolMap.get(toolId)` hits**. When it misses, `endpoint = tc.action.toolId` (the bare toolId), and that bare toolId is what flows into the rootCause and into `generateFixHints`. The hint then has neither a METHOD nor a `/path`, so both regex branches in `extractEndpointFromFixHints` return null.

**Why does `toolMap.get` miss?** Read `packages/cli/src/phases/run.ts` and `packages/cli/src/phases/execute.ts:51` — the `toolMap` is built from `apiTools` returned by SurfaceMCP at discovery time. For the dynamic route `POST /api/admin/alerts/oversell/:id/resolve`, the toolId IS in the catalog (otherwise the test wouldn't have been planned). Spot-checking the smoke `discovery.json` would confirm. Either way: the hint and rootCause for surface_call_failed get the bare toolId on the failure path, and the relation extraction never sees a METHOD or path. **Both kinds end up keyed off the bare toolId for one and null for the other** — they cannot match.

### 2.A.1 Decision: Option C — key both kinds off `toolId` from `cluster.occurrences[0].action.toolId`

Three options were considered (per the user's framing). The trade-offs:

- **Option A** (change `rootCause` / `fixHints` to include METHOD+path): requires `toolMeta` at clustering time. The current cluster phase does not have a `toolMap`. Threading it through is non-trivial.
- **Option B** (resolve toolId → METHOD+path inside `routeKeyOf` via a passed-in catalog): same — requires plumbing a `toolMap` to `runCluster`. Doable but adds parameter churn.
- **Option C** (key both kinds off `toolId`): the toolId is the canonical identifier in the action — every `OccurrenceSummary` and `OccurrenceFull` already carries `action.toolId`. No new plumbing. The route-key abstraction collapses to a tool-key abstraction, which is strictly more reliable: two clusters that share a toolId are by construction calls to the same API endpoint regardless of how the catalog represents that endpoint.

**Pick Option C.** Existing tests that key off `targetPath` / `endpoint` paths still pass — see § 5.A.2 — because the new logic prefers `toolId` from occurrences but falls back to the path-extraction logic when no occurrence carries a toolId (covers UI-only `404_for_linked_route` clusters where the link's `targetPath` is the actual path and there is no toolId).

### 2.B Why `mutationObserverWindowMs` is 0

Two compounding bugs.

**Bug 2.B.1 (data loss in cluster phase):** `packages/cli/src/phases/cluster.ts:101-130` (`upgradeToFull`) constructs a fresh `OccurrenceFull` from the summary occurrence, **discarding any per-occurrence pre/postState data**. `mutationObserverWindowMs: 0` is hardcoded at line 115 unconditionally.

The data flow is:
1. `executeUiTest` (`packages/cli/src/phases/execute.ts:150-327`) computes `mutWindowMs` at line 272 and constructs `postState: PostState` at line 293-300, then **discards it** by returning a `TestResult` (line 321-326) that does not carry it.
2. `runClassify` (`packages/cli/src/phases/classify.ts`) maps `TestResult` → `BugDetection`; `BugDetection` doesn't carry pre/postState either.
3. `runCluster` (`packages/cli/src/phases/cluster.ts:33-79`) gets `BugDetection` + `TestCase`. Neither has pre/postState.
4. `upgradeToFull` (line 101-130) builds an empty PostState with `mutationObserverWindowMs: 0`.

**This is the dominant cause** for the smoke's all-zero readings. Fixing this alone makes UI-test occurrences carry their actual mutationObserverWindowMs into the persisted JSONL.

**Bug 2.B.2 (silent failure in MutationObserver script):** Even if the plumbing were fixed, the start script in `packages/cli/src/classify/state-change.ts:37-52` is multi-statement:

```ts
window.__bhMutations = [];
window.__bhObserver = new MutationObserver(function(mutations) { ... });
window.__bhObserver.observe(document.body, { ... });
window.__bhObserverStart = Date.now();
true;
```

This is sent via `browser.evaluate(MUTATION_OBSERVER_START_SCRIPT)` (`packages/cli/src/phases/execute.ts:173`), which routes to camofox-mcp's `evaluate` tool, which forwards to upstream camofox at `/root/.openclaw/extensions/camofox-browser/server.js` — the upstream calls Playwright's `tabState.page.evaluate(expression)`.

Playwright's `page.evaluate(string)` accepts a string; it is internally evaluated in the page context. Multi-statement scripts can fail silently or partially, depending on the Playwright/CDP wrapping path. The currently-shipped STOP script (`state-change.ts:54-62`) is wrapped as an IIFE that returns the result object — that's the right pattern. The START script is NOT wrapped and has no explicit return. Per `tabState.page.evaluate` semantics: if the string does not parse as a single expression, Playwright will throw a parse error (returned by camofox as 500 → BrowserMcpError). The adapter call at execute.ts:173 then has `.catch(() => {})` swallowing the error completely. The observer is never installed.

Fix both: wrap the start script as an IIFE returning a small status object, AND remove the silent `.catch(() => {})` so a real failure surfaces in logs.

A separate subtle point: when the user reads `mutationObserverWindowMs > 0` they are reading wall-clock duration between start and stop. The "mutations" data is captured but not currently persisted. v0.1 keeps `PostState.mutationObserverWindowMs: number` as the only observable from the observer; v0.2 may surface `mutations[]` for richer state-change classification. This spec ships v0.1 — only the duration is plumbed end-to-end. Leave `state-change.ts:42-47` recording mutations into `window.__bhMutations` (for future extension) but only the duration is read back.

### 2.C No e2e harness — design constraints

The fixture Next.js app at `/root/SurfaceMCP/fixtures/nextjs-app/` already exists and ships routes that exercise:

- Zod-introspected schema (`app/api/users/route.ts`, `app/api/users/[id]/route.ts`).
- Manual `if (!body.X) throw` validation (`app/api/journal-entries/route.ts`) — exercises SurfaceMCP `'partial'`-confidence path (sister spec § B).
- External-integration grep matter: `app/api/orders/route.ts` imports Stripe; `app/components/CheckoutButton.tsx` is `'use client'`; `app/policies/privacy/page.tsx` mentions "Stripe" only in body text — exercises sister spec § C.
- Server action: `app/admin/users/page.tsx` declares `'use server'` — exercises server-action filtering.

What's missing for an end-to-end BugHunter test:

1. The fixture's `package.json` has no `dev` / `start` script. The harness must add one and then spawn it.
2. There are no fixture routes that produce a UI mutation observable (for Gap 1.B verification).
3. There is no fixture route pair that share a toolId across kinds (for Gap 1.A verification — though Option C means a single route producing both detections is enough).
4. `MUST_DISCOVER.json` lists 8 routes but does not assert per-route schema confidence; no tools-level fixture assertions.

The harness must extend the fixture to cover the gaps it's meant to regression-test against, then run the full BugHunter pipeline against it.

---

## 3. Boundaries (what changes, what doesn't)

### 3.1 BugHunter — files this spec WILL change

| File | Change |
|---|---|
| `packages/cli/src/phases/cluster.ts` | Replace `routeKeyOf` body to prefer `cluster.occurrences[0].action.toolId`; remove the `extractEndpointFromFixHints` helper (no longer needed). |
| `packages/cli/src/phases/execute.ts` | Wrap MutationObserver start in IIFE (move the wrapping to `state-change.ts`); thread captured mutWindowMs into the returned `TestResult`; surface evaluate failures (no silent `.catch`). |
| `packages/cli/src/classify/state-change.ts` | Wrap `MUTATION_OBSERVER_START_SCRIPT` in IIFE that returns `{ok: true, startedAt: <ms>}`. Comment block explaining why. |
| `packages/cli/src/phases/cluster.ts` | `upgradeToFull` now reads `postState` from the per-occurrence map provided by `runCluster`'s caller (see § 4.B). |
| `packages/cli/src/types.ts` | Extend `TestResult` with `postState?: PostState` and `preState?: PreState`. |
| `packages/cli/src/phases/run.ts` | Build a `Map<testId, {pre, post}>` from `testResults` and pass it to `runCluster`. |
| `packages/cli/src/phases/cluster.ts` | `ClusterOptions` accepts `stateByTestId?: Map<string, {preState: PreState; postState: PostState}>`; `upgradeToFull` reads from it. |
| `packages/cli/tests/cluster-related.test.ts` | Add two new cases — toolId-keyed match (Option C); UI-only 404 with toolId absent (path fallback). |
| `packages/cli/tests/cluster.test.ts` | Add a regression test asserting `mutationObserverWindowMs` flows from `TestResult` to `OccurrenceFull` (synthetic preState/postState). |
| `packages/cli/tests/state-change.test.ts` | NEW. Unit-test the wrapped start script string is a valid expression (parses via `new Function('"use strict"; return (' + SCRIPT + ');')` — quick check that does not require a browser). |
| `packages/cli/tests/e2e/` | NEW directory — see § 5. |
| `packages/cli/package.json` | Add `test:e2e` script; install no new prod deps. |
| `SPEC.md` § 3.6, § 3.7 | Note the route-keying-via-toolId for `relatedClusterIds`. |

### 3.2 BugHunter — files this spec WILL NOT change

- The `BugCluster.relatedClusterIds` field shape (still `string[] | undefined`).
- The `surface_call_failed.endpoint` shape (still `"METHOD /normalized/path"` per § 7.5 of `SPEC_SMOKE_FIXES.md`). Option C does not depend on `endpoint`'s shape; it uses `occurrences[0].action.toolId`.
- The clustering signature (`packages/cli/src/cluster/signature.ts`). Cluster ids stay stable; only the post-clustering annotation changes.
- The `BugDetection` shape. No new fields.
- Camofox-mcp source. Camofox is correct. `tabState.page.evaluate(expression)` semantics are upstream's contract; the BugHunter side adapts.

### 3.3 SurfaceMCP — files this spec WILL change (sister branch)

The SurfaceMCP-side e2e work lives on its own branch (`/root/SurfaceMCP/spec/e2e-harness`) with a sister spec at `/root/SurfaceMCP/SPEC_E2E_HARNESS.md`. The BugHunter-side e2e harness depends on the SurfaceMCP-side fixture additions. See § 5.

### 3.4 Camofox-mcp — files this spec WILL NOT touch

Camofox-mcp is correct. The spec references it only as a hard dependency of the BugHunter-side e2e (§ 5.B). If the camofox daemon is not running, the BugHunter e2e SKIPS the browser portion gracefully — but does not fail. Tests that need camofox print `[skip] camofox-mcp daemon not running on http://127.0.0.1:3104` and exit 0.

---

## 4. Interface contracts

### 4.A `routeKeyOf` (replacement)

```ts
// packages/cli/src/phases/cluster.ts
function routeKeyOf(cluster: BugCluster): string | null;
```

New behaviour:

1. If `cluster.occurrences[0]?.action.toolId` is set, return `'tool:' + toolId`. Prefix is intentional — disambiguates from path-based keys.
2. Else for `404_for_linked_route`: parse `targetPath` from rootCause via the existing regex (`/links to (\S+) which returned/`), normalise via `normalizePath`. Prefix `'path:'`. Return null on no match.
3. Else for `surface_call_failed`: every occurrence carries `action.toolId` (it was the toolId on which the call failed); the toolId branch always wins. Return null only if the cluster has zero occurrences (defensive — should never happen).
4. Else: return null.

Comparison: equal keys link. The prefix means a UI-only 404 keyed by `path:/api/foo` does NOT mistakenly link to a surface_call_failed keyed by `tool:abc123` even when `abc123` happens to equal the path string.

`extractEndpointFromFixHints` is **deleted**. It is unused after this change.

### 4.B `runCluster` — pre/postState plumbing

```ts
// packages/cli/src/phases/cluster.ts
export type ClusterOptions = {
  // ...existing fields...
  /** Per-test pre/post observation captured by the executor. Optional — when
   * absent, OccurrenceFull falls back to today's empty PostState (preserves
   * backward-compat for unit tests that don't pass it). */
  stateByTestId?: Map<string, { preState: PreState; postState: PostState }>;
};
```

`upgradeToFull` (line 101-130) reads `stateByTestId.get(occurrenceTestId)`. The `OccurrenceSummary` does not currently carry `testId` — extend it to do so (a single new `testId: string` field on both `OccurrenceSummary` and `OccurrenceFull`). Threading is straightforward — `runCluster` already has access to `testId` via the `detections` array.

### 4.C `TestResult` — pre/postState carry-through

```ts
// packages/cli/src/types.ts
export type TestResult = {
  // ...existing fields...
  preState?: PreState;
  postState?: PostState;
};
```

Both fields are optional; UI tests populate them, API tests leave them undefined. `runCluster`'s caller in `phases/run.ts` builds `stateByTestId` from `testResults.filter(r => r.postState).map(r => [r.testId, {preState: r.preState!, postState: r.postState!}])`.

### 4.D `MUTATION_OBSERVER_START_SCRIPT` — IIFE wrap

```ts
// packages/cli/src/classify/state-change.ts
export const MUTATION_OBSERVER_START_SCRIPT = `
(function() {
  window.__bhMutations = [];
  window.__bhObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      window.__bhMutations.push({
        type: m.type,
        target: m.target ? m.target.nodeName : null,
        addedCount: m.addedNodes.length,
        removedCount: m.removedNodes.length,
      });
    });
  });
  window.__bhObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  window.__bhObserverStart = Date.now();
  return { ok: true, startedAt: window.__bhObserverStart };
})()
`;
```

Behaviour: returns an object so Playwright's `page.evaluate` returns `{ok, startedAt}` (we don't read it; the truth is the side effects on `window.*`). The IIFE makes the multi-statement script a single expression Playwright accepts unambiguously.

### 4.E Execute path — surface evaluate failures

`packages/cli/src/phases/execute.ts:173`:

```ts
// BEFORE
await browser.evaluate(MUTATION_OBSERVER_START_SCRIPT).catch(() => {});

// AFTER
try {
  await browser.evaluate(MUTATION_OBSERVER_START_SCRIPT);
} catch (err) {
  log.warn({ err: String(err), tc: tc.id }, 'MutationObserver start failed; mutWindowMs will be 0');
}
```

Same treatment for the STOP script at line 271 (already has `.catch(() => null)` — keep but log if non-null error). The mutResult.value extraction at line 272 expects the IIFE return shape:

```ts
const mutWindowMs = (mutResult?.value as { durationMs?: number })?.durationMs ?? 0;
```

After the IIFE wrap of START, the STOP IIFE still returns `{mutations, durationMs}`. The extraction is unchanged.

The constructed `postState` (line 293-300) flows into the new `TestResult.postState`; same for `preState`.

### 4.F E2E harness — config

Two new fixtures added to `/root/SurfaceMCP/fixtures/nextjs-app/` (sister spec § 4). Summary:

- `app/api/dom-mutate/route.ts` — POST that bumps a counter (no DOM impact, but its tool id is referenced from `app/dom-test/page.tsx`).
- `app/dom-test/page.tsx` — client component with a button whose click toggles a class on the page (`'use client'` at top; pure-client mutation; does NOT call the API). This generates a UI test where the click produces a DOM mutation.
- `app/api/missing-route-link/page.tsx` — page whose <a href> points to a non-existent /api/missing-route-target endpoint, causing a 404_for_linked_route.

The BugHunter e2e harness (`packages/cli/tests/e2e/bughunter-e2e.test.ts`) runs the full pipeline against the fixture and asserts:

- A UI test on `/dom-test` produces an `OccurrenceFull` with `mutationObserverWindowMs > 0`.
- (Gap 1.A) Two clusters whose `occurrences[0].action.toolId` match get `relatedClusterIds`.
- The fixture's expected route count and tool count match `MUST_DISCOVER.json`.
- The run completes within `--max-runtime 60000` (60s budget — generous; real runs against the small fixture finish in <10s).
- Tear-down kills the Next dev server and the SurfaceMCP server.

---

## 5. Edge cases

### 5.A Gap 1.A (`routeKeyOf`)

| Case | Expected outcome |
|---|---|
| 404 cluster + surface_call_failed cluster, both have occurrences with same toolId | Mutual link. |
| 404 cluster has no occurrences (defensive — should never happen) | `routeKeyOf` returns null; no link. |
| 404 cluster occurrences exist but `action.toolId` is undefined (UI-only 404 from a navigate or anchor click — `dom-walker.ts` passes a synthetic `toolId` only when fetching; pure UI-walker hits don't have one) | Fall back to path extraction (existing behaviour). |
| Two surface_call_failed clusters with different toolIds | Different keys; no link (correct). |
| Two surface_call_failed clusters with the **same** toolId (different statuses, different palettes — they cluster separately because of signature differences? No — `surface_call_failed` signature is `kind|endpoint`. Same endpoint + same kind = same cluster. So this case can't arise unless the endpoint shape differs.) | They're already the same cluster; not applicable. |
| 404 cluster from API path with `targetPath = toolId` (the smoke case) and matching surface_call_failed | Mutual link via `tool:<toolId>` key. ✓ |
| 404 cluster from UI walker with `targetPath = '/api/x/123'` (real path) and a surface_call_failed for tool with `path = '/api/x/:id'` | Both have toolId? The 404_for_linked_route emitted by `network.ts:42-46` populates `targetPath` only — no toolId. So 404 falls back to `path:/api/x/:id` (after normalize); surface_call_failed uses `tool:<id>`. They don't link. **Limitation, documented**: UI-walker 404s and API-path surface_call_failed clusters cannot be linked under Option C unless we resolve UI-walker's `path` against the toolMap (out of scope for this fix; the smoke evidence is API-path on both sides). |

### 5.B Gap 1.B (MutationObserver)

| Case | Expected outcome |
|---|---|
| Page navigation between START and STOP | `window.__bhObserver` is wiped (new page context). STOP returns `durationMs: ~0` because `__bhObserverStart` is undefined → `Date.now() - undefined = NaN`; actually `Date.now() - (undefined \|\| Date.now()) = 0`. The IIFE in STOP already handles this case (`window.__bhObserverStart \|\| Date.now()` fallback). So duration is 0 — that's correct: a navigate is a different observation window. |
| START throws (parse error) | `try/catch` logs warn; STOP returns `{mutations: [], durationMs: ~0}` because the observer was never installed; `mutationObserverWindowMs: 0` flows through correctly (no false positives on observer state). |
| Page has no `document.body` yet (very early SPA) | The observer's `observe` call throws inside the IIFE; the IIFE throws; caught by the new try/catch. Logged. `mutWindowMs: 0`. |
| The action triggers a DOM mutation but the test framework's STOP runs before the mutation propagates | Race exists; v0.1 accepts the race. The classifier `classifyMissingStateChange` already handles "no observable change" gracefully; this race is rare and produces a false positive `missing_state_change` only if combined with no URL change AND no network completion AND no console error AND no toast. Not new; not introduced by this fix. |
| `evaluate` returns `{value: {ok: true, startedAt: <ms>}}` from START (we ignore the return value) | Unchanged. |
| `evaluate` succeeds for START but page is reloaded by the test action (e.g. form submit causes navigation) | STOP runs against the new page context; `window.__bhObserverStart` is undefined; STOP returns durationMs = 0. Correct (different observation context). |
| API test (no UI) | `executeApiTest` does not call MutationObserver. `TestResult.postState` is undefined. `stateByTestId.get(testId)` returns undefined. `upgradeToFull` falls back to today's empty PostState (mutationObserverWindowMs: 0). Correct. |

### 5.C E2E harness

| Case | Expected outcome |
|---|---|
| Camofox-mcp not running | E2E SKIPs the browser-mode portion with a printed `[skip] camofox-mcp daemon not running` line. The API-only portion still runs. Exit 0. |
| Fixture's Next.js dev server fails to start (port collision) | The harness reads a free port via `node:net.createServer().listen(0)`; collision shouldn't happen. If it does, harness exits non-zero with a clear error. |
| SurfaceMCP server fails to start | Harness exits non-zero with stdout from the failed spawn. |
| Tests left zombie processes | Each spawned process is killed in a `finally` block; on test-runner SIGINT, an `unhandledRejection` handler calls the same teardown. |
| Re-running the harness back-to-back | Each run creates an isolated temp project dir under `os.tmpdir()`; the fixture is symlinked or copied into it for `bughunter init`'s working directory. |
| `npm run test` (the existing top-level test) | Excludes the e2e dir via vitest config (only includes `tests/**/*.test.ts` excluding `tests/e2e/`). E2E runs only via `npm run test:e2e`. |

---

## 6. Acceptance criteria

### 6.A Gap 1.A

- Given a cluster set with two clusters whose `occurrences[0].action.toolId === 'abc123'` and kinds `404_for_linked_route` and `surface_call_failed`: both clusters get `relatedClusterIds` containing the other's id. (UNIT, deterministic.)
- Given the **exact** smoke shapes (rootCause `"Page links to 0928801337a9 which returned 404"`, occurrence with `action.toolId = '0928801337a9'`, opposite cluster with `rootCause = "surface_call failed with status 404 for tool 0928801337a9"`, fix hint `"surface_call failed for tool 0928801337a9. Check ..."`, occurrence with `action.toolId = '0928801337a9'`): linked. (UNIT, against actual smoke fixtures.)
- Existing `tests/cluster-related.test.ts` cases still pass (path-based fallback) because the test fixtures construct occurrences without `toolId` — the fallback path is exercised.
- Add a new test case in `tests/cluster-related.test.ts`: `'links via toolId regardless of rootCause/endpoint shape'` — uses the smoke shapes verbatim.

### 6.B Gap 1.B

- Add a fixture page `/root/SurfaceMCP/fixtures/nextjs-app/app/dom-test/page.tsx` (sister spec § 4): a `'use client'` component with a button that toggles `document.body.dataset.toggled` between `'on'` and `'off'`.
- The BugHunter e2e harness (§ 6.C) navigates to `/dom-test`, clicks the button via the UI walker, and asserts the resulting `OccurrenceFull` (or, more reliably, the underlying `TestResult.postState`) has `mutationObserverWindowMs > 0` AND `< 60000` (sane bound).
- Unit test `tests/state-change.test.ts`: parses `MUTATION_OBSERVER_START_SCRIPT` via `new Function(' "use strict"; return (' + SCRIPT + ')')` — must not throw. (Quick parse-validity check that does not require a browser.)
- Unit test in `tests/cluster.test.ts`: synthesize a `TestResult` with `postState = { mutationObserverWindowMs: 1234, ... }`; pass it to `runCluster` via the new `stateByTestId` map; assert `OccurrenceFull.postState.mutationObserverWindowMs === 1234`.

### 6.C E2E harness

- `npm run test:e2e` from `packages/cli/` succeeds with all of:
  1. Fixture Next.js dev server starts and binds to a free port.
  2. SurfaceMCP server (`surfacemcp serve` from the fixture dir) starts and binds to a free port.
  3. The harness writes a programmatically-constructed `.bughunter/config.json` pointing at both servers (and at camofox if `BUGHUNTER_E2E_BROWSER=1` env var is set).
  4. `bughunter run --max-runtime 60000 --max-bugs 50 --no-interactive` completes (or is interrupted by `--max-runtime` cap; either is fine — the assertions read the partial-emit JSONL).
  5. Assertions from § 6.A, § 6.B, plus:
     - Tool count matches `MUST_DISCOVER.json` expectations (8 routes + N from sister-spec additions).
     - The manual-validation route (`POST /api/journal-entries`) is reported by SurfaceMCP with `inputSchemaConfidence: 'partial'`.
     - `_suggestedExternalIntegrations` excludes both `app/policies/privacy/page.tsx` and `app/components/CheckoutButton.tsx`.
     - The deliberate fixture bug — a route that throws when `body.memo` is absent and is NOT covered by `bodyFixtures` — produces a `surface_call_failed` cluster on the happy palette. Adding `bodyFixtures: { '<toolId>': { '*': { memo: 'seeded' } } }` to the config and re-running suppresses that cluster (Question B from `SPEC_SMOKE_FIXES.md` § 8).
     - `relatedClusterIds` populated for at least one cluster pair (Gap 1.A).
     - `mutationObserverWindowMs > 0` for at least one occurrence whose action is the dom-test button click (Gap 1.B).
  6. All spawned child processes are killed on test exit (verified by capturing PIDs and re-checking with `process.kill(pid, 0)` after teardown).
- `npm run test` (existing) does NOT run the e2e suite — vitest config excludes `tests/e2e/`.
- E2E SKIPS gracefully when camofox-mcp is unreachable: prints `[skip] camofox-mcp daemon not running on http://127.0.0.1:3104; browser portion of e2e skipped`, runs API-only assertions, exits 0.
- E2E exits non-zero if the API-only portion (which never depends on camofox) fails any assertion.

---

## 7. Files to touch

### 7.A BugHunter (`/root/BugHunter`, branch `spec/gaps-and-e2e`)

| File | Type | Purpose |
|---|---|---|
| `packages/cli/src/phases/cluster.ts` | EDIT | Replace `routeKeyOf` body (Option C); delete `extractEndpointFromFixHints`; thread `stateByTestId` through `ClusterOptions`; `upgradeToFull` reads from it. |
| `packages/cli/src/phases/execute.ts` | EDIT | Surface MutationObserver start failure; carry `preState`/`postState` into `TestResult`. |
| `packages/cli/src/phases/run.ts` | EDIT | Build `stateByTestId` from `testResults`; pass to `runCluster`. |
| `packages/cli/src/classify/state-change.ts` | EDIT | Wrap `MUTATION_OBSERVER_START_SCRIPT` in IIFE returning `{ok, startedAt}`. |
| `packages/cli/src/types.ts` | EDIT | Extend `TestResult` with `preState?`, `postState?`. Extend `OccurrenceSummary`/`OccurrenceFull` with `testId: string` (required — used by `upgradeToFull` to look up state). |
| `packages/cli/tests/cluster-related.test.ts` | EDIT | Add toolId-keyed match case (smoke shapes verbatim). Existing cases unchanged. |
| `packages/cli/tests/cluster.test.ts` | EDIT | Add postState plumbing test (synthesise `TestResult.postState`, assert `OccurrenceFull.postState`). |
| `packages/cli/tests/state-change.test.ts` | NEW | Parse-validity assertion for the wrapped START script. |
| `packages/cli/tests/e2e/bughunter-e2e.test.ts` | NEW | Full pipeline against fixture; § 5.C, § 6.C. |
| `packages/cli/tests/e2e/helpers/spawn.ts` | NEW | `startNextDev`, `startSurfaceMcp`, `startBugHunter`, `teardown` helpers. Pure CLI orchestration. |
| `packages/cli/tests/e2e/helpers/free-port.ts` | NEW | `getFreePort()` via `net.createServer().listen(0)`. |
| `packages/cli/tests/e2e/helpers/fixture-project.ts` | NEW | Copies `/root/SurfaceMCP/fixtures/nextjs-app/` into a temp dir; ensures `package.json` has `"dev": "next dev -p <port>"`. |
| `packages/cli/vitest.config.ts` | EDIT | Add `exclude: ['tests/e2e/**']` so `npm test` skips e2e by default. |
| `packages/cli/vitest.e2e.config.ts` | NEW | Mirror config, `include: ['tests/e2e/**/*.test.ts']`. |
| `packages/cli/package.json` | EDIT | Add `"test:e2e": "../../node_modules/.bin/vitest run --config vitest.e2e.config.ts"`. |
| `SPEC.md` § 3.6 | EDIT | One-paragraph note: `relatedClusterIds` keys off `occurrences[0].action.toolId` first, falling back to `targetPath` for UI-walker 404s. |
| `SPEC.md` § 3.7 | EDIT | Mention `TestResult.preState`/`postState` are optional. |
| `SPEC.md` § 12 | EDIT | Add `npm run test:e2e` invocation to the verification recipe. |
| `dist-skill/bughunt-host.md` | EDIT | Update gotchas: remove "MutationObserver always 0" once fix lands; document e2e harness invocation. |

### 7.B SurfaceMCP (`/root/SurfaceMCP`, branch `spec/e2e-harness`, sister spec)

See `/root/SurfaceMCP/SPEC_E2E_HARNESS.md` for full detail. Summary of changes:

| File | Type | Purpose |
|---|---|---|
| `fixtures/nextjs-app/package.json` | EDIT | Add `"dev": "next dev -p ${PORT:-3010}"` and `"start": "next start -p ${PORT:-3010}"`. |
| `fixtures/nextjs-app/app/dom-test/page.tsx` | NEW | `'use client'` page with a button toggling `document.body.dataset.toggled`. |
| `fixtures/nextjs-app/app/api/missing-route-link/page.tsx` | NEW | Page with anchor pointing at `/api/missing-route-target` (which doesn't exist) — produces 404_for_linked_route. |
| `fixtures/nextjs-app/MUST_DISCOVER.json` | EDIT | Add the new routes + per-route schema confidence assertions. |
| `src/e2e/surfacemcp-e2e.test.ts` | NEW | Spawns fixture + SurfaceMCP; asserts MUST_DISCOVER + `_suggestedExternalIntegrations` content + `'partial'` confidence. |
| `src/e2e/helpers/*` | NEW | Spawn helpers for the fixture and the SurfaceMCP server. |
| `vitest.config.ts` | EDIT | Exclude `src/e2e/**` from default `test` task. |
| `vitest.e2e.config.ts` | NEW | E2E-only include. |
| `package.json` | EDIT | Add `"test:e2e"` script. |

### 7.C Camofox-mcp

No changes.

---

## 8. Risk & sequencing

### 8.1 Independence

| Item | Repo | Depends on |
|---|---|---|
| Gap 1.A (routeKeyOf via toolId) | BugHunter | none |
| Gap 1.B (postState plumbing + IIFE wrap) | BugHunter | none |
| SurfaceMCP fixture additions | SurfaceMCP | none |
| BugHunter e2e harness | BugHunter | both gap fixes + SurfaceMCP fixture additions |

The two BugHunter gap fixes are independent of each other and can land in either order. The e2e harness depends on BOTH gap fixes (otherwise its assertions would not pass) AND the SurfaceMCP fixture additions (otherwise the assertions about new fixture routes would not pass).

### 8.2 Recommended landing order

1. **BugHunter Gap 1.A** — small change to `cluster.ts` + add a unit test using the smoke fixtures verbatim. Independent commit on `spec/gaps-and-e2e`.
2. **BugHunter Gap 1.B** — type extension (`TestResult.preState/postState`, `Occurrence.testId`), `executeUiTest` populates them, `runCluster` reads them, IIFE wrap of START script, surface evaluate failures. Independent commit.
3. **SurfaceMCP fixture additions** — sister spec on `spec/e2e-harness`. New routes, fixture page, MUST_DISCOVER updates, surfacemcp-e2e.test.ts. Independent of BugHunter.
4. **BugHunter e2e harness** — depends on 1, 2, 3. Final commit on `spec/gaps-and-e2e`.

### 8.3 Risk

- **Gap 1.A: type-prefix collision in `routeKeyOf`.** The new keys are `tool:<toolId>` and `path:<normalized-path>`. The `tool:` and `path:` prefixes are added explicitly so they cannot collide. **Mitigation:** explicit prefixes are tested in unit tests (`'tool:abc' !== 'path:abc'`).
- **Gap 1.B: backward-compat break — `Occurrence.testId` becomes required.** Existing JSONL files do not carry `testId` per occurrence. Old artifacts cannot be replayed against the new code. **Mitigation:** make `testId` optional on `OccurrenceSummary` / `OccurrenceFull`, with a fallback empty string in `upgradeToFull`. Old artifacts replay; new artifacts include the field. This is a small concession to backward-compat.
- **Gap 1.B: IIFE wrap might still fail in obscure browsers.** Camofox runs Firefox; Firefox's JS engine is standard. The IIFE pattern is the same one used by the STOP script which already works. **Mitigation:** parse-validity unit test in `tests/state-change.test.ts`.
- **E2E harness flakiness.** Spawning real processes is inherently flakier than unit tests. **Mitigations:** (a) generous `--max-runtime`; (b) explicit `getFreePort()`; (c) hard process kill in `afterAll`; (d) skip-on-camofox-down behaviour so missing-browser doesn't fail the suite; (e) tests run on `npm run test:e2e` only — not on the default `npm test` — so flakes don't block routine work.
- **E2E harness — fixture pollution.** Each run copies the fixture into a fresh temp dir. The original fixture is read-only from the harness's perspective. **Mitigation:** hard-copy with `fs.cpSync(src, dst, {recursive: true})` and use the temp dir as the `bughunter init` cwd.

### 8.4 Test ordering inside the e2e harness

Inside `bughunter-e2e.test.ts`:

1. **Setup** (beforeAll): copy fixture → temp dir; ensure `package.json` has `dev` script; spawn Next dev server + SurfaceMCP server; wait for both to be reachable (ping `/health` or equivalent with exponential backoff up to 30s).
2. **Probe camofox-mcp**: `fetch('http://127.0.0.1:3104/health').then(r => r.ok)`. Set `browserAvailable` boolean.
3. **Initialise BugHunter**: write `.bughunter/config.json` programmatically (no need for `bughunter init`).
4. **Test 1 (API-only)**: run `bughunter run --max-runtime 30000 --max-bugs 50` with no `browserMcpUrl`; assertions for tool count, surface_call_failed clustering, relatedClusterIds for the journal-entries route (assuming we also seed a `404_for_linked_route` from `/api/missing-route-link`).
5. **Test 2 (UI, conditional)**: `if (!browserAvailable) test.skip(...)`. Otherwise run `bughunter run` with `browserMcpUrl = http://127.0.0.1:3104`; assertions for `mutationObserverWindowMs > 0`.
6. **Test 3 (bodyFixtures suppression)**: re-run with `bodyFixtures: { '<journal-entries-toolId>': { '*': { memo: 'seeded', amount: 42 } } }`; assert the previously-flagged cluster is gone.
7. **Teardown** (afterAll): kill all spawned PIDs; remove temp dir.

Each test is independent (re-runs fresh on a freshly-spawned server pair).

---

## 9. Self-hosting decision (declarative)

**SurfaceMCP cannot introspect itself.** SurfaceMCP catalogs Next.js / Express / Vite apps — the MCP server itself is a Node.js stdio/HTTP daemon with no Next.js routes, no Express handlers, and no Vite-built UI. There is no API surface to discover. **Verdict: N/A.** Do not pursue self-hosting.

**BugHunter cannot bug-hunt itself.** BugHunter is a CLI; it has no UI for the walker to crawl, no fetch handlers, no role model, no auth. The closest analog is exercising it against a fixture — which is what the e2e harness does. **Verdict: N/A.** Do not pursue self-hosting.

**The fixture-based e2e from § 5 is the right answer** to "can BugHunter run against its own code?" The fixture exercises the full pipeline against a real (small) Next.js app. Future work that breaks BugHunter, SurfaceMCP, or their integration will fail the e2e suite.

---

## 10. Open questions

The fixes above are deterministic. Two genuinely require user input:

### 10.1 Should the e2e harness be hard-required to run camofox-mcp, or skip-when-down?

This spec recommends **skip-when-down with a clear printed message** (§ 5.C, § 6.C). Rationale: CI runners may not have Firefox; a hard-required gate would block all PRs on those runners. The API-only portion of the e2e is the bulk of the regression value; the browser portion adds Gap 1.B coverage.

**Open question for user:** is this the right trade-off, or should CI be required to provide camofox-mcp and the e2e fail when it's unreachable? (No code change either way; the difference is whether the test prints `[skip]` or fails. The recommendation is to ship `[skip]` and revisit if Gap 1.B regressions slip past.)

### 10.2 Should the e2e fixture additions live in BugHunter or SurfaceMCP?

This spec puts them in SurfaceMCP (`fixtures/nextjs-app/`) — that's where the existing fixture lives, and the SurfaceMCP-side e2e (sister spec) needs them too. The BugHunter e2e copies the fixture into a temp dir at runtime.

**Open question for user:** is cross-repo coupling acceptable? Alternative is to copy the fixture into BugHunter (`fixtures/nextjs-app/`), making BugHunter independent but creating a divergence risk between the two copies. The recommendation is **single source of truth in SurfaceMCP** with BugHunter consuming via filesystem path; if/when these repos move into a monorepo, this becomes trivially correct.

All other items (option A vs B vs C, IIFE vs polling, hard-required vs optional preState/postState, vitest config split) are resolved above.

---

## 11. Test plan summary

| Test file | Status | Covers |
|---|---|---|
| `tests/cluster-related.test.ts` | EDIT (existing) | Gap 1.A — toolId-keyed link; smoke shapes verbatim |
| `tests/cluster.test.ts` | EDIT (existing) | Gap 1.B — postState plumbing; pre/post survives `upgradeToFull` |
| `tests/state-change.test.ts` | NEW | Gap 1.B — IIFE-wrapped START script parses |
| `tests/e2e/bughunter-e2e.test.ts` | NEW | Full pipeline against fixture; § 6.C |
| `/root/SurfaceMCP/src/e2e/surfacemcp-e2e.test.ts` | NEW (sister spec) | MUST_DISCOVER conformance; `'partial'` confidence; `_suggestedExternalIntegrations` precision |

`npm run test` runs everything except `tests/e2e/`. `npm run test:e2e` runs the e2e harness. Both must pass for DoD.

---

## 12. Definition of done

- All items in § 7.A land per § 8.2 sequencing (sister spec § 7.B lands in parallel on its own branch).
- All acceptance criteria in § 6 pass.
- `npx tsc --noEmit` clean.
- `npx vitest run` (default config) green; new `tests/state-change.test.ts` and updated `cluster*.test.ts` green.
- `npm run test:e2e` green when camofox-mcp is reachable; SKIPs cleanly with exit 0 when not.
- Re-run smoke against `/root/spoonworks` after both gap fixes:
  - Cluster `qb0cldg1...` (404_for_linked_route on toolId `0928801337a9`) carries `relatedClusterIds: ['cw6rx3ri...']` (or whatever the new run's surface_call_failed id is).
  - At least one UI test in the smoke result has `mutationObserverWindowMs > 0` AND `< 60000`.
  - Run summary line still prints `Tests: N planned, M ran, K skipped` (regression check on § 9 of `SPEC_SMOKE_FIXES.md`).
- `dist-skill/bughunt-host.md` updated; the gotchas list reflects the post-fix state.
- Sister spec (`/root/SurfaceMCP/SPEC_E2E_HARNESS.md`, branch `spec/e2e-harness`) is committed and ready for its own coder pass.
