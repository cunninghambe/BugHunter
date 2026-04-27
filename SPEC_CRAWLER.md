# SPEC: BugHunter v0.2.1 — Link-following crawl for SPA page discovery

Status: draft, ready for implementation
Owner: @architect
Target version: BugHunter v0.2.1
Companion spec: `/root/SurfaceMCP/SPEC_CRAWL_SEED.md`

---

## 1. Problem

BugHunter v0.2 (PR #6) wired stack-aware page discovery: Next.js uses filesystem walk, Vite uses `surface_list_pages`. This works when SurfaceMCP can statically extract routes (Vite + `react-router-dom`).

It doesn't work for:
- TraiderJo (Vite + tab-state routing, no `react-router-dom`).
- Vue Router projects (different config shape).
- Wouter / TanStack Router / hand-rolled routing.

SurfaceMCP v0.2.1 (companion spec) closes the producer side: when static extraction is empty, the surface returns a single `Page` with `route: '/'` and `source: 'crawl_seed'`. **This spec is the consumer half.** When BugHunter sees a crawl-seed page, it:

1. Visits `/` via the browser MCP.
2. Walks the DOM (already does this — reuses `walkDom`).
3. Follows every same-origin link found in the DOM.
4. Recursively walks each link target as a new page.
5. Bounds the crawl by `maxPages`, `maxDepth`, `sameOrigin`, dedup.
6. Returns a flat `DiscoveredPage[]` for the rest of the pipeline.

The crawler is a **discovery source** that produces fully-populated `DiscoveredPage` entries (with `elements`, `forms`, `links` from the DOM walk). The existing per-page DOM walk loop in `runDiscover` skips pages that arrived pre-walked.

### 1.1 Live target (gating)

After this lands AND the SurfaceMCP companion lands, re-smoking `/tmp/TraiderJo`:
- Plans **non-zero UI tests** — at least 5, drawn from routes reachable from `/`.
- Discovery output contains `≥ 5` distinct pages from the crawl.
- Run completes within budget; crawl phase logs progress per page.

### 1.2 Non-goals

- Per-role crawls (crawl runs once with the configured role's browser session).
- Form submission during crawl (read-only, click-free; only follows `<a href>`).
- Cookie injection / programmatic auth setup for the browser session — out of scope; v0.3.
- Concurrency — serial only in v0.2.1.
- Tab-state route discovery via JS execution (SurfaceMCP could in v0.3 invoke `pushState` to enumerate; not in this spec).

---

## 2. Root cause / motivation

`discoverPages` (in `packages/cli/src/discovery/pages.ts`) returns `[]` for any Vite project where SurfaceMCP can't extract static routes. Today that's TraiderJo and any non-`react-router-dom` SPA. The static-extraction path scales linearly with extractor effort (one extractor per framework). The runtime crawl path scales O(1) — the DOM walker already exists, links are first-class.

Crawling-from-`/` is the "single extractor" that subsumes per-framework support, with the trade-off that it operates at runtime not compile time, and that uncrawlable pages (auth-walled, requires a click sequence to reach) are missed. For v0.2.1 we accept that trade-off — it's strictly more coverage than today (zero).

---

## 3. Existing code map

### 3.1 Files you MUST read before writing any code

- `packages/cli/src/types.ts` — `DiscoveredPage`, `BugHunterConfig`. Extend (do NOT replace).
- `packages/cli/src/discovery/pages.ts` — current `discoverPages` dispatcher; the entry point for the new branch.
- `packages/cli/src/discovery/dom-walker.ts` — `walkDom` already returns `{ elements, forms, links }`. **Reuse verbatim.** Do not duplicate the eval script.
- `packages/cli/src/phases/discover.ts` — current per-page DOM walk loop. The crawler runs BEFORE this loop, populates `pages` directly, and the loop must skip pre-walked entries.
- `packages/cli/src/adapters/surface-mcp.ts` — `SurfacePageMeta`, `SurfaceDescribeSelfResult`. Add optional `source?` and `capabilities.crawlSeed?` fields.
- `packages/cli/src/adapters/browser-mcp.ts` — `BrowserMcpAdapter.navigate()`, `evaluate()`, `withTab()`. Use these.

### 3.2 Patterns to follow

- **Logging:** `import { log } from '../log.js';` — use `log.info` / `log.warn` / `log.error`. Match the existing tone (`'Discovered N pages'`, `'DOM walk for /route'`).
- **Error handling:** `try { ... } catch (err) { log.warn('crawl: ...', err); }` — never silent.
- **No throws on per-page failure:** match `walkDom`'s posture — log + return empty for that page.
- **Test colocation:** new module `discovery/crawler.ts` ⇒ test `discovery/crawler.test.ts` next to it.
- **`path.posix` for URL paths**, never `path` (which uses platform separator on Windows).
- **No new deps.** Use `node:url` / `URL` for URL parsing.

### 3.3 DO NOT

- Do NOT duplicate the DOM eval script in `dom-walker.ts` — reuse `walkDom` as the per-page primitive.
- Do NOT add a separate browser session per page — reuse `browser` (the existing adapter handle). One tab is fine; navigations are sequential.
- Do NOT touch `phases/plan.ts` or `phases/execute.ts`. The crawler outputs `DiscoveredPage[]`; downstream is unchanged.
- Do NOT extend `BugHunterConfig` with crawl options under any other key than `crawl: { ... }` — the namespace is reserved.
- Do NOT modify `walkDom` itself. If you need a variant (e.g. shorter timeout), pass new parameters through, do not fork.
- Do NOT write a markdown progress file — log lines only.
- Do NOT create new files outside the list in § 9.1.

---

## 4. Design

### 4.1 New types (in `packages/cli/src/adapters/surface-mcp.ts`)

```ts
// Extend existing SurfacePageMeta
export type PageSource = 'static' | 'crawl_seed';

export type SurfacePageMeta = {
  route: string;
  sourceFile: string;
  componentName?: string;
  lazy: boolean;
  dynamicParams: string[];
  declaredAt: { file: string; line: number };
  source?: PageSource;  // NEW; optional for backward-compat with SurfaceMCP < 0.2.1
};

// Extend existing SurfaceDescribeSelfResult.capabilities
export type SurfaceDescribeSelfResult = {
  // ... existing fields ...
  capabilities: {
    listPages: boolean;
    crawlSeed?: boolean;  // NEW; optional
  };
};
```

The `source` field is the typed contract that triggers crawl mode. The `crawlSeed` capability flag is informational — BugHunter does not require it to be true; it branches purely on `source === 'crawl_seed'`. This keeps the consumer logic simple and forward-compatible.

### 4.2 New types (in `packages/cli/src/types.ts`)

```ts
// Add to BugHunterConfig
export type CrawlConfig = {
  /**
   * Auto-derived from SurfaceMCP `source: 'crawl_seed'`. Set to false to disable
   * crawl entirely (e.g. for projects where the seed is wrong). Default: undefined
   * (auto-enable when seed is detected).
   */
  enabled?: boolean;
  /** Max distinct pages to visit (including the seed). Default: 50. */
  maxPages?: number;
  /** Max link-follow depth from the seed. Seed is depth 0. Default: 3. */
  maxDepth?: number;
  /**
   * If true, query strings are kept as part of the dedup/visit key.
   * If false (default), query strings are stripped before dedup.
   */
  followQueryParams?: boolean;
  /**
   * Per-page DOM-walk timeout for the crawler. Aligns with the existing walkDom
   * behavior (which has implicit ~10s scroll caps). Default: 30000.
   */
  walkTimeoutMs?: number;
  /**
   * Same-origin only. If false, off-site links are followed (rarely useful;
   * default true). Off-site is determined by URL.origin equality with the
   * configured appBaseUrl.
   */
  sameOriginOnly?: boolean;
};

export type BugHunterConfig = {
  // ... existing fields ...
  crawl?: CrawlConfig;  // NEW
};
```

Defaults are inlined when reading the config (no separate defaults object — keep it simple, document in `cli/run.ts`):

```ts
const crawlOpts = {
  enabled: config.crawl?.enabled,            // undefined ≡ auto
  maxPages: config.crawl?.maxPages ?? 50,
  maxDepth: config.crawl?.maxDepth ?? 3,
  followQueryParams: config.crawl?.followQueryParams ?? false,
  walkTimeoutMs: config.crawl?.walkTimeoutMs ?? 30_000,
  sameOriginOnly: config.crawl?.sameOriginOnly ?? true,
};
```

### 4.3 New module — `packages/cli/src/discovery/crawler.ts`

Public API:

```ts
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { DiscoveredPage } from '../types.js';

export type CrawlOpts = {
  baseUrl: string;             // http://host:port (no trailing slash)
  seedRoutes: string[];        // ['/'] in v0.2.1; allow array for future
  maxPages: number;
  maxDepth: number;
  followQueryParams: boolean;
  walkTimeoutMs: number;
  sameOriginOnly: boolean;
  runId: string;
  extraHeaders?: Record<string, string>;
};

export type CrawlResult = {
  pages: DiscoveredPage[];     // each fully populated (elements/forms/links)
  visited: string[];           // ordered list of normalized paths visited
  skipped: Array<{ url: string; reason: string }>;  // off-origin, depth-cap, errors
  hitMaxPages: boolean;        // true if cap was reached
  hitMaxDepth: boolean;        // true if any link was rejected for depth
};

export async function crawlFromSeeds(
  browser: BrowserMcpAdapter,
  opts: CrawlOpts
): Promise<CrawlResult>;
```

**Function size**: keep `crawlFromSeeds` under 40 lines by delegating to helpers:
- `normalizeLink(href: string, currentUrl: string, opts): string | null` — returns absolute URL if same-origin & supported scheme, else null.
- `routeKey(url: URL, followQueryParams: boolean): string` — the dedup key (path + optional query, no fragment, no trailing slash).
- `buildDiscoveredPage(walkResult, route, sourceFile?): DiscoveredPage` — adapt `walkDom`'s output.

### 4.4 Algorithm

```
Inputs: opts, browser
State:
  visited: Map<string /*routeKey*/, DiscoveredPage>
  queue:   Array<{ url: string, depth: number }>
  skipped: Array<{ url: string, reason: string }>
  hitMaxDepth = false
  hitMaxPages = false

Init:
  for each seed in opts.seedRoutes:
    fullUrl = opts.baseUrl + seed  (assert seed starts with '/')
    queue.push({ url: fullUrl, depth: 0 })

Loop while queue non-empty:
  if visited.size >= opts.maxPages: hitMaxPages = true; break
  { url, depth } = queue.shift()
  parsed = new URL(url)
  key = routeKey(parsed, opts.followQueryParams)
  if visited.has(key): continue
  visited.set(key, /* placeholder */ undefined)   // reserve
  log.info(`crawl: visiting ${visited.size}/${opts.maxPages} depth=${depth} queue=${queue.length} ${parsed.pathname}${parsed.search ?? ''}`)

  // Per-page DOM walk
  let walkResult: DomWalkResult | null = null
  try {
    walkResult = await Promise.race([
      walkDom(browser, url, opts.runId, opts.extraHeaders),
      timeoutAfter(opts.walkTimeoutMs, 'walk timeout')
    ])
  } catch (err) {
    log.warn(`crawl: walk failed ${parsed.pathname}`, err)
    skipped.push({ url, reason: `walk_failed: ${String(err).slice(0, 200)}` })
    visited.delete(key)
    continue
  }

  // Construct DiscoveredPage
  page = {
    route: parsed.pathname + (opts.followQueryParams ? parsed.search : ''),
    sourceFile: undefined,
    elements: walkResult.elements,
    forms: walkResult.forms,
    links: walkResult.links,
  }
  visited.set(key, page)

  // Enqueue links
  if (depth + 1 > opts.maxDepth):
    hitMaxDepth = true
    continue                               // children too deep; no enqueue

  for each link in walkResult.links:
    abs = normalizeLink(link, url, opts)
    if abs === null:
      skipped.push({ url: link, reason: 'off_origin_or_unsupported' })  // dedup'd later if noisy
      continue
    childKey = routeKey(new URL(abs), opts.followQueryParams)
    if visited.has(childKey): continue
    if queue.some(q => routeKey(new URL(q.url), opts.followQueryParams) === childKey): continue
    queue.push({ url: abs, depth: depth + 1 })

Output:
  pages = Array.from(visited.values()).filter(Boolean)
  return { pages, visited: [...visited.keys()], skipped, hitMaxPages, hitMaxDepth }
```

### 4.5 `normalizeLink` rules

```
function normalizeLink(href: string, currentUrl: string, opts): string | null
  if href is empty, null, or starts with '#': return null
  if href starts with 'javascript:', 'mailto:', 'tel:', 'data:', 'blob:', 'file:': return null
  try: u = new URL(href, currentUrl)        // resolves relative against current
  catch: return null
  if u.protocol !== 'http:' && u.protocol !== 'https:': return null
  if opts.sameOriginOnly:
    base = new URL(opts.baseUrl)
    if u.origin !== base.origin: return null
  // Strip fragment always (#hash same DOM)
  u.hash = ''
  // Strip trailing slash (except root)
  if u.pathname !== '/' && u.pathname.endsWith('/'):
    u.pathname = u.pathname.slice(0, -1)
  // Strip query unless explicitly kept
  if !opts.followQueryParams: u.search = ''
  return u.toString()
```

### 4.6 `routeKey` rules

```
function routeKey(u: URL, followQueryParams: boolean): string
  // Path post-normalization only — origin already constrained by sameOriginOnly.
  let key = u.pathname
  if key !== '/' && key.endsWith('/'): key = key.slice(0, -1)
  if followQueryParams && u.search:
    // Sort query params for stable dedup: ?b=2&a=1 ≡ ?a=1&b=2
    const params = [...u.searchParams.entries()].sort()
    key += '?' + params.map(([k,v]) => `${k}=${v}`).join('&')
  return key
```

Fragment never included (hash navigation = same DOM).

### 4.7 Wiring into `phases/discover.ts`

Insert AFTER `discoverPages` returns (after line 32 of the current file), BEFORE the existing dynamic-route expansion loop:

```ts
// rawPages is the existing variable from discoverPages
const seedEntries = rawPages.filter(p => p.source === 'crawl_seed');
const staticEntries = rawPages.filter(p => p.source !== 'crawl_seed');

// Collect crawl-discovered pages (already DOM-walked) and routes to walk normally
const crawledPages: DiscoveredPage[] = [];

if (seedEntries.length > 0 && browser && config.crawl?.enabled !== false) {
  const seedRoutes = seedEntries.map(s => s.route);
  const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
  log.info(`crawl: starting from ${seedRoutes.length} seed(s): ${seedRoutes.join(', ')}`);
  const result = await crawlFromSeeds(browser, {
    baseUrl,
    seedRoutes,
    maxPages: config.crawl?.maxPages ?? 50,
    maxDepth: config.crawl?.maxDepth ?? 3,
    followQueryParams: config.crawl?.followQueryParams ?? false,
    walkTimeoutMs: config.crawl?.walkTimeoutMs ?? 30_000,
    sameOriginOnly: config.crawl?.sameOriginOnly ?? true,
    runId,
    extraHeaders: config.extraHeaders,
  });
  log.info(`crawl: visited ${result.pages.length} pages` +
    (result.hitMaxPages ? ' (max-pages cap hit)' : '') +
    (result.hitMaxDepth ? ' (max-depth cap hit)' : ''));
  crawledPages.push(...result.pages);
  // Convert skipped reasons into the run's skipList (existing skipList variable)
  for (const s of result.skipped) {
    skipList.push({ route: s.url, reason: `crawl_skipped: ${s.reason}` });
  }
}

// fsPages is the variable already used — populate it from staticEntries only;
// crawled pages are passed to the DOM walk loop pre-populated.
const fsPages = staticEntries.map(p => ({
  route: p.route,
  sourceFile: p.sourceFile ?? '',
}));
```

Then in the DOM walk loop (existing lines 83-124), add a "skip if pre-walked" branch. Approach: the existing loop iterates `filteredRoutes` (post-dedup of `staticEntries`-derived routes) and produces `pages`. After that loop, append `crawledPages` directly.

Final concrete change in `discover.ts`:

```ts
// existing loop builds pages: DiscoveredPage[] from filteredRoutes
// after the loop:
pages.push(...crawledPages);
```

The `routeAliases` dedup against crawl results is NOT applied (crawled pages have no alias — they ARE the canonical routes). The `excludedRoutes` filter SHOULD apply to crawled pages too — apply `micromatch` filter on `crawledPages` before pushing. To avoid duplicate logic:

```ts
const filteredCrawled = (config.excludedRoutes?.length ?? 0) > 0
  ? crawledPages.filter(p => !micromatch([p.route], config.excludedRoutes!).length)
  : crawledPages;
pages.push(...filteredCrawled);
```

`routeAliases` is still applied to crawled pages — they enter the same dedup `seen` set BEFORE the DOM walk loop runs, OR we apply it post-hoc. Simpler: apply to the crawled set independently, using the same alias map, BEFORE pushing:

```ts
const seen = new Set(filteredRoutes.map(r => config.routeAliases?.[r.route] ?? r.route));
const filteredCrawled = crawledPages.filter(p => {
  const canonical = config.routeAliases?.[p.route] ?? p.route;
  if (seen.has(canonical)) return false;
  seen.add(canonical);
  if ((config.excludedRoutes?.length ?? 0) > 0 && micromatch([p.route], config.excludedRoutes!).length > 0) return false;
  return true;
});
pages.push(...filteredCrawled);
```

### 4.8 Auth model

The crawler navigates via the browser MCP. Whatever auth state the browser session has is what the crawler sees. **No new login mechanic.** The existing per-DOM-walk auth gap (browser doesn't share SurfaceMCP cookies) is unchanged. Document in § 8.4.

This means:
- For TraiderJo's `bughunter run` from a clean browser session: anonymous crawl. Public pages discovered; auth-walled pages may produce login-redirect targets that fail to deepen further, OR may produce a flat tree from the public landing page.
- Operators wanting authed crawl coverage: not in v0.2.1. Track as v0.3 follow-up.

### 4.9 Role interaction

The crawl runs ONCE per `bughunter run`, not per role. Discovery output (`DiscoveredPage[]`) is shared across all roles in the plan phase. Per-role behavior surfaces in the EXECUTE phase, where each test case is run for every role (existing behavior).

This matches the existing single DOM-walk per page in `discover.ts:94` (`const role = roles[0] ?? 'anonymous'`). Do NOT change that — the crawl simply REPLACES that single walk for crawled pages.

---

## 5. Tests

### 5.1 Unit — `packages/cli/src/discovery/crawler.test.ts`

Mock the `BrowserMcpAdapter` (no real browser). Each test stubs `navigate`, `evaluate` (the eval inside `walkDom`), and `scroll`.

Cases:

1. **Single seed, no links — visits one page only.**
   - Mock `evaluate` to return `{ elements: [], forms: [], links: [] }`.
   - Assert `result.pages.length === 1`, `pages[0].route === '/'`, `result.visited === ['/']`, `hitMaxPages === false`, `hitMaxDepth === false`.

2. **Seed with two same-origin links — visits three pages BFS.**
   - Mock to return `{ links: ['/about', '/contact'] }` for `/`, then `{ links: [] }` for `/about` and `/contact`.
   - Assert `result.pages.length === 3` and visit order `['/', '/about', '/contact']`.

3. **maxPages cap stops the crawl mid-queue.**
   - Mock to return many links; set `maxPages: 2`.
   - Assert `result.pages.length === 2`, `hitMaxPages === true`.

4. **maxDepth cap rejects child enqueue.**
   - Mock seed returns links to `/a`; `/a` returns links to `/b`. Set `maxDepth: 1`.
   - Assert `result.pages.length === 2` (`/`, `/a`), `/b` not visited, `hitMaxDepth === true`.

5. **Off-origin links are skipped.**
   - Mock seed returns `['/local', 'https://google.com/x']`.
   - Assert visited contains `/`, `/local`; off-origin appears in `skipped` with reason `off_origin_or_unsupported`.

6. **Hash-only links are skipped, hash-with-path is followed but hash stripped.**
   - Mock seed returns `['#section', '/dashboard#tab=trades']`.
   - Assert `/dashboard` is visited (NOT `/dashboard#tab=trades`); `#section` is skipped silently (no skip-list entry — too noisy).
   - **Decision (clarify):** hash-only DOES get a `skipped` entry with reason `'hash_only'`? Or silently? **Default: silently** — they're so common they'd dominate the skip list. Test asserts they're absent from `skipped`.

7. **Trailing slash normalization — `/about/` and `/about` collapse to one visit.**
   - Mock seed returns `['/about', '/about/']`.
   - Assert `result.pages.length === 2`, with `/about` visited once.

8. **Query-string default behavior — stripped.**
   - `followQueryParams: false`. Mock seed returns `['/users?id=1', '/users?id=2']`.
   - Assert one extra page visited (`/users`), not two.

9. **Query-string follow mode — kept.**
   - `followQueryParams: true`. Same input. Assert two extra pages visited with query in route.

10. **Visited dedup against re-encountered URL.**
    - Mock `/` → `['/about', '/']`; `/about` → `['/']`.
    - Assert `/` visited once, `/about` visited once.

11. **Walk failure — page logged, skipped, crawl continues.**
    - Mock `evaluate` to throw on the second navigate.
    - Assert seed page is in `pages`, second URL is in `skipped` with reason starting `walk_failed:`, crawl completes.

12. **Per-page walk timeout fires.**
    - Mock `walkDom` to never resolve; `walkTimeoutMs: 100`.
    - Assert that page goes to `skipped` with `walk_failed` reason containing `timeout`.

13. **`javascript:` / `mailto:` / `tel:` schemes are silently skipped.**
    - Mock seed returns `['javascript:void(0)', 'mailto:x@y.z', 'tel:+15555', '/real']`.
    - Assert only `/` and `/real` visited.

14. **Empty seedRoutes returns empty result.**
    - Assert `result.pages === []`.

### 5.2 Unit — link normalization

`packages/cli/tests/crawler-normalize.test.ts` (new file). Table-driven:

| input href | currentUrl | followQueryParams | sameOriginOnly | expected |
|---|---|---|---|---|
| `/about` | `http://h:1/` | false | true | `http://h:1/about` |
| `about` | `http://h:1/` | false | true | `http://h:1/about` |
| `./x` | `http://h:1/dir/` | false | true | `http://h:1/dir/x` |
| `../x` | `http://h:1/dir/sub/` | false | true | `http://h:1/dir/x` |
| `/x?a=1` | `http://h:1/` | false | true | `http://h:1/x` |
| `/x?a=1` | `http://h:1/` | true | true | `http://h:1/x?a=1` |
| `/x#hash` | `http://h:1/` | false | true | `http://h:1/x` |
| `#hash` | `http://h:1/` | false | true | `null` |
| `https://other/` | `http://h:1/` | false | true | `null` |
| `https://other/` | `http://h:1/` | false | false | `https://other/` |
| `javascript:void(0)` | `http://h:1/` | false | true | `null` |
| `mailto:a@b` | `http://h:1/` | false | true | `null` |
| `''` | `http://h:1/` | false | true | `null` |
| `'/about/'` | `http://h:1/` | false | true | `http://h:1/about` |
| `/` | `http://h:1/` | false | true | `http://h:1/` |

### 5.3 Unit — `routeKey`

Table-driven:

| URL | followQueryParams | expected |
|---|---|---|
| `http://h:1/` | false | `/` |
| `http://h:1/about` | false | `/about` |
| `http://h:1/about/` | false | `/about` |
| `http://h:1/about?b=2&a=1` | true | `/about?a=1&b=2` |
| `http://h:1/about?b=2&a=1` | false | `/about` |
| `http://h:1/about#sec` | false | `/about` |

### 5.4 Discovery dispatcher integration test

`packages/cli/src/discovery/pages.test.ts` — extend with cases that ensure `discoverPages` passes through the `source` field correctly:

15. **`stack: 'vite'` with seed page** — adapter mock returns `{ pages: [{ route: '/', source: 'crawl_seed', ... }] }`. Assert `discoverPages` returns one entry with `source: 'crawl_seed'`.
16. **`source` is preserved** on the returned `DiscoveredPageMeta`. Add `source?: PageSource` to `DiscoveredPageMeta`.

### 5.5 Phase test — `discover.ts` integration

`packages/cli/tests/discover-crawl.test.ts` (new):

17. **Seed flow end-to-end with a mock browser MCP.**
    - Stub `surface.surface_describe_self` → `{ stack: 'vite', capabilities: { listPages: true, crawlSeed: true } }`.
    - Stub `surface.surface_list_pages` → seed page.
    - Stub `browser.evaluate` to return a small graph: `/` → `['/a', '/b']`, `/a` → `[]`, `/b` → `[]`.
    - Run `runDiscover` with a mock browser.
    - Assert `output.pages.length === 3` with routes `['/', '/a', '/b']`.
    - Assert each page has `elements`, `forms`, `links` populated (from the mock walk).

18. **Seed flow with `crawl.enabled: false` — crawl is skipped, zero pages.**
    - Same setup. `config.crawl = { enabled: false }`.
    - Assert `output.pages.length === 0` (no static, no crawl).

19. **Mixed seed + static (forward-compat case).**
    - Stub adapter to return `[{ route: '/dashboard', source: 'static', ... }, { route: '/', source: 'crawl_seed', ... }]`.
    - Assert both flow through and dedup against each other. `/dashboard` walked normally; `/` and its descendants from crawl.

### 5.6 No-regression — existing tests

- `packages/cli/tests/discovery-pages-nextjs-snapshot.test.ts`: still passes (Next.js path unchanged).
- `packages/cli/tests/dynamic-routes.test.ts`: still passes.
- `packages/cli/tests/e2e/**`: must still pass; no e2e infra changes.
- `packages/cli/src/discovery/pages.test.ts` — existing 5 cases must still pass after the `source` field is added.

### 5.7 e2e — new fixture: `fixtures/vite-crawl-app/`

A small Vite SPA WITHOUT `react-router-dom`. Hand-rolled tab-state routing OR plain `<a href>` links rendering different components based on `window.location.pathname`. Pages reachable from `/`:
- `/` (landing) — links to `/about`, `/login`, `/dashboard`.
- `/about` (static info) — links back to `/`.
- `/login` (form) — links to `/`.
- `/dashboard` (post-login) — links to `/about`, `/`.

Build with `vite build` to a static `dist/`, served by a thin Express + `serve-static` (existing pattern in repo).

`package.json` deps: `vite`, `react`, `react-dom`. **No `react-router-dom`**. This is the v0.2.1 functional gate fixture.

E2E test: `packages/cli/tests/e2e/bughunter-e2e.test.ts` adds a top-level `describe('BugHunter e2e — Vite SPA crawl (no router)')` block. Setup mirrors the existing Vite block:
1. Spawn the fixture's dev/preview server.
2. Spawn SurfaceMCP pointed at the fixture (stack=`vite`).
3. Spawn camofox (existing helper).
4. Run BugHunter via `runBugHunter`.

Assertions:

20. **`bughunter run` plans non-zero UI tests.**
    - Assert `summary.testsPlanned > 0`.
    - Assert at least one test case has `action.via === 'ui'` AND its `page` is one of `['/', '/about', '/login', '/dashboard']`.

21. **All four reachable routes appear in `discovery.pages`.**
    - Read `discovery.json` artifact.
    - Assert `discovery.pages.map(p => p.route).sort()` === `['/', '/about', '/dashboard', '/login']`.

22. **maxPages cap respected.**
    - Re-run with `bughunterConfig.crawl.maxPages = 2`.
    - Assert `discovery.pages.length === 2`.

23. **Crawl skip log present.**
    - Assert `summary.skippedReasons` contains an entry whose reason starts with `crawl_skipped:` (off-origin or similar) when the fixture has even one off-origin link in the markup.

### 5.8 Live target re-smoke (manual / not CI)

Document in `bughunt.md` skill manifest: re-running `bughunter run` against `/tmp/TraiderJo` with SurfaceMCP v0.2.1 on a vite surface should:
- Plan ≥ 5 UI tests.
- Discovery output contains ≥ 5 distinct routes from the live site.
- Run summary's `crawl_skipped` reasons logged.

This is THE killer demo per the task description. Acceptance is observed-not-asserted because the live site is mutable.

---

## 6. Risk

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Bad crawls hammer the app.** 50 pages × ~1.5s/page = ~75s of consecutive navigations. | high — that's the point | Default `maxPages: 50` is the user-tunable cap. Document conservatively in `bughunt.md`. Operators can set lower for slow apps. |
| **Infinite loops** via hand-crafted links (e.g. unique ids in URLs causing dedup miss) | medium | `maxPages` + `maxDepth` are belt+suspenders. Default `maxDepth: 3` keeps fan-out bounded. |
| **Auth state leak across pages** during crawl | low — single browser session, single tab, no auth switching | Crawl uses one role (the browser's current state). No state mutation across pages beyond what the SPA itself does. |
| **Slow tests / CI timeouts** — crawl phase takes ~75s on a 50-page SPA | high | `log.info` per page (the spec calls this "crawl progress log"). Visible in CI logs — operators can tune cap. |
| **Crawler walks pages that mutate state** — e.g. `<a href="/logout">` is a link, the crawl would follow it and log the user out mid-discovery | high for SPAs with auth | Document in `bughunt.md`: encourage `excludedRoutes: ['/logout', '/admin/destructive-action']`. v0.3: heuristic auto-skip for `<a>` tags whose href contains `logout|signout|destroy`. Out of scope for v0.2.1. |
| **Walk timeout cascades** — 50 pages × 30s timeout = 25min worst-case crawl | low — most pages return in ~1.5s | `walkTimeoutMs` is configurable. The total bound is intentional: the run-level `maxRuntimeMs` ultimately gates anyway. |
| **Fragile link extraction** when SPAs route via `<button onClick>` (no `<a href>`) | medium | Acknowledged limitation. v0.2.1 follows only `<a href>` (existing `walkDom` link extraction). Click-to-route discovery is v0.3. Document. |
| **`appBaseUrl` mismatch** vs SurfaceMCP origin causes seed URL to point at wrong host | medium | Existing `runDiscover` line 81 already handles this. Crawler reuses the same logic. Test in § 5.5. |
| **Browser MCP not available during run** but seeds returned | low | Wiring (§ 4.7) explicitly checks `if (browser)`. Without browser, crawl is skipped, log a warning, run continues with no UI tests. |
| **TraiderJo's tab-state routing may not produce useful links** if state-driven nav doesn't render `<a href>` markup | medium — that's the live-target risk | Mitigated by the e2e gate on the fixture (which does have `<a href>`). For TraiderJo: if real outcome < 5 routes, the spec acceptance § 8.4 fails and we revisit. |

---

## 7. Negative requirements (DO NOT)

- Do NOT add `crawl` config fields under any other key (e.g. `BugHunterConfig.crawler`, `discoveryCrawl`). Use exactly `BugHunterConfig.crawl: CrawlConfig`.
- Do NOT pass `as any` anywhere. The `source` field is a discriminated union; use it.
- Do NOT throw out of `crawlFromSeeds` on per-page failure. Always return a result; failed pages go to `skipped`.
- Do NOT modify `walkDom`. If you need to change behavior, add a new helper or pass new args through.
- Do NOT implement concurrency / parallelism (defer to v0.3).
- Do NOT implement form submission / button clicks during crawl.
- Do NOT alter `phases/plan.ts` or `phases/execute.ts`.
- Do NOT add a separate browser instance for the crawl. Reuse the existing `browser` parameter in `runDiscover`.
- Do NOT silently swallow errors. `log.warn` minimum on every catch.
- Do NOT exceed 40 lines per function. The crawl loop body must delegate to helpers.
- Do NOT write a JSON artifact for the crawl trail; existing `skipList` + log lines are the record.

---

## 8. Acceptance criteria

### 8.1 Unit

- All 14 cases in § 5.1 (`crawler.test.ts`) pass.
- All rows in § 5.2 (`crawler-normalize.test.ts`) pass.
- All rows in § 5.3 (`routeKey` table) pass.
- Cases 15–16 in § 5.4 (`pages.test.ts` extension) pass.
- Cases 17–19 in § 5.5 (`discover-crawl.test.ts`) pass.
- `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx vitest run` green.

### 8.2 e2e

- `npm run e2e` against the new `vite-crawl-app` fixture passes:
  - § 5.7 cases 20–23 all pass.
- All existing e2e blocks pass without modification — including the existing nextjs and vite (with router) blocks.

### 8.3 Backward compat

- `BugHunterConfig` schema additive only. Existing configs unchanged.
- BugHunter v0.2.1 against SurfaceMCP v0.2 (no `source` field): `source` is undefined, treated as `'static'`, no crawl mode. Equivalent to v0.2 behavior.
- BugHunter v0.2.1 against SurfaceMCP v0.2.1 (with seed): crawl mode triggers, populates pages.
- Next.js path: `surface_describe_self` returns `stack: 'nextjs'` → `discoverPages` returns filesystem pages → no seed entries → no crawl. **Pinned by `discovery-pages-nextjs-snapshot.test.ts`.**
- Vite + `react-router-dom` path: static extraction returns N pages (no seed) → no crawl. **Pinned by the existing `vite-app` fixture e2e.**

### 8.4 Live target gate (TraiderJo re-smoke)

After implementation, manual re-smoke of `/tmp/TraiderJo`:
- `bughunter run` against the live `:8787` SPA (with SurfaceMCP v0.2.1 vite surface configured):
  - **MUST plan ≥ 5 UI tests.**
  - **MUST discover ≥ 5 distinct routes.**
  - Runs to completion within the configured `maxRuntimeMs` (no infinite loop).

If the gate fails on the live site, document the failure mode in a follow-up and re-spec — the fixture gate (§ 8.2) is the contractual gate for merging; the live-site gate is the demo.

### 8.5 Performance

- Crawl phase wall-clock: ≤ `maxPages × walkTimeoutMs` (theoretical max) — typically `maxPages × ~2s`.
- Logs one `crawl: visiting N/M depth=D queue=Q ...` line per page visited.
- Logs one `crawl: visited X pages` line at end with cap-hit flags.

---

## 9. Files

### 9.1 Files to create

- `/root/BugHunter/packages/cli/src/discovery/crawler.ts` — main module.
- `/root/BugHunter/packages/cli/src/discovery/crawler.test.ts` — § 5.1.
- `/root/BugHunter/packages/cli/tests/crawler-normalize.test.ts` — § 5.2 + § 5.3 (combine in one file or split; either acceptable).
- `/root/BugHunter/packages/cli/tests/discover-crawl.test.ts` — § 5.5.
- `/root/BugHunter/fixtures/vite-crawl-app/` — fixture directory:
  - `package.json` — vite + react + react-dom only.
  - `vite.config.ts`.
  - `index.html`.
  - `src/main.tsx`, `src/App.tsx`, `src/pages/Landing.tsx`, `src/pages/About.tsx`, `src/pages/Login.tsx`, `src/pages/Dashboard.tsx`.
  - `surfacemcp.config.json` (stack: `vite`).
  - `MUST_DISCOVER.json` — pin the 4 expected routes for assertions.
  - `README.md` — one paragraph describing the fixture.

### 9.2 Files to modify

- `/root/BugHunter/packages/cli/src/types.ts` — add `CrawlConfig`; add `crawl?: CrawlConfig` to `BugHunterConfig`.
- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — add `PageSource` type; add optional `source?` to `SurfacePageMeta`; add optional `crawlSeed?` to `SurfaceDescribeSelfResult.capabilities`.
- `/root/BugHunter/packages/cli/src/discovery/pages.ts` — propagate `source` field from `surface_list_pages` into `DiscoveredPageMeta`. Update type:
  ```ts
  export type DiscoveredPageMeta = {
    route: string;
    sourceFile?: string;
    source?: PageSource;  // NEW — propagated from SurfacePageMeta
  };
  ```
- `/root/BugHunter/packages/cli/src/phases/discover.ts` — wire crawl per § 4.7. Single new import (`crawlFromSeeds`); branching on `source === 'crawl_seed'`.
- `/root/BugHunter/packages/cli/src/cli/run.ts` — read `crawl` from config (defaults inlined). No new file.
- `/root/BugHunter/packages/cli/src/discovery/pages.test.ts` — add cases 15–16.
- `/root/BugHunter/packages/cli/tests/e2e/bughunter-e2e.test.ts` — add the new `describe` block per § 5.7.
- `/root/BugHunter/packages/cli/dist-skill/bughunt-host.md` (or wherever `bughunt.md` lives) — add a § documenting the new `crawl: { ... }` config knobs and the live-site precaution about `<a href="/logout">`.

### 9.3 Files NOT to modify

- `packages/cli/src/discovery/dom-walker.ts` — reuse only.
- `packages/cli/src/phases/plan.ts`, `phases/execute.ts` — no change.
- `packages/cli/src/discovery/filesystem-pages.ts` — no change.
- `packages/cli/src/discovery/element-collapse.ts`, `form-cross-ref.ts` — no change.
- Any `packages/cli/tests/discovery-pages-nextjs-snapshot.test.ts` — must continue to pass, do not edit.

---

## 10. Open questions

- **Q1.** Should the crawl run per-role? **Default: no, single crawl.** Per-role is 5x cost for marginal coverage gain (most apps surface the same set of pages to most roles; auth-walled pages get tested per-role in execute). Revisit in v0.3 if a real consumer needs role-divergent crawl.
- **Q2.** Should `<button onClick>` patterns be followed (extracted as click-to-navigate)? **Default: no, `<a href>` only.** Click-to-route is v0.3 — needs a different primitive (browser MCP `click` per element + observe URL change).
- **Q3.** Should the crawler collapse `/users/123` and `/users/456` into `/users/:id`? **Default: no, treat each as distinct.** Heuristic-based collapsing is unsafe (numeric segments aren't always IDs). Operators can use `routeAliases` config for explicit collapsing. Add v0.3 opt-in `crawl.collapseIdSegments` if real-world demand emerges.
- **Q4.** What about `<a href>` to non-page resources (e.g. `/api/download.csv`)? **Default: handled by existing skip — non-HTML responses produce zero links and zero elements.** If the navigation returns 5xx/4xx, `walkDom` is unaffected; the page is added with empty arrays. To filter: use `excludedRoutes: ['/api/**']` config. Document.
- **Q5.** Should the crawl deadline be wall-clock-bounded independent of `maxPages`? **Default: no — `maxRuntimeMs` at the run level is the wall-clock gate, and `maxPages × walkTimeoutMs` is the per-phase gate.** If user reports show crawls eating the whole `maxRuntimeMs`, add `crawl.maxWallClockMs` in v0.3.
- **Q6.** Should `crawl_seed_emitted` SurfaceMCP skips be propagated to BugHunter's run summary? **Default: yes, prefixed `surface:`.** Reuses the existing § 6.2 Q3 forwarding pattern (per `SPEC_SPA_PAGES.md`). One-line change in the existing skip-forwarding code.
- **Q7.** What if the seed URL `/` is `excludedRoutes`-filtered? **Default: the seed is dropped before the crawl starts.** Apply `excludedRoutes` filter to `seedRoutes` before invoking `crawlFromSeeds`. If filtered to empty, log `WARN` and skip crawl. Test in § 5.5.

---

End of spec.
