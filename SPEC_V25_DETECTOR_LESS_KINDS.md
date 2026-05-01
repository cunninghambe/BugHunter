# SPEC — v0.25 "Detector-less BugKinds: CSRF + hallucinated-route"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** SPEC_PATH_TO_EXHAUSTIVE.md (Phase A item 2) · **Sibling:** SPEC_V05_SECURITY_HYGIENE.md (header-probe + hallucinated-route stubs).

The PR #53 audit found two `BugKind` union members with no emit site: `csrf_missing_on_mutating_route` and `hallucinated_route`. Both are in the priority hierarchy at `phases/classify.ts:39,48` and have working cluster signatures at `cluster/signature.ts:63-64,125-126` — but no detector emits them. This spec implements both. Both reuse existing infrastructure (HAR network capture, filesystem-page metadata) and anchor the comprehensive claim: CSRF is OWASP A01 territory, hallucinated_route is the natural demo for vibe-coded apps shipping 404-ing routes the LLM invented.

---

## 1. Objective

Add two detectors so that each BugKind in the union has at least one emit site:

| Kind | Detection signal | Lives in |
|---|---|---|
| `csrf_missing_on_mutating_route` | A captured HAR entry for a mutating method (POST/PUT/PATCH/DELETE) carries no CSRF token (cookie name match against `csrfCookieNamePatterns`, or a `X-CSRF-Token` / `X-XSRF-Token` header), and the request is not exempt (Bearer auth, `SameSite=Strict` session cookie, or `csrfCookieNamePatterns: []`). | `packages/cli/src/security/csrf-detector.ts` (new). Called from `runExecute` post-drain, alongside the existing HAR-feeds-classifyNetworkRequests block. |
| `hallucinated_route` | A render TestCase against a filesystem-routed (or surface_list_pages-listed) `DiscoveredPage` produces a 404 on the page URL itself, and the route is not a discoveryFixture-expanded route. | `packages/cli/src/classify/hallucinated-route.ts` (new). Called from `runClassify` (or before, in `runExecute`'s post-test loop) with access to the originating `DiscoveredPage` set. |

**In scope:**
- Two new detector modules, each pure and unit-testable
- Wiring at the existing HAR-classification site (CSRF) and at a new render-test post-classification site (hallucinated_route)
- Two integration fixture scenarios under `fixtures/` proving each kind fires
- Negative-case tests proving the disambiguation rules (CSRF skip-when-Bearer; hallucinated-route skip-when-discoveryFixture)

**Out of scope (deferred):**
- Active CSRF probing (sending a request without the token to confirm the server actually accepts it). v0.25 is observational only — we flag what we already saw fly without a token. Active probing is in v0.16 pen-testing territory and would need its own spec.
- Rebuilding `header-probe.ts`. The CSRF detector reuses `csrfCookieNamePatterns` from `analyzeProbeResult`'s options bag but does NOT live inside `analyzeProbeResult` itself — header-probe is for response-header inspection; CSRF needs request inspection.
- Changing planner discovery semantics. `discovery.pages` is the source of truth for "what routes the planner thinks exist." We do not recompute it.
- Cross-referencing frontend `fetch('/api/x')` strings against the SurfaceMCP catalog. SPEC_V05_SECURITY_HYGIENE § 4.17 specced that as one of two possible detection paths for hallucinated_route; this spec uses the simpler render-time 404 path. Static-source-scan can be added later as a complementary detector if v0.25 misses too many real cases.
- A new CLI flag. Both detectors run as part of the existing pipeline; CSRF gates on `config.headers?.enabled` and on the HAR being available (perf path), hallucinated_route gates on the existence of render test results.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union (lines 23-93) — both kinds at 40, 53. `DiscoveredPage.sourceFile` (341), `DiscoveredPage.navSource` (355) — identify filesystem-routed pages. `BugDetection.endpoint`/`targetPath`/`headerContext` per signature.ts. |
| `packages/cli/src/cluster/signature.ts` | Lines 63-64, 125-126. Both signatures already wired. Do NOT modify. |
| `packages/cli/src/phases/classify.ts` | KIND_PRIORITY 14-81; both kinds at 39, 48. Do NOT modify. |
| `packages/cli/src/phases/execute.ts` | Lines 245-265 — post-drain HAR→`classifyNetworkRequests` block (commit 82b6325). CSRF detector hooks in alongside. Render branch at 541-542 is a no-op; page status flows through HAR. |
| `packages/cli/src/phases/cluster.ts` | Lines 14-25: `STATIC_RERUN_KINDS` already contains `hallucinated_route`. Add `csrf_missing_on_mutating_route` here. |
| `packages/cli/src/security/header-probe.ts` | `analyzeProbeResult` reads `csrfCookieNamePatterns` (line 57) but never emits CSRF. The new detector is a sibling module; do NOT modify this file. |
| `packages/cli/src/security/header-rules.ts` | `CSRF_COOKIE_NAME_PATTERNS` (line 11) — reuse via import. |
| `packages/cli/src/adapters/har-writer.ts` | `harEntriesToNetworkRequests` strips down to `NetworkRequest`. We add a parallel helper preserving request headers + cookie jar — § 3.1.2. |
| `packages/cli/src/classify/network.ts` | `classifyNetworkRequests` (5-63) emits `404_for_linked_route` for ANY 404. Hallucinated-route runs AFTER and disambiguates per § 4.1.3. |
| `packages/cli/src/phases/discover.ts` | `runDiscover` returns `DiscoveryOutput.pages`. `sourceFile` (truthy ≡ filesystem-routed) and `navSource` are the join keys for hallucinated-route. |
| `packages/cli/src/phases/plan.ts` | Lines 213-224: `renderTestCase`. No DOM assertion beyond post-state pipeline; relies on HAR. |

### 2.2 Patterns to follow

- **Pure-function detectors.** Both new modules export a function that takes structured input and returns `BugDetection[]`. No fs, no fetch, no globals. Mirrors `classifyNetworkRequests`, `analyzeProbeResult`, `classifyConsoleErrors`.
- **Signature shape contract.** `csrf_missing_on_mutating_route` MUST set `detection.endpoint` to `${method} ${normalizedPath}` (matches signature.ts:64). `hallucinated_route` MUST set `detection.targetPath` to the page route (matches signature.ts:126).
- **`headerContext` for security findings.** Follow the convention in `analyzeProbeResult` — set `headerName`, `expectedShape`, optional `observedValue`. Surfaces in retest hints.
- **Skip reasons logged at info, not silent.** When the CSRF detector skips because `cookieNamePatterns: []` or because the request had a Bearer token, emit `log.info('csrf-detector: skipped', { reason, ... })`. Do not bury skips.
- **Discriminated-union exhaustiveness.** No new union variants needed — both kinds already exist. If you find yourself adding to `BugKind`, you are off-spec.

### 2.3 DO NOT

- Do **not** modify `analyzeProbeResult`, `header-probe.ts`, or `header-rules.ts`. CSRF is a request-side check, not a response-header check; co-locating breaks the existing module's invariant.
- Do **not** change `classifyNetworkRequests` to emit `hallucinated_route` directly. Keep it focused on status-code classification; hallucinated_route disambiguation runs as a separate post-pass with access to the discovery context that `classifyNetworkRequests` does not have.
- Do **not** add new CLI flags. Both detectors are covered by `config.headers.enabled` (CSRF, since it shares the security-headers feature flag) and run unconditionally for hallucinated_route (no observable cost — it's a filter over results that already exist).
- Do **not** introduce a new BugKind for "hallucinated_route_static" or split CSRF by sub-rule. v0.25 ships exactly the two kinds the union already advertises.
- Do **not** call `surface_call` from inside the detectors. Both run on data already collected. No active probing.
- Do **not** swallow HAR parse errors. If `harEntriesToCsrfObservations` (the new helper) cannot parse a header, log at debug level and skip that entry; do not throw.
- Do **not** flag `OPTIONS` preflights as mutating. Only POST/PUT/PATCH/DELETE.

---

## 3. CSRF detector — `csrf_missing_on_mutating_route`

### 3.1 Module: `packages/cli/src/security/csrf-detector.ts`

#### 3.1.1 Public function signature

```ts
import type { BugDetection } from '../types.js';

/** A single mutating HTTP request as captured by the HAR pipeline. */
export type CsrfObservation = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;                                   // absolute URL of the request
  requestHeaders: Record<string, string>;        // lowercase keys (normalized by parser)
  cookieJar: string[];                           // raw `Cookie:` header values, one per request, split on '; '
  responseSetCookieHeaders: string[];            // for SameSite=Strict heuristic
};

export type CsrfDetectorOptions = {
  /** Cookie name patterns indicating a CSRF token cookie. Default: ['csrf', 'xsrf', '_csrf']. */
  cookieNamePatterns?: string[];
  /** Header names that indicate an explicit CSRF token. Default: ['x-csrf-token', 'x-xsrf-token', 'csrf-token', 'xsrf-token']. */
  tokenHeaderNames?: string[];
};

export function detectMissingCsrf(
  observations: CsrfObservation[],
  options: CsrfDetectorOptions = {},
): BugDetection[];
```

#### 3.1.2 Helper: `harEntriesToCsrfObservations(entries) → CsrfObservation[]`

Lives in `packages/cli/src/adapters/har-writer.ts` next to `harEntriesToNetworkRequests`. Filters HAR entries to mutating methods, extracts `request.headers` (lowercased keys), the `Cookie` header (split on `; `), and `response.headers` for the `Set-Cookie` values.

Why a separate helper rather than enriching `NetworkRequest`: the existing `NetworkRequest` shape (types.ts:133-139) is intentionally lean for clustering. Adding `requestHeaders` would balloon it for the 95% of consumers that don't need them. A parallel projection keeps the surface narrow.

#### 3.1.3 Detection algorithm

```
For each observation in observations:
  if method ∉ {POST, PUT, PATCH, DELETE}:
    continue                                   # OPTIONS/HEAD/GET cannot be CSRF targets

  # Skip 1: explicit opt-out via empty cookieNamePatterns
  if options.cookieNamePatterns is exactly [] (length 0, NOT undefined):
    log.info('csrf-detector: skipped (cookieNamePatterns: [])')
    return []                                   # whole-detector skip; one log line per run

  # Skip 2: Bearer-token auth (OAuth/JWT — not CSRF-vulnerable from cross-origin JS)
  if requestHeaders['authorization'] starts with 'Bearer ' (case-insensitive):
    continue                                   # per-observation skip

  # Skip 3: SameSite=Strict on every session-shaped cookie in the response jar
  if every Set-Cookie in responseSetCookieHeaders that is session-shaped (per isSessionCookie)
     has SameSite=Strict:
    continue                                   # per-observation skip — strict cookie auth is its own CSRF defense

  # Detection: do we have a CSRF cookie OR a CSRF header?
  hasCsrfCookie = any name in cookieJar matches options.cookieNamePatterns (case-insensitive includes)
  hasCsrfHeader = any name in requestHeaders matches options.tokenHeaderNames

  if not (hasCsrfCookie or hasCsrfHeader):
    emit BugDetection {
      kind: 'csrf_missing_on_mutating_route',
      rootCause: `Mutating ${method} ${normalizedPath} accepted without CSRF token (no matching cookie or header)`,
      endpoint: `${method} ${normalizedPath(url)}`,
      headerContext: {
        headerName: 'X-CSRF-Token',
        expectedShape: 'present_or_cookie_match',
        observedValue: '',
      },
    }
```

`normalizedPath` is imported from `../classify/network.ts` (already exists). Uses `:id` substitution so `/api/orders/123` and `/api/orders/456` cluster together as one finding.

Default `tokenHeaderNames`: `['x-csrf-token', 'x-xsrf-token', 'csrf-token', 'xsrf-token']`. These four are the only spelling variants we've seen in the wild.

Default `cookieNamePatterns`: import `CSRF_COOKIE_NAME_PATTERNS` from `header-rules.ts` and use it. Do not redefine.

#### 3.1.4 Integration site: `runExecute` post-drain block (execute.ts ~line 250-265)

The existing block (after commit `82b6325`):

```ts
if (har.log.entries.length > 0 && result.postState !== undefined) {
  const networkRequests = harEntriesToNetworkRequests(har.log.entries);
  result.postState.networkRequests = networkRequests;
  const networkBugs = classifyNetworkRequests(networkRequests, tc.expectedOutcome, true);
  result.bugs.push(...networkBugs);
  if (networkBugs.length > 0) result.passed = false;
}
```

Extend with:

```ts
if (har.log.entries.length > 0 && config.headers?.enabled !== false) {
  const observations = harEntriesToCsrfObservations(har.log.entries);
  const csrfBugs = detectMissingCsrf(observations, {
    cookieNamePatterns: config.headers?.csrf?.cookieNamePatterns,
  });
  if (csrfBugs.length > 0) {
    result.bugs.push(...csrfBugs);
    result.passed = false;
  }
}
```

Gating: `config.headers.enabled !== false` (header-probe master switch — CSRF inherits this since it shares conceptual scope). Independent of `--enable-perf` only because the HAR is what drives this — same caveat as the audit-fix in 82b6325: without perf the HAR is empty.

#### 3.1.5 STATIC_RERUN_KINDS update

Add `'csrf_missing_on_mutating_route'` to `STATIC_RERUN_KINDS` in `packages/cli/src/phases/cluster.ts:14-25`. Retest semantics: re-run a single mutating-method probe to the endpoint with no token; if the server now rejects (or now requires the token), the bug is verified fixed. The retest path itself is in `ops/retest.ts` and works generically for `static_rerun` kinds; this is a pure dispatch flag.

### 3.2 CSRF edge cases

- **EC-CSRF-1. Double-submit-cookie pattern.** Server sets `csrf` cookie; SPA echoes as `X-CSRF-Token`. Both observed → no flag.
- **EC-CSRF-2. SameSite=Strict-only auth (no token at all).** Skip per § 3.1.3 Skip 3. SameSite=Strict is itself a CSRF defense; the user's choice.
- **EC-CSRF-3. JWT bearer-token auth.** Skip per Skip 2 — Bearer tokens cannot be CSRF'd from cross-origin JS.
- **EC-CSRF-4. Session cookie WITHOUT SameSite=Strict + no CSRF token observed.** Canonical CSRF vulnerability. Fires.
- **EC-CSRF-5. `OPTIONS` preflight.** Filtered by method check.
- **EC-CSRF-6. CORS-preflighted JSON request with `Content-Type: application/json`.** Preflight is a soft CSRF defense, but the server SHOULD still validate origin/token — we still flag. False-positive shape documented; suppression is the user's responsibility.
- **EC-CSRF-7. `cookieNamePatterns: []` (explicit empty array).** Whole-detector skip, logged once. Distinct from `undefined`.
- **EC-CSRF-8. HAR entry malformed (missing `request.headers`).** Helper logs at debug, skips entry.
- **EC-CSRF-9. Cross-origin request (third-party API the SPA calls).** Out of scope. Harvester pre-filters on `URL(observation.url).origin === appBaseUrl origin`.
- **EC-CSRF-10. Cookie names — HTTP case-sensitive, but patterns match case-insensitively.** All comparisons via `.toLowerCase()` on names. Values not inspected.

### 3.3 CSRF acceptance criteria

| Criterion | Verifier |
|---|---|
| `detectMissingCsrf` unit-tested for the 10 edge cases above | `packages/cli/src/security/csrf-detector.test.ts` |
| `harEntriesToCsrfObservations` unit-tested for header lowercasing, cookie split, mutating-method filter | `packages/cli/src/adapters/har-writer.test.ts` (extend) |
| Fixture: `fixtures/csrf-vulnerable-app/` — Express app with `POST /api/items` accepting requests sans token | `tests/integration/csrf.spec.ts` (new) |
| Integration test runs BugHunter against the fixture, expects exactly one cluster of kind `csrf_missing_on_mutating_route`, signature `csrf_missing_on_mutating_route\|POST /api/items` | jest assertion |
| Negative fixture: same fixture with double-submit pattern enabled — expects zero CSRF clusters | jest assertion |
| `npx tsc --noEmit` clean | `tsc` |

---

## 4. Hallucinated-route detector — `hallucinated_route`

### 4.1 Module: `packages/cli/src/classify/hallucinated-route.ts`

#### 4.1.1 Public function signature

```ts
import type { BugDetection, DiscoveredPage, TestResult } from '../types.js';

export type HallucinatedRouteInput = {
  /** Render TestResults only (filter on action.kind === 'render' before passing in). */
  renderResults: TestResult[];
  /** The discovery output's pages list — gives us sourceFile / navSource per route. */
  pages: DiscoveredPage[];
  /** Routes excluded from hallucinated-route detection (configured discoveryFixtures whose row is missing). */
  fixtureUnresolvableRoutes: Set<string>;
};

export function detectHallucinatedRoutes(
  input: HallucinatedRouteInput,
): BugDetection[];
```

#### 4.1.2 Detection algorithm

```
pageByRoute = Map(pages.map(p => [p.route, p]))

emit = []
for each result in renderResults:
  if result has no postState OR postState.networkRequests is empty:
    continue                                   # nothing to assess

  page = pageByRoute.get(result.testCase.page)  # join via tc.page === DiscoveredPage.route
  if page is undefined:
    continue                                   # crawl-discovered route that doesn't appear in pages — should not happen

  # Skip 1: route was expanded from a discoveryFixture and the row is unresolvable.
  if result.testCase.page in fixtureUnresolvableRoutes:
    continue

  # Skip 2: not a planner-discovered route (only filesystem + surface_list_pages count).
  isFilesystemRouted = page.sourceFile !== undefined and page.sourceFile !== ''
  isStaticListed = page.navSource === 'static-page' or page.navSource === undefined
  if not (isFilesystemRouted or isStaticListed):
    continue                                   # crawl-link-only routes don't qualify; if a link 404s we already emit 404_for_linked_route

  # Detection: did the page navigation itself return 404?
  pageRequest = postState.networkRequests.find(r =>
    r.method === 'GET' AND
    pathsMatch(r.path, page.route)
  )
  if pageRequest exists and pageRequest.status === 404:
    emit BugDetection {
      kind: 'hallucinated_route',
      rootCause: `Planner-discovered page ${page.route} returned 404 — route does not exist on the server`,
      targetPath: page.route,
      pageRoute: page.route,
    }
```

`pathsMatch(harPath, route)`: tolerates absolute vs relative URL, query-string presence (strip first), and trailing-slash normalisation. Implementation = `new URL(harPath, 'http://x').pathname.replace(/\/$/, '') === route.replace(/\/$/, '')`. Edge case: root `/` stays `/`.

#### 4.1.3 Disambiguation from `404_for_linked_route`

These two kinds overlap on "we saw a 404 in the HAR." The split:

| Source of 404 | Kind |
|---|---|
| The page URL the test renders (the navigation itself) | `hallucinated_route` |
| Any other URL in the HAR (sub-resource, fetch, image, link click) | `404_for_linked_route` |

Both can fire in the same test result: a hallucinated page might also link to a different 404. `classifyNetworkRequests` runs first and emits `404_for_linked_route` for everything; the hallucinated-route pass then runs, finds the page-URL 404, and emits `hallucinated_route`. The classify-priority hierarchy (classify.ts:14-81) places `hallucinated_route` BELOW `404_for_linked_route` (lines 24, 48), so when both fire on the same testId, the prior-art `404_for_linked_route` wins as canonical.

**The architect-considered alternative** — suppress the parallel `404_for_linked_route` whenever `hallucinated_route` fires on the same URL — is rejected: keeping both keeps the priority hierarchy doing its job, and it's conceivable the user wants the "linked route" framing too. The cluster phase de-duplicates via the signature hash, and the priority filter in `applyPriorityFilter` (classify.ts) attaches the lower-priority finding as a `secondaryObservation`. Net result: one canonical detection per render, with both kinds visible.

**Edge case:** if `404_for_linked_route` is selected as canonical because it ranks higher, the cluster signature will be `404_for_linked_route|/ghost` not `hallucinated_route|/ghost`. To ensure `hallucinated_route` clusters get formed at all, the new detector must run BEFORE `applyPriorityFilter` and must emit the `hallucinated_route` detection on a DIFFERENT testId (a synthetic per-page testId carrying the render result's occurrenceId). This is fiddly. **Decision:** when `detectHallucinatedRoutes` fires for a given render result, REMOVE the matching `404_for_linked_route` detection from that result's bug list (filter by `targetPath === page.route`). One signal per cause. This is implemented as a post-pass in the same module — the detector returns both `add: BugDetection[]` and `removeWhere: (d: BugDetection) => boolean`, and the caller applies both. Update the function signature accordingly:

```ts
export function detectHallucinatedRoutes(
  input: HallucinatedRouteInput,
): {
  perTestId: Map<string, {
    add: BugDetection[];
    removePredicate: (d: BugDetection) => boolean;
  }>;
};
```

#### 4.1.4 Integration site

Hallucinated-route detection runs in `runExecute` immediately after the per-test HAR-classify block, NOT in `runClassify`. Reasoning: at execute time we still have the testCase and the per-result postState in scope; running it as a classify-phase pass would require re-joining tc → result → discovery, which is more plumbing for no benefit.

Pseudocode insertion after the existing HAR classify block:

```ts
// After classifyNetworkRequests + CSRF detector, before pushing the result:
if (tc.action.kind === 'render') {
  const hallucinatedOut = detectHallucinatedRoutes({
    renderResults: [result],
    pages: discoveryPages,                         // passed in via ExecuteOptions
    fixtureUnresolvableRoutes: fixtureUnresolved,  // passed in via ExecuteOptions
  });
  const entry = hallucinatedOut.perTestId.get(result.testId);
  if (entry !== undefined) {
    result.bugs = result.bugs.filter(d => !entry.removePredicate(d));
    result.bugs.push(...entry.add);
    if (entry.add.length > 0) result.passed = false;
  }
}
```

`ExecuteOptions` (execute.ts ~line 110) gains two fields:
```ts
discoveryPages: DiscoveredPage[];                  // required when runExecute is called from CLI; tests pass []
fixtureUnresolvableRoutes?: Set<string>;           // built in discover.ts:128-138 alongside the existing skip
```

The unresolvable-fixtures set is computed during `runDiscover` (discover.ts:127-140) — wherever `expanded.length === 0` triggers a skip, also push `p.route` into the set. Surface this on `DiscoveryOutput` as a new field `fixtureUnresolvableRoutes?: string[]` (types.ts addition; serialisable). Convert to `Set` at the execute call site.

### 4.2 Hallucinated-route edge cases

- **EC-HR-1. App's 404 page returns HTTP 200 (SPA catch-all).** Detector relies on HTTP status only — cannot fire. Documented; vision-based 404-page detection is a separate kind, out of scope.
- **EC-HR-2. Dynamic route `/products/[id]` expanded with `discoveryFixtures.123`.** If fixture resolved AND server returns 404, fires (informative either way). If fixture missing, route is in `fixtureUnresolvableRoutes` → skip.
- **EC-HR-3. `state`-kind page (tab-state click-to-reach).** No real URL to render against. Detector filters on `page.kind === 'url'` (or undefined; default).
- **EC-HR-4. Crawler-discovered route via link traversal that 404s on render.** `navSource === 'crawl-link'/'crawl-seed'` → Skip 2 rejects. 404 still fires as `404_for_linked_route` (the originating link is the real bug).
- **EC-HR-5. Page route is `/` (root) and root returns 404.** Fires; signature `hallucinated_route|/`. Catches misconfigured base URLs.
- **EC-HR-6. Auth gate redirects unknown routes to `/login` with 302→200.** No 404 in HAR — does not fire. False-negative shape; documented.
- **EC-HR-7. `postState.networkRequests` empty (perf disabled, no HAR).** Silent no-op. Same caveat as audit-fix 82b6325.
- **EC-HR-8. Two filesystem pages collapse to same route after dynamic expansion.** Map last-write-wins. Acceptable.
- **EC-HR-9. Page returns 410 / 451.** Not 404 — does not fire. By design.
- **EC-HR-10. Vite stack via `surface_list_pages` with `sourceFile === '<unresolved>'` mapped to undefined.** Skip 2's `isStaticListed` branch (`navSource === 'static-page' or undefined`) qualifies even without sourceFile.

### 4.3 Hallucinated-route acceptance criteria

| Criterion | Verifier |
|---|---|
| `detectHallucinatedRoutes` unit-tested for the 10 edge cases above | `packages/cli/src/classify/hallucinated-route.test.ts` |
| Fixture: `fixtures/hallucinated-route-app/` — Next.js app with `app/ghost/page.tsx` that 404s because the underlying handler is missing OR the page imports a non-existent component | `tests/integration/hallucinated-route.spec.ts` |
| Integration test asserts exactly one cluster of kind `hallucinated_route`, signature `hallucinated_route\|/ghost` | jest |
| Disambiguation: same fixture also has `app/realpage/page.tsx` that 200s and a link inside it pointing to `/missing-link` (404) — expects ONE `hallucinated_route` cluster (for `/ghost`) AND ONE `404_for_linked_route` cluster (for `/missing-link`); no overlap | jest |
| `npx tsc --noEmit` clean | `tsc` |

---

## 5. Cluster signatures — verification

Both already exist; do not modify. Cited:

- `csrf_missing_on_mutating_route|<endpoint>` at `packages/cli/src/cluster/signature.ts:63-64`. The `endpoint` is the `${method} ${normalizedPath}` string set by the detector.
- `hallucinated_route|<targetPath>` at `packages/cli/src/cluster/signature.ts:125-126`. The `targetPath` is the page route set by the detector.

Both already covered in the existing `signature.test.ts` exhaustiveness test (lines 92, 97).

---

## 6. CLI / config

No new CLI flags. Behaviour matrix:

| Setting | CSRF detector | Hallucinated-route detector |
|---|---|---|
| Default (out of the box) | Runs when `--enable-perf` is on (HAR available). Uses default `cookieNamePatterns`. | Runs always. Fires only when `--enable-perf` is on (HAR available). |
| `config.headers.enabled = false` | Skipped | Unaffected |
| `config.headers.csrf.cookieNamePatterns = []` | Skipped (whole detector, logged once per run) | Unaffected |
| `config.headers.csrf.cookieNamePatterns = ['my-custom']` | Uses custom list | Unaffected |
| Perf disabled (no HAR) | No data → silent no-op | No `postState.networkRequests` → silent no-op |

Both detectors honour the existing `config.staticAnalysis.enabled` only indirectly — they run during execute, not static-analysis. No new fields on `BugHunterConfig`.

---

## 7. Negative requirements

- Do **not** add a new field on `BugHunterConfig` for either detector. Both are reachable through existing knobs.
- Do **not** add a new BugKind. Both kinds are already in the union.
- Do **not** modify `header-probe.ts` or `header-rules.ts`. Reuse `CSRF_COOKIE_NAME_PATTERNS` by import.
- Do **not** introduce a runtime dependency. Header parsing is `String.prototype.split`; URL parsing is `URL`.
- Do **not** swallow errors. If HAR parsing of a single entry fails, log at debug and continue; if the WHOLE HAR is missing, log at info and no-op.
- Do **not** emit `hallucinated_route` for routes that 200 but show a "Page not found" message in the DOM. v0.25 is HTTP-status-driven only. Vision-based detection is a different kind.
- Do **not** call `surface_call` or fetch from inside the detectors. Pure functions.
- Do **not** make `detectHallucinatedRoutes` mutate its inputs. Return value is the only side effect.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `harEntriesToCsrfObservations` helper | `packages/cli/src/adapters/har-writer.ts` (+ test) | none |
| 2 | Implement `detectMissingCsrf` and unit-test the 10 edge cases | `packages/cli/src/security/csrf-detector.ts`, `csrf-detector.test.ts` | 1 |
| 3 | Wire CSRF detector in `runExecute` post-drain block | `packages/cli/src/phases/execute.ts` | 2 |
| 4 | Add `csrf_missing_on_mutating_route` to `STATIC_RERUN_KINDS` | `packages/cli/src/phases/cluster.ts` | none |
| 5 | Build CSRF integration fixture + test | `fixtures/csrf-vulnerable-app/`, `tests/integration/csrf.spec.ts` | 3 |
| 6 | Add `fixtureUnresolvableRoutes` to `DiscoveryOutput` and populate in `runDiscover` | `packages/cli/src/types.ts`, `phases/discover.ts` | none |
| 7 | Implement `detectHallucinatedRoutes` and unit-test 10 edge cases | `packages/cli/src/classify/hallucinated-route.ts`, `hallucinated-route.test.ts` | 6 |
| 8 | Plumb `discoveryPages` + `fixtureUnresolvableRoutes` through `ExecuteOptions` | `packages/cli/src/phases/execute.ts`, `cli/run.ts` | 7 |
| 9 | Wire hallucinated-route detector in `runExecute` per-render-result block | `packages/cli/src/phases/execute.ts` | 7, 8 |
| 10 | Build hallucinated-route integration fixture + test | `fixtures/hallucinated-route-app/`, `tests/integration/hallucinated-route.spec.ts` | 9 |
| 11 | Verify exhaustiveness test still passes (both kinds already in coverage) | `packages/cli/src/cluster/signature.test.ts` | 2, 7 |
| 12 | Run full test suite + typecheck + lint | (whole repo) | all |

Tasks 1–5 are CSRF-only; 6–10 are hallucinated_route-only. They can be parallelized across two coders if needed; the only shared edit is `runExecute` post-drain block which both touch (sequence 3 → 9).

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| `detectMissingCsrf` + helper unit tests pass | `npx vitest run packages/cli/src/security/csrf-detector.test.ts packages/cli/src/adapters/har-writer.test.ts` |
| `detectHallucinatedRoutes` unit tests pass | `npx vitest run packages/cli/src/classify/hallucinated-route.test.ts` |
| CSRF integration test passes | `npx vitest run tests/integration/csrf.spec.ts` |
| Hallucinated-route integration test passes | `npx vitest run tests/integration/hallucinated-route.spec.ts` |
| `cluster.test.ts` exhaustiveness still green (both kinds covered) | `npx vitest run packages/cli/src/phases/cluster.test.ts` |
| `signature.test.ts` exhaustiveness still green | `npx vitest run packages/cli/src/cluster/signature.test.ts` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Full suite passes | `npx vitest run` |
| Full build succeeds | `npm run build` |
| Manual: run BugHunter against TraiderJo with `--enable-perf` and observe whether either kind fires (regression smoke; either result is informative) | tail `summary.json.byKind` |

---

## 10. Risks + escape hatches

- **CSRF noise on preflighted JSON requests:** documented in EC-CSRF-6. Escape hatch: `cookieNamePatterns: []` skips entirely. Iterate on filter precision in v0.26 if needed.
- **Both detectors require `--enable-perf` (HAR-driven):** same caveat as audit-fix 82b6325. Per-test browser-side network listener is the v0.7 deferred fix.
- **Hallucinated_route ↔ 404_for_linked_route disambiguation is fragile:** explicit predicate-based removal in § 4.1.3, unit-tested. Contract: one detection per cause.
- **Escape hatch (CSRF):** `config.headers.csrf.cookieNamePatterns = []` — one-line opt-out.
- **Escape hatch (hallucinated_route):** `config.excludedRoutes` filters at discovery; `.bughunter/suppressions.json` filters at cluster level.

---

## 11. Open questions

1. **Should `hallucinated_route` also fire for SurfaceMCP-discovered API tools whose route 404s when the API test runs?** (Currently it fires only for filesystem-routed pages on render.) An API tool catalog entry pointing to a 404 endpoint is conceptually the same "planner believed this exists" bug. **Architect's recommendation:** defer to v0.26. The catalog→404 case is partially covered by `surface_call_failed`; adding a parallel API-side hallucinated_route requires disambiguation rules similar to the `404_for_linked_route` split. Ship the simpler render-side case first.

2. **Should the CSRF detector also flag missing-CSRF on cookieless server-to-server request flows?** Such flows never pass through a browser HAR. **Resolution:** v0.25 is observational from a browser session by construction. If v0.7 adds direct API mutating-probe coverage, the same pure detector applies without modification.

3. **SameSite=Strict skip — require ALL session cookies to be Strict, or just FIRST observed?** Spec says ALL. A Lax cookie + a Strict cookie still has Lax exposure. **Decision:** stay with ALL.

4. **Ship a CLI flag `--no-csrf-detector` for parity with other security toggles?** No — `cookieNamePatterns: []` is sufficient and avoids flag-bloat.

5. **Is there a meaningful interaction with `routeAliases`?** No. Alias collapse in `dedupRoutes` (discover.ts:148-154) means only the canonical route is ever tested; if it's hallucinated, the alias is implicitly hallucinated too.
