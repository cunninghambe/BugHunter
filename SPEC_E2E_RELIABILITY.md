# SPEC: E2E Reliability — un-skip 3 tests + fixture .gitignore

**Status:** ready for implementation
**Owner:** @architect
**Implementer:** split between @coder (BugHunter, SurfaceMCP fixture) and @qa (verification)
**Branches:**
- `BugHunter#spec/e2e-reliability` — this spec, plus the fixes in `packages/cli/`
- `SurfaceMCP#spec/e2e-reliability` — fixture additions, `.gitignore`

---

## Background

The BugHunter cross-repo e2e harness at `packages/cli/tests/e2e/bughunter-e2e.test.ts` runs five vitest cases (`Test Files 1 passed (1) / Tests 5 passed (5)`), but three of those five take the early-return / skip path inside the test body. They report as passing while doing nothing. Live baseline (`/tmp/e2e-baseline.log`):

```
[info] No 404_for_linked_route in API-only run — relatedClusterIds check skipped
[skip] No UI clusters produced in browser run (camofox instability) — Gap 1.B unit test in cluster.test.ts provides the regression gate
[skip] journal-entries endpoint did not stabilise (last: 500 <!DOCTYPE html><html><head>...) — fixture unstable, suppression test skipped
```

The bar from the user: "expansive and solid; no more skipped tests after this lands." Each skip has a distinct, observable root cause; the three are unrelated despite the surface similarity.

Camofox-mcp is up at `http://127.0.0.1:3104` (`pm2 list` shows `camofox-mcp-http` and `camofox-browser` online; `/health` returns `{"ok":true,"camofoxReachable":true}`). Camofox availability is not the blocker.

---

## 1. Problem statements (observed, not speculated)

### 1.1 Skip 1 — `relatedClusterIds` check

The test at `packages/cli/tests/e2e/bughunter-e2e.test.ts:151-166` looks for two clusters in the same API-only run — one of kind `404_for_linked_route` and one of kind `surface_call_failed` — then asserts they are mutually linked through `relatedClusterIds`. In the freshly-merged main branch, the API-only run produces only **one** cluster matching the conditional-404 fixture: `surface_call_failed` (`kind=surface_call_failed toolId=72b4a00bd716 page=/api/conditional-404`). No `404_for_linked_route` cluster is produced, so the test takes the `if (!cluster404 || !clusterFailed) { ... return; }` branch and silently passes.

### 1.2 Skip 2 — browser `mutationObserverWindowMs > 0`

The test at `packages/cli/tests/e2e/bughunter-e2e.test.ts:170-221` asserts that at least one cluster's `OccurrenceFull.postState.mutationObserverWindowMs` is `> 0`. The selector for "qualifying occurrence" is `o.action.via === 'ui'`. After running BugHunter with `browserMcpUrl` set, no cluster contains a `via: 'ui'` occurrence, so the test takes the `[skip] No UI clusters produced` branch.

The diagnostic gold: `state.json` from the browser run (`/tmp/bh-e2e-fixture-y5GdtQ/.bughunter/runs/vk2x099ysa0t62mbto4zv94v/state.json`) shows nine UI test cases planned. Eight ran and produced `mutationObserverWindowMs` between 2 and 12 ms with **zero bugs**. The single click test (`kind=click sel=[data-testid="toggle"]`) failed with infrastructure failure:

```
kind=generic
detail=Error: Browser action failed: BrowserMcpError: Snapshot parsed 0 elements; tab may have crashed
```

### 1.3 Skip 3 — `bodyFixtures` suppression

The test at `packages/cli/tests/e2e/bughunter-e2e.test.ts:225-318` polls `POST {appBaseUrl}/api/journal-entries` with body `{"memo":"seeded","amount":42}` and expects HTTP 201 within 20 s. After Test 2 (browser) finishes, the probe receives a Next.js 500 error page. The HTML payload contains the actual error:

```
Module build failed: Server Actions must be async functions.
,-[/tmp/.../app/admin/users/page.tsx:10:1]
10 | export default function AdminUsersPage() { ... }
```

### 1.4 Cleanup 4 — untracked fixture artefacts

`SurfaceMCP/fixtures/nextjs-app/` contains nine untracked entries after a normal e2e run:
```
.bughunter/  .env.example  .gitignore  .next/  ecosystem.config.cjs
next-env.d.ts  package-lock.json  surfacemcp.config.json  tsconfig.json
```

Some are part of the fixture (need to be tracked); others are runtime artefacts (need to be ignored). No `.gitignore` exists at `fixtures/nextjs-app/` in the committed tree (the file in the working dir is itself untracked).

---

## 2. Root cause (with citations)

### 2.1 Skip 1 — root cause

Two pipeline stages compose into the visible behaviour.

**(a) Plan generates a single test case for `unknown` schema confidence.** `packages/cli/src/mutation/apply.ts:46-65` short-circuits `apiTestCases` when `tool.inputSchemaConfidence === 'unknown' || 'partial'` and emits exactly one `palette: 'happy'` test. The conditional-404 fixture (`SurfaceMCP/fixtures/nextjs-app/app/api/conditional-404/route.ts`) does manual validation with no Zod schema, so SurfaceMCP labels it `unknown`. One test case → one detection set per test → one chance for the priority filter.

**(b) Priority filter collapses 404_for_linked_route into surface_call_failed.** Inside `packages/cli/src/phases/execute.ts:executeApiTest` (lines 358-387), when conditional-404 returns 404, the test produces *two* detections in the same `bugs[]` array:

1. `surface_call_failed` (line 368) because `palette === 'happy' && status === 404`.
2. `404_for_linked_route` (line 386 → `classifyNetworkRequests`, network.ts line 41) because `req.status === 404`.

`classify.ts:applyPriorityFilter` (lines 33-43) keeps only the highest-priority detection per test result. The `KIND_PRIORITY` array places `surface_call_failed` at index 3 and `404_for_linked_route` at index 5. The 404 detection becomes a `secondaryObservations` entry, not a separate cluster.

**Net effect:** a single API test against a `unknown`-schema 404-returning route can never produce two clusters that can be linked. `annotateRelatedClusters` (`phases/cluster.ts:146-172`) is correct and runs unconditionally; there is simply nothing to link.

For older runs that produced both clusters (e.g. `qtp1ooxb7n4o7ju1hg942k1a`, prior fixture iteration with toolId `997c1db5bd0b`), the route had a Zod schema and four palette tests. Three non-happy-palette tests fired *only* `404_for_linked_route` (palette ≠ happy → no `surface_call_failed`), creating a separate cluster. That historical fixture was removed.

The dom-walker UI path also cannot produce `404_for_linked_route` independently because `executeUiTest` (`phases/execute.ts:202`) initialises `postNetworkRequests: NetworkRequest[] = []` and never assigns to it — there is no browser-side network capture wired into camofox.

### 2.2 Skip 2 — root cause

Single shared `currentTabId` across concurrent UI tests. `packages/cli/src/cli/run.ts:50` instantiates exactly one `CamofoxBrowserMcpAdapter` per BugHunter process. `phases/execute.ts:142-145` runs the UI queue at `concurrency: 4` (default in `config.ts:25`). The adapter holds `private currentTabId?: string` (`adapters/browser-mcp.ts:76`) and mutates it on every `navigate()` call (line 193). With four concurrent UI test cases:

- Test A calls `navigate(/dom-test)` → camofox creates tab T → `currentTabId = T`.
- Test B (running in parallel) calls `navigate(/journal)` → adapter sees `currentTabId=T`, sends `{ tabId: T, url: /journal }` → tab T navigates away from `/dom-test`.
- Test A then calls `click([data-testid="toggle"])` → `requireTab` returns `T` → `resolveRef` snapshots tab `T` (now showing `/journal` or in-flight) → `parseSnapshot` returns `[]` → throws `BrowserMcpError('snapshot_failed', 'Snapshot parsed 0 elements; tab may have crashed')`.

Captured in the harness as `BrowserMcpError` of kind `snapshot_failed`, which does not match the `transport`/`timeout` infra-failure branch in `executeUiTest` (lines 251-269), so it falls through to the `throw new Error(...)` rethrow at line 271 and is caught by the outer `runTest` error handler as a generic infrastructure failure (`infrastructure.jsonl` records `kind=generic` for it).

A secondary aggravator: camofox tabs persist across BugHunter processes. Right now (without any test running) `list_tabs` reports a tab still pointed at `http://127.0.0.1:35189/api/missing-route-target` from a long-dead Next.js dev server. The session is keyed on `userId='claude'` × `sessionKey='default'`, both of which BugHunter and the e2e harness inherit from environment defaults. Tab leakage compounds memory pressure but is **not** the immediate snapshot-emptiness cause — the immediate cause is in-process tabId aliasing under concurrency.

The dom-test page itself is fine. The MutationObserver IIFE works (other tests show `mutMs` of 9-12 ms). React hydration timing is not the issue.

### 2.3 Skip 3 — root cause

`SurfaceMCP/fixtures/nextjs-app/app/admin/users/page.tsx` violates Next.js 15's Server Actions module rules. Line 1 is `'use server';` (file-level directive), which marks the entire module as a Server Actions module. Next.js then requires every export from such a file to be an async function. Line 10 exports `function AdminUsersPage()` — non-async. The compiler raises `ModuleBuildError: Server Actions must be async functions.` and the dev server marks the build as failed.

Once the build is poisoned, the dev server returns a 500 HTML error page (`/_error` with `statusCode: 500` and the full stack trace embedded in `__NEXT_DATA__`) for **all** requests, not just for `/admin/users` — this is webpack-level breakage. Test 1 (API-only) never visits a UI route so the `app/admin/users/page.tsx` module is never compiled and the dev server never enters the broken state. Test 2 (browser) walks every discovered page, including `/admin/users`, which triggers the compile. After Test 2, every subsequent request — including the bodyFixtures probe in Test 3 — receives the error fallback. Hence the observed `last: 500 <!DOCTYPE html>...` payload.

Reproduced this exactly in `/tmp/jsonfix-test/`: with the file-level `'use server'` removed (only the inner function-level `'use server';` retained), the post-browser-run probe returns `{"ok":true}` HTTP 201.

### 2.4 Cleanup 4 — root cause

The fixture acquired runtime files from local development and from running the e2e harness against the source tree (the harness copies the fixture to a temp dir, but earlier interactive runs emitted artefacts in place). No fixture-scoped `.gitignore` was committed.

---

## 3. Fix design

### 3.1 Skip 1 — add a Zod-validated 404 fixture route

Goal: two clusters with the same `toolId` and different kinds.

**Add**: `SurfaceMCP/fixtures/nextjs-app/app/api/always-404/route.ts`. POST endpoint with a Zod schema (so SurfaceMCP marks it `introspected`, plan generates four palette tests) that always returns HTTP 404:

```ts
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

const schema = z.object({
  payload: z.string().min(1).max(50),
  count: z.number().int().min(0).max(100),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  schema.parse(body); // valid input still 404s
  return NextResponse.json({ error: 'always 404 by design' }, { status: 404 });
}
```

**Why this works:**
- Confidence `introspected` → `apiTestCases` enters the four-palette branch (`apply.ts:67-83`).
- All four palettes hit a 404. Non-happy palettes (`null`, `edge`, `out_of_bounds`) have `expectedOutcome='expected_failure'` → no `surface_call_failed` (gated by `palette==='happy'` in `execute.ts:358`). They produce only `404_for_linked_route` → cluster A.
- Happy palette produces `surface_call_failed` + `404_for_linked_route`; priority filter keeps `surface_call_failed` → cluster B.
- Both clusters share `toolId = sha1('POST:/api/always-404').slice(0,12)` on `occurrences[0].action.toolId`. `routeKeyOf` (`phases/cluster.ts:180-190`) returns `tool:<id>` for both → `annotateRelatedClusters` links them mutually.

**Update the e2e assertion** (`bughunter-e2e.test.ts:151-166`): keep the search for `404_for_linked_route` and `surface_call_failed`, but require both to exist (no early return). Acceptable change: replace the optional skip with a hard assertion; if either is missing, fail with a diagnostic listing the kinds present and the toolIds seen.

**Negative requirement:** do NOT touch the priority filter, do NOT add a separate UI-side network capture, do NOT modify `conditional-404` (it remains a useful API-only `unknown`-confidence fixture for other regression coverage).

### 3.2 Skip 2 — per-test tab isolation

Goal: each UI test runs against its own tab, so concurrent tests cannot collide on `currentTabId`.

**Chosen option: (c) per-test scoped adapter** with explicit tab lifecycle.

The minimal viable design is a small refactor of the adapter:

1. **Add `BrowserMcpAdapter.openTab(url, extraHeaders?): Promise<{ tabId: string; finalUrl: string; title?: string }>`** — creates a new tab unconditionally (no tabId aliasing), returns the tabId. Does NOT mutate `currentTabId`.
2. **Add `closeTabExplicit(tabId): Promise<void>`** — wraps `close_tab` for a specific id, no shared-state mutation.
3. **Add `withTab<T>(url, extraHeaders, fn: (scope: TabScope) => Promise<T>): Promise<T>`** — convenience: open, run fn with a `TabScope` whose methods (`click`, `type`, `evaluate`, `snapshot`, `screenshot`, `scroll`, `navigate`) all carry the bound tabId, finally close. The `TabScope` type is a non-shared per-call object — its mutability does not leak across tests.

4. **Refactor `executeUiTest`** to use `browser.withTab(pageUrl, headers, async scope => { ... })`. All current `browser.navigate / click / evaluate / snapshot` calls inside become `scope.navigate / scope.click / ...`.

5. **Keep `currentTabId`-based methods** as legacy-compat for `dom-walker.ts` and `replay.ts` (which are single-threaded callers and do not race). Add a brief deprecation note in adapter.ts.

6. **Startup hygiene**: at the start of each BugHunter run, when `browserMcpUrl` is set, the adapter calls `listTabs()` and sequentially `closeTab(t.id)` for every existing tab. This clears leakage from prior processes and prevents long-term tab accumulation in the camofox session.

**Why (c) over (a)/(b)/(d):**
- (a) `closeAllTabs in afterEach` doesn't help — the test's UI work is over by the time afterEach runs; the race is *inside* the test, not between tests.
- (b) per-suite fresh camofox-mcp daemon is heavy (camofox is shared infra; restarting it impacts other tools) and doesn't fix the in-process aliasing.
- (d) a shared currentTabId with serialised concurrency (`concurrency=1` for UI) works but kills future UI throughput. The fix above keeps `concurrency=4` capable.

**Why not just hold the lock around the existing adapter:** the adapter currently has methods like `click(selector)` that internally take a snapshot then click. The lock would have to span the entire UI test, defeating concurrency. Per-tab scoping is the clean abstraction.

**Fixture confirmation:** the dom-test toggle button click currently produces a *false-positive* `missing_state_change` detection (because `classifyMissingStateChange` does not look at MutationObserver mutations to confirm change). That's fine for the e2e — `missing_state_change` is a UI cluster, has `via: 'ui'` occurrences, and carries `mutationObserverWindowMs > 0`. The assertion is satisfied.

### 3.3 Skip 3 — fix the broken Server Actions fixture

Goal: the Next.js dev server stays compilable across the entire e2e run.

**Edit** `SurfaceMCP/fixtures/nextjs-app/app/admin/users/page.tsx`: remove the file-level `'use server';` directive on line 1. Keep the function-level `'use server';` inside `createUser` (which is the canonical Next.js 15 form). The file becomes:

```tsx
async function createUser(formData: FormData) {
  'use server';
  const name = formData.get('name');
  const email = formData.get('email');
  console.log({ name, email });
}

export default function AdminUsersPage() {
  return (
    <form action={createUser}>
      <input name="name" type="text" />
      <input name="email" type="email" />
      <button type="submit">Create</button>
    </form>
  );
}
```

**Why this works:** `'use server'` at function scope marks the function as a Server Action, which is permitted alongside synchronous default exports. Verified by reproduction in `/tmp/jsonfix-test/` (after the edit, `POST /api/journal-entries {memo:'seeded',amount:42}` returns 201 even after the browser walks `/admin/users`).

**Negative requirement:** do NOT introduce `next start` (option b in the prompt) — slower iteration, masks future Next.js dev incompatibilities. Do NOT add a state-reset endpoint (option c) — overkill for a static-file compile bug. Do NOT restart the Next.js dev server between tests (option a) — adds 8-10 s to harness wall time and treats the symptom, not the cause.

**Rejected alternative considered:** changing the dev server to `next start`. Building once and serving with `next start` would also avoid the dev-time compilation, but it eliminates a class of regressions the harness should detect (dev-mode-only warnings, hot-reload artefacts, lazy compile errors). Keep `next dev`; keep the fixture syntactically valid.

### 3.4 Cleanup 4 — fixture .gitignore + tracked baseline files

**Track** (commit to `SurfaceMCP/fixtures/nextjs-app/`):
- `tsconfig.json` — required by Next.js 15 dev. Without it, the fixture autoinstalls TypeScript on first dev start (8-10 s delay; transient infra-failure window in the harness).
- `next-env.d.ts` — auto-generated TS reference; convention is to track it.
- `package-lock.json` — pins fixture deps for deterministic harness runs.
- `.gitignore` — fixture-scoped ignore (see below).
- `surfacemcp.config.json` — working baseline so the fixture is runnable standalone (e.g. `surfacemcp serve` from the dir during dev). The e2e harness calls `writeSurfaceMcpConfig` against the temp copy; the source baseline is untouched.

**Ignore** (add to `SurfaceMCP/fixtures/nextjs-app/.gitignore`):
```
# Build / runtime artefacts
.next/
node_modules/

# BugHunter run artefacts
.bughunter/

# pm2 ecosystem (user-specific paths to /root/SurfaceMCP/dist/...)
ecosystem.config.cjs

# Local env overrides
.env
.env.local
.env.example

# OS / editor noise
.DS_Store
*.log
```

**Rationale per file:**
- `.bughunter/` — contains `runs/<runId>/screenshots/*.png`, `dom/*.html`, etc. Up to 4 GB per run by config default. Never track.
- `.next/` — Webpack build cache. Regenerated by Next.js on every change.
- `ecosystem.config.cjs` — generated by `surfacemcp init` with absolute `/root/SurfaceMCP/dist/cli/main.js`. User-scoped.
- `.env.example` — produced by `surfacemcp init` with role placeholders. The repo root has the canonical example. Ignore the fixture-scoped one.

The root `SurfaceMCP/.gitignore` already has `node_modules/`, `dist/`, `data/`, `*.log`, `.env`, `.env.local`, `.surfacemcp/`. The fixture-scoped `.gitignore` adds the fixture-local entries (especially `.bughunter/`, `.next/`, `ecosystem.config.cjs`, `.env.example`).

---

## 4. Boundaries

**In scope:**
- New fixture route `app/api/always-404/route.ts` (SurfaceMCP repo).
- Edit of `app/admin/users/page.tsx` to remove file-level `'use server'` (SurfaceMCP repo).
- New `fixtures/nextjs-app/.gitignore` and tracking of `tsconfig.json`, `next-env.d.ts`, `package-lock.json`, `surfacemcp.config.json` (SurfaceMCP repo).
- Adapter additions: `openTab`, `closeTabExplicit`, `withTab`, `TabScope` (BugHunter repo).
- `executeUiTest` refactor to use `withTab` (BugHunter repo).
- Startup tab cleanup in BugHunter `cli/run.ts` when `browserMcpUrl` is configured (BugHunter repo).
- E2E harness assertion changes: drop the three "skip-and-pass" branches; assert positively (BugHunter repo).
- Unit tests for the new adapter methods and refactored executeUiTest (BugHunter repo).

**Out of scope:**
- Browser network-request capture (keeping `postNetworkRequests` empty; UI 4xx detection remains API-side).
- Priority filter changes — `surface_call_failed` continues to subsume `404_for_linked_route` for the same test result.
- Camofox-mcp daemon changes (no protocol modifications).
- Anything in `replay.ts` or `dom-walker.ts` beyond what's needed for compatibility (they continue to use the legacy single-tab API).
- Server Actions semantics — only the one fixture file is corrected.
- Concurrency tuning beyond what's needed to validate the new isolation works (default `concurrency: 4` stays).
- New tracked ecosystem/env files — `ecosystem.config.cjs` and `.env.example` stay generated-and-ignored.

---

## 5. Acceptance criteria

A successful implementation produces, on a fresh checkout with both branches merged:

```bash
cd /root/BugHunter
git checkout main && git pull
NODE_ENV=development npm install --legacy-peer-deps
npm --workspace packages/cli run build
NODE_ENV=development npm --workspace packages/cli run test:e2e
```

Output (exact pattern; no `[skip]` or `[info] ... skipped` lines anywhere in test stdout):

```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Per-test acceptance:

- **Test 1.1** `completes a full run and produces a summary with tests planned` — unchanged.
- **Test 1.2** `conditional-404 route triggers surface_call_failed cluster` — unchanged.
- **Test 1.3** `relatedClusterIds links 404_for_linked_route ↔ surface_call_failed (Gap 1.A)` — must find both clusters (using the new always-404 fixture or conditional-404 + always-404, whichever satisfies) and assert `relatedClusterIds` is mutually populated. No early return path.
- **Test 2.1** `dom-test click produces mutationObserverWindowMs > 0 (Gap 1.B)` — must find a cluster with `via: 'ui'` occurrences and `postState.mutationObserverWindowMs > 0`. No early return path. Camofox availability check stays at the suite boundary (whole-suite skip if `/health` is unreachable; the user explicitly noted camofox is up).
- **Test 3.1** `network_5xx cluster from journal-entries disappears when bodyFixtures seeds memo` — the journal-entries probe must return 201 within 5 s of harness post-Test-2 state. Suppression assertion runs and passes. No early return path.

Cleanup acceptance:

- After running the e2e harness from a clean `git status`, `git status` in `SurfaceMCP/` shows no untracked files under `fixtures/nextjs-app/` (only the source-tree files exist; `.bughunter/`, `.next/`, etc. are ignored).
- `git status` in `BugHunter/` shows nothing untracked.

Verification gates per the user's global CLAUDE.md:

```bash
# BugHunter
cd /root/BugHunter
npm run typecheck
npx eslint packages/*/src --max-warnings 0
npm --workspace packages/cli run test
npm --workspace packages/cli run test:e2e

# SurfaceMCP
cd /root/SurfaceMCP
npx tsc --noEmit
npm run test
```

All green, zero warnings.

---

## 6. Files to touch (cross-repo)

### BugHunter (`/root/BugHunter`)

| Path | Change kind | Reason |
| --- | --- | --- |
| `packages/cli/src/adapters/browser-mcp.ts` | edit | Add `openTab`, `closeTabExplicit`, `withTab`, `TabScope`. Keep existing single-tab methods. ~80 LOC added. |
| `packages/cli/src/adapters/browser-mcp.types.ts` *(new, optional)* | new | If type definitions for `TabScope` start exceeding 30 lines, split out. Otherwise inline in `browser-mcp.ts`. |
| `packages/cli/src/phases/execute.ts` | edit | `executeUiTest` switched to `browser.withTab(...)`. ~40 LOC of diff. |
| `packages/cli/src/cli/run.ts` | edit | After validate, when `browser` exists, call `await closeAllExistingTabs(browser)` (new helper) to clear stale session tabs. ~10 LOC. |
| `packages/cli/tests/e2e/bughunter-e2e.test.ts` | edit | Drop the three early-return / skip branches. Tighten assertions per acceptance criteria. The `browserAvailable` whole-suite check at `beforeAll` remains — that's the only legitimate environment-not-present skip. |
| `packages/cli/tests/adapters/browser-mcp-tab-scope.test.ts` *(new)* | new | Unit test the new `withTab` lifecycle: open creates tab, scope methods carry tabId, close fires on success and on throw. |

### SurfaceMCP (`/root/SurfaceMCP`)

| Path | Change kind | Reason |
| --- | --- | --- |
| `fixtures/nextjs-app/app/api/always-404/route.ts` | new | Skip 1 — Zod-schema route returning 404. ~12 LOC. |
| `fixtures/nextjs-app/app/admin/users/page.tsx` | edit | Skip 3 — drop file-level `'use server'`. 1-line change. |
| `fixtures/nextjs-app/.gitignore` | new (track) | Fixture-scoped ignore (see §3.4). |
| `fixtures/nextjs-app/tsconfig.json` | new (track) | Track existing local file. |
| `fixtures/nextjs-app/next-env.d.ts` | new (track) | Track existing local file. |
| `fixtures/nextjs-app/package-lock.json` | new (track) | Track existing local file. |
| `fixtures/nextjs-app/surfacemcp.config.json` | new (track) | Track existing local file. |

No code in `SurfaceMCP/src/` changes.

---

## 7. Risk and sequencing

Independence and risk per work item:

| Item | Independent? | Risk |
| --- | --- | --- |
| Cleanup 4 (fixture .gitignore + tracked files) | Yes — no other item depends on it. | Lowest. Pure repo hygiene. |
| Skip 3 (Server Actions fixture fix) | Yes. | Lowest. One-line edit, reproduced fix. |
| Skip 1 (always-404 fixture + harness assertion) | Yes — does not require Skip 2's adapter work. | Low. New file, well-understood pipeline. |
| Skip 2 (tab isolation) | Yes — does not depend on Skip 1 or Skip 3, though all three need to be fixed before the e2e suite passes cleanly. | Medium. Touches the adapter's public surface and `executeUiTest`. Need adapter unit tests for the new lifecycle. |

**Recommended landing order:**
1. Cleanup 4 — simplest. Verifies tooling.
2. Skip 3 — single-line fixture fix unblocks Test 3 and removes a noise source while debugging Skip 2.
3. Skip 1 — additive (new fixture, harness assertion change). No code-path changes in BugHunter.
4. Skip 2 — adapter refactor. Land last because it is the largest and most complex; once it lands, all five e2e tests should pass.

Each item should land as a separate commit on the `spec/e2e-reliability` branch in its respective repo. Cross-repo PR coordination: the SurfaceMCP fixture changes (Skip 1 + Skip 3 + Cleanup 4) merge first; then the BugHunter changes (Skip 2 + harness assertion changes) merge against the updated fixture.

**Failure modes to watch:**
- After Skip 2 lands, if `concurrency=4` UI tests start producing a flood of `missing_state_change` clusters (because every page render with no toast/url-change/network/console-error trips the classifier), the harness assertion in Test 2 still passes (it only needs one such cluster), but cluster volume could mask future regressions. Note for future spec: the classifier should consult `mutWindowMs > 0 && mutationCount > 0` before declaring missing state change.
- Camofox session-level rate limits or browser-context limits on tab creation. If creating a tab per UI test (~9 tabs per browser run, ~40+ tabs across a full suite) trips a limit, the new startup cleanup (`closeAllExistingTabs`) should keep the working set small. If it still trips: the spec for that escalation is not in this document.

---

## 8. Open questions

None that block implementation. All technical decisions above are made with citations and reproductions. The only judgement call worth flagging:

- **`.env.example`**: ignored per §3.4 because the repo root has a canonical example and the fixture-scoped one duplicates it. If the team prefers fixture-scoped examples to live next to the fixture for discoverability, flip to "track" — but then the `surfacemcp init` flow must stop overwriting it on each invocation. Default decision: ignore.

Everything else is determined.
