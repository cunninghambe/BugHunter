# SPEC: BugHunter — verify crawler state-routed reach (sister to `SurfaceMCP/SPEC_PAGE_KIND_FIX.md`)

Status: draft (verification-only).
Owner: @architect.
Implementer: @coder.
Predecessors: `SPEC_SPA_DEEP_CRAWL.md` (introduced `kind: 'state' | 'url'` on the queue and click-based reach for state navs).
Companion: `SurfaceMCP/SPEC_PAGE_KIND_FIX.md` (drops synthetic state-pages from `surface_list_pages`).

---

## 1. Problem (downstream of the SurfaceMCP fix)

Live evidence — TraiderJo (Vite tab-state SPA) via SurfaceMCP at `127.0.0.1:3105`:

- `surface_list_pages` returns 30 entries; 29 are synthetic `/?<stateVar>=<value>` query-param routes.
- BugHunter's `discoverPages` (`packages/cli/src/discovery/pages.ts:43-58`) treats them as URL pages.
- `phases/discover.ts:75-76` filters seeds by `source === 'crawl_seed'`; the 29 synthetic pages have `source: 'static'`, so they fall into `staticEntries`.
- `staticEntries` are walked URL-by-URL at `phases/discover.ts:164` via `walkDom(browser, baseUrl + route, ...)`. TraiderJo's SPA ignores the query params; all 29 walks land on the SPA shell.
- Vision baseline (line 256-303) hashes screenshots; all 29 collapse to one unique image, so vision runs on 1 page.

The SurfaceMCP-side fix (`SPEC_PAGE_KIND_FIX.md`) drops those 29 synthetic pages. After that fix, `surface_list_pages` returns only the `crawl_seed` `/`, the deep-crawl path runs, and `surface_list_navigations` provides 32 `kind: 'state'` entries that the crawler reaches via clicks.

This spec verifies BugHunter's existing crawler does the right thing for those state navigations. No behavioural code changes are expected; this is a guard-rail audit + targeted regression tests.

## 2. Investigation findings

Citations are file:line at HEAD of `main` on the `spec/crawler-state-fix` branch.

- `packages/cli/src/discovery/crawler.ts:11-26` — `QueueItem` is a discriminated union with `kind: 'url' | 'state'`. URL items carry `url`, state items carry `baseRoute`, `stateVar`, `stateValue`, `trigger: TriggerSelectorHint`.
- `packages/cli/src/discovery/crawler.ts:206-238` — when `surface.surface_describe_self().capabilities.listNavigations === true`, the crawler calls `surface_list_navigations()` and dispatches by `kind`:
  - `kind: 'url' | 'hash'` → enqueued as a URL item.
  - `kind: 'state'` → enqueued as a state item with `triggerSelectorHint` propagated.
- `packages/cli/src/discovery/crawler.ts:248-296` — the visit loop:
  - URL items call `walkDom(browser, item.url, ...)`.
  - State items: `evaluate('location.pathname')` to check current path, `browser.navigate(opts.baseUrl + item.baseRoute)` if the base route doesn't match, `resolveTriggerSelector(browser, item.trigger)` to convert the hint into a CSS selector, `browser.click(selector)`, settle delay (`stateSettleMs`, default 250ms), then `collectDomOnly(browser)` (no second navigation).
- `packages/cli/src/discovery/crawler.ts:122-139` — `buildStatePage` constructs a `DiscoveredPage` with `kind: 'state'`, `stateContext: { baseRoute, stateVar, stateValue, triggerHint }`, no `sourceFile`, and `navSource` propagated from the queue item (set to `'static-navigation'` for entries from `surface_list_navigations`).
- `packages/cli/src/types.ts:250-267` — `DiscoveredPage.kind?: 'url' | 'state'`, `stateContext?` present iff `kind === 'state'`.
- `packages/cli/src/phases/discover.ts:262-272` — vision baseline already special-cases `page.kind === 'state'`: it navigates to `baseRoute`, resolves the trigger via `resolveTriggerSelector`, clicks, settles, screenshots. So the vision pass reaches state pages correctly.
- `packages/cli/src/discovery/crawler.test.ts:273-422` — cases C1–C4 already cover URL navs (`C1`), state navs reaching click (`C2`), state-nav dedup (`C3`), and the `maxStateNavigations` cap (`C4`).

**Verdict:** the crawler is wired correctly. The bug was upstream in SurfaceMCP. After the SurfaceMCP-side fix, the existing crawler already produces the right behaviour for TraiderJo.

## 3. Design — verify-and-guard

No code changes to the crawler. Add one regression test that locks in the contract: when `surface_list_pages` returns only the `crawl_seed` `/` and `surface_list_navigations` returns N `kind: 'state'` navs, the crawler produces N+1 distinct DiscoveredPages (the seed plus one per state value), and each `kind: 'state'` page carries the `stateContext` needed by the vision baseline.

The new test goes beside the existing `C1–C9` cases in `packages/cli/src/discovery/crawler.test.ts`. It is the "tab-state-only app" scenario in pure unit form, covering the integration of:

- Empty `surface_list_pages` (apart from a single seed).
- Multiple `kind: 'state'` navs from `surface_list_navigations`.
- The seed `/` is the entry; each state nav clicks once after navigating to base; each produces a distinct `DiscoveredPage` with `kind: 'state'`.

A separate fixture-based assertion is **not** required; the existing C1–C4 cover the per-mechanism logic. The new test is integrative — it asserts the cumulative effect.

## 4. Cross-repo impact

Sister to `SurfaceMCP/SPEC_PAGE_KIND_FIX.md`. This spec stands alone but the live-test acceptance criterion (A4) only passes after the SurfaceMCP-side fix is merged.

Order of merging:
1. Merge `SurfaceMCP/spec/page-kind-fix` first.
2. Update SurfaceMCP staged at `:3105` (or whatever port BugHunter consumes).
3. Run BugHunter's TraiderJo smoke; expect vision baseline on > 1 unique screenshot.
4. Merge `BugHunter/spec/crawler-state-fix` (which adds only a regression test).

## 5. Test plan

### 5.1 New regression test — `packages/cli/src/discovery/crawler.test.ts`

Add one `describe` block, e.g. `describe('SPA deep crawl — tab-state-only integration')`, with a single test:

```ts
it('seed + 3 state navs → 4 DiscoveredPages, one URL + three state', async () => {
  // surface_list_pages returns only the seed page; the rest is in surface_list_navigations
  // with kind:'state'. After SPEC_PAGE_KIND_FIX this matches a real tab-state app.
  const surface = makeSurface({
    surface_describe_self: vi.fn().mockResolvedValue({
      name: 'tab-state-app', stack: 'vite', baseUrl: 'http://h:1',
      toolRevision: 1, pageRevision: 1,
      capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false, crawlSeed: true },
    }),
    surface_list_navigations: vi.fn().mockResolvedValue({
      revision: 1,
      navigations: [
        { label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
          sourceFile: 'src/App.tsx', sourceLine: 10, confidence: 'high' },
        { label: 'Trades', method: 'state-setter', target: 'trades', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { text: 'Trades' },
          sourceFile: 'src/App.tsx', sourceLine: 11, confidence: 'high' },
        { label: 'Settings', method: 'state-setter', target: 'settings', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { testId: 'nav-settings' },
          sourceFile: 'src/App.tsx', sourceLine: 12, confidence: 'high' },
      ],
      skips: [],
    }),
  });

  // Mock browser: location.pathname always reports '/', click always succeeds.
  const clickMock = vi.fn().mockResolvedValue({ clicked: true });
  const browser: BrowserMcpAdapter = {
    navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
    evaluate: vi.fn(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      if (script.includes('querySelector(') && !script.includes('querySelectorAll')) {
        return { value: true }; // selector exists
      }
      return { value: makeDomResult([]) };
    }),
    click: clickMock,
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
    listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;

  const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));

  // Seed produces one URL page; three state navs produce three click-reached pages.
  expect(result.pages).toHaveLength(4);
  expect(result.pages.filter(p => p.kind === 'state')).toHaveLength(3);
  expect(result.pages.find(p => p.kind === undefined || p.kind === 'url')?.route).toBe('/');

  // Each state page carries its stateContext.
  const dashboard = result.pages.find(p => p.stateContext?.stateValue === 'dashboard');
  expect(dashboard).toBeDefined();
  expect(dashboard!.stateContext!.stateVar).toBe('tab');
  expect(dashboard!.stateContext!.triggerHint.text).toBe('Dashboard');

  // click was called once per state nav (3), not for the URL seed.
  expect(clickMock).toHaveBeenCalledTimes(3);

  // Telemetry reflects the source split.
  expect(result.telemetry.staticNavigations).toBe(3);
  expect(result.telemetry.stateKindPages).toBe(3);
});
```

The test reuses the existing `makeSurface`, `makeOpts`, `makeDomResult`, `BrowserMcpAdapter` mock pattern in the same file (lines 246-271).

### 5.2 Live acceptance — TraiderJo smoke

After both repos are at HEAD of their respective spec branches:

1. Restart SurfaceMCP at the TraiderJo project port. `surface_list_pages` returns 1 entry (`/`, `source: 'crawl_seed'`).
2. Run BugHunter discover phase against TraiderJo (or whichever existing smoke harness exercises the discover loop end-to-end with a real browser).
3. Assert:
   - `discoveryOutput.crawlTelemetry.seedRoutes === 1`.
   - `discoveryOutput.crawlTelemetry.staticNavigations >= 32`.
   - `discoveryOutput.crawlTelemetry.stateKindPages > 1` (the killer demo metric).
   - Vision baseline produced > 1 distinct screenshot (the screenshot-hash dedup keeps multiple).
   - At minimum the following distinct dashboard states appear (one per): `activeTab=insights` (APR Insights), `activeTab=leaderboard` (APR Leaderboard), `feeMode=fixed`, `feeMode=manual`, `hmDim=monthday`, `hmDim=hour`.

### 5.3 Existing tests that must continue to pass

- `packages/cli/src/discovery/crawler.test.ts` cases C1–C9 (no functional change).
- `packages/cli/tests/discovery/spa-deep-crawl.test.ts` (full integration; verify the tab-state path still produces correct pages now that `surface_list_pages` returns one seed).
- `packages/cli/tests/discover-crawl.test.ts` (top-level discover phase).
- `packages/cli/tests/b11-b12-regressions.test.ts` (regression bench).

### 5.4 No behaviour change in `discoverPages` / `discover.ts`

Sanity-grep for any new mention of `'state'` in the static-walk path. There should be none. State entries flow exclusively through `crawlFromSeeds → surface_list_navigations → click`.

## 6. Backward compat

- `DiscoveredPage`, `QueueItem`, `CrawlOpts`, `CrawlResult`, `CrawlTelemetry` types: unchanged.
- `SurfaceMcpAdapter` interface: unchanged.
- Older SurfaceMCP servers that still emit synthetic state-pages (pre-fix): BugHunter continues to walk them as URL pages. The duplicates are wasted work but not incorrect — the screenshot-hash dedup in vision baseline collapses them. The fix on the SurfaceMCP side is what eliminates the wasted work.
- Apps that don't use tab-state routing (`<Routes>`, Next.js, etc.): unaffected.

## 7. Acceptance criteria

A1. New unit test in `packages/cli/src/discovery/crawler.test.ts` (the "seed + 3 state navs" integration) passes.

A2. All existing crawler tests (C1–C9) continue to pass.

A3. `npx tsc --noEmit` passes for the BugHunter monorepo.

A4. Live: TraiderJo discover phase reports `crawlTelemetry.stateKindPages > 1` and `discoveryOutput.pages.filter(p => p.kind === 'state').length > 1`. Vision baseline runs on > 1 unique screenshot.

A5. No new files outside the test added in §5.1 and this spec document.

A6. No code changes in `crawler.ts`, `discover.ts`, or `pages.ts`.

## 8. Files to touch

### Modified

- `packages/cli/src/discovery/crawler.test.ts` — add the integration test in §5.1.

### Created

- `BugHunter/SPEC_CRAWLER_STATE_FIX.md` (this file).

### Not touched

- `packages/cli/src/discovery/crawler.ts` — already correct.
- `packages/cli/src/discovery/pages.ts` — already correct (treats SurfaceMCP output verbatim; the fix is in SurfaceMCP).
- `packages/cli/src/phases/discover.ts` — already correct.
- `packages/cli/src/types.ts` — `DiscoveredPage.kind` already a discriminator.
- All SurfaceMCP files — separate spec.

## 9. Risk

R1. The new test's mock browser shape diverges from how real `BrowserMcpAdapter` reports `evaluate` results, causing the test to pass while the live path fails. Mitigation: mirror the exact mock shape used by C1–C9, which are known to align with the live adapter (case C2 already exercises the full state path with the same mocking strategy).

R2. Live acceptance (A4) depends on the SurfaceMCP merge landing first. Mitigation: explicit ordering in §4. If BugHunter merges first, the new unit test still passes (it does not depend on SurfaceMCP behaviour); the live smoke is the only thing that needs the SurfaceMCP side.

R3. A future change to vision baseline that re-uses `walkDom` instead of the explicit click path (`phases/discover.ts:264-272`) could regress — state pages would attempt URL navigation and silently collapse. Mitigation: out of scope for this spec; flagged for the next vision overhaul.

## 10. Open questions

None.
