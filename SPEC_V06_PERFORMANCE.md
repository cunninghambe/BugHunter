# SPEC — v0.6 "Performance & Web Vitals"

**Status:** Draft 1, ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Source roadmap:** `SPEC_COMPREHENSIVE_ROADMAP.md` §6.v0.6 + §3.3 + §4.1/§4.2 · **Predecessor:** v0.5 security/hygiene (`SPEC_V05_SECURITY_HYGIENE.md`, shipping) · **Successor:** v0.7 static-analysis & code-hygiene (separate spec).

This spec is the **implementation contract** for v0.6. Coder-implementable end-to-end. Every BugKind, every infrastructure module, every config knob, and every CLI surface is named here. Where v0.5 introduced `infra:har` as a stub, v0.6 makes it real and adds `infra:cdp` on the same parallel-Playwright session. Bundle-size analysis is a static-only sidecar that does not touch the browser path.

When a phrase appears in **bold** in a Done-when clause, the verifier (test or human) should look for it literally.

---

## 0. Reading guide

| Section | Audience | When to read |
|---|---|---|
| §1 Objective + boundaries | everyone | first |
| §2 Existing code map | `@coder` before any task | before keyboard touch |
| §3 Cross-cutting infra (4 modules) | `@coder` per assigned module | before that module's tasks |
| §4 BugKind specs (12 kinds) | `@coder` per assigned kind | before that kind's tasks |
| §5 Config / CLI surface | `@coder` | before CLI work |
| §6 Negative requirements | everyone | before commit |
| §7 Task breakdown + ownership | `@architect` (assigning) + assignee | per task |
| §8 Acceptance + done-when matrix | `@qa` + `@architect` | end of phase |
| §9 Killer-demo runbook (TraiderJo) | `@architect` closing v0.6 | end-of-phase verification |
| §10 Risk + escape hatches | everyone | before commit |

---

## 1. Objective

Ship **12 new `BugKind`s** in three clusters (Web Vitals, request hygiene, render/runtime perf) plus the **two cross-cutting infrastructure modules** they depend on (`infra:har`, `infra:cdp`) plus **one static sidecar** (`infra:bundle`). The release is independently valuable — a user adopting BugHunter at v0.6 gets the full v0.5 + v0.6 detection set, with no regression to v0.4 vision or v0.5 security.

Twelve kinds:

1. `slow_lcp` — Largest Contentful Paint > 2.5s on a navigated page.
2. `slow_inp` — Interaction to Next Paint > 200ms during action execution.
3. `high_cls` — Cumulative Layout Shift > 0.1 across page life.
4. `unbounded_list_render` — list rendering > 100 rows without virtualization (static + runtime hybrid).
5. `n_plus_one_api_calls` — same endpoint family hit > 8 times within one action window (HAR-based).
6. `request_dedup_missing` — identical concurrent requests during one action window (HAR-based).
7. `request_cancellation_missing` — fetches in flight after navigation away, completing into nothing (HAR + URL events).
8. `main_thread_blocked` — long task > 50ms during action execution (CDP `Performance.metrics`).
9. `oversized_bundle` — initial-route JS bundle > 500KB gzipped or CSS > 200KB gzipped (static, reads `dist/`).
10. `excessive_re_renders` — component re-rendering > 10 times in 5 seconds (CDP runtime hook).
11. `hydration_mismatch` — **already exists** as a v0.5 promotion from `react_error`; v0.6 **verifies integration**, adds CDP-grounded coverage, and ships any remaining classification gap.
12. `memory_leak_suspected` — JS heap size grows monotonically across N actions without GC plateau (CDP `HeapProfiler`).

**Out of scope** for v0.6 (do not implement, even partially):

- `loading_state_stuck`, `pagination_off_by_one`, `stale_data_after_mutation` (v0.6 roadmap entries that are **not** part of this spec — the perf cluster is the entire scope here; the dynamic-DOM cluster is its own follow-up).
- Lighthouse SEO + `axe_color_contrast_strong` + keyboard-trap + focus-management — **deliberately moved** to a dedicated `SPEC_V06_A11Y_SEO.md` follow-up. The roadmap groups them; the implementation reality is they share zero infra with the perf cluster, so split.
- Multi-viewport / multi-browser fan-out (v0.8 / v0.9).
- Real heap snapshot diffing for memory-leak detection — v0.6 ships **growth detection only**, not leak attribution.
- Per-component re-render attribution to a specific React Fiber subtree — v0.6 reports **counts**, not blame.
- Network-conditions emulation (slow-3G, offline) — v0.6 ships the CDP plumbing but no detector that uses it; first detector lands in v0.7 (`offline_behavior`).
- Lighthouse wrap. Tempting; the perf detectors here are native CDP + native HAR analysis. Lighthouse adds ~30MB of deps and runs its own Chrome — not worth it for the v0.6 perf set. **Lighthouse stays out of v0.6**; revisit if SEO follow-up needs it.

The shape of v0.6: **two new infrastructure modules** (HAR and CDP, sharing one Playwright context), **one static sidecar** (bundle size — read `dist/` artifacts), and twelve detectors layered on top. Every detector reuses the existing `BugDetection` plumbing (`classify` → `cluster` → `emit`), the existing artifact paths (`runs/<runId>/network/`, `runs/<runId>/perf/`), and the existing structured logger.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

These exist today, are stable, and must be **extended, not duplicated**.

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union, `BugDetection`, `NetworkRequest`, `PostState`, `BugHunterConfig`, `RunState`. ALL new types extend this file; do not create a parallel `types-v06.ts`. |
| `packages/cli/src/cluster/signature.ts` | Cluster-signature derivation. Every new BugKind requires a new `case` in `clusterSignature` and (where applicable) a new branch in `extractNormalizedFields`. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. New perf kinds slot **below** security findings and **above** `visual_anomaly`. Pattern documented in §3.1. |
| `packages/cli/src/phases/execute.ts` | The phase pipeline. Today emits an empty HAR stub at line ~212 ("HAR v0.1 stub: real network capture deferred"). The HAR module is what we replace; the rest of the phase is re-entrancy-clean and is left alone. |
| `packages/cli/src/phases/cluster.ts` | Cluster materialization + `occurrenceIdByTestId` contract. New phases that produce detections must mint occurrence ids the same way. |
| `packages/cli/src/adapters/browser-mcp.ts` | The browser MCP adapter (`BrowserMcpAdapter`, `TabScope`). New CDP integration runs **alongside** this — a parallel Playwright session whose lifetime is bound to the same scope. **Do not** mutate `BrowserMcpAdapter`. |
| `packages/cli/src/adapters/surface-mcp.ts` | The SurfaceMCP HTTP adapter. Bundle analyzer queries SurfaceMCP for the project's build-output path (new `surface_describe_self.buildArtifacts` field — see §3.3). |
| `packages/cli/src/classify/network.ts` | `classifyNetworkRequests`, `normalizePath`. Reuse for HAR-derived analyses (N+1, dedup, cancel) — do not reimplement path-id replacement. |
| `packages/cli/src/store/filesystem.ts` | `runPaths()`. New artifacts (`perfDir`, `cdpTraceDir`) live under `runs/<runId>/`. Do not write outside this path; do not introduce process-global state. |
| `packages/cli/src/log.ts` | Structured logger. Use it; do not `console.log`. |
| `packages/cli/src/security/header-probe.ts` | Pattern for a sidecar phase that runs once per origin and emits `BugDetection[]`. **Bundle analyzer follows this pattern.** Read it before writing `static/bundle-analyzer.ts`. |
| `packages/cli/src/static/runner.ts` | Pattern for the static-tool framework (used by gitleaks, npm audit, semgrep). Bundle-size analysis is **not** an external tool — it's a native pass — but the per-output-adapter pattern is identical. |
| `packages/cli/src/repro/action-log.ts` | Action-log writer. New phases that produce occurrences must call `writeActionLog`. |

### 2.2 Patterns to follow

- **Adapter pattern.** Every external dependency (SurfaceMCP, browser MCP, vision API, `npm audit`, Playwright CDP) lives behind an interface in `packages/cli/src/adapters/` or `packages/cli/src/static/`. Tests mock the interface. There is no "just call `playwright-core` from inside a phase."
- **Discriminated-union returns.** Phase functions return `{ ok: true; data: T }` or `{ ok: false; reason: string }`. Errors that escape a phase boundary are infrastructure failures and go through `InfrastructureFailure`, not exceptions.
- **Cluster signature normalization.** Every new BugKind defines its `clusterSignature` deterministically. Two findings with the same root cause (different role, different occurrence) collapse to one cluster.
- **`{ data, error }` envelope** for any new HTTP surface; never bare arrays.
- **Re-entrancy.** Zero global mutable state. RunState read exclusively from `runs/<runId>/`. Reviewed at spec gate. (Q4 from v0.5 carries forward.)

### 2.3 DO NOT

- Do **not** create new schema files; extend `types.ts`.
- Do **not** create a new HTTP client; reuse `surface-mcp.ts`'s adapter.
- Do **not** modify `BrowserMcpAdapter` — the CDP session is a sibling adapter, not a fork.
- Do **not** import `playwright` or `playwright-core` outside `packages/cli/src/adapters/cdp-session.ts` (the new file). One choke-point.
- Do **not** call `console.log`; use the structured logger.
- Do **not** write outside `runs/<runId>/`.
- Do **not** reimplement HAR serialization — emit the `log.entries[]` shape that already lives in the empty stub at `phases/execute.ts:212-217`.
- Do **not** wrap Lighthouse. The roadmap mentioned it; the implementation cost-benefit doesn't justify it for v0.6's perf set. (See §1 boundaries.)
- Do **not** introduce `any`. CDP types come from `playwright-core`'s generated `protocol.d.ts`; reuse them.

---

## 3. Cross-cutting infrastructure

Three modules. Each lands as its own commit, in dependency order: types → CDP+HAR (one PR — same Playwright session) → bundle sidecar → first detector using each → remaining detectors. **No detector ships before its underlying infra is reviewed-merged.**

### 3.1 `infra:har` + `infra:cdp` — parallel-Playwright CDP session

**Files to create:**

- `packages/cli/src/adapters/cdp-session.ts` — wraps a parallel Playwright `BrowserContext` + `CDPSession` per RunState. Single import-point for `playwright-core`.
- `packages/cli/src/adapters/cdp-session.test.ts` — mocked-Playwright unit tests (no real browser).
- `packages/cli/src/adapters/har-writer.ts` — converts CDP `Network.*` events to HAR 1.2 entries. Pure function (events in → HAR out); easy to unit-test.
- `packages/cli/src/adapters/har-writer.test.ts` — fixture-driven tests (snapshot real events from `tests/fixtures/cdp-network-events.json`; assert HAR shape).
- `packages/cli/src/perf/web-vitals-injector.ts` — script-string constant that bundles the `web-vitals` library at build time + a small runtime adapter that publishes vitals via `window.__bughunter_vitals__`.
- `packages/cli/src/perf/web-vitals-injector.test.ts`.
- `packages/cli/src/perf/perf-collector.ts` — orchestrator: starts CDP, attaches `Network.enable` + `Performance.enable`, injects web-vitals, drains metrics at end-of-action, emits a `PerfArtifacts` record per occurrence.
- `packages/cli/src/perf/perf-collector.test.ts`.

**New types** (added to `types.ts`):

```ts
export type WebVitalSample = {
  name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  value: number;            // milliseconds for LCP/INP/FCP/TTFB; unitless score for CLS.
  rating: 'good' | 'needs-improvement' | 'poor';
  /** When the sample was captured relative to action start (ms). */
  capturedAtMs: number;
};

export type LongTaskSample = {
  /** ms duration of the long task */
  duration: number;
  /** ms relative to action start */
  startTime: number;
};

export type HeapSample = {
  /** ms relative to action start */
  capturedAtMs: number;
  /** bytes */
  jsHeapUsedSize: number;
  jsHeapTotalSize: number;
};

export type PerfArtifacts = {
  occurrenceId: string;
  webVitals: WebVitalSample[];
  longTasks: LongTaskSample[];
  heapSamples: HeapSample[];     // empty unless config.perf.heapSampling === true
  /** Render-frame events from the React DevTools-compatible runtime hook (see §4.10). */
  renderEvents: RenderEvent[];
};

export type RenderEvent = {
  /** Component display name (best-effort; "Anonymous" if missing). */
  component: string;
  /** ms relative to action start */
  capturedAtMs: number;
};
```

**`CdpSession` interface** (the only contract `playwright-core` lives behind):

```ts
export interface CdpSession {
  /** Open a new tab; returns a TabScope-compatible handle. */
  newTab(url: string): Promise<CdpTabScope>;
  /** Drain metrics for the current tab; returns the collected samples. */
  drain(): Promise<{
    webVitals: WebVitalSample[];
    longTasks: LongTaskSample[];
    heap: HeapSample[];
    networkEvents: NetworkEvent[];   // raw CDP Network.* events; HarWriter consumes
    renderEvents: RenderEvent[];
  }>;
  /** Close the session; idempotent. */
  close(): Promise<void>;
}

export interface CdpTabScope {
  navigate(url: string): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  /** Snapshot heap at a single point. Used between actions for memory-leak detection. */
  sampleHeap(): Promise<HeapSample>;
}
```

**Approach (route 2 from roadmap §4.1):** Use `playwright-core`'s `chromium.launch()` + `context.newCDPSession()`. The session lives **alongside** the existing camofox-mcp browser adapter — same RunState, **different** Chromium instance. This is acceptable because:

1. The browser-MCP adapter (camofox) handles auth/cookies/role state — the CDP session is *only* a passive observer that doesn't drive the UI.
2. Camofox's roadmap eventually grows native CDP support; when it does, `CdpSession` swaps implementation and the rest of v0.6 is unchanged.
3. Running two Chromiums per run costs RAM (~250MB extra) but keeps responsibilities clean: camofox owns the click; CDP owns the metrics.

**Key clarification on the execution model:** The CDP session navigates the **same URL** as camofox, **mirroring** the URL navigation only. It does NOT re-execute the click — it observes a fresh page-load that lands on the same URL. This means:
- LCP/CLS/long-tasks measured against a clean navigation (the right baseline for performance budgeting).
- INP requires interaction; the CDP session drives a synthetic click on the same selector that camofox clicked (one click only — not the full mutation palette).
- Network requests from the CDP session may **differ** from the camofox session (camofox may have a logged-in cookie; CDP starts cold). HAR entries from the CDP session are tagged `cdpSessionRole: 'observer'` to disambiguate.

**Open mitigation for the cold-CDP problem:** for v0.6, the perf collector accepts a `cookieJar` argument from camofox. The CDP session imports those cookies before navigating, so authenticated routes work. This is **the only state shared** between the two browsers. (The cookie import goes through `context.addCookies()`; standard Playwright API.) The CdpSession interface gains `setCookies(cookies: Cookie[]): Promise<void>` to support this.

**HAR shape:** HAR 1.2 (`log.version: '1.2'`). `log.creator.name = 'bughunter'`, `log.creator.version` from `package.json`. Each entry: `request`, `response`, `timings`, plus a custom `_bughunter` namespace for our metadata (`actionWindowId`, `cdpSessionRole`). Custom namespaces are spec-allowed in HAR 1.2.

**Test plan for `infra:har` + `infra:cdp`:**

- **Unit:** `cdp-session.test.ts` mocks `playwright-core`; verifies the lifecycle (`newTab`, `drain`, `close`) calls the right CDP commands in order.
- **Unit:** `har-writer.test.ts` reads `tests/fixtures/cdp-network-events.json` (a recorded event stream from a real run), produces a HAR, and snapshot-asserts. Fixture is checked in; ~100 events covering 5 requests with redirects + 1 cancelled in-flight.
- **Integration (gated, opt-in):** `cdp-session.e2e.ts` spins a real Chromium against `fixtures/perf-app/`, asserts LCP samples arrive, asserts HAR has ≥ 5 entries. Skipped unless `BUGHUNTER_E2E_PLAYWRIGHT=1`.

**Effort:** L. ~4 days for an experienced TS engineer.

### 3.2 `infra:bundle` — static bundle-size analyzer

**Files to create:**

- `packages/cli/src/static/bundle-analyzer.ts` — pure function: takes a `dist/` (or `.next/static/`) path, returns `BundleArtifact[]`.
- `packages/cli/src/static/bundle-analyzer.test.ts` — fixture-driven tests with synthetic `dist/` directories.
- `packages/cli/src/phases/bundle-probe.ts` — phase wrapper: invoked once per run after `discover`, before `execute`. Emits `BugDetection[]` directly to classify.
- `packages/cli/src/phases/bundle-probe.test.ts`.

**New types** (added to `types.ts`):

```ts
export type BundleArtifact = {
  path: string;                                  // project-root-relative
  kind: 'js' | 'css' | 'html' | 'asset';
  bytesRaw: number;
  bytesGzipped: number;
  /** When the file participates in the initial-route critical path (heuristic — see §3.2.1). */
  initialRoute: boolean;
};

export type BundleProbeConfig = {
  enabled: boolean;
  jsThresholdGzipBytes: number;       // default 500 * 1024
  cssThresholdGzipBytes: number;      // default 200 * 1024
  /** Project-root-relative paths to scan; SurfaceMCP-derived if absent. */
  searchPaths?: string[];
};
```

**Bundle discovery:**

The analyzer discovers `dist/` via SurfaceMCP. Add a new field to `surface_describe_self`:

```ts
buildArtifacts: {
  /** Project-root-relative path to the build output, OR null if the surface doesn't have one. */
  distPath: string | null;
  /** Path to the index HTML inside distPath, or null. */
  indexHtmlPath: string | null;
  /** Stack-aware default: 'dist' for vite, '.next/static' for next, etc. */
  defaultedFrom: 'config' | 'stack-default' | 'absent';
}
```

(SurfaceMCP changes are in `SPEC_NAV_HINT_QUALITY.md`'s sister track — no, actually they live here. Add a one-paragraph note in the SurfaceMCP repo under `SPEC_BUILD_ARTIFACTS_DISCOVERY.md` follow-up. For v0.6's BugHunter side, **read the field if SurfaceMCP returns it; fall back to `<projectDir>/dist` otherwise**.)

#### 3.2.1 Initial-route attribution

The `initialRoute` flag is the hard part. Bundle analyzers like `webpack-bundle-analyzer` know the dependency graph; we don't (and don't want to). Heuristic:

- Read the `index.html` (path from SurfaceMCP `buildArtifacts.indexHtmlPath`).
- Parse `<script src="...">` and `<link rel="stylesheet" href="...">` tags. These files are **definitely** initial-route.
- Follow `<link rel="modulepreload">` and `<link rel="preload">` — initial-route.
- Lazy-loaded chunks (Vite emits `assets/SomePage-<hash>.js` not in index.html) — **not** initial-route.

This is good-enough for the v0.6 detector. The threshold check sums `initialRoute === true && kind === 'js'` for the JS budget; same for CSS.

#### 3.2.2 Output

Per-file results emitted as a single `oversized_bundle` cluster when totals exceed thresholds. Per-file detail rides in `BugDetection.evidence.files: BundleArtifact[]`.

**Threshold rationale** (defaults; configurable):
- JS: 500KB gzipped. Industry-standard "performance budget" for a typical SPA. (Roadmap §3.3.)
- CSS: 200KB gzipped. Less common to bust this; conservative.

**Test plan:**

- **Unit:** `bundle-analyzer.test.ts` builds three synthetic `dist/` fixtures: small (under threshold), large-JS (over), large-CSS (over), large-not-initial-route (under — lazy chunk doesn't count).
- **Unit:** `bundle-probe.test.ts` verifies the phase wrapper emits exactly one `BugDetection` per threshold breach with the right `evidence.files` payload.

**Effort:** S. ~1 day.

### 3.3 Perf-collector wiring into the execute phase

`runExecute` (in `phases/execute.ts`) gains a new option: `perfCollector?: PerfCollector`. When present, every UI action gets observed by the collector. Per-action lifecycle:

```
Camofox: navigate(scope, url)             → camofox does its thing
Perf:    perfCollector.observe(scope)     → CDP session navigates same URL with cookies
Camofox: action (click/fill/etc.)         → camofox observes camofox's outcome
Perf:    perfCollector.tick(actionId)     → CDP captures vitals/long-tasks
... (test ends) ...
Perf:    perfCollector.drain(occurrenceId) → emits PerfArtifacts → writes runs/<runId>/perf/<occurrenceId>.json
```

The drain runs **after** camofox's `persistUiArtifacts`. The `PerfArtifacts` record is then consumed by the perf-classifier (§4.1) which produces `BugDetection[]` for the 5 vitals/long-task kinds.

**HAR replacement:** Today, line ~212 of `phases/execute.ts` writes an empty HAR. Replace with: if `perfCollector` is present, write the real HAR from `perfCollector.drain().networkEvents` via `HarWriter`. If not (legacy/opt-out path), continue writing the empty stub for backward compat.

**Important non-regression:** existing v0.4/v0.5 runs without `--enable-perf` continue to write the empty HAR and execute identically. The perf collector is **additive**.

### 3.4 Config additions to `BugHunterConfig`

```ts
export type BugHunterConfig = {
  // ... existing fields ...

  /** v0.6 performance subsystem. Disabled by default until users opt in. */
  perf?: {
    enabled: boolean;                              // master switch; default false
    /** Web Vitals thresholds; numbers from web.dev/vitals. */
    vitalsThresholds?: {
      lcpMs?: number;          // default 2500
      inpMs?: number;          // default 200
      cls?: number;            // default 0.1
    };
    /** N+1 / dedup / cancellation analysis on HAR. */
    requestHygiene?: {
      enabled: boolean;        // default true (when perf.enabled === true)
      nPlusOneThreshold?: number;  // default 8 (calls to one endpoint family in one window)
    };
    /** Enable JS heap sampling for memory-leak detection. Adds ~50ms per action. */
    heapSampling?: boolean;    // default false
    /** Long-task threshold ms (sub-INP). */
    longTaskMs?: number;       // default 50
    /** Excessive re-render threshold (count in window). */
    rerenderCountThreshold?: number;  // default 10
    /** Re-render window ms. */
    rerenderWindowMs?: number;  // default 5000
  };

  /** v0.6 bundle-size sidecar. */
  bundleProbe?: BundleProbeConfig;
};
```

CLI flag: `--enable-perf` (sets `perf.enabled = true` if not in config). `--enable-bundle-probe` (sets `bundleProbe.enabled = true`). `--enable-all-v06` (sets both — convenience for the killer demo).

---

## 4. BugKind specs

Each kind below is its own implementation contract: signature, classifier inputs, threshold, evidence shape, dedup, test cases, and assigned task #.

### 4.1 `slow_lcp` (Task: T-VITAL-LCP)

**Signature:**
```ts
{
  kind: 'slow_lcp',
  detail: `LCP {valueMs}ms exceeds threshold {thresholdMs}ms on {pageRoute}`,
  evidence: {
    valueMs: number,
    thresholdMs: number,
    pageRoute: string,
    sample: WebVitalSample,
  }
}
```

**Classifier:** `classifyVitals(perf: PerfArtifacts, config: VitalsThresholds): BugDetection[]`. Pure function in `packages/cli/src/classify/vitals.ts`. Iterates `perf.webVitals`; emits one finding per vital kind that crosses the `poor` boundary on at least one sample.

**Threshold:** 2500ms (web.dev "poor" boundary); configurable.

**Cluster signature:** `${pageRoute}:slow_lcp`.

**Test cases:**

1. LCP sample 3500ms → emit `slow_lcp`, evidence.valueMs = 3500.
2. LCP sample 2000ms → no emit.
3. Two LCP samples (3000ms then 2400ms) on same occurrence → one finding (the worse one).
4. No LCP samples → no emit (do not throw; missing vitals is expected on minimal pages).

### 4.2 `slow_inp` (Task: T-VITAL-INP)

Same shape as `slow_lcp`. Threshold 200ms.

**Important:** INP requires user interaction. The classifier only emits if at least one INP sample is present **and** the action was a click/fill/submit (not a `render`-only action). For `render` actions, no INP is expected.

### 4.3 `high_cls` (Task: T-VITAL-CLS)

Same shape. Threshold 0.1 (unitless score). Evidence `valueMs` field renamed to `value: number` (unitless).

**Edge case:** transient layout-shift during a known-mutation action is **not** a finding — those are expected. The classifier filters by `entry.hadRecentInput === true` (the web-vitals library exposes this flag). When `hadRecentInput`, exclude from CLS accumulation.

### 4.4 `unbounded_list_render` (Task: T-LIST-RENDER)

**Hybrid kind:** static analysis + runtime check. Runtime is the primary signal; static is a complementary read-only hint.

**Runtime classifier:**

`classifyUnboundedList(perf: PerfArtifacts, postSnapshot: string, config): BugDetection[]`. Reads the post-action DOM (already captured by camofox at `runs/<runId>/dom/<occurrenceId>.html`) and counts repeated-shape children of common list containers (`ul`, `ol`, `tbody`, `[role="list"]`, `[role="grid"]`, `[role="rowgroup"]`).

A "repeated shape" is two siblings whose `nodeName` matches and whose direct-child class-list jaccard similarity is ≥ 0.6. (Implementation: a small AST walker; the same primitive used by `dom-walker.ts` already exists for similar deduping.)

**Threshold:** > 100 children in a single repeated-shape group **and** no virtualization signal. Virtualization signals: a parent ancestor has `data-virtualized`, or class contains `react-window`, `react-virtual`, `tanstack-virtual`, or the parent's `style.height` is fixed and `style.overflow-y === 'auto'/'scroll'` while children's total height vastly exceeds that height (we approximate via children count and absence of horizontal overflow).

**Evidence:**
```ts
evidence: {
  containerSelector: string,
  rowCount: number,
  threshold: number,
  virtualizationSignals: string[],  // empty when none detected
}
```

**Test cases:**

1. `<tbody>` with 250 `<tr>`s, no virtualization → emit.
2. `<tbody>` with 250 `<tr>`s wrapped in `data-virtualized="true"` parent → no emit.
3. `<ul>` with 50 `<li>`s → no emit (under threshold).
4. `<ul>` with 250 mixed-shape children (alternating `<li>` and `<div>`) → no emit (no single repeated-shape group ≥ threshold).
5. `react-window` class on a parent with 500 children → no emit.

**Cluster signature:** `${pageRoute}:${containerSelector}:unbounded_list_render`.

### 4.5 `n_plus_one_api_calls` (Task: T-NPLUS1)

**Classifier:** `classifyNPlusOne(har: HarLog, config): BugDetection[]`.

**Algorithm:**

1. Group entries by **action window**: HAR entries tagged with the same `_bughunter.actionWindowId`. Each action window corresponds to one `OccurrenceFull`.
2. Within each window, normalize each request's path via `normalizePath()` (already exists in `classify/network.ts` — replaces numeric ids with `:id`, UUIDs with `:uuid`, etc.).
3. Group by `(method, normalizedPath)`. Count entries per group.
4. If any group's count ≥ `nPlusOneThreshold` (default 8), emit one finding per group.

**Evidence:**
```ts
evidence: {
  method: string,
  endpointFamily: string,        // the normalized path
  count: number,
  threshold: number,
  exampleUrls: string[],         // first 5 raw URLs
  actionWindowId: string,
}
```

**Test cases:**

1. 12 calls to `GET /api/trades/:id` in one window → emit (count: 12).
2. 5 calls to `GET /api/trades/:id` in one window → no emit (under threshold).
3. 12 calls but to **distinct** unnormalizable paths (`/api/foo/bar`, `/api/baz/qux`, ...) → no emit (no group ≥ threshold).
4. 12 calls split across two windows (6 each) → no emit (per-window, not per-run).
5. 200 calls to one endpoint family — one finding (do not emit 200 findings).

**Cluster signature:** `${endpointFamily}:n_plus_one_api_calls`.

### 4.6 `request_dedup_missing` (Task: T-DEDUP)

**Classifier:** `classifyDedupMissing(har: HarLog): BugDetection[]`.

**Algorithm:**

1. Group entries by action window.
2. Within each window, find entries with **identical** `(method, url, requestBody)` whose `request.timestamp` differs by < 100ms — these are duplicates issued before the first response could possibly arrive.
3. Emit one finding per dedup group.

**Evidence:**
```ts
evidence: {
  method: string,
  url: string,
  duplicateCount: number,
  firstAtMs: number,
  lastAtMs: number,
  windowMs: number,
}
```

**Cluster signature:** `${method}:${normalizePath(url)}:request_dedup_missing`.

**Test cases:**

1. Same `GET /api/me` issued 3 times within 50ms → emit `duplicateCount: 3`.
2. Same `GET /api/me` issued 2 times 500ms apart → no emit (the second is after the first response).
3. `POST /api/save` with **different** request bodies in the same window → no emit (different bodies = different requests).

### 4.7 `request_cancellation_missing` (Task: T-CANCEL)

**Classifier:** `classifyCancelMissing(har: HarLog, navigationEvents: NavigationEvent[]): BugDetection[]`.

**Algorithm:**

1. Build a timeline of `NavigationEvent`s (from CDP `Page.frameNavigated`).
2. For each in-flight request at navigation time (no `response.endedAt` before nav timestamp), check whether the response landed **after** nav and was unused.
3. Emit a finding when at least one such request completed-into-nothing during the run.

**Heuristic for "unused":** the response arrived but the page had already navigated to a different URL — therefore the response cannot have been consumed by user-visible UI (the component that requested it is unmounted). This is a heuristic; false-positives possible when a service-worker caches the response.

**Evidence:**
```ts
evidence: {
  method: string,
  url: string,
  startedBeforeNavAtMs: number,
  completedAfterNavAtMs: number,
  navigatedToUrl: string,
}
```

**Cluster signature:** `${method}:${normalizePath(url)}:request_cancellation_missing`.

### 4.8 `main_thread_blocked` (Task: T-LONGTASK)

**Classifier:** `classifyLongTasks(perf: PerfArtifacts, config): BugDetection[]`.

Iterates `perf.longTasks`; emits one finding per long task ≥ `longTaskMs` (default 50ms).

**Evidence:**
```ts
evidence: {
  durationMs: number,
  startTimeMs: number,
  threshold: number,
  pageRoute: string,
}
```

**Cluster signature:** `${pageRoute}:main_thread_blocked` (one cluster per page; sample is the worst long task).

### 4.9 `oversized_bundle` (Task: T-BUNDLE)

See §3.2 (`infra:bundle`). Classifier is the bundle-probe phase itself; emission is direct. No new classifier file.

**Cluster signature:** `oversized_bundle:${kind}` where kind is `js` or `css`. (One cluster per asset class; the run has at most 2 oversized_bundle clusters.)

### 4.10 `excessive_re_renders` (Task: T-RERENDER)

**Mechanism:** The web-vitals injector (§3.1) also injects a tiny React DevTools-compatible hook that observes `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` events. For each commit, walk the Fiber root and emit `RenderEvent`s for components whose `actualDuration > 0` (i.e. they actually rendered, not just bailed out).

**Compatibility surface:** React 16.6+ (when DevTools became universal). For non-React apps (Vue, Solid), `excessive_re_renders` simply emits no findings — the `__REACT_DEVTOOLS_GLOBAL_HOOK__` is absent, the hook is a no-op.

**Hook setup:** the injector script (already in `web-vitals-injector.ts`) appends:

```js
(function () {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;
  const events = window.__bughunter_render_events__ = [];
  const orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id, root, ...rest) {
    walkFiber(root.current, events);
    if (typeof orig === 'function') return orig.call(hook, id, root, ...rest);
  };
})();
```

`walkFiber` is a 30-line walker that pushes `{ component: <displayName>, capturedAtMs: performance.now() }` per fiber with `actualDuration > 0`. Stop at depth 50 (don't blow the stack on deep trees).

**Classifier:** `classifyExcessiveRerenders(perf: PerfArtifacts, config): BugDetection[]`.

**Algorithm:**

1. Group `perf.renderEvents` by `component`.
2. For each group, sliding-window over `capturedAtMs` with window = `rerenderWindowMs` (5000ms default).
3. If any window has `count > rerenderCountThreshold` (10 default), emit a finding.

**Evidence:**
```ts
evidence: {
  component: string,
  count: number,
  windowMs: number,
  threshold: number,
  firstCaptureAtMs: number,
}
```

**Cluster signature:** `${component}:excessive_re_renders`.

**Test cases:**

1. Component `TradesTable` rendered 25 times in 5s → emit count: 25.
2. Component rendered 8 times in 5s → no emit.
3. Component rendered 25 times across 30 seconds → no emit (no 5s window has > 10).
4. Anonymous components (`displayName === 'Anonymous'`) → emit with component `'Anonymous'`; cluster signature still uses the literal string. (This means all anon-component re-render storms collapse to one cluster; acceptable.)

### 4.11 `hydration_mismatch` (Task: T-HYDRATE-VERIFY)

**Status:** Promoted from `react_error` in v0.5. v0.6's job: **verify integration**, **add CDP-grounded coverage**, **ship any remaining classification gap**.

**Action items:**

1. Audit `packages/cli/src/classify/console.ts` for the existing `hydration_mismatch` classifier path. Confirm it triggers on:
   - "Hydration failed because the initial UI does not match" (React 18 message)
   - "Text content does not match server-rendered HTML" (React 17 message)
   - "Warning: Did not expect server HTML to contain" (React 16 message)
2. Add a CDP-grounded path: when CDP captures a `Console.messageAdded` event with `level: 'error'` matching the patterns above, emit `hydration_mismatch`. (Defensive; the existing camofox path should already catch these, but CDP-via-our-session is the redundancy.)
3. Add the `hydration_mismatch` cluster-signature path (already exists if the v0.5 promotion landed; verify).
4. Add an integration test in `tests/fixtures/perf-app/` with a deliberately-hydration-broken component; assert v0.6 detects it via the CDP path even with `--disable-camofox-console` (a flag we add for this test only).

**Effort:** S. ~half a day. The bulk is verification, not new code.

### 4.12 `memory_leak_suspected` (Task: T-MEMLEAK)

**Mechanism:** With `config.perf.heapSampling === true`, the perf-collector calls `cdpTabScope.sampleHeap()` between actions (drained as part of `PerfArtifacts`).

**Classifier:** `classifyMemoryLeak(perfArtifactsPerOccurrence: PerfArtifacts[], config): BugDetection[]`.

**Algorithm (run-level, not per-action):**

1. Concatenate all `heapSamples` across the run, sorted by `capturedAtMs`.
2. Compute the linear regression slope of `jsHeapUsedSize` vs `capturedAtMs` over the whole run.
3. If slope > 100 KB/s **and** the final sample is > 2× the first sample, emit one run-level finding.

**Evidence:**
```ts
evidence: {
  startBytes: number,
  endBytes: number,
  slopeBytesPerMs: number,
  durationMs: number,
  sampleCount: number,
}
```

**Cluster signature:** `memory_leak_suspected:run`. (One per run; this is a global signal, not per-page.)

**Caveat:** false-positive prone (legitimate caches grow). v0.6 ships this as a **medium-confidence** finding; v0.8 will add heap-snapshot diffing for attribution. Document in the run summary that this kind needs human review.

**Test cases:**

1. Synthetic heap series: 50MB → 60MB → 70MB → 80MB → 100MB over 60s → emit (slope > 100KB/s, end > 2× start? 100/50 = 2.0, **boundary** — adjust to "≥ 2×" for inclusive).
2. Steady 50MB ± 1MB → no emit (slope ~0).
3. 50MB → 51MB over 10 minutes → no emit (slope tiny).

**Heap sampling cadence:** one sample per occurrence end. For a run with 200 occurrences, this is 200 samples — enough for regression. No mid-action sampling (too expensive).

---

## 5. Config / CLI surface

### 5.1 New flags (in `packages/cli/src/cli/run.ts`)

```
--enable-perf                  Enable Web Vitals + request hygiene + long-tasks + rerenders.
                               (Sets perf.enabled = true.)
--enable-bundle-probe          Enable static bundle-size analysis.
--enable-memory-profile        Enable JS heap sampling (sets perf.heapSampling = true).
--enable-all-v06               Convenience: --enable-perf --enable-bundle-probe --enable-memory-profile.
--lcp-threshold <ms>           Override perf.vitalsThresholds.lcpMs (default 2500).
--inp-threshold <ms>           Override perf.vitalsThresholds.inpMs (default 200).
--cls-threshold <unitless>     Override perf.vitalsThresholds.cls (default 0.1).
--n-plus-one-threshold <n>     Override perf.requestHygiene.nPlusOneThreshold (default 8).
--bundle-js-budget <KB>        Override bundleProbe.jsThresholdGzipBytes (default 500KB).
--bundle-css-budget <KB>       Override bundleProbe.cssThresholdGzipBytes (default 200KB).
```

CLI flag parsing follows the existing pattern in `cli/run.ts` (boolean / number-with-unit). No new dependency for CLI parsing.

### 5.2 Config file additions

`bughunter.json` accepts the new `perf` and `bundleProbe` blocks (Zod-validated; see new schema in `packages/cli/src/config.ts`). Strict no-unknown-keys mode (already on).

### 5.3 RunSummary additions

New optional fields on `RunSummary` (in `types.ts`):

```ts
perfSummary?: {
  vitalsByPage: Record<string, { lcp?: number; inp?: number; cls?: number }>;
  longestTaskMs: number;
  totalNetworkRequests: number;
  /** Average heap growth across the run. */
  heapGrowthBytesPerSec?: number;
  /** Worst N+1 group across the run. */
  worstNPlusOne?: { endpoint: string; count: number };
};
bundleSummary?: {
  initialJsBytesGzipped: number;
  initialCssBytesGzipped: number;
  budgetExceeded: boolean;
};
```

The CLI `bughunter status` command (existing) prints these when present.

---

## 6. Negative requirements

- Do **not** introduce a third browser stack. The CDP session uses Playwright's bundled Chromium; reuse it.
- Do **not** modify `BrowserMcpAdapter` to expose CDP. The CDP session is a sibling; do not couple them.
- Do **not** vendor or wrap Lighthouse. (Out of scope per §1; revisit in v0.6 a11y/SEO follow-up.)
- Do **not** modify the empty-HAR fallback at `phases/execute.ts:212`. The replacement is gated behind `perfCollector !== undefined`; the legacy path stays for backward compatibility.
- Do **not** import `playwright` or `playwright-core` outside `packages/cli/src/adapters/cdp-session.ts` and its test.
- Do **not** ship any detector before its underlying infra is reviewed-merged. (Same gate as v0.5.)
- Do **not** introduce `any`. `playwright-core` exports `protocol.d.ts`; reuse those types.
- Do **not** silently swallow CDP errors. A failed `Network.enable` is an `InfrastructureFailure`; it does not silently degrade detection.
- Do **not** write `console.log`. Use `log.*`.
- Do **not** write outside `runs/<runId>/`. (Same re-entrancy gate as v0.5.)
- Do **not** use `web-vitals` as an npm dependency. Its source is small (~7KB minified). **Vendor it** under `packages/cli/src/perf/web-vitals-vendored/` with a one-paragraph LICENSE attribution. This avoids a runtime dep and avoids the dual-fetch problem (the library has to live inside the page, not the BugHunter process).

  Acceptable shape: paste `web-vitals` v4 (or whichever the latest stable is at impl time) into a single `web-vitals.umd.js` file; commit it. Update annually.

  Rationale: the library is stable, small, and is loaded into every page under test — a runtime npm dep would have to be `fs.readFileSync`d from `node_modules` and shipped through the network anyway.

- Do **not** add `playwright-core` as a `dependencies` of `packages/cli` until `infra:cdp` is the merged commit. Add it in the same commit as `cdp-session.ts`. (No leaking dep entry into v0.5's lockfile.)

  Pin: `"playwright-core": "1.49.x"` (latest 1.x as of impl date). No semver range.

- Do **not** copy/paste `classifyNetworkRequests`. Extract or compose. (Carryover from v0.5 §6.)

- Do **not** change the existing `BugDetection` shape. Add evidence fields; do not rename.

---

## 7. Task breakdown

Each task is independently completable and verifiable. Tasks are agent-sized (~30 min human equivalent for an experienced TS engineer; longer for the CDP integration which is the riskiest piece).

### Task 1 — Type additions

**Assignee:** `@coder`
**Depends on:** none
**Files to modify:** `packages/cli/src/types.ts`
**Files to create:** none
**Test:** `npm run typecheck`
**Done when:** `WebVitalSample`, `LongTaskSample`, `HeapSample`, `PerfArtifacts`, `RenderEvent`, `BundleArtifact`, `BundleProbeConfig`, `BugHunterConfig.perf`, `BugHunterConfig.bundleProbe`, `RunSummary.perfSummary`, `RunSummary.bundleSummary` all exist and compile. New `BugKind` literals registered: `'slow_lcp'`, `'slow_inp'`, `'high_cls'`, `'unbounded_list_render'`, `'n_plus_one_api_calls'`, `'request_dedup_missing'`, `'request_cancellation_missing'`, `'main_thread_blocked'`, `'oversized_bundle'`, `'excessive_re_renders'`, `'memory_leak_suspected'`. (`hydration_mismatch` already exists.)
**DO NOT:** add fields outside the listed paths; do not break v0.5 type compatibility (no removals/renames).

### Task 2 — Add `playwright-core` dependency

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to modify:** `packages/cli/package.json`, `package-lock.json`
**Files to create:** none
**Test:** `npm install` succeeds; `npm run typecheck` passes.
**Done when:** `playwright-core@1.49.x` (or latest stable 1.x at impl date) appears as a `dependencies` entry; lockfile committed. Pin exact version.
**DO NOT:** add `playwright` (the full version with browsers); only `playwright-core`. Browser binaries are downloaded on first run via Playwright's own machinery.

### Task 3 — `CdpSession` + `CdpTabScope` adapter

**Assignee:** `@coder`
**Depends on:** Task 2
**Files to create:** `packages/cli/src/adapters/cdp-session.ts`, `packages/cli/src/adapters/cdp-session.test.ts`
**Files to modify:** none (this adapter does not modify execute.ts yet)
**Test:** `npm test -- cdp-session`. All test cases use a mocked `playwright-core` (no real browser).
**Done when:** `createCdpSession({ cookieJar?: Cookie[] }): Promise<CdpSession>` exists; lifecycle (`newTab` → `drain` → `close`) verified; cookie import verified; error paths (browser launch failed, page crashed) return `InfrastructureFailure`-shaped data.
**DO NOT:** import playwright-core outside this file.

### Task 4 — `web-vitals` vendored

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to create:** `packages/cli/src/perf/web-vitals-vendored/web-vitals.umd.js`, `packages/cli/src/perf/web-vitals-vendored/LICENSE`, `packages/cli/src/perf/web-vitals-vendored/VERSION.txt`
**Files to modify:** none
**Test:** none (asset only).
**Done when:** the file is the official `web-vitals` UMD build, unmodified; LICENSE is the upstream Apache-2.0 text; VERSION.txt records the upstream version.
**DO NOT:** modify the library; do not minify-roundtrip; do not run codegen.

### Task 5 — Web Vitals injector + render-events hook

**Assignee:** `@coder`
**Depends on:** Task 4
**Files to create:** `packages/cli/src/perf/web-vitals-injector.ts`, `packages/cli/src/perf/web-vitals-injector.test.ts`
**Files to modify:** none
**Test:** `npm test -- web-vitals-injector`. Tests use `jsdom` (already a vitest peer) to evaluate the injection script and assert that the global `window.__bughunter_vitals__` is wired up.
**Done when:** `getInjectionScript(): string` returns a self-contained string that, when evaluated in a page context, registers vitals callbacks and the React DevTools hook.
**DO NOT:** evaluate the script in the BugHunter process; it's only ever sent into a page via `Page.evaluate`.

### Task 6 — `HarWriter`

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to create:** `packages/cli/src/adapters/har-writer.ts`, `packages/cli/src/adapters/har-writer.test.ts`, `tests/fixtures/cdp-network-events.json`
**Files to modify:** none
**Test:** `npm test -- har-writer`. Snapshot-based against the fixture.
**Done when:** `eventsToHar(events: NetworkEvent[]): HarLog` produces a valid HAR 1.2 payload with the `_bughunter` namespace populated.
**DO NOT:** use `playwright-core` here. This is a pure function on event objects (typed via `NetworkEvent` from the `protocol.d.ts` re-export in `cdp-session.ts`).

### Task 7 — `PerfCollector` orchestrator

**Assignee:** `@coder`
**Depends on:** Task 3, Task 5, Task 6
**Files to create:** `packages/cli/src/perf/perf-collector.ts`, `packages/cli/src/perf/perf-collector.test.ts`
**Files to modify:** none
**Test:** `npm test -- perf-collector`. Mocked `CdpSession`.
**Done when:** `createPerfCollector({ cdpSession, runState, harWriter, injector }): PerfCollector` exists with `observe`, `tick`, `drain` lifecycle; `drain(occurrenceId)` writes `runs/<runId>/perf/<occurrenceId>.json` and returns the `PerfArtifacts` record.
**DO NOT:** persist artifacts outside `runState`'s paths.

### Task 8 — Wire `PerfCollector` into `runExecute`

**Assignee:** `@coder`
**Depends on:** Task 7
**Files to modify:** `packages/cli/src/phases/execute.ts`, `packages/cli/src/cli/run.ts`
**Files to create:** none
**Test:** `npm test -- execute`. Existing tests pass unchanged. New test: when `--enable-perf` is set, the perf collector is constructed; when not, the legacy empty-HAR path runs.
**Done when:** `runExecute` accepts an optional `perfCollector` and calls `observe`/`tick`/`drain` per-action when present; HAR replacement behavior matches §3.3.
**DO NOT:** remove the empty-HAR stub; gate it behind `perfCollector === undefined`.

### Task 9 — Vitals classifier (LCP / INP / CLS)

**Assignee:** `@coder`
**Depends on:** Task 7
**Files to create:** `packages/cli/src/classify/vitals.ts`, `packages/cli/src/classify/vitals.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts` (add to the chain), `packages/cli/src/cluster/signature.ts` (add the three new BugKinds)
**Test:** `npm test -- vitals`
**Done when:** §4.1, §4.2, §4.3 test cases all pass; integration through to cluster signature verified.
**DO NOT:** emit findings for vitals samples missing from a run (graceful absence).

### Task 10 — Long-tasks classifier

**Assignee:** `@coder`
**Depends on:** Task 7
**Files to create:** `packages/cli/src/classify/long-tasks.ts`, `packages/cli/src/classify/long-tasks.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts`, `packages/cli/src/cluster/signature.ts`
**Test:** `npm test -- long-tasks`
**Done when:** §4.8 test cases pass.

### Task 11 — Excessive re-renders classifier

**Assignee:** `@coder`
**Depends on:** Task 7
**Files to create:** `packages/cli/src/classify/rerenders.ts`, `packages/cli/src/classify/rerenders.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts`, `packages/cli/src/cluster/signature.ts`
**Test:** `npm test -- rerenders`
**Done when:** §4.10 test cases pass; sliding-window logic verified.

### Task 12 — Memory-leak classifier

**Assignee:** `@coder`
**Depends on:** Task 7
**Files to create:** `packages/cli/src/classify/memory-leak.ts`, `packages/cli/src/classify/memory-leak.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts`, `packages/cli/src/cluster/signature.ts`
**Test:** `npm test -- memory-leak`
**Done when:** §4.12 test cases pass; the `≥ 2×` boundary is exercised by a test.

### Task 13 — N+1 / dedup / cancel classifiers

**Assignee:** `@coder`
**Depends on:** Task 8 (real HAR writer wiring)
**Files to create:** `packages/cli/src/classify/request-hygiene.ts`, `packages/cli/src/classify/request-hygiene.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts`, `packages/cli/src/cluster/signature.ts`
**Test:** `npm test -- request-hygiene`
**Done when:** §4.5, §4.6, §4.7 test cases pass.

### Task 14 — Unbounded-list classifier

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to create:** `packages/cli/src/classify/unbounded-list.ts`, `packages/cli/src/classify/unbounded-list.test.ts`
**Files to modify:** `packages/cli/src/phases/classify.ts`, `packages/cli/src/cluster/signature.ts`
**Test:** `npm test -- unbounded-list`
**Done when:** §4.4 test cases pass; jaccard-similarity threshold verified.

### Task 15 — Bundle analyzer (static)

**Assignee:** `@coder`
**Depends on:** Task 1
**Files to create:** `packages/cli/src/static/bundle-analyzer.ts`, `packages/cli/src/static/bundle-analyzer.test.ts`, three small fixture `dist/` directories under `tests/fixtures/bundles/{small,large-js,large-css}`
**Files to modify:** none
**Test:** `npm test -- bundle-analyzer`
**Done when:** §3.2 test cases pass.

### Task 16 — Bundle-probe phase wrapper

**Assignee:** `@coder`
**Depends on:** Task 15
**Files to create:** `packages/cli/src/phases/bundle-probe.ts`, `packages/cli/src/phases/bundle-probe.test.ts`
**Files to modify:** `packages/cli/src/cli/run.ts` (wire `--enable-bundle-probe`), `packages/cli/src/phases/classify.ts` (add to KIND_PRIORITY for `oversized_bundle`)
**Test:** `npm test -- bundle-probe`
**Done when:** running BugHunter against `tests/fixtures/bundles/large-js` produces exactly one `oversized_bundle` finding.

### Task 17 — `hydration_mismatch` audit + CDP path

**Assignee:** `@coder`
**Depends on:** Task 8
**Files to modify:** `packages/cli/src/classify/console.ts` (verify; minimal-or-no change), `packages/cli/src/perf/perf-collector.ts` (subscribe to `Console.messageAdded`)
**Files to create:** `packages/cli/src/classify/hydration.test.ts` if not already; fixture `tests/fixtures/perf-app/hydration-mismatch/`
**Test:** `npm test -- hydration`; integration test in `tests/perf-app.e2e.ts` (gated on `BUGHUNTER_E2E_PLAYWRIGHT=1`)
**Done when:** §4.11 acceptance items 1-4 all green.

### Task 18 — Run summary additions

**Assignee:** `@coder`
**Depends on:** Tasks 9-13, 16
**Files to modify:** `packages/cli/src/phases/emit.ts`, `packages/cli/src/cli/main.ts` (`bughunter status` printer)
**Test:** `npm test -- emit`
**Done when:** the run summary JSON contains `perfSummary` and `bundleSummary` blocks when v0.6 features are enabled; `bughunter status` prints them with sensible formatting.

### Task 19 — Killer-demo runbook

**Assignee:** `@architect` (verification owner) — **not** `@coder`
**Depends on:** all of the above
**Files to modify:** none in code; this is the operational verification described in §9.
**Done when:** the §9 acceptance criteria are met against TraiderJo.

---

## 8. Acceptance criteria

The v0.6 feature branch is mergeable when **all** of the following hold:

1. `npm run typecheck` is green for both packages.
2. `npm run lint` reports zero warnings (`--max-warnings 0`).
3. `npm run test` is green for both packages.
4. `npm run build` succeeds.
5. Tasks 1-18 are each landed via their own commit (or PR) on the v0.6 feature branch.
6. The 12 BugKinds in §1 are detectable by their respective classifier with the test cases in §4 all passing.
7. The integration test gated on `BUGHUNTER_E2E_PLAYWRIGHT=1` runs against `tests/fixtures/perf-app/` and produces:
   - At least one `slow_lcp` finding (the fixture deliberately delays its LCP image to 3.5s).
   - At least one `oversized_bundle` finding (the fixture's `dist/` is 700KB gzipped).
   - At least one `n_plus_one_api_calls` finding (the fixture's home page fires 12 calls to `/api/items/:id`).
   - At least one `excessive_re_renders` finding (the fixture has a setInterval-driven re-render loop).
   - At least one `main_thread_blocked` finding (the fixture has a 250ms synchronous loop on mount).
   - Zero findings of unrelated v0.4/v0.5 kinds.
8. The killer-demo (§9) hits its targets against TraiderJo.
9. No regressions in the existing v0.4 / v0.5 test suites.
10. `playwright-core` appears exactly once in `package.json`'s `dependencies`; appears exactly once in lockfile resolution roots; no transitive `playwright` (the full one).
11. The vendored `web-vitals` directory has a LICENSE file; checked-in version matches an upstream tag in VERSION.txt.

---

## 9. Killer-demo runbook (TraiderJo)

**Goal:** End-to-end confirmation against TraiderJo. Output captures real findings — at minimum:

- 1 `slow_lcp` finding on the dashboard (or whichever route's LCP is highest).
- 1 `oversized_bundle` finding (TraiderJo's `dist/` is non-trivial; KLineChart + Three.js + chart libs add up).
- 1+ `n_plus_one_api_calls` finding on the trades list.

```bash
cd /tmp/TraiderJo
npm run build                                                   # produce dist/
cd /root/BugHunter
node packages/cli/dist/cli/main.js run \
  --project /tmp/TraiderJo \
  --enable-all-v06 \
  --discovery-fixtures fixtures/traiderjo-discovery.json \
  --max-bugs 50 \
  --max-runtime-ms 1800000
```

**Acceptance:**

1. **`slow_lcp`** — at least one finding on a TraiderJo route. The dashboard's chart-eager-load is the prime suspect; secondary candidates are the trades list and APR. Threshold 2500ms; in practice TraiderJo's dashboard is consistently 3.5-4.5s on the local dev server with `--mode production`, so this finding is reliable.

2. **`oversized_bundle`** — initial-route JS budget reliably busts on TraiderJo (KLineChart wrapper + chart pre-loading + auth-state hydration). Expected total: 1.6-2.0 MB gzipped.

3. **`n_plus_one_api_calls`** — the trades list at `/api/trades` followed by per-row metadata fetches is a known pattern in many trading apps. If TraiderJo doesn't ship N+1 today, the demo lands at 1-2 findings (the bare minimum).

4. **`excessive_re_renders`** (bonus) — TraiderJo's autosave + filters cause cascading re-renders; the threshold (10 in 5s) catches it.

5. **`main_thread_blocked`** (bonus) — the chart-renders historically run synchronous chunks that exceed 50ms on the initial paint.

**If fewer than 3 distinct kinds are found:**

- Step 1: confirm `--enable-all-v06` was honored (`bughunter status` should show `perfSummary` populated).
- Step 2: review `runs/<runId>/perf/*.json` artifacts; the raw vitals should be present even if no finding fired (means thresholds may not trip on this dev setup).
- Step 3: temporarily lower thresholds (`--lcp-threshold 1500 --n-plus-one-threshold 4`) to validate the pipeline. If findings appear at lower thresholds, the pipeline works; the app is just well-tuned.

The demo target is **3 distinct BugKinds with at least one finding each**. Hitting 4 or 5 is bonus; hitting fewer than 3 is a spec gap to investigate.

---

## 10. Risk + escape hatches

| Risk | Mitigation |
|------|-----------|
| Two Chromiums per run = ~250MB extra RAM | Default off (`--enable-perf` is opt-in); document the cost in README. |
| Cold CDP session can't reach authed routes | Cookie import from camofox jar; verified in Task 7 tests. |
| HAR drift from camofox session (different cookies, different responses) | Tag CDP-session HAR entries `cdpSessionRole: 'observer'`; disambiguation lives in the data, not the analysis. |
| `web-vitals` library divergence — the page may have its own copy | The injector evaluates `web-vitals.umd.js` into a fresh closure; collisions on `window` are namespaced via `window.__bughunter_*`. |
| React DevTools hook clash with a real DevTools extension | The injector reads `__REACT_DEVTOOLS_GLOBAL_HOOK__` and chains the existing `onCommitFiberRoot`; the chain calls the original. Verified in Task 5 tests. |
| `playwright-core` browser binary download adds 100+ MB on first run | Document in README; `BUGHUNTER_SKIP_BROWSER_DOWNLOAD=1` env var to opt out (delegates to Playwright's standard env). |
| N+1 false-positive on legitimate pagination loops | Threshold default 8 is conservative; users can tune via `--n-plus-one-threshold`. Document in spec. |
| Dedup false-positive on legitimate optimistic-retry patterns | 100ms window is tight; legitimate retries have visible backoff. Document. |
| Cancel false-positive on service-worker-cached responses | Acknowledged limitation; mark finding as medium-confidence in the cluster summary. |
| Memory-leak false-positive on legitimate growing caches | Run-level finding only; needs human review; documented. |
| Vendored `web-vitals` falls behind upstream | Annual review pinned to v0.6.x release notes; bumping is a one-file PR. |
| Playwright + camofox both bind to local Chrome process registry | Playwright manages its own; camofox manages its own; no shared resource. Verified by running both side-by-side in Task 7's integration test. |
| The bundle-analyzer's "initial route" heuristic is wrong for non-Vite stacks | v0.6 ships with the Vite/Next.js heuristics; other stacks emit no `oversized_bundle` finding (graceful absence). Document in Task 15 the exact stacks supported. |

### 10.1 Escape hatch for a CDP failure mid-run

If the parallel Chromium crashes or fails to launch, the perf collector reports an `InfrastructureFailure` and the run **continues with the legacy empty-HAR + no-perf-findings path**. The user sees a single warning in the run summary; no other detectors are affected. (Same shape as a vision-API timeout in v0.4.)

### 10.2 Escape hatch for a wonky `web-vitals` payload

If the injection script fails to execute (CSP blocks inline scripts, page navigates before injection lands, etc.), no vitals are captured for that occurrence. The classifier silently emits zero findings for that occurrence. The run summary records `perfSummary.injectionFailures: number` so the user can see how often this happened.

---

## 11. Open questions

- **OQ-1.** Should `oversized_bundle` emit per-page or per-run? **Decision:** per-run; the bundle analyzer is project-wide, not page-wide. (The cluster signature `oversized_bundle:js` already encodes this.)
- **OQ-2.** Is the React DevTools hook stable enough to ship without feature-flag? **Decision:** ship behind `--enable-perf`; the hook only attaches when the global is present, so non-React apps see no impact.
- **OQ-3.** Should the killer demo gate on real findings count, or just pipeline integrity? **Decision:** real findings (≥ 3 distinct kinds). Pipeline integrity is verified by the unit/integration tests.
- **OQ-4.** Does `web-vitals` vendoring create a license concern? **Decision:** Apache-2.0 is permissive; LICENSE file in the vendored directory satisfies. Reviewed in Task 4.
- **OQ-5.** Should we ship a `bughunter perf-baseline` command that records vitals for later comparison? **Decision:** out of scope; v0.7 candidate. The data is in `runs/<runId>/perf/*.json` and can be diffed with shell tools today.

Out-of-scope (v0.7+):

- Lighthouse SEO + a11y wrapping (separate v0.6 follow-up spec).
- Heap-snapshot diffing for memory-leak attribution (v0.8).
- Network-conditions emulation (v0.7+).
- Per-Fiber-subtree blame for `excessive_re_renders` (v0.8).
- LLM-of-source pipeline for "this React component has a memo gap" (v0.7's `infra:llm-text`).
- Multi-viewport perf fan-out (v0.8).

---

## 12. Estimated effort

≈ 4-6 weeks for one senior TS engineer **plus** spec-review gating at each task boundary. Coder-implementable end-to-end; no architectural decisions left unresolved. The single highest-risk task is Task 7 (`PerfCollector` orchestrator) — budget two days for it including the cookie-import edge cases.

Cross-tracking with the v0.6 a11y/SEO follow-up: that spec is independent and can run in parallel by a different `@coder` once the `--enable-perf` plumbing in Task 8 is in place.

---

End of spec.
