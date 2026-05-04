# SPEC — v0.51 "Cross-browser parity (Chromium, Firefox/Camofox, WebKit)"

**Status:** Draft 1 — strategic + implementation hybrid. Phasing makes each sub-version independently shippable.
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-05-02
**Depends on:** V49 (real MCP transport, `BrowserMcpAdapter` is the contract everyone implements), V41 (mobile mode — mobile-emulation is *not* re-done here), V32 (deterministic mode — same `--seed` must reproduce per-browser results), V27 (`bugIdentity` — the seam where cross-browser reconciliation actually lives).
**Roadmap slot:** `SPEC_PATH_TO_EXHAUSTIVE.md` §3.1 (browser-platform surface) and the implicit gap in the "Detection coverage" axis: today every BugHunter run only ever observes the Firefox-line engine. Vibe-coded apps ship to all three engines.
**Sibling specs:** V52 (visual regression — overlap on `cross_browser_visual_diff`), V36 (browser-platform surface — APIs whose engine support varies, e.g. service workers, `:has()`, `popover`).

---

## 1. Problem

Every BugHunter run today drives **one** browser engine — Camofox, a hardened Camoufox/Firefox fork — through the camofox-mcp transport that V49 just put on a real MCP Client footing. The camofox path is correct, fast, stealth-capable, and useful. It is also, **for cross-engine parity, blind**.

Vibe-coders ship to a tri-engine world:

- **Chromium-line:** Chrome (~64% desktop share), Edge, Opera, Brave, Arc, Electron-shell apps. JS engine V8, layout Blink.
- **Firefox-line:** Firefox + Camofox. JS engine SpiderMonkey, layout Gecko. ~3% desktop share but disproportionate dev-tester share.
- **WebKit-line:** Safari macOS, Safari iOS, every iOS browser (Chrome-on-iOS is WebKit underneath). JS engine JavaScriptCore, layout WebKit. ~20% desktop and ~98% iOS — and iOS is what catches the founder demo on a phone.

Concrete bug classes that **only** one of the three engines surfaces, with no detection in BugHunter today:

| Bug | Manifests on | Invisible to current pipeline |
|---|---|---|
| `<input type="date" value="2026-05-02">` rendered as `MM/DD/YYYY` text input | Safari iOS until 14.x, all WebKit until ~2022; some embedded WebViews still | Camofox always parses ISO date — no signal |
| `Date.parse('2026-05-02')` returns `NaN` (older WebKit) | Safari < 14 | Firefox always parses ISO 8601 — no signal |
| `IndexedDB` quota exhaustion semantics differ — Safari aborts the *transaction*, Chromium aborts the *request* only | WebKit | Camofox follows Firefox semantics (transaction-abort but with different error code) — no signal |
| `requestIdleCallback` undefined | Safari (still, as of 17) | Firefox + Chromium both implement — feature-detect bug invisible |
| `scroll-behavior: smooth` honors `prefers-reduced-motion: reduce` differently per engine | Chromium ignores RM in some cases; WebKit always honors; Firefox toggles via about:config | Camofox is a single sample — no cross-engine diff |
| Focus event ordering on `<button>` click: Chromium fires `focus` before `mousedown`; WebKit fires after; Firefox depends on whether button has `:focus-visible` styling | All three differ | Camofox locks us to Firefox's ordering |
| `:has()` selector — pre-Chromium 105, pre-Firefox 121, WebKit 15.4+ has it | Old Chromium and old-ish Firefox both miss it | Today: only the engine version ImageHunter ships against |
| `popover` API — Chromium 114+, Firefox 125+, WebKit 17+ | All three — but rollout windows differ by 12 months | We see Camofox's window only |
| `Intl.Segmenter` — Firefox 125+, Chromium 87+, WebKit 14.1+ | Firefox lags | Camofox runs new-enough; production users still on older Firefox don't |
| `dialog` element close-on-Escape — Chromium fires `cancel`, WebKit fires `cancel` then `close`, Firefox fires only `close` | All three differ | Camofox sees Firefox's order — wrong assumption baked in |
| File-input `accept="image/heic"` — accepted on Safari, rejected silently on Chromium and Firefox | Chromium / Firefox | Camofox pretends to accept then silently shows nothing |
| WebSocket close-code for abnormal shutdown — Chromium 1006, WebKit 1006 sometimes 1011, Firefox 1006 — but reconnect-jitter differs | Subtle, all three | One-engine sample misses cross-engine assumption |
| CSS `backdrop-filter` without `-webkit-` prefix — Safari < 14 needs prefix | WebKit | Camofox renders fine — the bug ships |
| `:focus-visible` polyfill collisions with native impl | All three differently | Single-sample baseline can't tell |
| `BroadcastChannel` between iframes with same origin but different document URLs — WebKit isolates more aggressively | WebKit | Camofox sees Firefox's permissive isolation |
| `Notification.permission` granted then revoked — Chromium asynchronously notifies, WebKit silently demotes, Firefox prompts again | All three | Single-sample miss |

The pattern is consistent: real engine differences (rendering, parsing, event ordering, web-API support) silently get baked into vibe-coded apps because the developer tested on Chrome, BugHunter tested on Camofox, and **nobody tested WebKit**. The user's iOS Safari demo breaks; the founder is humiliated.

This spec adds Chromium and WebKit drivers behind the same `BrowserMcpAdapter` contract V49 standardised, plus a cross-browser **reconciliation** step that turns "the same bug seen on three engines" into one cluster (with three confirming occurrences) and "a bug seen on only one engine" into a high-signal divergence cluster.

It does **not** triple the runtime by default. Camofox stays the default fast path; Chromium and WebKit are opt-in flags. The cost story is explicit in §6 below.

---

## 2. Boundaries

### 2.1 In scope

- **Three browser engines:** Chromium (Blink/V8), Firefox/Camofox (Gecko/SpiderMonkey, **already** present), WebKit (WebKit/JavaScriptCore). All three drivable from Linux via Playwright's bundled browsers.
- **Adapter parity:** new `ChromiumBrowserAdapter` and `WebKitBrowserAdapter` classes, both implementing the existing `BrowserMcpAdapter` interface from V49 byte-for-byte. Same call-sites; the adapter is selected by `--browsers` flag and config.
- **Browser-aware finding:** every `BugDetection` carries a new `browser?: BrowserId` field (`'chromium' | 'firefox' | 'webkit'`). Defaulted to `'firefox'` on un-tagged legacy detections so old `bugs.jsonl` files migrate cleanly.
- **Cross-browser cluster reconciliation:** a new post-cluster phase, `phases/cross-browser-reconcile.ts`. Same `bugIdentity` across engines → one cluster with up to three confirming occurrences. Different `bugIdentity` across engines → distinct clusters; the reconciler emits a paired `browser_only_failure` meta-cluster when a bug appears on exactly one engine and the other two passed the same test.
- **Three new BugKinds (meta-kinds):**
  - `browser_only_failure` — same test passed on two engines and failed on one. The diverging engine is the field of interest.
  - `cross_browser_visual_diff` — vision pass shows pixel-level disagreement above threshold across engines (coordinates with V52 visual regression; this is the *cross-engine* flavour).
  - `feature_unsupported_in_browser` — the test attempted an API (`requestIdleCallback`, `Intl.Segmenter`, `popover`, `:has()`, `dialog.showModal()`, IndexedDB cursor, etc.) that is unavailable in the current engine. Useful for "the dev wrote `requestIdleCallback(fn)` with no fallback and it's `undefined` on iOS." Detector source: a feature-availability probe injected via init script + try/catch wrapping per-call.
- **CLI surface:**
  - `--browsers <list>` flag — comma-separated, default `firefox`, accepts `chromium,firefox,webkit` or any subset. Synonyms: `chrome=chromium`, `safari=webkit`, `all=chromium,firefox,webkit`.
  - `--browsers chromium-only` — convenience for "only run on the engine the dev tests on, fastest mode" — equivalent to `--browsers chromium`.
  - `bughunter doctor` reports each configured engine's reachability.
- **MCP surface:** the read-side V30 tools (`bughunt_clusters`, etc.) gain a `browser?: BrowserId` filter; cluster detail surfaces the per-browser occurrence breakdown. No new MCP tools — the existing surface is sufficient because `browser` is just a new filter dimension.
- **Determinism integration:** `--seed N --browsers chromium,firefox,webkit` produces three deterministic per-browser bug logs. Same seed, same engine versions → byte-identical results per engine. Cross-engine results are inherently non-byte-identical; the spec does not promise that.
- **Calibration:** the BugHunter-bench corpus (V44) gains per-browser gold annotations for divergence cases; existing single-browser annotations remain unchanged and apply to all engines unless explicitly per-engine-marked.

### 2.2 Explicitly out of scope

- **Browser version matrices.** "Chromium 120 vs 130" multi-version is not in scope. We pin one version per engine per BugHunter release (the Playwright-bundled version). Going multi-version is a separate spec; the surface area would explode (`browser × version × OS`).
- **Mobile emulation.** V41 owns `--mobile`. V51 does not re-implement it. **Combinatorics rule:** `--mobile --browsers chromium,webkit` is allowed and means "run the mobile pass on these two engines." It does not double-up viewports — V41's viewport set applies, multiplied across engines.
- **Real iOS / real Android devices.** WebKit-on-Linux via Playwright is a faithful enough JavaScriptCore + WebKit2 build that catches ≥95% of "WebKit-only" bugs. Real-device cloud (Sauce, BrowserStack) is V53+.
- **Internet Explorer, Opera Presto, niche engines.** IE is dead. Pre-Blink Opera is dead. KaiOS / Samsung Internet (Blink fork) is covered by the Chromium adapter sufficiently for the vibe-coder cohort.
- **Driving Camofox via Playwright.** Camofox stays on its native MCP transport (V49). Forcing it through Playwright's Firefox driver loses the stealth properties Camofox exists for. Firefox-line is **camofox by default** — not Playwright Firefox.
- **WebDriver BiDi protocol.** Playwright is the chosen unified driver. WebDriver/Selenium is explicitly excluded — the request prohibits it and we have no reason to re-introduce it.
- **Replacing the BrowserMcpAdapter interface.** The V49 contract is the integration seam. New adapters implement it; no new interface.
- **Browser-specific BugKinds beyond the three meta-kinds.** Specific engine quirks (`safari_date_input_text_fallback`, `chromium_focus_order_specific`) are NOT new kinds. They surface as `browser_only_failure` clusters whose `divergingDetectionKind` field is the underlying detector that fired. This keeps the BugKind union from exploding by N×3.
- **Per-engine auto-fix routing.** When `/bughunt fix` repairs a `browser_only_failure`, the fix is engine-agnostic at the source-code level. We do not synthesize per-engine code paths — that's the user's choice. The fix prompt is enriched with the "this only fails on WebKit" context.

### 2.3 External dependencies

- **`playwright-core` ≥ 1.49** — already in `packages/cli` via the `BrowserMcpAdapter` snapshot pipeline (used for CDP-side hooks). Upgrade pinned-version if needed; bundle-size delta is zero (we already ship it).
- **Playwright browser binaries** — `playwright install chromium webkit` (Firefox path is unused; Camofox is the Firefox-line engine). Disk: ~300 MB chromium + ~250 MB webkit. Documented as opt-in install in `bughunter doctor`.
- **Camofox / camofox-mcp** — unchanged. Firefox-line stays camofox-only.
- **No new npm runtime deps.** All capabilities come from playwright-core which is already present.

### 2.4 Headline naming clarification

- The interface stays named `BrowserMcpAdapter` (V49 chose that name; we honour it). The "Mcp" suffix is now a misnomer for non-camofox adapters but renaming the interface is a V49-broke-promise, not V51's problem. Recommend a follow-up V52.x rename to `BrowserAdapter` after V51 lands and proves multiple implementations work — the rename is mechanical at that point.

---

## 3. Architecture decision

Three options were considered.

### Option α — Extend the BrowserMcpAdapter interface to be browser-aware (one adapter, multi-engine internally)

Add a `browser: BrowserId` field to the adapter and a `for(browser)` constructor. Each method dispatches internally to the right engine. Single-class abstraction.

**Pro:** call-sites unchanged. One adapter object.
**Con:** wrong abstraction. The adapter's job is "drive **a** browser." A class that secretly drives three is a god object. Concurrency, error mapping, and disposal all become per-engine concerns hidden in branches. Worse: the call sites of today *implicitly assume single-browser* — they cache `currentTabId`, snapshot results, and screenshots per-adapter. Multiplexing inside the adapter would break that. **Rejected.**

### Option β — Three separate adapters; orchestrator runs them in parallel; reconcile findings post-hoc (RECOMMENDED)

Three concrete classes implement `BrowserMcpAdapter`:
- `CamofoxBrowserMcpAdapter` (existing, V49) → drives the Firefox-line engine via camofox-mcp.
- `ChromiumBrowserAdapter` (new) → drives Playwright Chromium directly.
- `WebKitBrowserAdapter` (new) → drives Playwright WebKit directly.

A new orchestrator phase, `phases/multi-browser-runner.ts`, runs the existing pipeline (`validate → discover → plan → execute → classify → cluster`) once per configured browser. Each per-browser run produces its own intermediate `bugs.jsonl` tagged with `browser`. A new reconcile phase combines them into the final `bugs.jsonl`, deduplicating shared-bug clusters and minting `browser_only_failure` for divergent ones.

**Pro:** every existing detector, classifier, runner, and adapter stays unchanged. The seam between "single-browser runner" and "multi-browser orchestrator" is one new phase. Adapters are independently testable; failures in one engine don't poison the other runs. Determinism per-engine is preserved.
**Con:** wall-clock cost is N× the single-engine cost for the parallel passes. Mitigated via §6 cost-control. Reconciliation logic is non-trivial — but it's bounded to one new file.

### Option γ — Run engine A only and only escalate to B/C on divergence

Use camofox by default; when a test produces a "suspicious" finding (e.g. a layout shift, a console error, an a11y violation), re-run just that test on Chromium and WebKit. Triple cost only on suspect tests.

**Pro:** lower average runtime.
**Con:** masks bugs that are silent on the default engine and only loud on the others. The whole point of cross-browser is that the *primary* engine sees nothing wrong — escalation triggered by primary-engine failure misses by definition. **Rejected.** (Could be revived as a fast pre-pass *in addition to* β, but not as a replacement.)

### Decision: β

The interface is the integration seam V49 already standardised. Implementing it three times keeps responsibilities crisp. The reconcile phase is the only genuinely new logic; everything else is composition. Cost is bounded by the `--browsers` flag default of `firefox` only.

### 3.1 How clustering reconciles across engines

The cluster signature today is roughly `(kind, normalisedRoute, normalisedSelectorOrUrl, normalisedSymptom)`. After per-browser pipelines complete:

1. Each per-browser run computes its own clusters with `bugIdentity = sha256(projectName ⨁ signatureKey)` (V27 seam; `bug-identity.ts:6`).
2. The reconciler walks all three (or fewer) bug stacks and groups by `bugIdentity`:
   - **Hit on ≥2 engines:** one cross-browser cluster. `occurrences` is the union (each tagged with `browser`). `clusterSize` is the sum. `verdict` is the worst across engines. `engines: ['chromium', 'firefox', 'webkit']` lists the engines that confirmed.
   - **Hit on exactly 1 engine, when the other configured engines ran the same test plan and produced no equivalent finding:** mint a `browser_only_failure` meta-cluster pointing at the underlying single-engine cluster. The meta-cluster's `divergingBrowser` is the engine that failed; `confirmingPassEngines` is the engines that passed.
   - **Hit on exactly 1 engine when other engines didn't run the corresponding test (e.g. timeout, infra error):** keep the per-engine cluster as-is; flag `crossBrowserStatus: 'unverified'`. Do NOT mint `browser_only_failure` — we cannot prove the divergence.
3. The reconciled cluster's `bugIdentity` is **stable across engines**: it is `computeBugIdentity(projectName, sharedSignatureKey)` where `sharedSignatureKey` strips engine-specific noise (e.g. user-agent strings, engine version numbers, engine-specific stack-frame line numbers). Engine-specific signature noise is moved into a separate per-occurrence `engineSignatureSuffix` so `bugIdentity` is engine-stable.
4. Visual-diff clusters (`cross_browser_visual_diff`) get their own identity rule: `bugIdentity = computeBugIdentity(projectName, kind:'cross_browser_visual_diff' + route + viewportLabel + diffRegionHash)`. The diffRegionHash is computed from the disagreement bounding-box, not the screenshot pixels themselves (else the identity changes every run).

### 3.2 The `BrowserId` discriminator

```ts
// types.ts
export type BrowserId = 'chromium' | 'firefox' | 'webkit';
// 'firefox' covers both real Firefox and Camofox, since they share a Gecko/SpiderMonkey runtime.
// Sub-distinction (camofox vs vanilla Firefox) is irrelevant for cross-browser parity.
```

Every `BugDetection`, every `BugCluster`, every `Occurrence` gets an optional `browser?: BrowserId`. Defaulted to `'firefox'` on read-back of legacy `bugs.jsonl` (the historical default — the only browser that ever ran).

### 3.3 Discriminated unions over string conventions

`browser_only_failure` is a meta-cluster with explicit fields:

```ts
export type BrowserOnlyFailureCluster = {
  kind: 'browser_only_failure';
  bugIdentity: string;
  divergingBrowser: BrowserId;
  confirmingPassEngines: BrowserId[];
  underlyingDetectionKind: BugKind;        // the actual detector that fired on the diverging engine
  underlyingClusterId: string;             // the per-engine cluster this meta wraps
  occurrences: Array<Occurrence & { browser: BrowserId }>;
  // ... standard cluster fields
};
```

Same shape for `cross_browser_visual_diff` and `feature_unsupported_in_browser`. Avoids string-conventions like `browser:webkit_only_failure` baked into a `kind` string.

---

## 4. BugKinds proposed (meta-kinds only — see §2.2 for why)

Three new kinds in the `BugKind` union. Add **after** the v0.41 mobile kinds (line 180 of `packages/cli/src/types.ts`).

```ts
  // v0.51 cross-browser parity meta-kinds
  | 'browser_only_failure'
  | 'cross_browser_visual_diff'
  | 'feature_unsupported_in_browser'
```

| Kind | Detector | Severity (per V29) |
|---|---|---|
| `browser_only_failure` | Reconciler in `phases/cross-browser-reconcile.ts` mints when ≥2 engines passed and exactly 1 failed the same logical test. Underlying detection is whatever fired on the diverging engine. | Inherits from `underlyingDetectionKind` severity, then **bumped one level up** (a bug that only one engine catches is more likely to be real, less likely to be a flake). Bumping caps at `critical`. |
| `cross_browser_visual_diff` | Pairwise vision-diff between per-engine baseline screenshots at the same route + viewport. Threshold: SSIM < 0.97 OR pixel-diff-area > 1% of frame, *and* the disagreement region is in the rendered content area (not chrome/scrollbar). Coordinates with V52 visual regression — V52 is "this run vs prior run, single engine"; V51 is "this run, engine A vs engine B." Same threshold knob. | `major` |
| `feature_unsupported_in_browser` | Init-script-injected `try {} catch {}` wrapper around a hardcoded list of "frequently-vibe-coded-without-fallback" Web APIs (`requestIdleCallback`, `IntersectionObserver`, `Intl.Segmenter`, `dialog.showModal`, `popover`, `:has()` selector, `BroadcastChannel`, `WebShare`, `Clipboard.write`). When app code calls one and the engine throws `TypeError: undefined is not a function` — emit. | `major` |

The rationale for keeping it to three meta-kinds (rather than dozens of `webkit_date_parse_diverges`-style specifics): the BugKind union already has 100+ entries; adding `(specific class) × 3 (engines)` would push it past 130 and most of the entries would be empty most runs. The meta-kind + `divergingBrowser` field carries the same information at a fraction of the schema cost.

### 4.1 Specific engine-divergence classes (deferred)

The original spec ask listed `focus_order_diverges`, `date_parse_diverges`, `idb_quota_diverges` as candidate kinds. **Decision:** these become *detector implementations* under the meta-kind `browser_only_failure`, not new BugKinds. The detector for `focus_order_diverges` lives in `static/cross-browser-probes/focus-order.ts`; when it fires on a single engine, the reconciler classifies it as `browser_only_failure` with `divergingBrowser` set and `underlyingDetectionKind='focus_lost_after_action'` (or a new sub-kind if needed).

If the post-V51 telemetry shows that one specific divergence dominates (>40% of `browser_only_failure` clusters trace to a single class), promote that class to its own BugKind in V52.x. Until then, meta-kind suffices.

---

## 5. Adapter implementation

### 5.1 Adapter inventory

| Adapter | Engine | Transport | Status |
|---|---|---|---|
| `CamofoxBrowserMcpAdapter` | Firefox/Camofox | MCP (camofox-mcp) | Exists. V49. Unchanged in V51. |
| `ChromiumBrowserAdapter` (new) | Chromium | Playwright direct (`playwright-core` `chromium.launch()`) | NEW |
| `WebKitBrowserAdapter` (new) | WebKit | Playwright direct (`playwright-core` `webkit.launch()`) | NEW |

Both new adapters skip the MCP transport entirely. **Why?**

- camofox-mcp's value-add is *stealth* (anti-bot fingerprints, residential-proxy support). Vibe-coded apps under test are local dev or staging; stealth is irrelevant.
- camofox-mcp adds an MCP hop. We only kept it for Firefox because Camofox **is** camofox-mcp's reason to exist.
- Playwright is already a runtime dep. Spawning `chromium.launch()` is one line; the same is true for `webkit.launch()`. Adding an MCP wrapper around Playwright would be pure ceremony.

Each new adapter is ~600 lines (cf. `CamofoxBrowserMcpAdapter` at ~800 LOC of which 200 is MCP envelope handling we don't need). Most of the 600 is direct Playwright API translation:

```ts
async navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
  const ctx = await this.ensureContext();
  const page = await ctx.newPage();
  if (extraHeaders) await page.setExtraHTTPHeaders(extraHeaders);
  const resp = await page.goto(url, { waitUntil: 'networkidle' });
  this.tabIdToPage.set(this.mintTabId(), page);
  return { url: page.url(), title: await page.title() };
}
```

### 5.2 What changes in the call-sites: factories and selection

V49 introduced `makeBrowserAdapter(config)`. V51 generalises:

```ts
// adapters/browser-adapter-factory.ts (renamed from browser-mcp.ts factory)
export function makeBrowserAdapters(config: ResolvedConfig): Map<BrowserId, BrowserMcpAdapter> {
  const out = new Map<BrowserId, BrowserMcpAdapter>();
  const browsers = config.browsers ?? ['firefox'];
  for (const id of browsers) {
    out.set(id, makeBrowserAdapter(config, id));
  }
  return out;
}

function makeBrowserAdapter(config: ResolvedConfig, id: BrowserId): BrowserMcpAdapter {
  switch (id) {
    case 'firefox':  return makeCamofoxAdapter(config);          // existing V49 factory body
    case 'chromium': return new ChromiumBrowserAdapter({ headless: config.headless ?? true });
    case 'webkit':   return new WebKitBrowserAdapter({ headless: config.headless ?? true });
  }
}
```

The orchestrator in `multi-browser-runner.ts` calls `makeBrowserAdapters` once, fans out the run-loop, and aggregates.

### 5.3 What MCP companion repos are NOT needed

The spec ask raised the question: do we need `chromium-mcp` and `webkit-mcp` companion repos analogous to `camofox-mcp`? **No.**

The camofox-mcp wrapper exists because Camofox itself is shipped as a service (port 9377) with its own REST API; camofox-mcp wraps that REST in MCP. Chromium and WebKit through Playwright are just libraries — there is no service to wrap. Spawning a Playwright instance directly inside BugHunter is the simplest path.

**However**, we DO add a small internal module `packages/cli/src/adapters/playwright-shared.ts` that Chromium and WebKit adapters both consume — context lifecycle, snapshot serialisation (Playwright's `page.locator(...).snapshotForAI()` shape vs. our `snapshot()` shape), screenshot path, etc. Shared by composition, not inheritance.

### 5.4 What the new adapters cannot do (gracefully unimplemented optional methods)

V49's `BrowserMcpAdapter` has many optional methods (V20 network faults, V23 init-scripts, V38 emulateMedia, V41 setViewport, etc.). Mapping:

| Optional method | Chromium | WebKit | Notes |
|---|---|---|---|
| `setViewport` | ✅ via `page.setViewportSize` | ✅ same | Direct |
| `setZoom` | ✅ CDP `Emulation.setPageScaleFactor` | ⚠️ no CDP equivalent — fallback to CSS `transform: scale()` | Document the degraded mode |
| `emulateMedia` | ✅ `page.emulateMedia` | ✅ same | Direct |
| `dispatchSyntheticEvent` | ✅ `page.evaluate` | ✅ same | Direct |
| `setTimezoneOverride` | ✅ `context.setTimezoneId` (newContext-only — V51 caveat) | ✅ same | Document |
| `addInitScript` | ✅ `context.addInitScript` | ✅ same | Direct |
| `applyNetworkFault` | ✅ `page.route(...).fulfill` for fault-injection | ✅ same | New impl; not as feature-rich as camofox-mcp's V20 — document the gaps |
| `routeFulfill` | ✅ `page.route(...).fulfill` | ✅ same | Direct |

For each "✅ same" we reuse the playwright-shared helpers. For each "⚠️ degraded," the adapter returns `{ ok: false, reason: 'webkit_no_zoom_cdp' }` and the caller skips with the existing `adapter_unsupported` path. No interface change.

### 5.5 Determinism (V32 integration)

Each adapter accepts a `seed?: number` constructor arg. Playwright's pseudo-random sources (network jitter simulation, idle-detection timing) are seeded from it. Engine-internal randomness (V8/JSC/SpiderMonkey internal pseudorandom for JIT/GC scheduling) cannot be seeded; we accept this and document it. The frozen-clock and frozen-network V32 paths apply to all three engines via init-scripts and `route` interception, respectively.

---

## 6. Cost / runtime impact

This is the section that determines whether V51 is shipped or shelved. The honest case is:

### 6.1 Default runtime: **unchanged**

`--browsers` defaults to `firefox`. No flag → no change vs. v0.50. `bughunter run` (no flag) on Aspectv3 takes the same wall-clock as today. **Camofox-only fast path is the default.**

### 6.2 Triple-engine runtime: ~2.4× wall-clock, NOT 3×

A naive read says "three browsers = 3× runtime." The actual factor is lower:

- **Per-browser parallelism.** The orchestrator runs the three browser passes **in parallel** by default (one OS process per engine, no shared resource). On a 4-core machine, parallel-3 saturates 75% of cores; on an 8-core CI runner, 37%. Wall-clock for parallel-3 is `max(t_chromium, t_firefox, t_webkit) + reconcile_overhead` — typically 1.0×-1.2× the single-engine wall, *not* 3×.
- **CPU-time** triples (3× the work). Important for cloud CI billing.
- **Memory** triples (each engine has its own context). On a 4 GB BugHunter run, parallel-3 needs ~12 GB. On laptop dev, opt-in `--browsers-serial` runs one engine at a time — slower but fits in 4 GB.
- **Reconcile phase** is O(n log n) on cluster count; for typical 200-cluster runs it adds <2 seconds.

**Realistic numbers** for Aspectv3 (based on V49 telemetry):
- Camofox-only: 18 minutes wall, 4 GB peak.
- `--browsers chromium,firefox,webkit` (parallel): 22 minutes wall, 11 GB peak.
- `--browsers chromium,firefox,webkit --browsers-serial`: 56 minutes wall, 4 GB peak.
- `--browsers chromium-only` (single, for "match prod browser" mode): 14 minutes wall, 4 GB peak. (Faster than camofox because no MCP hop.)

### 6.3 Concurrency model interaction

Today, BugHunter's intra-engine concurrency is `concurrency: 4` (4 parallel test executions per engine). With parallel-3 engines, the global parallelism is 12 — which is **fine** on an 8+-core machine but oversubscribes a 4-core. The orchestrator caps total parallelism at `Math.max(2, os.cpus().length)`:

```ts
const totalParallelism = Math.min(
  config.concurrency * browsers.length,
  Math.max(2, os.availableParallelism())
);
const perBrowserConcurrency = Math.max(1, Math.floor(totalParallelism / browsers.length));
```

Each per-engine pipeline gets its own concurrency budget. Total stays sane.

### 6.4 Cost-control flags

- `--browsers <list>` — pick 1, 2, or 3. Default 1.
- `--browsers-serial` — run engines sequentially instead of in parallel. Lower memory; higher wall-clock.
- `--browsers-only-on-failure` — run additional engines *only* for tests that failed on the primary engine. (Option γ from §3, kept as a flag.) This catches "did our flake reproduce on another engine" but misses cross-engine bugs whose symptom is silent on the primary. Document the limitation.
- `--browsers chromium-only` — explicit single-engine override; equivalent to `--browsers chromium`, named to signal "I know this is a fast-path."

### 6.5 Recommendation

CI: opt-in to `--browsers all` on nightly cron only. PRs run camofox-only as today. Local dev defaults to camofox.

---

## 7. Calibration corpus impact (V44 integration)

The BugHunter-bench repo (`cunninghambe/BugHunter-bench`, V44) has 5 fixture apps, hand-curated gold-standard bug lists, single-engine annotations. V51 needs:

### 7.1 Per-engine gold annotations — minimal additions

For each existing gold-bug entry, add an optional `browsersAffected?: BrowserId[]` field. Default: `['chromium', 'firefox', 'webkit']` (the bug exists on all three). A small subset of bugs is engine-specific — e.g. a Safari-date-input bug should be `browsersAffected: ['webkit']`. The bench README spells out how to add them.

For bug calibration to work cross-engine:
- A bench app gains 5–10 deliberate cross-engine divergences (e.g. a `:has()` selector with no fallback; a `requestIdleCallback` call without polyfill; a `dialog` element relying on Chromium's event order). Each is annotated with `browsersAffected`.
- `bughunter calibrate --app <bench-app> --gold <gold> --browsers all` reports per-engine precision/recall **and** cross-engine reconcile precision (did we cluster the same bug across engines correctly? did we mint `browser_only_failure` for the right divergences?).

### 7.2 Cross-browser-specific metrics (computed post-hoc)

In addition to the existing per-kind precision/recall, add:
- **Cross-engine reconcile precision:** for bugs annotated as cross-engine in gold, fraction correctly clustered into a single `bugIdentity`.
- **Browser-only-failure precision:** for bugs annotated as engine-specific in gold, fraction correctly minted as `browser_only_failure` with the right `divergingBrowser`.
- **False-positive divergence rate:** clusters minted as `browser_only_failure` that gold says are not real bugs (e.g. acceptable rendering differences, UA-string-only differences).

### 7.3 What we do NOT need to add

- Browser-specific gold corpora — just per-bug `browsersAffected` flags on existing corpora.
- New bench apps — the existing 5 are enough for V51 calibration. Cross-engine-heavy apps are a V52+ corpus expansion.

---

## 8. Phasing

Each phase is independently shippable. Together they satisfy the spec.

### V51.1 — Add Chromium adapter

- New `ChromiumBrowserAdapter` implementing `BrowserMcpAdapter` via Playwright direct.
- `--browsers` flag in CLI; accepts only `firefox` or `chromium` in this phase.
- Single-engine runs work for both. **No reconciliation yet** — picking `--browsers chromium` runs the existing pipeline against Chromium and produces a normal `bugs.jsonl` with `browser:'chromium'` tags.
- `bughunter doctor` reports Chromium installation status.
- Calibration bench unchanged; per-engine numbers gained for free.
- Aspectv3 smoke gate: `--browsers chromium` produces a non-empty `bugs.jsonl` and finishes in ≤2× the camofox-only baseline.

**Acceptance:** `bughunter run --browsers chromium <app>` works end-to-end. Per-engine `bugs.jsonl` contains expected detections. Tests in `packages/cli/src/adapters/chromium-browser-adapter.test.ts` cover the same surface as `browser-mcp.test.ts` for the camofox adapter.

### V51.2 — Add WebKit adapter

- New `WebKitBrowserAdapter` (same shape as Chromium adapter).
- Extends `--browsers` to accept `webkit` as well.
- Documented degraded modes (e.g. `setZoom` fallback) for WebKit-only quirks.
- Aspectv3 smoke gate: `--browsers webkit` works; produces clusters specific to WebKit (e.g. on a deliberately-WebKit-broken bench app).

**Acceptance:** same as V51.1, scoped to WebKit. Full per-engine pipeline correctness.

### V51.3 — Cross-browser cluster reconciliation

- `phases/cross-browser-reconcile.ts` ships.
- `--browsers` accepts comma-separated lists; orchestrator runs all configured engines and reconciles.
- Three new BugKinds wired (`browser_only_failure`, `cross_browser_visual_diff`, `feature_unsupported_in_browser`).
- `summary.json` gains `crossBrowser: { engines, browserOnlyFailures: [], visualDiffs: [], unsupportedFeatures: [] }`.
- MCP read-side tools accept `browser` filter parameter.
- Determinism mode (`--seed`) verified across multi-engine runs.
- Calibration: `bughunter calibrate --browsers all <app>` reports per-engine and cross-engine metrics.

**Acceptance:** on a deliberately-engine-divergent bench app, V51.3 mints the expected `browser_only_failure` clusters and dedupes the shared-bug clusters into single per-`bugIdentity` records. Reconcile precision/recall ≥ 0.85 on the calibration corpus.

### V51.4 (optional, follow-up) — Cost-control polish

- `--browsers-only-on-failure` flag.
- `--browsers-serial` flag.
- Memory-pressure detector that auto-falls-back to serial mode if peak RSS exceeds available memory × 0.7.
- Documented runbook for tuning `--browsers` in CI vs. local dev.

**Acceptance:** the cost story in §6 is reflected in CLI flags users can actually invoke.

---

## 9. Acceptance criteria

1. **Default behaviour unchanged.** `bughunter run <app>` (no flags) drives camofox only. Same wall-clock, same memory, same `bugs.jsonl` shape. Verified against the v0.50 baseline run on Aspectv3.
2. **`--browsers chromium`** (single-engine non-default) produces a `bugs.jsonl` populated by Chromium-driven detections, all tagged with `browser:'chromium'`. Pipeline phases (`validate → discover → plan → execute → classify → cluster → emit`) all run unchanged.
3. **`--browsers webkit`** same as above for WebKit.
4. **`--browsers chromium,firefox,webkit`** runs all three engines (parallel by default) and produces a single reconciled `bugs.jsonl`. Each cluster has `engines: BrowserId[]` listing confirming engines.
5. **Cross-engine reconciliation correctness.** On a fixture app with deliberate cross-engine divergence, `bughunter run --browsers all` produces ≥1 `browser_only_failure` cluster per planted divergence, with the correct `divergingBrowser`. Verified by a new `phases/cross-browser-reconcile.test.ts`.
6. **Determinism within engine.** `bughunter run --browsers chromium --seed 42 <app>` twice produces byte-identical Chromium-tagged `bugs.jsonl`. Same for WebKit. Cross-engine bytes are NOT promised identical.
7. **Per-engine cluster identity.** A bug whose root cause exists on all three engines reconciles to **one** `bugIdentity` in the final output. The reconcile phase is responsible. Verified by a unit test on `cross-browser-reconcile.ts`.
8. **Wall-clock budget.** On Aspectv3, parallel triple-engine wall-clock ≤ 2.5× the camofox-only baseline. Measured by the existing perf-regression smoke gate.
9. **Memory budget.** On Aspectv3, parallel triple-engine peak RSS ≤ 14 GB on an 8-core CI runner. Documented; no auto-enforcement (yet — V51.4).
10. **`bughunter doctor`** reports per-engine reachability: `chromium: ok (Playwright 1.49.0)`, `firefox: ok (camofox-mcp http://127.0.0.1:3104)`, `webkit: ok (Playwright 1.49.0)`. Missing engine prints install instructions.
11. **MCP filter support.** `bughunt_clusters({ browser: 'webkit' })` returns only clusters confirmed by WebKit.
12. **Calibration runs cross-engine.** `bughunter calibrate --browsers all <app> --gold <gold>` produces a `report.json` with per-engine and cross-engine precision/recall.
13. **Aspectv3 PR-gate smoke.** A pre-merge smoke run on `--browsers chromium,firefox` (cheaper triple-skipping) finds at least one previously-unseen `browser_only_failure` on Aspectv3 (high prior — Aspectv3's vibe-coded surface has known engine-divergent bugs from manual QA).
14. **No new runtime deps.** `git diff packages/cli/package.json` shows no additions; playwright-core is already pinned.
15. **Lint clean.** `npx eslint . --max-warnings 0` passes for all new files.
16. **Type clean.** `npx tsc --noEmit` zero errors across the monorepo.
17. **All existing tests pass** unchanged. New tests added for new modules; legacy tests do NOT change.

---

## 10. Non-goals

- **IE / Edge Legacy / Opera Presto / KaiOS / Samsung Internet specific drivers.** Modern Edge is Chromium; covered. Samsung Internet is Blink-based; covered for our purposes by Chromium. Anything else is dead.
- **Browser version matrix.** "Chromium 120 vs 130" is V52+ if ever. We pin one version per engine via Playwright's bundled binaries.
- **Mobile-engine emulation beyond V41.** V41 is the mobile spec; V51 composes with it but does not replicate it.
- **Real iOS hardware.** WebKit-on-Linux is faithful enough for our cohort.
- **Driving Camofox via Playwright.** Camofox keeps its MCP transport.
- **MCP companion repos for Chromium / WebKit.** Playwright is a library; no service to wrap.
- **Browser-specific BugKinds (per §4.1).** Defer until telemetry proves a single class dominates.
- **Per-engine fix synthesis.** `/bughunt fix` does not generate per-engine code branches; it generates one fix annotated with the engine context.
- **`browser-mcp.ts` rename.** Mechanical V52.x cleanup.
- **WebDriver / WebDriver-BiDi / Selenium.** Playwright is the chosen unified driver.

---

## 11. Open questions

1. **Should `browser_only_failure` severity be an automatic +1 bump from the underlying detection, or fixed at `major`?** Bumping makes "WebKit-only auth bypass" critical (correct) but also makes "WebKit-only console.warn" unduly loud. Recommend bump-with-cap (see §4) but flag for review.

2. **Should reconciliation tolerance be tunable?** Two engines fail with subtly different signatures (e.g. error-message text differs by engine). Should the reconciler aggressively cluster (loose match) or strictly cluster (exact signature match)? Recommend strict by default with a `--cross-browser-loose` flag for exploratory use.

3. **Does `--browsers all` include camofox or vanilla Firefox?** Today Firefox-line is camofox. If a user explicitly disables stealth, do we offer `--browsers chromium,firefox-vanilla,webkit` as an extension? **Recommend defer** — camofox is the Firefox-line by definition in V51.

4. **Visual-diff threshold for `cross_browser_visual_diff`.** SSIM 0.97 is a starting point. Real UI differences (font-rendering anti-aliasing, scrollbar widths) are below that threshold and would noise the output. Recommend per-region exclusions tuned during V51.3 calibration.

5. **Should we run `--browsers all` on every PR or only on nightly?** PR-gate is sensitive to wall-clock. Recommend nightly + `--browsers all`, PR + `--browsers chromium-only` (the engine the dev tests on).

6. **Does the `feature_unsupported_in_browser` probe-list grow unbounded?** A hardcoded list of "frequently-vibe-coded-without-fallback" APIs is a maintenance sink. Recommend ship 12 in V51.3 and revisit annually.

7. **How do we surface `browser_only_failure` in the summary CLI output?** Today summary lists clusters by kind. A "diverged on" column would help. Recommend add to `summary.json` first; CLI rendering follows.

---

## 12. Risks + escape hatches

- **Risk: Playwright-bundled Chromium / WebKit version drifts away from real-world distribution.** Mitigation: pin Playwright version; `bughunter doctor` reports the bundled version. Document the pinning.
- **Risk: Triple-engine peak memory exceeds CI budgets, jobs OOM-kill.** Mitigation: `--browsers-serial` falls back; V51.4 adds auto-detection. Document in CI templates.
- **Risk: Reconciliation false-clusters real bugs (groups two distinct bugs because `bugIdentity` collides).** Mitigation: V44 calibration corpus includes deliberate identity-collision cases; precision metric guards.
- **Risk: Reconciliation mints `browser_only_failure` for engine-version-only differences (e.g. Chromium 130 vs 120 popover support).** Mitigation: pin engine versions; document them; offer `--cross-browser-strict` to suppress feature-detection-only divergences.
- **Risk: The `cross_browser_visual_diff` overlaps with V52 visual regression and emits double-counted clusters.** Mitigation: V52 is "vs prior run, single engine"; V51 is "vs other engine, this run." Different `bugIdentity` derivations. Coordinated in code review with V52 author.
- **Risk: Per-adapter test maintenance triples.** Mitigation: shared `playwright-shared.ts` module; per-adapter tests are thin wrappers around shared assertions.

---

## 13. Files to touch / add (summary)

### 13.1 Created

| File | Reason |
|---|---|
| `packages/cli/src/adapters/chromium-browser-adapter.ts` | New Chromium driver impl |
| `packages/cli/src/adapters/chromium-browser-adapter.test.ts` | Unit tests |
| `packages/cli/src/adapters/webkit-browser-adapter.ts` | New WebKit driver impl |
| `packages/cli/src/adapters/webkit-browser-adapter.test.ts` | Unit tests |
| `packages/cli/src/adapters/playwright-shared.ts` | Shared Playwright helpers (context lifecycle, snapshot serialisation) |
| `packages/cli/src/phases/multi-browser-runner.ts` | Orchestrator |
| `packages/cli/src/phases/cross-browser-reconcile.ts` | Reconciler |
| `packages/cli/src/phases/cross-browser-reconcile.test.ts` | Unit tests |
| `packages/cli/src/static/cross-browser-probes/feature-availability.ts` | Probe-list generator for `feature_unsupported_in_browser` |
| `docs/specs/V51_CROSS_BROWSER.md` | this spec |

### 13.2 Modified

| File | Change |
|---|---|
| `packages/cli/src/types.ts` | `BrowserId` type; `BugKind` union additions; `browser?` field on `BugDetection` / `Occurrence` / `BugCluster` |
| `packages/cli/src/config.ts` | `browsers: BrowserId[]` config field; CLI flag plumbing |
| `packages/cli/src/cli/run.ts` | Parse `--browsers` flag; dispatch to multi-browser-runner when ≥2 engines configured |
| `packages/cli/src/cli/doctor.ts` | Per-engine reachability checks |
| `packages/cli/src/adapters/browser-mcp.ts` | Generalise `makeBrowserAdapter` to `makeBrowserAdapters` factory |
| `packages/cli/src/cluster/bug-identity.ts` | Add helper to strip engine-specific signature noise before identity derivation |
| `packages/mcp/src/tools/clusters.ts` (V30) | Add `browser` filter param |
| `packages/cli/src/calibrate/run.ts` (V44) | Multi-engine awareness; per-engine + cross-engine metrics |

### 13.3 Untouched (verify)

- `packages/cli/src/adapters/browser-mcp.ts`'s adapter implementation body — unchanged (the camofox path is V49's; V51 does not edit it).
- `phases/discover.ts`, `phases/execute.ts`, `phases/classify.ts`, `phases/cluster.ts` — engine-agnostic; consume the adapter via interface; unchanged.
- All detector implementations (`classify/*`, `static/*`, `discovery/*`) — unchanged. They run per-engine; they don't know about engines.
- Camofox / camofox-mcp source — unchanged.
- Aspectv3 application code — unchanged.

---

## 14. Negative requirements

- Do **not** rename `BrowserMcpAdapter` to `BrowserAdapter` in V51. (Defer to V52.x.)
- Do **not** introduce Selenium or WebDriver. Playwright is the unified driver.
- Do **not** route Chromium or WebKit through camofox-mcp. Direct Playwright.
- Do **not** create per-engine BugKinds (e.g. `webkit_date_parse_diverges`). Use `browser_only_failure` + `divergingBrowser` field.
- Do **not** auto-enable `--browsers all` on any default code path. Camofox-only is the default for cost reasons.
- Do **not** wire engine-specific code paths into detectors. Detectors stay engine-agnostic; per-engine differences emerge in the data and reconcile post-hoc.
- Do **not** expose a Playwright-flavored MCP server. Adapters are libraries inside BugHunter.
- Do **not** change the `BrowserMcpAdapter` interface shape. New fields go on `BugDetection` / `Occurrence` / `BugCluster`, not on the adapter.
- Do **not** strip stealth from camofox. Firefox-line stays camofox.
- Do **not** add per-engine fix synthesis to `/bughunt fix`. The fix is single-shot, engine-aware in context only.
- Do **not** compute `bugIdentity` from per-engine signature noise. Engine-stable identity is the seam that makes reconciliation work.
- Do **not** cap engines at 3. The `BrowserId` type today is `'chromium' | 'firefox' | 'webkit'`; any future addition (e.g. `servo`) extends the union, not the implementation pattern.
- Do **not** double-emit clusters when `cross_browser_visual_diff` overlaps with V52 visual regression. The two systems use different identity derivations and the reconciler dedupes.

---

## 15. Definition of Done (V51.3 = full V51 done)

- [ ] All acceptance criteria in §9 satisfied.
- [ ] V51.1 (Chromium adapter) merged and a smoke run is green.
- [ ] V51.2 (WebKit adapter) merged and a smoke run is green.
- [ ] V51.3 (reconciliation) merged; cross-engine fixture-bug correctly clustered.
- [ ] `npx tsc --noEmit` clean monorepo-wide.
- [ ] `npx eslint . --max-warnings 0` clean.
- [ ] `npm test` green.
- [ ] Aspectv3 nightly cron switched to `--browsers all`; baseline established.
- [ ] PR-gate smoke runs `--browsers chromium-only` for cost reasons; documented.
- [ ] Calibration corpus has per-engine `browsersAffected` annotations on at least 5 bugs.
- [ ] `docs/migrations/v51-cross-browser.md` (follow-up) explains opt-in.
- [ ] PR description references this spec by file name.
- [ ] No new runtime deps in `packages/cli/package.json`.
- [ ] `bughunter doctor` reports per-engine status.

---

## 16. Reference — directly relevant existing files

```
packages/cli/src/adapters/browser-mcp.ts                 # V49 adapter + factory; CamofoxBrowserMcpAdapter
packages/cli/src/types.ts                                # BugKind union (line 29), BugDetection / Occurrence / BugCluster
packages/cli/src/cluster/bug-identity.ts                 # computeBugIdentity — the seam reconciliation extends
packages/cli/src/phases/cluster.ts                       # per-run cluster phase; reconcile runs after this
packages/cli/src/phases/discover.ts                      # screenshotPhase per-viewport pattern (V41 model)
packages/cli/src/cli/run.ts                              # flag parsing + config merge
packages/cli/src/cli/doctor.ts                           # health-check surface
packages/cli/src/cli/main.ts                             # USAGE
packages/cli/src/config.ts                               # BugHunterConfigSchema
SPEC_PATH_TO_EXHAUSTIVE.md                               # §3.1 browser-platform surface; the gap V51 addresses
SPEC_V49_BUGHUNTER_MCP_TRANSPORT.md                      # interface contract V51 implements three times
SPEC_V41_MOBILE_RESPONSIVE.md                            # composes-with pattern; --mobile + --browsers compose
SPEC_V32_DETERMINISTIC_MODE.md                           # per-engine determinism applies
SPEC_V27_CROSS_RUN_HISTORY.md                            # bugIdentity stability across runs (V51 extends to across engines)
SPEC_V44_CALIBRATION_CORPUS.md                           # browsersAffected gold-annotation extension
```

---

End of spec.
