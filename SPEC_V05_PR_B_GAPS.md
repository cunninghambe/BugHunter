# SPEC — v0.5 PR B Smoke Gaps

**Status:** Draft 1, ready for @coder · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-28 · **Source:** smoke run `pblrq9amiy8pljeqbybb11iq` on `/tmp/TraiderJo` after PR B merge (main @ `79ff932`).

This spec patches three concrete gaps surfaced by the v0.5 PR B smoke. It is a single PR, broken into three focused, independently verifiable tasks. Each gap has live evidence from the run. Land all three before any v0.7 work begins; the IDOR matrix in particular is dead in the water until G2 is fixed.

---

## 0. Live evidence (from `pblrq9amiy8pljeqbybb11iq`)

`/tmp/TraiderJo/.bughunter/runs/pblrq9amiy8pljeqbybb11iq/summary.json`:

```json
{
  "bugs_filed": 8,
  "byKind": {
    "missing_state_change": 4,
    "vulnerable_dependency_high": 1,
    "hardcoded_credentials_in_source": 3
  },
  "byRole": { "owner": 4, "anon": 4, "system": 4 }
}
```

`/tmp/TraiderJo/.bughunter/runs/pblrq9amiy8pljeqbybb11iq/state.json`:
- `discovery.pages.length === 15` (route `/` is page index 0).
- `discoveredIds === {}` — empty.
- `config.appBaseUrl === 'http://127.0.0.1:8787'` — set.
- `config.headers === undefined`, `config.staticAnalysis === undefined`.
- `testCases.length === 66`, **all `via: 'ui'`. Zero API tests** (SurfaceMCP catalog reports `tools: 0` for TraiderJo).

`curl -s -i http://127.0.0.1:8787/`:
```
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ...
```

So TraiderJo:
1. **Does** emit a CSP header with `script-src 'self' 'unsafe-inline'` — should fire `missing_csp_header` with `expectedShape: 'inline_scripts_allowed'`. It did not.
2. Has no API tools registered in SurfaceMCP, so the IDOR matrix has nothing to harvest from.
3. Produced 4 stray `cluster: testId present but stateByTestId lookup missed` warnings during cluster materialization.

Three gaps, three tasks. Land all of them in a single PR `feat/v05-pr-b-gaps`.

---

## 1. Gap 1 — Header probe runs but emits zero detections on TraiderJo

### 1.1 Problem

TraiderJo's `/` returns `Content-Security-Policy: ... script-src 'self' 'unsafe-inline' ...`. The header-probe regex `/script-src[^;]*'unsafe-inline'/` correctly matches this. The route `/` is in `discovery.pages[0]`. `appBaseUrl` is set. The probe is enabled. Yet `byKind` reports zero `missing_csp_header`.

### 1.2 Root cause

Three independent defects compound to silently swallow the detection:

**Defect 1.2.a — `headerProbeEnabled` evaluation is fragile.** `packages/cli/src/cli/run.ts:206`:

```ts
headerProbeEnabled: resolved.headers !== undefined || resolved.staticAnalysis?.enabled !== false,
```

This expression is logically correct on TraiderJo (resolves to `true`) **but the intent is wrong.** Header probing is its own subsystem and should have its own master switch driven by `config.headers?.enabled` (default `true`), independent of `staticAnalysis.enabled`. Coupling them means a future user who disables static analysis also accidentally disables header probing — and the failure is silent. Furthermore the current expression makes header probing *fail-closed* the moment a user adds `staticAnalysis: { enabled: false }` to their config, which is misleading.

**Defect 1.2.b — silent log loss.** In `packages/cli/src/phases/execute.ts:601` (`runHeaderProbes`), every error path is silent:

```ts
try {
  origin = new URL(absoluteUrl).origin;
} catch {
  continue;            // no log
}
...
if (probedOrigins.has(origin)) continue;   // no log
...
} catch (err) {
  log.warn('header-probe: request failed', { url: absoluteUrl, err: String(err) });
}
...
if (detections.length > 0) {
  log.info(`header-probe: found ${detections.length} detection(s) ...`);
}
```

When `detections.length === 0` we log nothing — there is no record of probing having occurred. The smoke run state file confirms this: `grep -c "header-probe" state.json === 0`. We cannot tell from artifacts whether the probe ran at all, found a clean origin, or hit a pre-fetch error and bailed.

**Defect 1.2.c — page-route collapse loses signal.** `pageUrls = discovery.pages.map(p => p.route)` produces:

```
['/', '/wiki/pre-trade-warnings', '/?hmDim=monthday', '/?hmDim=hour', '/?eqRange=', ...]
```

`runHeaderProbes` dedupes by `origin`. All 15 pages share `http://127.0.0.1:8787`. So we probe **`/` once and stop**. That's correct for the CSP-per-origin contract — but if the request to `/` fails (e.g. the dev server is restarting between execute and post-execute, or the response is a 304 with no headers, or a 502), we get no detection and no fallback to a second route. The probe is non-resilient.

The **most likely** actual failure mode on the smoke run is one of:
- A `fetch` thrown and silently swallowed in the `catch (err)` branch at `execute.ts:633` — the `log.warn` did fire but is filtered out at the default log level (which is `info` in production runs, `debug` for warnings goes to stderr only). The smoke summary doesn't surface it.
- `redirect: 'manual'` on the bare-origin GET against TraiderJo's vite dev server returns a 30x to a host with `Vary: Origin` that doesn't include the header. Unlikely but possible.

We are not going to chase the precise per-run cause. The fix is to make this subsystem **observable and resilient** so we never have to chase it again.

### 1.3 Fix design

Three changes, in priority order:

**Fix 1 — first-class enable flag.** Extend `HeadersConfig` with an explicit `enabled?: boolean` (default `true`). Add to `packages/cli/src/types.ts`:

```ts
export type HeadersConfig = {
  /** Master switch for header probing. Default: true. */
  enabled?: boolean;
  // ...existing fields unchanged
};
```

In `packages/cli/src/cli/run.ts:206`, replace the compound expression with:

```ts
headerProbeEnabled: resolved.headers?.enabled ?? true,
```

This is independent of `staticAnalysis`. It defaults to on. It fails open.

**Fix 2 — exhaustive logging in the probe loop.** Rewrite `runHeaderProbes` (`packages/cli/src/phases/execute.ts:596-643`) to log every state transition. Required log lines (use the structured logger; do not `console.log`):

```
log.info('header-probe: starting', { enabled, totalPageUrls, appBaseUrl, maxProbes });
log.debug('header-probe: skipped (origin already probed)', { absoluteUrl, origin });
log.debug('header-probe: skipped (URL parse failed)', { absoluteUrl });
log.info('header-probe: probing origin', { origin, absoluteUrl });
log.info('header-probe: origin probed', { origin, status, durationMs, detectionCount });
log.warn('header-probe: request failed', { absoluteUrl, err });
log.info('header-probe: complete', { originsAttempted, originsSucceeded, totalDetections });
```

The `header-probe: complete` line is **always** emitted, regardless of detection count. It is the canary that tells us the phase ran. Put it after the loop, before the return.

Add a per-origin retry: if the first GET fails (network error or 5xx), retry **once** with a 250ms backoff. Reuse the retry pattern from `discoverRateLimit` (look at `packages/cli/src/security/rate-limit-discovery.ts` for the pattern; do **not** introduce a new retry helper).

**Fix 3 — probe a representative path per origin, not the bare origin.** When the probe queue contains multiple routes for the same origin, prefer `/` first, then the deepest route (longest pathname), then the alphabetically-first route. The reason: many apps emit a different (often weaker) CSP on static index responses than on app-shell routes. Probing both `/` and one app-shell route catches CSP-per-route divergence. Cap at **2 probes per origin** to stay within the 100-probe budget.

Add to `runHeaderProbes`: replace the simple `probedOrigins: Set<string>` with a `Map<string, number>` (origin → probe count) and allow up to `2` probes per origin. The deduper picks the second route to be either the longest distinct pathname or the alphabetically-first route that differs from the first by more than the query string.

```ts
type ProbedOriginState = { count: number; routes: Set<string> };
const probedOrigins = new Map<string, ProbedOriginState>();
const MAX_PROBES_PER_ORIGIN = 2;
```

The cluster signature already keys on `origin` for `missing_csp_header`, so two probes against the same origin that both lack CSP collapse to one cluster — this is correct.

### 1.4 Test plan

**Unit (`packages/cli/src/security/header-probe.test.ts`):**
- Add a test for `analyzeProbeResult` against a probe result with `script-src 'self' 'unsafe-inline'` (TraiderJo's exact CSP). Asserts `inline_scripts_allowed` fires.

**Integration (new file `packages/cli/src/phases/execute-header-probe.test.ts`):**
- Mock `fetch` (use `vi.spyOn(globalThis, 'fetch')`) to return TraiderJo's exact CSP header.
- Call `runExecute` with `pageUrls = ['/', '/wiki/x']`, `appBaseUrl = 'http://127.0.0.1:8787'`, `headerProbeEnabled = true`, an empty `testCases` array, and a stub `surface`/`browser`.
- Assert `headerProbeDetections` contains exactly one `missing_csp_header` with `expectedShape: 'inline_scripts_allowed'`.
- Add a second test: same setup but `appBaseUrl` undefined and `pageUrls = ['/']`. Assert detection count is 0 AND `log.warn` was called with a message containing `URL parse failed`.
- Add a third test: same setup but `headerProbeEnabled = false`. Assert no fetch calls, no detections, and `log.info` was called with `header-probe: starting` carrying `enabled: false` then `header-probe: complete`.

**Smoke gate (manual; @qa):**
- After implementation, re-run on TraiderJo. Confirm `summary.json.byKind.missing_csp_header >= 1` AND log file contains `header-probe: complete` line.

### 1.5 Files to touch

- **Modify** `packages/cli/src/types.ts` — add `enabled?: boolean` to `HeadersConfig`.
- **Modify** `packages/cli/src/cli/run.ts` — change `headerProbeEnabled` evaluation.
- **Modify** `packages/cli/src/phases/execute.ts` — rewrite `runHeaderProbes` per Fix 2 + Fix 3.
- **Modify** `packages/cli/src/security/header-probe.test.ts` — add TraiderJo-CSP regression test.
- **Create** `packages/cli/src/phases/execute-header-probe.test.ts` — integration tests per § 1.4.

**Do not** create a new module. The probe stays in `execute.ts` (it's <80 lines).

### 1.6 Acceptance

- TraiderJo run `bughunter run --project /tmp/TraiderJo` emits at least one `missing_csp_header` cluster with `expectedShape: 'inline_scripts_allowed'`.
- Log file contains `header-probe: starting` AND `header-probe: complete` lines.
- All three integration tests pass.
- `npm run lint && npm run typecheck && npm test` clean.

### 1.7 Risk

Low. The header-probe module is already tested in isolation. The change is observability + a default-on flag rename. Pre-existing TraiderJo demo expectation in SPEC_V05_SECURITY_HYGIENE.md § 4.4 explicitly predicts this finding.

---

## 2. Gap 2 — `discoveredIds` empty; cross-user IDOR matrix produces 0 candidates

### 2.1 Problem

Smoke log: `cross-user: no discoveredIds available; phase produced 0 candidates`. Run state confirms `discoveredIds === {}`.

### 2.2 Root cause

**Cause A (TraiderJo-specific): zero API tools in SurfaceMCP catalog.** `curl -s http://127.0.0.1:3105/health` returns `{"ok":true,"revision":1,"tools":0}`. Plan phase iterates `enrichedTools` and produces 0 API test cases. The harvest hook (`extractIdsFromBody` at `execute.ts:512-516`) is wired into the API path only, so it is never invoked. **This is a SurfaceMCP-side gap and is not fixable in BugHunter** (TraiderJo's surface emitter doesn't introspect Express routes). But we can still feed the IDOR matrix from a second source.

**Cause B (general): the extractor's field-name set is too narrow.** `ID_FIELD_NAMES` is 12 names: `id, uuid, _id, tradeId, userId, accountId, resourceId, orderId, productId, transactionId, sessionId, customerId`. Real-world API responses commonly carry IDs in:

- snake_case: `user_id`, `account_id`, `order_id`, `tx_id`, `wallet_id`, `customer_id`, `created_by`
- domain-prefixed: `tradeUuid`, `sessionToken`, `apiKey` (sensitive — exclude), `slug`, `handle`
- composite identifiers: `pk` (Django), `objectId` (Parse), `_key` (ArangoDB), `nodeId`
- foreign keys nested inside related entities: `data.account.id`, `result.records[0].uuid`, `payload.entity.entityId`

Even with API tools present, narrow field coverage → narrow IDOR coverage.

**Cause C (general): no UI-side ID harvesting.** Even when SurfaceMCP has zero tools, the browser sees JSON in `window.__INITIAL_STATE__`, fetch responses logged to `console.log`, and IDs embedded in `data-*` attributes / hrefs (`/trades/abc-123`, `/users/42/edit`). The cross-user matrix could be fed by harvesting from the DOM and the network log of the UI test pass. Currently it isn't.

**Cause D (general): cross-user phase is gated on `discoveredIds.size === 0` with no fallback.** When zero IDs are available, the phase skips entirely. But there is a useful **vertical-only** sub-mode: replay every authed-tool with `targetRole = 'anonymous'` to detect `auth_bypass_via_unauthed_route` even with no IDs. This is currently dead.

### 2.3 Fix design

Four changes, again in priority order:

**Fix 1 — broaden `ID_FIELD_NAMES`.** Replace the static set with a tiered match:

```ts
// Tier 1: known identifier names (case-insensitive exact match)
const ID_NAMES_EXACT = new Set([
  'id', 'uuid', 'guid', '_id', '_uuid', '_key', '_pk', 'pk',
  'slug', 'handle', 'code', 'key', 'objectid', 'nodeid', 'hash',
]);

// Tier 2: regex match — foreign-key columns and snake_case ids
const ID_NAMES_REGEX = [
  /^[a-z][a-zA-Z0-9]*Id$/,           // tradeId, accountId, customerId
  /^[a-z][a-zA-Z0-9]*Uuid$/,         // tradeUuid
  /^[a-z][a-z0-9]*_id$/,             // user_id, tx_id, wallet_id
  /^[a-z][a-z0-9]*_uuid$/,           // user_uuid
  /^[a-z][a-zA-Z0-9]*Hash$/,         // txHash
  /^[a-z][a-zA-Z0-9]*Number$/,       // accountNumber, invoiceNumber
];

// Tier 3 (excluded — sensitive but not addressable):
// 'apiKey', 'token', 'secret', 'password', 'sessionId' — these are auth material, not resource IDs
const ID_NAMES_EXCLUDE = new Set([
  'apikey', 'apiKey', 'token', 'secret', 'password', 'sessionid',
  'sessiontoken', 'csrftoken', 'authtoken',
]);
```

Match order: exact → regex → exclude-filter. Lowercase the field name before exact and regex match. Keep `value` typed as `string | number` exactly as today; add `boolean` and `null` to the explicit-skip list (boolean PKs don't exist in real APIs).

Also: change the type from `Array<{ field: string; value: string }>` to `Array<{ field: string; value: string; path: string }>` where `path` is the dot-joined JSON path (e.g. `data.records[0].id`). Use the path in cluster signatures and in the IDOR rootCause for human-readable evidence.

**Fix 2 — value heuristics to reduce false positives.** Not every field named `id` carries a useful resource id. Cap on shape:

```ts
function looksLikeResourceId(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  // Reject obvious non-ids
  if (value === '0' || value === '-1') return false;
  // Reject all-whitespace / control characters
  if (/^\s*$/.test(value)) return false;
  // Reject obvious enums (boolean strings, very common case for `status: 'active'`)
  if (/^(true|false|null|undefined|active|inactive|pending|complete)$/i.test(value)) return false;
  return true;
}
```

Apply in `extractIdsFromBody` after coercion, before push.

**Fix 3 — UI-side ID harvest hook.** Add a new pure helper `harvestIdsFromDom(snapshot: string, links: string[]): Array<{ field: string; value: string; path: string }>`. Feeds two channels:

1. **Hrefs**: parse `links` (already collected by `walkDom`), regex-extract path-id tail segments matching `/[a-z]+\/([a-z0-9-]{4,40})(?:/|$)`. Emit `{ field: '__route_id', value: '<id>', path: '<href>' }`.
2. **`data-*` attributes**: parse the snapshot HTML, find attributes named `data-id`, `data-uuid`, `data-trade-id`, etc. Reuse the same Tier-1/Tier-2 logic on attribute names (sans the `data-` prefix).

Wire the hook into `executeUiTest` after `postSnapshot` is captured (around `execute.ts:323`):

```ts
if (postSnapshot?.snapshot !== undefined && discoveredIds !== undefined) {
  const uiIds = harvestIdsFromDom(postSnapshot.snapshot, /* links from somewhere */ []);
  if (uiIds.length > 0) mergeDiscoveredIds(discoveredIds, tc.role, '__ui_dom__', uiIds);
}
```

`'__ui_dom__'` is a synthetic toolId. The cross-user matrix in `phases/cross-user.ts` currently *requires* `toolCatalog.has(toolId)` — change that gate to **skip the catalog check for ids whose toolId starts with `__ui_`**, so DOM-harvested ids can drive replays against any tool.

**Fix 4 — anonymous-only fallback when `discoveredIds.size === 0`.** In `runCrossUser`, when `discoveredIds` is empty AND `anonymousProbeEnabled !== false`, run a **catalog-only anonymous-replay sweep**: for every tool in the catalog with `sideEffectClass === 'safe'` and `requiresAdmin !== true`, call `surface_call({ toolId, role: 'anonymous', input: {}, noAutoRelogin: true })`. If status === 200 and result is not empty, emit `auth_bypass_via_unauthed_route`. Cap at `maxReplays / 2` to leave budget for the matrix when ids do exist later.

This sweep is also the foundation for Track 5's auth-flow detectors (next spec) — wire it now so v0.7 can extend it.

### 2.4 Test plan

**Unit (`packages/cli/src/security/resource-id-extractor.test.ts` — extend):**
- Test snake_case: `extractIdsFromBody({ user_id: 'u1', account_id: 'a1' })` → both extracted.
- Test foreign-key suffix regex: `extractIdsFromBody({ ownerId: 'o1', creatorUuid: 'c1' })` → both extracted.
- Test exclusion: `extractIdsFromBody({ apiKey: 'sk-...', token: 't', sessionId: 's' })` → empty.
- Test `looksLikeResourceId`: '0', '-1', 'active', '   ' → all rejected.
- Test path emission: `extractIdsFromBody({ data: { records: [{ id: 'x' }] } })` → `{ field: 'id', value: 'x', path: 'data.records[0].id' }`.

**Unit (new file `packages/cli/src/security/dom-id-harvester.test.ts`):**
- Test href extraction: `harvestIdsFromDom('', ['/trades/abc-123', '/users/42/edit', '/static/x.png'])` → 2 ids extracted (skips `static` because length < 4 OR is reserved word — pick a heuristic).
- Test `data-*` extraction: snapshot containing `<div data-trade-id="t-1" data-uuid="u-1">` → 2 ids.
- Test that non-id `data-*` attributes (e.g. `data-testid`, `data-dismiss`) are not harvested.

**Integration (`packages/cli/src/phases/cross-user.test.ts` — extend):**
- Add a test where `discoveredIds` is empty but `surface.surface_list_tools()` returns 3 tools (1 admin, 2 safe). Assert anonymous-only sweep runs against the 2 safe tools and emits `auth_bypass_via_unauthed_route` for the one returning 200 with a non-empty body.

**Smoke gate (manual; @qa):**
- Re-run on TraiderJo. Even though TraiderJo has zero SurfaceMCP tools, the DOM-harvest hook should populate `discoveredIds` from the UI walk. Confirm `state.json.discoveredIds` is non-empty.
- If TraiderJo's API returns *any* JSON with an id-shaped field anywhere, cross-user matrix should attempt at least 1 replay.

### 2.5 Files to touch

- **Modify** `packages/cli/src/security/resource-id-extractor.ts` — broaden `ID_FIELD_NAMES`, add value heuristics, emit `path`.
- **Modify** `packages/cli/src/security/resource-id-extractor.test.ts` — extend per § 2.4.
- **Create** `packages/cli/src/security/dom-id-harvester.ts` — new pure module.
- **Create** `packages/cli/src/security/dom-id-harvester.test.ts`.
- **Modify** `packages/cli/src/phases/execute.ts` — wire `harvestIdsFromDom` into `executeUiTestInner`.
- **Modify** `packages/cli/src/phases/cross-user.ts` — add anonymous-only catalog sweep when `discoveredIds.size === 0`; relax catalog gate for `__ui_*` synthetic toolIds.
- **Modify** `packages/cli/src/phases/cross-user.test.ts` — extend per § 2.4.

**Do not** introduce a new HTTP client; reuse `surface`. **Do not** change the `DiscoveredIds` Map shape (still `role → toolId:field → Set<value>`); the new `path` is for logging/display, attached to the BugDetection.idorContext only.

### 2.6 Acceptance

- TraiderJo run produces `state.json.discoveredIds` with at least one entry harvested from the DOM walk.
- All new unit tests pass.
- The anonymous-only sweep test passes.
- On a project with API tools that return JSON with `data.id` / `user_id` shapes, the cross-user phase reports `>= 1 replay attempted`.
- `npm run lint && npm run typecheck && npm test` clean.

### 2.7 Risk

Medium. DOM parsing inside `executeUiTest` is on the hot path for every UI test. The harvester must be **pure**, **fast** (< 5ms on a 50KB snapshot — measure with a benchmark assertion in the test), and **must not throw on malformed HTML** (wrap in try/catch; on error, return `[]` and log at `debug`).

The anonymous-replay sweep can hit production endpoints. **Skip it whenever `config.resetPolicy === undefined`**: without a reset policy we have no safety net. Log `cross-user: anonymous sweep skipped (no resetPolicy)` and continue.

### 2.8 Open questions

None. Implement as specified.

---

## 3. Gap 3 — `cluster: testId present but stateByTestId lookup missed` × 4

### 3.1 Problem

Smoke run logged this warning four times. The cluster materialization in `cluster.ts:127-129` flags it:

```ts
if (occ.testId !== undefined && occ.testId !== '' && captured === undefined) {
  log.warn('cluster: testId present but stateByTestId lookup missed', { testId: occ.testId, occurrenceId: occ.occurrenceId });
}
```

### 3.2 Root cause

`stateByTestId` is built in `run.ts:252-257` from **only `results`** (the executor's output), not from `baselineResults` or `staticResults`:

```ts
const stateByTestId = new Map<string, { preState: PreState; postState: PostState }>(
  results
    .filter(r => r.postState !== undefined)
    .map(r => [r.testId, { preState: r.preState!, postState: r.postState! }])
);
```

`baselineResults` and `staticResults` are synthesised from detections and never populate `preState`/`postState` on their `TestResult` (see `synthesiseFakeDetectionCases` at `run.ts:355-389` — it sets `preState` and `postState` to undefined).

When the cluster phase iterates these synthetic TestCases through `upgradeToFull`, `captured` is `undefined`, and the warning fires. The cluster output is fine — the fallback `PostState` is built — but the warning is noisy and signals a contract violation.

### 3.3 Fix design

Two options:

**Option A — pre-populate stateByTestId from synthetic results too.** Change the map construction to include `baselineResults` and `staticResults` with empty-but-defined states.

**Option B — relax the warning in cluster.ts when the role is `'system'`.** Synthesised static / baseline detections always have `role: 'system'` (header probe + static analysis) or `role: 'anonymous'` (visual baseline). For these, missing `stateByTestId` is expected, not an error.

**Choose Option B.** It's localised to one file and one branch. It preserves the warning for *real* missing state on UI/API tests, where the warning is actionable.

Concretely, modify `packages/cli/src/phases/cluster.ts:122-139` (`upgradeToFull`):

```ts
const isSyntheticOccurrence = occ.role === 'system' || occ.role === 'anonymous';
const captured = (occ.testId !== undefined && occ.testId !== '') ? stateByTestId?.get(occ.testId) : undefined;
if (occ.testId !== undefined && occ.testId !== '' && captured === undefined && !isSyntheticOccurrence) {
  log.warn('cluster: testId present but stateByTestId lookup missed', { testId: occ.testId, occurrenceId: occ.occurrenceId, role: occ.role });
}
```

Document the carve-out: synthetic occurrences (header probe, static analysis, visual baseline, cross-user replay) intentionally lack pre/post states because they are not interactive tests. The warning gates UI/API test plumbing only.

### 3.4 Test plan

**Unit (`packages/cli/src/phases/cluster.test.ts`):**
- Add a test where a `BugCluster` with `role: 'system'` is materialized with `stateByTestId === undefined`. Assert no `log.warn` is called. (Use `vi.spyOn(log, 'warn')`.)
- Existing tests for UI tests with missing state continue to fire the warning.

### 3.5 Files to touch

- **Modify** `packages/cli/src/phases/cluster.ts` — guarded warning per § 3.3.
- **Modify** `packages/cli/src/phases/cluster.test.ts` — add carve-out test.

### 3.6 Acceptance

- TraiderJo run shows zero `cluster: testId present but stateByTestId lookup missed` warnings (assuming no genuine UI gaps).
- Cluster test for the carve-out passes.
- Existing cluster tests still pass.

### 3.7 Risk

Negligible. Single-file, single-branch change.

---

## 4. Negative requirements

Across all three tasks:

- **No new emoji.** Anywhere.
- **No `as any`.** Use `unknown` and narrow.
- **No new HTTP client.** Reuse `HttpSurfaceMcpAdapter` via the `SurfaceMcpAdapter` interface.
- **No new schema files.** Extend `types.ts`.
- **No new logger.** Use `packages/cli/src/log.ts`.
- **No `console.log`.**
- **No silent `catch (e) {}`.** Every catch logs at `debug` minimum and either continues with a documented default or rethrows with context.
- **No new dependencies.** The DOM harvester uses regex-based parsing on the snapshot string. Do not pull in `cheerio`, `jsdom`, or any HTML parser — the snapshots are already constrained to <50KB by the snapshot tool.
- **No retroactive changes to `BugDetection.idorContext`.** Add `harvestPath?: string` if needed; do not rename the existing fields.
- **Functions max 40 lines.** If a fix exceeds it (Fix 2 of Gap 1's `runHeaderProbes` rewrite is the riskiest one), extract sub-functions: `buildAbsoluteUrl`, `dedupeRoutesPerOrigin`, `probeAndAnalyze`.
- **Files max 300 lines.** `execute.ts` is currently 644 lines and needs decomposition anyway, but **do not** decompose it in this PR — that is a refactor, not a fix. Extract only `runHeaderProbes` and its helpers into a new file `packages/cli/src/phases/header-probe-runner.ts` if and only if the rewrite pushes execute.ts past 700 lines. Otherwise leave it.

---

## 5. Task breakdown

### Task G1 — Header probe observability + resilience

**Assignee:** @coder · **Depends on:** none · **Branch:** `feat/v05-pr-b-gaps` (single PR for all three tasks)

**Files to modify:** `types.ts`, `cli/run.ts`, `phases/execute.ts`, `security/header-probe.test.ts`
**Files to create:** `phases/execute-header-probe.test.ts`

**Test:** `npx vitest run packages/cli/src/phases/execute-header-probe.test.ts packages/cli/src/security/header-probe.test.ts`

**Done when:** Acceptance § 1.6 satisfied. PR description quotes the new `header-probe: complete` log line from a manual TraiderJo run.

**DO NOT:** add a new logger; introduce retry helper outside the existing pattern; change `analyzeProbeResult` semantics.

### Task G2 — IDOR id extraction + DOM harvest + anonymous fallback

**Assignee:** @coder · **Depends on:** G1 (so the PR doesn't churn on the same files twice)

**Files to modify:** `security/resource-id-extractor.ts`, `security/resource-id-extractor.test.ts`, `phases/execute.ts`, `phases/cross-user.ts`, `phases/cross-user.test.ts`
**Files to create:** `security/dom-id-harvester.ts`, `security/dom-id-harvester.test.ts`

**Test:** `npx vitest run packages/cli/src/security packages/cli/src/phases/cross-user.test.ts`

**Done when:** Acceptance § 2.6 satisfied. PR description quotes the new `discoveredIds` content from a TraiderJo run state.

**DO NOT:** change the `DiscoveredIds` map shape; introduce an HTML parser dependency; pre-cache DOM harvest results across tests (it must be pure per-call).

### Task G3 — `stateByTestId` warning carve-out

**Assignee:** @coder · **Depends on:** none (can land in parallel; trivial)

**Files to modify:** `phases/cluster.ts`, `phases/cluster.test.ts`

**Test:** `npx vitest run packages/cli/src/phases/cluster.test.ts`

**Done when:** Acceptance § 3.6 satisfied.

**DO NOT:** rewrite the cluster phase; touch `runCluster`'s signature.

---

## 6. Done-when matrix

| Gap | Fixed when | Verifier |
|---|---|---|
| G1 | TraiderJo run emits `missing_csp_header` cluster with `inline_scripts_allowed` AND log contains `header-probe: complete`. | @qa runs `bughunter run -p /tmp/TraiderJo` and greps summary + log. |
| G2 | TraiderJo state.json.discoveredIds non-empty AND cross-user phase reports `>= 1 attempted replay` on a project with API tools. | @qa runs TraiderJo + a second project with seeded API tools. |
| G3 | Zero `stateByTestId lookup missed` warnings on a TraiderJo run. | @qa greps log file. |

---

## 7. Predicted output on TraiderJo after this PR lands

`summary.json.byKind`:
- `missing_csp_header`: 1 (from CSP `script-src 'unsafe-inline'`)
- `vulnerable_dependency_high`: 1 (lodash; unchanged)
- `hardcoded_credentials_in_source`: 3 (Mailgun keys; unchanged)
- `missing_state_change`: 4 (unchanged)
- **Total**: 9 clusters (was 8)

`state.json.discoveredIds`: non-empty, populated from DOM walk (`__ui_dom__` synthetic toolId).

Cross-user matrix: still 0 detections on TraiderJo (no API tools in the surface), but the phase log line should now read `cross-user: 0 replays → 0 detections` instead of `no discoveredIds available`. That tells us the matrix ran and chose to skip — the difference between "untested" and "no targets," which is the whole point.

---

## 8. Open questions

None. Three concrete defects with concrete fixes; coder ships.
