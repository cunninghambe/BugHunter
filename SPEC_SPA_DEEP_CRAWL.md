# SPEC: BugHunter — SPA deep crawl (static + runtime navigation discovery)

Status: draft, ready for implementation
Owner: @architect
Companion specs: `/root/SurfaceMCP/SPEC_NAV_EXTRACT.md`, `/root/SurfaceMCP/SPEC_RUNTIME_ROUTE_ENUM.md`

---

## 1. Problem

BugHunter's crawler (`packages/cli/src/discovery/crawler.ts`) traverses an SPA by following `<a href>` links discovered during DOM walk. This works for static-routed apps with anchor tags. It fails on:

1. **Hand-rolled tab-state SPAs** (TraiderJo): no `<a href>` for internal navigation; views switch via `setTab(...)` on button clicks. Today the crawler reaches `/` and stops.
2. **`useNavigate()`-only navigations**: a `<button onClick={() => navigate('/x')}>` produces no anchor; the crawler never finds `/x` from DOM walk alone.
3. **Routes mounted dynamically by the SPA**: routes added at runtime (auth-gated, feature-flagged) that aren't visible in static source.

The killer demo (vision detection of bugs on TraiderJo's auth-walled dashboard) is gated on this single limitation: post-login, the crawler stops at `/` and vision sees the landing page only.

The fix is two new SurfaceMCP tools (specced in companion docs) and a crawler integration that consumes them. This spec covers the BugHunter side — adapter additions, crawler queue extensions, and click-simulation for tab-state apps.

### 1.1 Live target (acceptance gate)

Run BugHunter against TraiderJo (logged-in role):

- `crawl: visited 5+ pages` (was: 1)
- Pages reached: dashboard, trades, settings, plan, import, profile, apr (≥ 5 of these)
- `vision: anomaliesFound > 0` (assumes real bugs exist; baseline pass) **OR** `vision: 0 anomalies, 5+ pages screenshotted` if no bugs
- `summary.json` includes `discovery.navSources: ['static', 'static-navigations', 'runtime-enum', 'crawl-link']` showing which sources contributed.

### 1.2 Out of scope

- Inferring routes from server-side data (e.g. fetching `/api/menu` to enumerate). Server-side enumeration is a future spec.
- Exhaustive click traversal (clicking every interactive element to discover state). Limited to the navigations supplied by SurfaceMCP.
- A11y testing of newly-discovered pages. (Existing per-page a11y still runs.)

---

## 2. Root cause / motivation

The crawler's queue is fed only by `<a href>`s in the DOM. The new sources (`surface_list_navigations` and `surface_enumerate_routes_runtime`) supply richer transition data: typed targets, click semantics, and runtime-discovered routes. Wiring them into the queue is the smallest possible change that yields the largest behaviour delta.

The hard part is **tab-state click simulation**: when the navigation has `kind: 'state'`, the crawler can't `navigate(url)`. It must locate the trigger element and click it, then snapshot the resulting DOM as a "page." This is a small but real architectural change to the page model.

---

## 3. Design

### 3.1 Three sources, one queue

The crawler now consumes navigations from three sources:

```
                ┌───────────────────────────────────┐
                │  Crawler Seed Queue               │
                │   - dedup by route key            │
                │   - depth-aware                   │
                └─────────┬─────────────┬───────────┘
                          │             │
          ┌───────────────┴───┐  ┌──────┴────────────────┐
          │  source=link        │  source=state         │
          │  → browser.navigate │  → browser.click      │
          └───────────────────┬─┘  └──┬─────────────────┘
                              │       │
                ┌─────────────┴───────┴─────────────┐
                │   walkDom — collects elements,    │
                │   forms, AND new <a href> links   │
                │   AND fires runtime-enum probe    │
                │   on first authenticated visit    │
                └───────────────────────────────────┘
```

Inputs to the queue:

1. **Static pages** from `surface_list_pages` (existing).
2. **Static navigations** from `surface_list_navigations` (NEW). Each navigation produces one queue entry.
3. **Runtime-enumerated routes** from `surface_enumerate_routes_runtime` + `surface_postprocess_runtime_routes` (NEW). Run **once**, after the first successful authenticated page load.
4. **Live `<a href>` links** discovered during DOM walk (existing).

### 3.2 Queue item — discriminated union

Today, queue items are `{ url: string; depth: number }`. New shape:

```ts
export type QueueItem =
  | {
      kind: 'url';
      url: string;             // absolute URL
      depth: number;
      source: NavSource;       // for telemetry
    }
  | {
      kind: 'state';
      // The crawler will navigate to baseRoute first (if not already there),
      // then click the trigger, then walk the resulting DOM.
      baseRoute: string;       // synthetic page that "owns" this state, e.g. '/'
      stateVar: string;
      stateValue: string;
      trigger: TriggerSelectorHint;
      depth: number;
      source: NavSource;
    };

export type NavSource =
  | 'static-page'             // surface_list_pages, source: 'static'
  | 'static-navigation'       // surface_list_navigations
  | 'runtime-enum'            // surface_enumerate_routes_runtime
  | 'crawl-link'              // <a href> from DOM walk
  | 'crawl-seed';             // surface_list_pages, source: 'crawl_seed'

export type TriggerSelectorHint = {
  text?: string;
  testId?: string;
  ariaLabel?: string;
};
```

### 3.3 Route-key dedup with state semantics

Today's `routeKey` is `pathname + sorted query string`. New keys:

- For `kind: 'url'`: unchanged (`/dashboard`, `/users?id=1`).
- For `kind: 'state'`: synthetic key `${baseRoute}#state=${stateVar}=${stateValue}` (URL fragment-style, but **never** sent to navigate). Example: `/#state=tab=dashboard`. This guarantees no collision with real URL routes.

Update `routeKey` to accept a `QueueItem`:

```ts
export function queueKey(item: QueueItem): string {
  if (item.kind === 'url') {
    const u = new URL(item.url);
    return urlKey(u, /* followQueryParams */ true /* always for state-aware deduping */);
  }
  return `${item.baseRoute}#state=${item.stateVar}=${item.stateValue}`;
}
```

The visited Map is keyed by `queueKey`. Same-key items are de-duplicated regardless of source.

### 3.4 Crawl flow — pseudocode

```ts
async function crawlFromSeeds(browser, surface, opts): Promise<CrawlResult> {
  const visited = new Map<string, DiscoveredPage | null>();
  const queue: QueueItem[] = [];

  // Source 1: static pages (existing seed entries from surface_list_pages 'crawl_seed')
  for (const seed of opts.seedRoutes) {
    queue.push({ kind: 'url', url: opts.baseUrl + seed, depth: 0, source: 'crawl-seed' });
  }

  // Source 2: static navigations from SurfaceMCP (NEW)
  if (surface.capabilities.listNavigations) {
    const nav = await surface.surface_list_navigations();
    for (const n of nav.navigations) {
      if (n.confidence === 'low' && !opts.includeLowConfidence) continue;
      if (n.kind === 'url' || n.kind === 'hash') {
        const target = n.kind === 'hash' ? '/' + n.target : n.target;  // hash kept as fragment
        queue.push({
          kind: 'url',
          url: opts.baseUrl + target,
          depth: 0,
          source: 'static-navigation',
        });
      } else {
        // kind: 'state'
        queue.push({
          kind: 'state',
          baseRoute: '/',  // tab-state apps mount at root; if the static analyzer ever extends to nested mounts, this comes from the navigation entry
          stateVar: n.stateVar!,
          stateValue: n.target,
          trigger: n.triggerSelectorHint,
          depth: 0,
          source: 'static-navigation',
        });
      }
    }
  }

  // (Source 3 — runtime enum — fires after the first walk succeeds; see below)
  let runtimeEnumDone = false;

  while (queue.length > 0) {
    if (visited.size >= opts.maxPages) { hitMaxPages = true; break; }
    const item = queue.shift()!;
    const key = queueKey(item);
    if (visited.has(key)) continue;
    visited.set(key, null);

    let walkResult: DomWalkResult | null = null;

    try {
      if (item.kind === 'url') {
        walkResult = await walkDom(browser, item.url, opts.runId, opts.extraHeaders);
      } else {
        // State navigation: ensure we're on baseRoute, then click trigger.
        const currentUrl = await browser.evaluate('location.pathname');
        const targetBase = opts.baseUrl + item.baseRoute;
        if (currentUrl.value !== item.baseRoute) {
          await browser.navigate(targetBase, opts.extraHeaders);
        }
        const selector = await resolveTriggerSelector(browser, item.trigger);
        if (!selector) {
          skipped.push({ url: key, reason: 'trigger_not_found' });
          visited.delete(key);
          continue;
        }
        await browser.click(selector);
        // Brief settle: state-render commits next tick + animations
        await new Promise(r => setTimeout(r, opts.stateSettleMs ?? 250));
        walkResult = await collectDomOnly(browser);  // see § 3.6 — does not navigate, just snapshots
      }
    } catch (err) {
      skipped.push({ url: key, reason: `walk_failed: ${String(err).slice(0, 200)}` });
      visited.delete(key);
      continue;
    }

    visited.set(key, buildPage(walkResult, item, opts));

    // Source 3: runtime enum, once per crawl, after first authenticated visit succeeds
    if (!runtimeEnumDone && item.depth === 0) {
      runtimeEnumDone = true;
      const runtimeRoutes = await runRuntimeEnum(browser, surface);
      for (const r of runtimeRoutes) {
        const u = opts.baseUrl + r.path;
        queue.push({ kind: 'url', url: u, depth: 1, source: 'runtime-enum' });
      }
    }

    if (item.depth + 1 > opts.maxDepth) { hitMaxDepth = true; continue; }

    // Existing <a href>-following
    for (const link of walkResult.links) {
      const abs = normalizeLink(link, currentUrlOf(item), opts);
      if (!abs) continue;
      const childKey = queueKey({ kind: 'url', url: abs, depth: 0, source: 'crawl-link' });
      if (visited.has(childKey) || queue.some(q => queueKey(q) === childKey)) continue;
      queue.push({ kind: 'url', url: abs, depth: item.depth + 1, source: 'crawl-link' });
    }
  }

  return { pages: [...visited.values()].filter((p): p is DiscoveredPage => p !== null), visited: [...visited.keys()], skipped, hitMaxPages, hitMaxDepth };
}
```

### 3.5 Trigger selector resolution

The static analyzer emits hints, not selectors. The crawler resolves them at click-time:

```ts
async function resolveTriggerSelector(
  browser: BrowserMcpAdapter,
  hint: TriggerSelectorHint
): Promise<string | StructuredSelector | null> {
  // Priority 1: data-testid (strongest)
  if (hint.testId) {
    const sel = `[data-testid="${escapeAttr(hint.testId)}"]`;
    if (await selectorExists(browser, sel)) return sel;
  }
  // Priority 2: aria-label
  if (hint.ariaLabel) {
    const sel = `[aria-label="${escapeAttr(hint.ariaLabel)}"]`;
    if (await selectorExists(browser, sel)) return sel;
  }
  // Priority 3: text content via :has-text() (already supported per SPEC_BROWSER_LOGIN_HAS_TEXT)
  if (hint.text) {
    return { kind: 'has-text', text: hint.text } satisfies StructuredSelector;  // adapter resolves at click time
  }
  return null;
}

async function selectorExists(browser: BrowserMcpAdapter, sel: string): Promise<boolean> {
  const result = await browser.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  return result.value === true;
}
```

The `StructuredSelector` `:has-text()` path is already implemented per `SPEC_BROWSER_LOGIN_HAS_TEXT.md`. Reuse it.

### 3.6 `collectDomOnly` — DOM snapshot without navigation

`walkDom` always calls `browser.navigate(url)`. State-transition crawl needs the snapshot side without the navigation:

```ts
// In dom-walker.ts, factor out:
export async function collectDomOnly(
  browser: BrowserMcpAdapter
): Promise<DomWalkResult> {
  // No navigate; no scroll-trigger (assume already in-flow). Optional small scroll.
  await browser.scroll('body', 'down', 1500).catch(() => {});
  const evalResult = await browser.evaluate(COLLECT_ELEMENTS_SCRIPT).catch(() => null);
  if (!evalResult) return { elements: [], forms: [], links: [] };
  return shapeFromEvalResult(evalResult);
}

// Existing walkDom becomes a thin wrapper:
export async function walkDom(browser, url, runId, extraHeaders): Promise<DomWalkResult> {
  await browser.navigate(url, { 'X-BugHunter-Run': runId, ...(extraHeaders ?? {}) });
  return collectDomOnly(browser);
}
```

This refactor is small and tested; the existing `walkDom` test cases continue to pass.

### 3.7 Runtime enumeration integration

After the first DOM walk completes (proves login is alive, app booted), call:

```ts
async function runRuntimeEnum(browser: BrowserMcpAdapter, surface: SurfaceMcpAdapter): Promise<PostprocessedRoute[]> {
  if (!(await surface.surface_describe_self()).capabilities.enumerateRoutesRuntime) return [];
  const { script, timeoutMs } = await surface.surface_enumerate_routes_runtime();
  let raw: unknown;
  try {
    const result = await Promise.race([
      browser.evaluate(script),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('runtime_enum_timeout')), timeoutMs + 500)),
    ]);
    raw = (result as { value: unknown }).value;
  } catch (err) {
    log.warn('runtime_enum: script failed', { err: String(err) });
    return [];
  }
  const post = await surface.surface_postprocess_runtime_routes({ raw });
  log.info(`runtime_enum: ${post.summary.detectedRouters.join(',') || 'none'}, ${post.routes.length} routes (${post.summary.dedupedRoutes} after dedup)`);
  return post.routes;
}
```

Failure modes:
- `enumerateRoutesRuntime` capability absent (older SurfaceMCP) → skip silently.
- Script throws → log warn, return empty (crawler continues with static + link sources).
- Postprocess returns empty → no error, just zero added routes.

Runtime enum runs **once per crawl**, after the first successful walk at depth 0. Re-running on every page would be wasteful (the route table is static at runtime).

### 3.8 SurfaceMcpAdapter additions

Add to `packages/cli/src/adapters/surface-mcp.ts`:

```ts
export type SurfaceNavigation = {
  label: string;
  method: 'link' | 'router-link' | 'router-push' | 'state-setter';
  target: string;
  kind: 'url' | 'state' | 'hash';
  stateVar?: string;
  triggerSelectorHint: TriggerSelectorHint;
  sourceFile: string;
  sourceLine: number;
  confidence: 'high' | 'medium' | 'low';
};

export type SurfaceListNavigationsResult = {
  revision: number;
  navigations: SurfaceNavigation[];
  skips: Array<{ reason: string; detail?: string; declaredAt?: { file: string; line: number } }>;
};

export type SurfaceRuntimeEnumScript = {
  version: number;
  script: string;
  timeoutMs: number;
  expectedSchema: unknown;
};

export type SurfacePostprocessedRoute = {
  path: string;
  params: string[];
  source: 'tanstack-router' | 'react-router-v6' | 'react-router-v5' | 'wouter' | 'vue-router' | 'next-router' | 'none';
};

export type SurfacePostprocessResult = {
  routes: SurfacePostprocessedRoute[];
  summary: {
    detectedRouters: string[];
    errorCount: number;
    totalRoutes: number;
    dedupedRoutes: number;
    fellBackToNone: boolean;
  };
};

export interface SurfaceMcpAdapter {
  // ... existing methods ...
  surface_list_navigations(filter?: { method?: string; kind?: string }): Promise<SurfaceListNavigationsResult>;
  surface_enumerate_routes_runtime(): Promise<SurfaceRuntimeEnumScript>;
  surface_postprocess_runtime_routes(args: { raw: unknown }): Promise<SurfacePostprocessResult>;
}
```

Update `surface_describe_self` capability fields:

```ts
capabilities: {
  listPages: boolean;
  listNavigations?: boolean;          // NEW
  enumerateRoutesRuntime?: boolean;    // NEW
  crawlSeed?: boolean;
};
```

Both new fields are **optional** for backward compat with SurfaceMCP < 0.2.2. Adapter callsites must guard:

```ts
const self = await surface.surface_describe_self();
const hasNavs = self.capabilities.listNavigations === true;
const hasRuntime = self.capabilities.enumerateRoutesRuntime === true;
```

### 3.9 Page model — DiscoveredPage extension

`DiscoveredPage` today has `route: string`. State-page entries need an additional discriminator so downstream phases (vision, planner, executor) handle them correctly:

```ts
export type DiscoveredPage = {
  route: string;          // for kind:'state' pages, the synthetic '/?tab=...' route
  sourceFile?: string;
  elements: Element[];
  forms: DiscoveredForm[];
  links: string[];
  // NEW
  kind?: 'url' | 'state';            // default 'url' for backward compat
  stateContext?: {                    // present iff kind === 'state'
    baseRoute: string;
    stateVar: string;
    stateValue: string;
    triggerHint: TriggerSelectorHint;
  };
  navSource?: NavSource;              // for telemetry
};
```

The vision pipeline (currently in `phases/discover.ts → runVisualBaseline`) already screenshots from a URL. State pages need a click-to-reach step:

```ts
// In runVisualBaseline:
if (page.kind === 'state') {
  await browser.withTab(`${baseUrl}${page.stateContext!.baseRoute}`, undefined, async scope => {
    const sel = await resolveTriggerSelectorViaScope(scope, page.stateContext!.triggerHint);
    if (!sel) throw new Error('trigger_not_found_in_vision');
    await scope.click(sel);
    await new Promise(r => setTimeout(r, VISION_BASELINE_SETTLE_MS));
    await scope.screenshot(screenshotPath);
  });
} else {
  await browser.withTab(`${baseUrl}${page.route}`, undefined, async scope => {
    await new Promise(r => setTimeout(r, VISION_BASELINE_SETTLE_MS));
    await scope.screenshot(screenshotPath);
  });
}
```

`TabScope` doesn't currently expose `click`. **Decision:** add `click(selector)` to `TabScope` interface (mirror of `BrowserMcpAdapter.click`). One line in `browser-mcp.ts`'s `withTab` factory. Trivial change, fully tested via the new `crawler.test.ts` cases below.

### 3.10 Configuration

Extend `CrawlConfig` in `packages/cli/src/types.ts`:

```ts
export type CrawlConfig = {
  // ... existing ...

  /** Include `confidence: 'low'` navigations from surface_list_navigations. Default: false. */
  includeLowConfidence?: boolean;

  /** Settle delay (ms) after clicking a state-trigger before snapshotting. Default: 250. */
  stateSettleMs?: number;

  /** Disable runtime route enumeration (Phase 2). Default: false (enabled). */
  disableRuntimeEnum?: boolean;

  /** Cap on state-kind queue items to prevent runaway tab-state crawls. Default: 30. */
  maxStateNavigations?: number;
};
```

Document defaults in the config.ts loader.

### 3.11 Telemetry

Add to `RunSummary` (already in `packages/cli/src/types.ts`):

```ts
export type RunSummary = {
  // ... existing fields ...
  discovery?: {
    seedRoutes: number;
    staticNavigations: number;
    runtimeEnumRoutes: number;
    crawlLinkRoutes: number;
    visitedPages: number;
    stateKindPages: number;
  };
};
```

Populated from the crawler's queue/visited bookkeeping at the end of the discover phase.

---

## 4. Files

### Files you MUST read before writing any code

- `packages/cli/src/discovery/crawler.ts` — current crawl loop. The change is additive: extend QueueItem, queueKey, and add the click branch.
- `packages/cli/src/discovery/dom-walker.ts` — extract `collectDomOnly` from `walkDom` (small refactor; § 3.6).
- `packages/cli/src/adapters/surface-mcp.ts` — add three method signatures + types.
- `packages/cli/src/adapters/browser-mcp.ts` — add `click` to `TabScope` interface; understand `StructuredSelector`/`:has-text()` machinery (already shipped per `SPEC_BROWSER_LOGIN_HAS_TEXT.md`).
- `packages/cli/src/adapters/browser-mcp-snapshot.ts` — `parsePlaywrightHasText` for trigger resolution.
- `packages/cli/src/phases/discover.ts` — where the new crawl is invoked. Update the runVisualBaseline path for state-kind pages (§ 3.9).
- `packages/cli/src/types.ts` — extend `CrawlConfig`, `DiscoveredPage`, `RunSummary`.
- `packages/cli/src/discovery/crawler.test.ts` — pattern for mock browser tests.
- `fixtures/vite-crawl-app/` — pattern for end-to-end crawl fixtures.

### Files to create

- `fixtures/vite-tab-state-app/` — mirror of the SurfaceMCP fixture from `SPEC_NAV_EXTRACT.md` (a 4-tab app).
  - `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`.
  - `src/main.tsx`, `src/App.tsx` — the tab-state app.
  - `src/pages/{Dashboard,Trades,Settings,Profile}.tsx`.
  - `surfacemcp.config.json`.
  - `MUST_DISCOVER.json` listing the 4 expected pages (3 state + 1 base).
- `packages/cli/src/discovery/trigger-resolve.ts` — `resolveTriggerSelector()` + `selectorExists()`.
- `packages/cli/src/discovery/trigger-resolve.test.ts` — unit tests.
- `packages/cli/tests/discovery/spa-deep-crawl.test.ts` — integration test driving crawler against mock SurfaceMCP returning navigations.

### Files to modify

- `packages/cli/src/types.ts` — extend `CrawlConfig`, `DiscoveredPage`, `RunSummary`. Add `NavSource`, `QueueItem`-related types if exported (see § 3.2).
- `packages/cli/src/adapters/surface-mcp.ts` — add 3 methods + types. Implement on `HttpSurfaceMcpAdapter`.
- `packages/cli/src/adapters/browser-mcp.ts` — add `click` to `TabScope` interface and its factory in `withTab`.
- `packages/cli/src/discovery/dom-walker.ts` — factor `collectDomOnly` out of `walkDom`.
- `packages/cli/src/discovery/crawler.ts` — main change: queue extension, click branch, runtime-enum integration, key extension.
- `packages/cli/src/discovery/crawler.test.ts` — extend test mock browser; add new cases (§ 6.1).
- `packages/cli/src/phases/discover.ts` — wire new sources; vision baseline state-page handling.
- `packages/cli/src/config.ts` — load new CrawlConfig fields with defaults.
- `packages/cli/src/log.ts` — no change needed (logging via `log.info` is sufficient).

### Files NOT to touch

- Any file under `packages/cli/src/{classify,cluster,mutation,ops,repro,store}/` — out of scope.
- `packages/cli/src/phases/{plan,execute,validate,classify,cluster,emit}.ts` — except as required to consume the extended `DiscoveredPage` shape (most should be unchanged because `route` and other fields remain present).
- `packages/cli/src/discovery/browser-login.ts` — orthogonal; the login flow is unchanged.

---

## 5. Edge cases

| # | Case | Expected |
|---|------|----------|
| 1 | SurfaceMCP returns 0 navigations | Crawler relies on link-following only (current behaviour) |
| 2 | SurfaceMCP `listNavigations` capability absent (old version) | Adapter call skipped; warning logged once |
| 3 | Runtime enum returns 0 routers | `runtime_enum: none` logged; no extra routes added; crawl continues |
| 4 | Runtime enum returns malformed output | Postprocess returns empty; crawl continues |
| 5 | State trigger selector hint with text="Dashboard" but the live page has 3 elements with that text | `:has-text()` resolver picks the first; if it's not the right one, this becomes a known limitation; coder can iterate later by adding `data-testid` |
| 6 | State trigger element disabled at click time | Click silently succeeds (browser MCP doesn't gate on disabled by default for `click`); the resulting walk shows no new content; visited.set the page with empty elements; no error |
| 7 | State page already visited (same `(baseRoute, stateVar, stateValue)`) | Skipped via dedup; no second click |
| 8 | State navigation triggers a URL change (e.g. setTab also pushes history) | After click, walk uses `location.pathname` as the actual URL; the visited Map keys by the synthetic state key, not the URL — both are stored. Possible duplication in pages list; mitigated by post-crawl dedup in `discover.ts` |
| 9 | Click resolution fails (no element with that text/testid) | Skipped with `trigger_not_found`; logged; crawl continues |
| 10 | Login session expires mid-crawl during runtime-enum | `surface.relogin` triggered (existing behaviour); script re-injected on next page; documented as best-effort |
| 11 | SurfaceMCP returns navigations referencing a route not in `surface_list_pages` | Fine — the navigation extractor and page extractor are independent; the crawler queues and visits based on navigations alone |
| 12 | Tab-state click triggers an async data-load that's still pending after `stateSettleMs` | `walkDom` already does scroll-and-wait; soft enough. If empty walk persists, increase `stateSettleMs` per surface (config). |
| 13 | A `kind: 'hash'` link target collides with a real route at the same path | URL fragments don't change pathname; the crawler navigates to `${url}#${target}` and walks; dedup works |
| 14 | Vision baseline opens a new tab via `withTab` for a state page | Tab is a fresh navigation to baseRoute; click resolves; screenshot captured; tab closes — same lifecycle as URL pages |
| 15 | `maxStateNavigations` cap reached | Subsequent state items in queue are dropped with `state_cap_hit` skip |
| 16 | `disableRuntimeEnum: true` | `runRuntimeEnum` not called; runtime-enum routes never queued |
| 17 | Two state navigations with same target but different stateVar (`setTab('home')` and `setView('home')`) | Distinct queue keys (`/#state=tab=home` vs `/#state=view=home`) |
| 18 | DOM walk inside a state page picks up `<a href>` links | Queued as `kind:'url'` (existing behaviour); state nav and link nav coexist freely |
| 19 | Static navigation with `kind: 'url'` and target identical to a static page | Deduped via `queueKey` (visited Map shared) |
| 20 | TraiderJo-style click in a CommandPalette overlay | Trigger selector hint = the button text; resolver finds it via `:has-text()`; if the overlay is not open at click time, click fails → `trigger_not_found`. Acceptable failure mode. |

---

## 6. Tests

### 6.1 Unit tests — `packages/cli/src/discovery/crawler.test.ts` (extension)

Add new cases. Use the existing `makeMockBrowser` pattern; extend with state-handling helpers.

**Required cases** (one `it()` each):

C1. **static-navigation/url** — surface returns one nav `{ method:'link', kind:'url', target:'/about' }`. Crawler visits `/` (seed) and `/about`.
C2. **static-navigation/state** — surface returns one nav `{ method:'state-setter', kind:'state', target:'dashboard', stateVar:'tab', triggerSelectorHint:{text:'Dashboard'} }`. Mock browser `click` is called with the `:has-text(Dashboard)` selector. Mock walk after click returns elements specific to dashboard. Resulting `pages` length === 2 (`/` and `/#state=tab=dashboard`).
C3. **state-navigation/dedup** — same nav surfaces twice (e.g. from listNavigations and listPages synthetic). Crawler clicks once.
C4. **state-navigation/cap** — `maxStateNavigations: 2` with 5 state navs in the surface output. Visits the first 2 only; remaining 3 in `skipped` with `state_cap_hit` reason.
C5. **trigger-resolve/testid-priority** — hint with both testId and text → adapter receives `[data-testid="X"]` not `:has-text()`.
C6. **trigger-resolve/aria-label-fallback** — hint with text and ariaLabel, no testId → ariaLabel selector used.
C7. **trigger-resolve/text-fallback** — hint with only text → `:has-text()` structured selector returned.
C8. **trigger-resolve/none** — hint empty → returns null; queue item skipped with `trigger_not_found`.
C9. **trigger-resolve/missing-element** — hint testId="x" but `document.querySelector` returns null → falls through to next hint; if all missing → null.
C10. **runtime-enum/integration** — surface_describe_self capability true; surface_enumerate returns a script that, when "evaluated" by mock browser, returns `{ routers: [{name:'tanstack-router', routes:[{path:'/x', params:[]}]}], errors:[], elapsedMs: 1 }`. Crawler queues `/x`, visits it. (Mock the postprocess result directly to avoid testing SurfaceMCP internals here.)
C11. **runtime-enum/disabled** — `disableRuntimeEnum: true`. Crawler does not call `surface_enumerate_routes_runtime`.
C12. **runtime-enum/capability-absent** — capability `enumerateRoutesRuntime: false`. Crawler skips the call; no warning thrown.
C13. **runtime-enum/script-fails** — mock browser.evaluate rejects. `runtime_enum` warn logged; crawl continues with seed pages.
C14. **runtime-enum/runs-once** — even with multiple depth-0 visits, runtime-enum fires once.
C15. **walk-collectDomOnly/no-navigate** — direct test of `collectDomOnly`: mock browser `evaluate` is called but `navigate` is not.
C16. **state-page-shape** — pages emitted from state-kind queue items have `kind:'state'` and populated `stateContext`.
C17. **mixed-sources** — combine static page, static nav (url), static nav (state), runtime-enum route, and `<a href>` link discovery in one run. Verify all 5 sources reachable; final `summary.discovery` counts match.
C18. **dedup/state-equals-existing-state** — same `(baseRoute, stateVar, stateValue)` queued from two sources → visited once.
C19. **dedup/state-vs-url** — nav `kind:'state'` with target `/dashboard` in stateValue, and nav `kind:'url'` with target `/dashboard` — these have different keys (`/#state=...` vs `/dashboard`), both visited (correct: they're different transitions).
C20. **low-confidence/excluded** — nav with `confidence:'low'`. With `includeLowConfidence: false` (default), skipped. With `true`, included.

### 6.2 Unit tests — `packages/cli/src/discovery/trigger-resolve.test.ts`

≥ 6 cases: testid present/absent, aria-label present/absent, text-only, escape special chars in attribute values, no hint, all-hints-empty.

### 6.3 Integration test — `packages/cli/tests/discovery/spa-deep-crawl.test.ts`

End-to-end against an in-process mock SurfaceMCP HTTP server (use the pattern from `crawler.test.ts` mock construction). Drive a full discover phase against a synthetic surface that returns:

- `surface_describe_self`: stack=vite, capabilities={listPages, listNavigations, enumerateRoutesRuntime}.
- `surface_list_pages`: returns 1 crawl_seed page at `/`.
- `surface_list_navigations`: returns 4 state-setter navs (mirroring the fixture).
- `surface_enumerate_routes_runtime`: returns a script that, in the mock browser's `evaluate`, returns `{routers:[], errors:[], elapsedMs:0}` (no router detected — TraiderJo case).

Mock browser:
- `evaluate(COLLECT_ELEMENTS_SCRIPT)` returns different element sets based on which trigger was last clicked (statefully).
- `click(selector)` records the selector, transitions internal state.
- `navigate(url)` resets to seed.

Assert:
- `discover` returns 5 pages (seed + 4 state).
- All 4 pages have `kind: 'state'`.
- `summary.discovery.staticNavigations === 4`.
- No `crawl-link` source (synthetic mock has no `<a href>`).

### 6.4 Live target — TraiderJo smoke (manual / out-of-CI)

Document a runbook:

```bash
# Prerequisites: TraiderJo running on port 3001 with seed user logged in via cookie.
# SurfaceMCP for traiderjo running with the new tools (post-PR-merge of nav-extract + runtime-route-enum).

cd /root/BugHunter
node ./dist/cli/main.js run --project /tmp/TraiderJo --runId smoke-traiderjo
```

Expected log highlights:
- `browser_login: success`
- `crawl: visited 6+/50 pages`
- Pages list includes `/?tab=dashboard`, `/?tab=trades`, `/?tab=settings`.
- `vision: classified N pages, found K anomalies`

This is the killer-demo gate.

---

## 7. Acceptance criteria

- [ ] All 20 unit-test cases in § 6.1 pass.
- [ ] All cases in § 6.2 and § 6.3 pass.
- [ ] `npm run lint` clean, `npx tsc --noEmit` clean, `npm run test` green.
- [ ] Backward compat: a crawler run against `vite-crawl-app` (existing fixture) produces identical pages list (no behaviour change for surfaces without listNavigations).
- [ ] Backward compat: a crawler run against a SurfaceMCP that lacks `listNavigations` capability completes without errors and without warnings (other than a single info-level "listNavigations unavailable").
- [ ] TraiderJo smoke gate (§ 6.4) reaches ≥ 5 distinct pages post-login; vision phase runs against all of them.
- [ ] `summary.json` includes `discovery.{seedRoutes, staticNavigations, runtimeEnumRoutes, crawlLinkRoutes, visitedPages, stateKindPages}`.
- [ ] No `as any`. No new heavy deps. No `console.log` (use `log.info/warn/error`).
- [ ] `DiscoveredPage` extension is non-breaking: all existing consumers compile unchanged.
- [ ] Vision baseline pipeline correctly screenshots state-kind pages (click before screenshot).

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Tab-state click resolution is brittle when text labels are non-unique | `data-testid` priority absorbs the impact for apps with reasonable test instrumentation; for TraiderJo specifically, manual `data-testid` annotations may be needed (out of scope, but document) |
| Vision baseline flakiness when click triggers async data load | `stateSettleMs` configurable; if a page consistently flakes, surface-specific `vision.settleMs` already exists in the vision config |
| Runtime-enum fires before app finishes booting | Run it AFTER the first depth-0 walk completes (not before); the walk itself is synchronous on a fully-mounted page |
| Queue grows unbounded with combinatoric state pages on apps with multiple state vars | `maxStateNavigations` cap (default 30); future spec may add per-stateVar-distinct limits |
| Existing `walkDom` callsites break after `collectDomOnly` refactor | The refactor preserves `walkDom`'s signature; only its internals change. Run all existing crawler tests as a regression suite. |
| `withTab` lifecycle for vision state-pages leaks tabs | Existing `withTab` already does try/finally tab close; the new click path runs inside that scope; no tab leak |
| Crawl explosion if SurfaceMCP returns 100+ navigations | `maxPages` already caps total visits; navigation queue is bounded by maxPages * (state cap factor) |
| Mock browser tests diverge from real browser behaviour | Add the integration test with a real SurfaceMCP-emitted script in postprocess (§ 6.3 covers this); rely on TraiderJo smoke as live gate |
| State pages mis-classified as URL pages by downstream phases | Phase code that uses `page.route` for navigation should check `page.kind === 'state'` first. Add a runtime guard in plan/execute that throws on missing handler — fast-fail beats silent corruption |
| Backward compat break in `DiscoveredPage` shape | All new fields are optional; `kind` defaults to 'url'; existing JSONL artifacts deserialize unchanged |

---

## 9. Open questions

None blocking. Items deferred:
- Should state pages have their own `executeOn` semantics (e.g. for palette/mutation testing, click trigger before each action)? **Decision:** out of scope; v1 only screenshots state pages for vision. Add palette-on-state-pages in a follow-up spec.
- Should the runtime-enum probe run on every login refresh? **Decision:** no — once per crawl is sufficient. If the route table changes between sessions, that's a server-side concern.
- Brute-force probing? **Decision:** explicitly out of scope (per `SPEC_RUNTIME_ROUTE_ENUM.md` § 1.3); add later behind a feature flag.

---

## 10. Negative requirements

- Do NOT navigate to synthetic `/#state=...` URLs in a real browser. They're queue keys, not URLs. Always use the `kind: 'state'` branch which clicks instead of navigating.
- Do NOT re-implement `:has-text()` resolution; use the existing `parsePlaywrightHasText` from `browser-mcp-snapshot.ts`.
- Do NOT run runtime-enum more than once per crawl. Cache via the `runtimeEnumDone` flag.
- Do NOT add a polling loop around runtime-enum (e.g. retry every second). The script either works on first try or is skipped.
- Do NOT modify the SurfaceMCP repo from this PR. Coordination spec lives in `/root/SurfaceMCP/SPEC_NAV_EXTRACT.md` and `/root/SurfaceMCP/SPEC_RUNTIME_ROUTE_ENUM.md`. This spec consumes them.
- Do NOT use `any`. Where structural typing across the discriminated union is awkward, use `satisfies` and discriminator narrowing.
- Do NOT bypass `withTab` for vision state-page screenshots — keep the tab lifecycle managed.
- Do NOT introduce a new global `lastClickedTrigger` — store click context per QueueItem.
- Do NOT change the on-disk artifact format (`pages.json`, `summary.json`) in a way that breaks existing consumers. Adding fields is OK; renaming/removing is not.

---

## 11. Task breakdown

### Task 1 — Type extensions
**Assignee:** @coder
**Files to modify:** `packages/cli/src/types.ts`, `packages/cli/src/adapters/surface-mcp.ts`
**Test:** `npx tsc --noEmit`
**Done when:** `QueueItem`, `NavSource`, `TriggerSelectorHint`, extended `DiscoveredPage`/`CrawlConfig`/`RunSummary` compile; `SurfaceMcpAdapter` has 3 new method signatures.

### Task 2 — HttpSurfaceMcpAdapter implementation
**Files to modify:** `packages/cli/src/adapters/surface-mcp.ts`
**Test:** Add unit tests for 3 new methods (mock fetch).
**Done when:** Three methods correctly POST to `/mcp` with the expected payloads.

### Task 3 — `collectDomOnly` refactor
**Files to modify:** `packages/cli/src/discovery/dom-walker.ts`
**Test:** All existing `walkDom` tests pass; new test for `collectDomOnly` (no navigate call).
**Done when:** Functionally equivalent split; existing crawler tests green.

### Task 4 — Trigger resolver
**Files to create:** `packages/cli/src/discovery/trigger-resolve.ts`, `packages/cli/src/discovery/trigger-resolve.test.ts`
**Test:** § 6.2 cases pass.

### Task 5 — Crawler queue extension
**Files to modify:** `packages/cli/src/discovery/crawler.ts`
**Test:** § 6.1 cases C1-C9, C15-C20 pass.

### Task 6 — Runtime-enum integration in crawler
**Files to modify:** `packages/cli/src/discovery/crawler.ts`
**Test:** § 6.1 cases C10-C14 pass.

### Task 7 — TabScope.click + vision baseline state-page handling
**Files to modify:** `packages/cli/src/adapters/browser-mcp.ts`, `packages/cli/src/phases/discover.ts`
**Test:** Vision baseline test against fixture state pages; assert `click` is called inside `withTab`.

### Task 8 — Discover-phase wiring
**Files to modify:** `packages/cli/src/phases/discover.ts`
**Test:** § 6.3 integration test passes.

### Task 9 — Fixture
**Files to create:** `fixtures/vite-tab-state-app/**`
**Test:** Manually verify `vite build` works; integration test consumes fixture.

### Task 10 — Config defaults + telemetry
**Files to modify:** `packages/cli/src/config.ts`, `packages/cli/src/phases/discover.ts`, summary writers in `phases/emit.ts` if needed.
**Test:** Run summary contains `discovery` block.

### Task 11 — TraiderJo smoke runbook
**Files to create:** `docs/SMOKE_TRAIDERJO.md` or extend existing smoke doc.
**Test:** Manual; gate criterion in § 6.4.

---

## 12. Estimated effort

≈ 2 senior engineer-days. Most of the time is in crawler.ts and the integration test; everything else is mechanical. Tasks 1-4 can run in parallel; 5+ are sequential.
