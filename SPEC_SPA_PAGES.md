# SPEC: BugHunter v0.2 — SPA Page Discovery via `surface_list_pages`

Status: draft, ready for implementation
Owner: @architect
Target version: BugHunter v0.2.0
Companion spec: `/root/SurfaceMCP/SPEC_VITE_DISCOVERY.md`

---

## 1. Problem

A live BugHunter smoke run against `/tmp/TraiderJo` (Express server + Vite/React SPA frontend, owner+anon roles) discovered 252 API tools and planned **952 API tests / 0 UI tests**. Zero UI tests because `discoverFilesystemPages` (in `packages/cli/src/discovery/filesystem-pages.ts`) is hard-wired to Next.js: it walks `app/**/page.tsx` and `pages/**/!(api)/*.tsx`. A Vite SPA has no filesystem-routed pages — its routes live in JSX/code.

Companion `SurfaceMCP` v0.2 adds:
- A new MCP tool `surface_list_pages` returning extracted SPA page meta.
- A new MCP tool `surface_describe_self` returning the stack and capabilities.

This spec wires BugHunter to consume them: the discovery phase becomes stack-aware so SPA stacks (currently only `'vite'`, plus future `'tanstack-router'`, `'vue'`) populate pages from SurfaceMCP, while Next.js continues to use the existing filesystem walk **without regression**.

### 1.1 Non-goal: TraiderJo is not a v0.2 SPA target

TraiderJo uses tab-state routing (no `react-router-dom`); its v0.2 outcome remains 0 UI tests. The fixture-driven gate (§ 6) proves v0.2 works for SPAs that DO use a supported router. TraiderJo's tab-state pattern is a v0.3 problem (see `/root/SurfaceMCP/SPEC_VITE_DISCOVERY.md` § 8.5).

---

## 2. Pattern catalog (BugHunter side — what BugHunter receives)

BugHunter's role is plumbing, not extraction. It consumes whatever SurfaceMCP returns. The contract is:

```ts
type Page = {
  route: string;             // "/", "/admin/users", "/users/:id"
  sourceFile: string;        // project-root-relative; "<unresolved>" if unknown
  componentName?: string;    // "Home", "AdminLayout", "UserDetail"
  lazy: boolean;
  dynamicParams: string[];   // ["id"], ["postId","commentId"], ["*"]
  declaredAt: { file: string; line: number };
};
```

This is the same shape SurfaceMCP returns from `surface_list_pages`. BugHunter's `DiscoveredPage` (in `packages/cli/src/types.ts` line 236) extends with DOM-walk fields (`elements`, `forms`, `links`); it does NOT extend with the page metadata above directly — instead BugHunter maps `Page → DiscoveredPage` by setting:

- `DiscoveredPage.route = page.route`
- `DiscoveredPage.sourceFile = absolutePathOf(page.sourceFile)` (joined with `projectDir`)
- (everything else filled by DOM walk as today)

`componentName`, `lazy`, `dynamicParams`, `declaredAt` are NOT propagated into `DiscoveredPage` for v0.2 — they're not used downstream and would expand `DiscoveredPage` unnecessarily. Defer until a consumer needs them. (No speculative abstraction — `/root/.claude/CLAUDE.md` § "Anti-Patterns".)

---

## 3. Discovery algorithm

### 3.1 New function: `discoverPages`

Replaces the **direct call** to `discoverFilesystemPages` from `packages/cli/src/phases/discover.ts` (line 30). The replacement function lives in `packages/cli/src/discovery/pages.ts`:

```ts
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

export type DiscoveredPageMeta = {
  route: string;
  sourceFile?: string;  // absolute path; undefined when SurfaceMCP returned '<unresolved>'
};

export async function discoverPages(
  projectDir: string,
  surface: SurfaceMcpAdapter
): Promise<DiscoveredPageMeta[]>;
```

Algorithm:

1. Call `surface.surface_describe_self()`. Extract `stack` and `capabilities.listPages`.
2. Branch on `stack`:
   - `'nextjs'`: call existing `discoverFilesystemPages(projectDir)`. Map to `DiscoveredPageMeta` (`sourceFile` already absolute). **No regression vs today.**
   - `'vite'` (and any other stack with `capabilities.listPages === true`): call `surface.surface_list_pages()`. Map each `Page → DiscoveredPageMeta`:
     - `route: p.route`
     - `sourceFile: p.sourceFile === '<unresolved>' ? undefined : path.join(projectDir, p.sourceFile)`
   - `'express'`, `'fastapi'`, `'django'`, `'openapi'`: return `[]`. Backend-only stacks have no UI surface; today this is implicit (those stacks rarely have an `app/` or `pages/` dir matching the Next.js glob). Now it's explicit.
3. If `surface_describe_self` is not available (SurfaceMCP < v0.2): fall back to `discoverFilesystemPages(projectDir)` to preserve existing behavior. Detect this by treating any error containing the string `not_found` or HTTP 4xx as "tool missing" and falling back. Log a deprecation warning.

### 3.2 Wiring into `runDiscover`

In `packages/cli/src/phases/discover.ts`, replace lines 30-31:

**Before:**
```ts
const fsPages = await discoverFilesystemPages(projectDir);
log.info(`Discovered ${fsPages.length} filesystem pages`);
```

**After:**
```ts
const rawPages = await discoverPages(projectDir, surface);
log.info(`Discovered ${rawPages.length} pages`);

// Adapt back to the existing FilesystemPage shape used by the rest of the function
const fsPages = rawPages.map(p => ({
  route: p.route,
  sourceFile: p.sourceFile ?? '',  // empty string treated as "no source" by downstream code
}));
```

The rest of `runDiscover` (dynamic route expansion via `discoveryFixtures`, `routeAliases` dedup, `excludedRoutes`, DOM walk per role per page, form cross-ref) is untouched. The only concept change is **where** pages come from.

### 3.3 Existing `isDynamicRoute` and `expandDynamicRoute` semantics

Today these are written for Next.js dynamic-route syntax `[id]` (square brackets). React Router uses `:id` (colon). Both must be supported. Update `discovery/filesystem-pages.ts`:

```ts
export function isDynamicRoute(route: string): boolean {
  return /\[.+\]/.test(route) || /:[A-Za-z_][\w]*/.test(route) || route.includes('*');
}

export function expandDynamicRoute(
  route: string,
  fixtures: Record<string, string[]>
): string[] {
  if (!isDynamicRoute(route)) return [route];
  const ids = fixtures[route];
  if (!ids || ids.length === 0) return [];
  return ids.map(id => {
    let r = route.replace(/\[([^\]]+)\]/g, id);  // Next.js style
    r = r.replace(/:[A-Za-z_][\w]*/g, id);       // React Router style
    r = r.replace(/\*/g, id);                    // Splat
    return r;
  });
}
```

Discovery fixtures are keyed on the EXACT route string from `discoverPages`. For a SurfaceMCP-emitted route `/users/:id`, `discoveryFixtures` must use the key `/users/:id` (not `/users/[id]`). Document in `bughunt.md` skill manifest.

### 3.4 Source file relativization for cross-ref

`runDiscover` calls `surface_routes_for_page({ pagePath })` with `pagePath` relative to the project root. The current code (line 91) does `path.relative(projectDir, sourceFile)`. With absolute paths from `discoverPages`, this still works. With `undefined` sourceFile, fall back to `route` (current behavior at line 92).

---

## 4. Interface contract

### 4.1 Adapter surface — new methods

Add to `SurfaceMcpAdapter` interface in `packages/cli/src/adapters/surface-mcp.ts`:

```ts
export type SurfacePageMeta = {
  route: string;
  sourceFile: string;
  componentName?: string;
  lazy: boolean;
  dynamicParams: string[];
  declaredAt: { file: string; line: number };
};

export type SurfaceListPagesResult = {
  revision: number;
  pages: SurfacePageMeta[];
};

export type SurfaceDescribeSelfResult = {
  name: string;
  stack: 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi' | 'vite';
  baseUrl: string;
  toolRevision: number;
  pageRevision: number;
  capabilities: {
    listPages: boolean;
  };
};

export interface SurfaceMcpAdapter {
  // ... existing methods ...
  surface_list_pages(filter?: { pathPrefix?: string; lazy?: boolean }): Promise<SurfaceListPagesResult>;
  surface_describe_self(): Promise<SurfaceDescribeSelfResult>;
}
```

`HttpSurfaceMcpAdapter` adds the two corresponding `mcpCall<>` methods — copy-paste of the existing pattern (one line each, no logic).

### 4.2 Error-shape contract

If SurfaceMCP returns an MCP `isError: true` for `surface_describe_self` (e.g. older server version), `HttpSurfaceMcpAdapter.surface_describe_self()` throws (existing behavior of `mcpCall`). `discoverPages` catches the error, logs a deprecation warning, and falls back to `discoverFilesystemPages(projectDir)`.

If `surface_list_pages` errors mid-discovery (e.g. SurfaceMCP crashed), bubble the error — discovery cannot proceed. This matches existing behavior for `surface_list_tools` failures.

### 4.3 Config additions — none required

`BugHunterConfig` is unchanged. The stack is implicit (read from SurfaceMCP at runtime). This is the chosen plumbing — see § 5.0.

### 4.4 Multi-surface client (deferred)

A TraiderJo-shape repo with both vite (frontend) and express (backend) surfaces would ideally have BugHunter point at BOTH SurfaceMCPs simultaneously: vite for pages, express for API tools. **Out of scope for v0.2.** Today (and in v0.2), `BugHunterConfig.surfaceMcpUrl` is a single URL. The recommended workflow for full-stack repos:

- Run two `surfacemcp serve` instances on different ports.
- For BugHunter's run, set `surfaceMcpUrl` to whichever surface is the "primary" — usually the backend (it's where API tools live). UI page discovery is bounded to the backend's perspective: it returns `pages: []` (express stack), so SPA UI tests are not generated.
- For full SPA UI testing, set `surfaceMcpUrl` to the vite surface; API tests are then bounded to whatever the vite surface knows (typically nothing, returning `[]`).

V0.3 (separate spec) will introduce `BugHunterConfig.surfaces: SurfaceRef[]` to merge from multiple SurfaceMCPs in one run. Document this limitation in `bughunt.md`. **Acceptance criterion § 9 reflects this**: TraiderJo's full-stack outcome remains "single-surface bounded" in v0.2.

---

## 5. Cross-repo coupling — producer / consumer pairs

| Producer | Consumer | Contract |
|---|---|---|
| SurfaceMCP `surface_list_pages` MCP tool | BugHunter `HttpSurfaceMcpAdapter.surface_list_pages` | `{ revision: number; pages: SurfacePageMeta[] }` |
| SurfaceMCP `surface_describe_self` MCP tool | BugHunter `discoverPages` dispatcher | `{ stack: Stack; capabilities: { listPages: boolean }; ... }` |
| BugHunter `discoverPages` | BugHunter `runDiscover` (replacing the direct `discoverFilesystemPages` call) | `Promise<DiscoveredPageMeta[]>` |
| BugHunter `DiscoveredPageMeta.sourceFile` | BugHunter `surface_routes_for_page({ pagePath })` (cross-ref forms) | absolute path → relativized at the call site |

### 5.0 Plumbing decision: option (a) — `surface_describe_self`

We chose option (a) — query SurfaceMCP for the stack via a new MCP tool — over:

- **(b)** Adding `stack` to `BugHunterConfig.json` at init time. Rejected: duplicates state already owned by SurfaceMCP. If a repo migrates from express to express+vite, BugHunter's config silently goes stale.
- **(c)** Dispatching both code paths and merging. Rejected: `discoverFilesystemPages` would happily walk a Vite project's `pages/` (if any exists) and produce phantom routes. Plus the call-out-and-merge cost on every run is wasteful.

Option (a) keeps SurfaceMCP as the single source of truth for stack identity, requires zero migration of existing configs, and matches the existing pattern (BugHunter never knows about stack-specific concepts; it asks the surface).

### 5.1 Backward-compat fallback

For BugHunter clients pointed at SurfaceMCP < v0.2 (no `surface_describe_self`):
- `surface_describe_self()` throws.
- `discoverPages` catches, logs `WARN bughunter: SurfaceMCP < 0.2 detected; falling back to filesystem-only page discovery`, calls `discoverFilesystemPages(projectDir)`.

This guarantees BugHunter v0.2 works against SurfaceMCP v0.1 without user intervention. Once SurfaceMCP v0.2 ships, the fallback becomes dead code that gets removed in BugHunter v0.3.

---

## 6. Fixture + test plan

### 6.1 Reuse SurfaceMCP's vite-app fixture

`/root/SurfaceMCP/fixtures/vite-app/` is the shared fixture (specced in `/root/SurfaceMCP/SPEC_VITE_DISCOVERY.md` § 6.1). BugHunter's e2e test spawns:
1. The fixture's Vite dev server (`npm run dev` in the fixture dir, allocated port).
2. A SurfaceMCP server pointed at the fixture (allocated port).
3. BugHunter via the existing `runBugHunter` helper.

Mirror `tests/e2e/bughunter-e2e.test.ts` `beforeAll` setup (lines 80-116) and `helpers/spawn.ts` patterns.

### 6.2 Unit tests — `packages/cli/src/discovery/pages.test.ts`

Co-located with `pages.ts`. Cases:

1. **`stack: 'nextjs'` calls `discoverFilesystemPages` and returns its result.** Mock the adapter to return `surface_describe_self => { stack: 'nextjs', capabilities: { listPages: false }, ... }`. Mock the FS to have `app/foo/page.tsx`. Assert the result.
2. **`stack: 'vite'` calls `surface.surface_list_pages` and maps results.** Mock adapter `surface_describe_self => { stack: 'vite', capabilities: { listPages: true }, ... }` and `surface_list_pages => { revision: 1, pages: [<one page>] }`. Assert mapping is correct (sourceFile becomes absolute via `path.join(projectDir, ...)`).
3. **`stack: 'vite'` with `'<unresolved>'` sourceFile maps to `sourceFile: undefined`.** Assert `DiscoveredPageMeta.sourceFile === undefined`.
4. **`stack: 'express'` returns empty array.** Adapter mock returns `stack: 'express'`. Assert `discoverPages` returns `[]`. Assert `surface_list_pages` is NOT called.
5. **Fallback when `surface_describe_self` is unavailable.** Adapter mock throws on `surface_describe_self`. Assert `discoverFilesystemPages` is called as fallback.

### 6.3 Unit test — dynamic-route syntax expansion

`packages/cli/tests/dynamic-routes.test.ts` (new file) — assert `isDynamicRoute` and `expandDynamicRoute` recognize:

| Input route | `isDynamicRoute` | Expansion (fixtures `{ '/users/:id': ['42'] }`) |
|---|---|---|
| `/users/[id]` | true | (with fixture key `/users/[id]` → `['/users/42']`) |
| `/users/:id` | true | `['/users/42']` |
| `/users/*` | true | (with fixture key `/users/*` → `['/users/42']`) |
| `/about` | false | `['/about']` |
| `/users/:postId/comments/:commentId` | true | (multi-param expansion) |

For multi-param routes with separate fixture entries per param: out of scope. v0.2 supports only single-param expansion (matches today's behavior). Document.

### 6.4 e2e test — extend `bughunter-e2e.test.ts`

Add a new top-level `describe('BugHunter e2e — Vite SPA')` block:

Setup (parallel `beforeAll`):
1. `copyFixtureToTemp` adapted to also handle the SurfaceMCP `vite-app` fixture (helper `copyViteAppFixtureToTemp`).
2. Spawn the vite dev server (`npm run dev` from the fixture dir; wait for `http://127.0.0.1:<port>`).
3. Spawn SurfaceMCP pointing at the fixture (`stack: 'vite'`).
4. Wait for both ready.

Test cases:

1. **`bughunter run` plans non-zero UI tests** (the v0.2 functional gate). Read the run summary; assert `summary.testsPlanned > 0`. Filter the test cases: assert at least one has `action.via === 'ui'` AND its `page.route` is one of `['/', '/about', '/admin', '/admin/users', '/admin/settings', '/users/:id']`.
2. **All six fixture pages are present in the discovery output.** Read `discovery.json` from the run artifacts; assert exactly six unique `pages[].route`.
3. **`/users/:id` is skipped without `discoveryFixtures`** (existing behavior, regression-pinned). Assert the run summary's `testsSkipped` includes one with `reason: 'discovery_skipped: missing_fixture'` and `route: '/users/:id'`.
4. **With `discoveryFixtures: { '/users/:id': ['42'] }` set, the dynamic route is expanded.** Assert at least one test case has `page === '/users/42'`.

### 6.5 e2e regression — Next.js fixture unchanged

The existing API-only and browser test blocks against the nextjs-app fixture must still pass without modification. Add an explicit assertion at the top of the existing `BugHunter e2e — API-only` block:

```ts
it('discoverPages dispatch returns identical pages for the Next.js fixture', async () => {
  // Spin up the same surface adapter the run uses
  const adapter = new HttpSurfaceMcpAdapter(surfaceMcpUrl);
  const before = await discoverFilesystemPages(fixtureDir);   // direct
  const after = await discoverPages(fixtureDir, adapter);     // through dispatcher
  const beforeSet = new Set(before.map(p => p.route));
  const afterSet = new Set(after.map(p => p.route));
  expect([...afterSet].sort()).toEqual([...beforeSet].sort());
});
```

This pins the regression: any future change to `discoverPages` that breaks the Next.js path fails this test before merging.

### 6.6 Skip-when-no-camofox is preserved

The browser-portion gate (`if (!browserAvailable) { ... return; }` at line 175) still applies to UI tests in the new Vite block. UI tests need camofox.

---

## 7. Backward compat & sequencing

### 7.1 Compat guarantees

| Behavior | Pre-v0.2 | Post-v0.2 |
|---|---|---|
| BugHunter v0.2 against SurfaceMCP v0.1 (no `surface_describe_self`) | n/a | falls back to `discoverFilesystemPages`, identical to today |
| BugHunter v0.2 against SurfaceMCP v0.2 (Next.js project) | n/a | calls `discoverFilesystemPages` directly (same code path), identical results |
| BugHunter v0.2 against SurfaceMCP v0.2 (Vite project) | 0 UI tests | non-zero UI tests, populated from `surface_list_pages` |
| `BugHunterConfig` schema | unchanged | unchanged |
| `bughunter init` UX | unchanged | unchanged |
| Existing `discoveryFixtures`, `routeAliases`, `excludedRoutes` | applied | applied (now also expand `:id` and `*` syntax) |

### 7.2 Build sequencing

1. Add adapter methods (`surface_list_pages`, `surface_describe_self`) to `SurfaceMcpAdapter` interface and `HttpSurfaceMcpAdapter` impl. **Mock SurfaceMCP-side** with a stub for testing (real impl ships with the SurfaceMCP spec). Tests in `packages/cli/tests/adapters/`.
2. Update `isDynamicRoute` / `expandDynamicRoute` to handle `:id` and `*`. Tests in `dynamic-routes.test.ts`.
3. Implement `discoverPages` in `packages/cli/src/discovery/pages.ts`. Unit tests in `pages.test.ts`. Mock the adapter; do NOT spin up a real SurfaceMCP for unit tests.
4. Wire `discoverPages` into `runDiscover` (one-line change in `phases/discover.ts`).
5. Add the e2e Vite block to `bughunter-e2e.test.ts`. This requires SurfaceMCP v0.2 deployed locally — gate on `npm run e2e` only.
6. Add the Next.js regression assertion (§ 6.5).

Each step independently committable.

### 7.3 No regression contract

Pin the Next.js page set into a JSON snapshot:

```ts
// packages/cli/tests/discovery-pages-nextjs-snapshot.test.ts
const EXPECTED = ['/', '/admin/inline-action', '/admin/orders', '/admin/users', '/api/missing-route-link', '/dom-test', '/dual-404-link', '/journal', '/policies/privacy'];
// (read from current behavior; pin literally)

it('Next.js page discovery produces the same set as v0.1', async () => {
  const fixtureRoot = '/root/SurfaceMCP/fixtures/nextjs-app';
  const pages = await discoverFilesystemPages(fixtureRoot);
  const got = pages.map(p => p.route).sort();
  expect(got).toEqual(EXPECTED.sort());
});
```

The implementer fills `EXPECTED` from a one-time observation on `main`. This test fails loudly on any change to the Next.js path.

---

## 8. Edge cases

### 8.1 SurfaceMCP returns a page with a route BugHunter already discovered

Cannot happen for vite (BugHunter doesn't filesystem-walk for vite). Cannot happen for nextjs (BugHunter doesn't call `surface_list_pages` for nextjs — the dispatcher branches before either path runs the other). Defensive dedup is unnecessary in `discoverPages`; the dedup at line 56 of `phases/discover.ts` (against `routeAliases`) still applies.

### 8.2 SurfaceMCP returns a page whose `sourceFile === '<unresolved>'`

Map to `sourceFile: undefined`. The form-cross-ref step at line 91 of `phases/discover.ts` falls back to `route` when `sourceFile` is missing. No break.

### 8.3 SurfaceMCP returns 0 pages for a vite project

Two sub-cases:
- **All routes were unresolvable** (e.g. all dynamically constructed): `pages: []`, but skips contain entries. Log `WARN bughunter: surface_list_pages returned 0 pages with N skips: <reasons>`. Continue with API-only testing.
- **The project is tab-state-routed** (TraiderJo): `pages: []`, skip with `tab_state_routing_suspected`. Log similarly. This is the expected TraiderJo outcome for v0.2.

### 8.4 `surface_describe_self` returns a stack BugHunter doesn't know about

E.g. `'tanstack-router'` (when SurfaceMCP eventually ships it). BugHunter reads `capabilities.listPages`:
- If `true`: call `surface_list_pages`. Treat the same as `'vite'`.
- If `false`: return `[]`.

This makes BugHunter forward-compatible without code changes when SurfaceMCP adds new SPA stacks.

### 8.5 Roles list is empty

Today (line 87 of `phases/discover.ts`) defaults to `'anonymous'` when roles is empty. No change.

### 8.6 `surface_list_pages` revision != `surface_list_tools` revision

Pages and tools have independent revisions (per SurfaceMCP spec § 4.3). BugHunter's `runDiscover` does not pin a page revision today; not adding one. If a watcher invalidates the page catalog mid-run, the next run picks up the new state — acceptable.

### 8.7 Empty `pages` list mid-run when SurfaceMCP regenerates

Possible briefly during a watcher-driven page-catalog regen. Unlikely to hit during the discovery phase (which runs once at the start). Not handling.

### 8.8 Project has both Next.js and Vite indicators

Today's `isVite` order (per SurfaceMCP spec § 7.2) says nextjs takes precedence. BugHunter's dispatcher trusts whatever `surface_describe_self` reports, no second opinion. If a hybrid project misconfigures and reports `'vite'`, BugHunter uses `surface_list_pages` and skips filesystem walk. User-fixable via SurfaceMCP config.

---

## 9. Acceptance criteria

### 9.1 Unit

- `npm test` (vitest) green.
- `pages.test.ts` covers all five cases in § 6.2.
- `dynamic-routes.test.ts` covers all rows in § 6.3.
- `discovery-pages-nextjs-snapshot.test.ts` (§ 7.3) pins the Next.js fixture page set.

### 9.2 e2e

- `npm run e2e` against the new Vite fixture passes:
  - `bughunter run` against the vite-app fixture (with `discoveryFixtures: { '/users/:id': ['42'] }`) plans **at least 30 UI tests** (six routes × five roles × ~1 render + clicks/links — exact count tightened by implementer after a one-time observation).
  - Discovery output contains exactly six unique routes from MUST_DISCOVER.
- Existing nextjs-app e2e tests pass without modification.
- The Next.js regression assertion (§ 6.5) passes.

### 9.3 Live target re-smoke (TraiderJo)

After this spec lands AND SurfaceMCP v0.2 lands:

- `bughunter run` against `/tmp/TraiderJo` (with TraiderJo's existing `surfacemcp.config.json` extended to add a vite surface, served on a separate port, and BugHunter's `surfaceMcpUrl` pointed at the vite surface):
  - Completes without errors.
  - Plans `0` UI tests (TraiderJo uses tab-state routing, NOT `react-router-dom`). This is **expected** for v0.2.
  - Discovery output's skip list contains `{ reason: 'tab_state_routing_suspected' }` (passed through from SurfaceMCP). Confirms the diagnostic plumbing works end-to-end.

- The same `bughunter run`, with `surfaceMcpUrl` pointed at TraiderJo's existing express surface (today's behavior), plans the same ~952 API tests as before. **Backward compat preserved.**

### 9.4 Backward compat

- Running BugHunter v0.2 against an unmodified SurfaceMCP v0.1 server:
  - Logs the deprecation warning.
  - Falls back to filesystem-only page discovery.
  - Produces byte-identical run summary to BugHunter v0.1 against the same SurfaceMCP v0.1.

### 9.5 Performance

- `discoverPages` adds < 50 ms on top of `discoverFilesystemPages` for a Next.js project (one extra MCP round-trip for `surface_describe_self`).
- For a Vite project, `discoverPages` completes in < 200 ms (one round-trip for `surface_describe_self`, one for `surface_list_pages`; SurfaceMCP-side extraction time is bounded by SurfaceMCP spec § 9.5).

---

## 10. Open questions

(Defaults recommended inline.)

- **Q1.** Should BugHunter re-fetch `surface_describe_self` on every run, or cache it? **Default: re-fetch every run.** Stack rarely changes; the round-trip is cheap (~5 ms). Caching adds invalidation complexity for negligible gain.
- **Q2.** When SurfaceMCP returns a non-empty `pages` AND BugHunter's `discoverFilesystemPages` would also return entries (e.g. someone manually ran `surfacemcp init --stack=vite` on a Next.js project), should we merge? **Default: trust SurfaceMCP.** BugHunter does not second-guess. The dispatcher branch on `stack` selects exactly one source.
- **Q3.** Should BugHunter expose `discoverPages` skip-list reasons in its run summary (in addition to existing skipReasons)? **Default: yes — extend `summary.skippedReasons` with the SurfaceMCP-side skips, prefixed with `surface:` for namespacing.** Implementer extends `runDiscover` to forward them.

---

End of spec.
