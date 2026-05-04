# SPEC — v0.53 "BugHunter consumer integration with SurfaceMCP v0.3.0 multi-surface"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-05-02
**Issue:** cunninghambe/BugHunter#133
**Upstream spec consumed:** `/root/SurfaceMCP/SPEC_MULTI_SURFACE.md` (SurfaceMCP v0.3.0, PR cunninghambe/SurfaceMCP#20)
**Sibling specs (do NOT overlap):** v0.52 visual regression (orthogonal), v0.51 cross-browser (orthogonal). v0.43 agentic detection (uses BugDetection.endpoint; we add `surface` next to it, not on top of it).
**Out of scope (firm):** cross-surface test composition (e.g. log in to surface A, exploit surface B); federated rate limits; hot-reload of the surface set.

---

## 1. Problem statement

SurfaceMCP v0.3.0 ships first-class multi-surface. `surface_list_surfaces` returns N entries; tools are prefixed `<surface>:<bareName>`; meta-tools that previously addressed the implicit single surface (`surface_describe_self`, `surface_list_pages`, `surface_list_navigations`, `surface_login_status`, `surface_relogin`, `surface_describe_auth`, `surface_routes_for_page`, `surface_enumerate_routes_runtime`, `surface_postprocess_runtime_routes`) now require an explicit `surface: string` argument when more than one is configured. Without it, SurfaceMCP returns either `surface_required` (hard abort) or implicitly resolves to surface zero (silent leak — strictly worse).

BugHunter's pipeline at `/root/BugHunter/packages/cli` was written against the implicit-single-surface contract. `discoverPages` calls `surface_describe_self()` with no argument (`packages/cli/src/discovery/pages.ts:29`). `runValidate` calls `surface_login_status({ role })` per role with no surface (`packages/cli/src/phases/validate.ts:131`). `runDiscover` walks `surface_list_tools()` once for the whole run. The result against the 6-surface deliberate-bugs fixture (`/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json` — `self-api`, `self-spa`, `race-bad`, `idor-bad`, `v24-deferred-bugs`, `pen-bad`):

- `surface_describe_self()` returns `self-api` (the legacy surface-zero shim per v0.3.0 § 7.2).
- BugHunter sees `stack === 'openapi'` → `discoverPages` returns `[]` → planner emits zero UI tests.
- All UI-origin BugKinds (`coop_coep_violation`, `seo_*`, `react_error`, `accessibility_critical`, `axe_color_contrast_strong`, `keyboard_trap`, `slow_lcp`, `memory_leak_*`, `visual_anomaly`, `i18n_*`, etc.) are unreachable.
- Smoke #9 (the cross-cutting kind-coverage smoke for v53) saw **8 of 105** golds matched: 7.6% recall vs. a structural maximum of ~80+/105 if both UI and API surfaces actually got served.

The deeper goal of this spec: honest recall measurement against any fixture with a frontend. The lever is one — promote BugHunter from single-surface consumer to multi-surface aware.

---

## 2. Goals / non-goals

### 2.1 In scope

- **Adapter contract change.** Every method on `SurfaceMcpAdapter` that hits a meta-tool requiring per-surface routing accepts an explicit `surface: string` first argument. The HTTP impl threads it through to the MCP call params (`{ surface, ... }`).
- **Topology discovery.** BugHunter calls `surface_list_surfaces` at run start, learns the surface set, and runs the discover→plan→execute pipeline once per `ready` surface (Architecture decision A — see § 3).
- **Cluster signature includes surface.** Same kind on different surfaces becomes two clusters by default. Explicit per-kind exceptions are listed in § 5 for kinds that semantically span surfaces (e.g. `oversized_bundle`, `memory_leak_suspected:run`).
- **Per-surface auth model.** Today `config.auth = { kind: 'none' }` is top-level. Tomorrow `config.surfaces?.[name]?.auth` is per-surface, with the existing `config.auth` retained as a default fall-through. Existing single-surface configs work unchanged.
- **Telemetry attribution.** Every emitted `BugDetection` carries `surface: string`. The run summary aggregates clusters by surface alongside the existing aggregation by kind.
- **Failure isolation surfacing.** If SurfaceMCP reports a surface in `state.kind === 'failed'` (per upstream § 9), BugHunter logs it, skips its pipeline, and includes it in the run summary. Sibling-surface pipelines proceed unimpeded.
- **Backwards-compatibility shim.** A v0.42 single-surface user upgrading to v0.43 sees **zero** behaviour changes. The single-surface fast path stays bare-name and stays auth-top-level.

### 2.2 Out of scope (firm)

- **Cross-surface test composition.** No "log in to surface A, then call surface B with A's session." Roles stay private to their surface, mirroring upstream § 10.3.
- **Federated rate limits.** Each surface gets its own `apiConcurrency`; we do not add a global cap across surfaces.
- **Hot-reload of the surface set.** SurfaceMCP requires a process restart to add/remove surfaces (upstream § 2.2). BugHunter takes the topology once at run start; we do not refresh mid-run.
- **Cross-surface clustering by intent.** A finding observed on `self-api` is a different cluster from the same finding on `idor-bad` even when the kinds match. The two exceptions in § 5.4 (`oversized_bundle`, `memory_leak_suspected:run`) are explicitly named; everything else is per-surface.
- **Pipeline parallelism across surfaces.** Architecture B (one pipeline, surface-aware throughout) is named in § 3 as the eventual destination. v53 ships A.
- **Repo split.** This is BugHunter-internal. No move to a new package. No new dependencies.

---

## 3. Architecture decision: per-surface pipeline pass (Architecture A)

Two options were on the table:

- **A — N pipelines, one per surface.** `for (const surface of surfaces) { discover; plan; execute; }`. Simpler to reason about. Each pipeline is single-surface; existing code paths reuse. Aggregate clusters at the end. Cost: N × wall clock for the discover/plan/execute phases; budget caps still apply per-pipeline (see § 6.2).
- **B — One pipeline, surface-aware throughout.** Every phase takes `surfaces: Surface[]` and iterates internally. Faster (concurrency across surfaces), better for cross-surface clustering, much larger refactor. Touches every phase (`runDiscover`, `runPlan`, `runExecute`, `runValidate`), every detector that emits to a per-page/per-tool aggregate, the resume state shape, and the run summary writer.

**Decision: ship A, name B as v53.4.** A is bounded, single-PR-shippable by a Sonnet coder, reuses existing `runDiscover/runPlan/runExecute` signatures verbatim, and gives the recall lift on day one. B is the eventual destination; we name it in § 11 (Phasing) as a follow-up after we have honest recall numbers from A.

The wrapping pass lives in `packages/cli/src/cli/run.ts` (current orchestration site, lines 464–660). The new wrapper `runMultiSurfacePipeline` calls `runValidate` once globally (it needs to talk to SurfaceMCP) and then iterates surfaces:

```
runMultiSurfacePipeline:
  validation = runValidate({ ... })          // unchanged signature; sees full surface set
  surfaces = await surface.surface_list_surfaces()
  perSurfaceResults = []
  for surfaceSummary of surfaces.surfaces:
    if surfaceSummary.state.kind !== 'ready': continue (logged, in summary)
    surfaceCfg = mergePerSurfaceConfig(config, surfaceSummary.name)
    surfaceAdapter = wrapSurface(surface, surfaceSummary.name)  // see § 4.3
    discovery = runDiscover(projectDir, surfaceCfg, roles, runId, surfaceAdapter, ...)
    plan      = runPlan(runId, discovery, surfaceCfg, roles, surfaceAdapter, ...)
    execute   = runExecute({ ... surface: surfaceAdapter, ... })
    perSurfaceResults.push({ surface: surfaceSummary.name, discovery, plan, execute })
  return aggregate(perSurfaceResults)
```

The body of `runValidate`, `runDiscover`, `runPlan`, `runExecute` does not change shape. They all receive a `SurfaceMcpAdapter` that has a single surface bound to it (via § 4.3's wrapper); they call meta-tools the same way they always did; the wrapper threads the `surface: string` into every MCP request.

Single-surface fast path: when `surfaces.surfaces.length === 1`, the wrapper still wraps but the `surface` arg is a no-op on the wire (single-surface mode in SurfaceMCP per upstream § 5.7). No behaviour change for v0.42 users.

---

## 4. Adapter contract change

### 4.1 Read first

- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — current adapter. ADD methods listed below; do not move the file.
- `/root/SurfaceMCP/SPEC_MULTI_SURFACE.md` § 5.6, § 7.1, § 7.2, § 7.3 — wire-format reference for the new tool plus the legacy fields kept on `surface_describe_self`.

### 4.2 New types

Added to `surface-mcp.ts` (existing file; do not create a new one):

```ts
export type SurfaceLifecycleState =
  | { kind: 'ready' }
  | { kind: 'extracting' }
  | { kind: 'failed'; phase: 'extract' | 'login' | 'detect'; error: string };

export type SurfaceSummary = {
  name: string;
  stack: 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi' | 'vite';
  baseUrl: string;
  state: SurfaceLifecycleState;
  toolCount: number;
  pageCount: number;
  navigationCount: number;
  toolRevision: number;
  capabilities: {
    listPages: boolean;
    listNavigations: boolean;
    enumerateRoutesRuntime: boolean;
    crawlSeed: boolean;
  };
};

export type SurfaceListSurfacesResult = {
  surfaceMcpVersion: string;
  surfaces: SurfaceSummary[];
};
```

The existing `SurfaceDescribeSelfResult` keeps its current fields (legacy single-surface shim; upstream § 7.2 retains them). It additionally gains:

```ts
export type SurfaceDescribeSelfResult = {
  // ...existing fields unchanged...
  /** v0.3.0+: full multi-surface view. Optional — absent on SurfaceMCP < 0.3. */
  surfaceMcpVersion?: string;
  surfaces?: SurfaceSummary[];
};
```

### 4.3 Method signatures

The interface `SurfaceMcpAdapter` adds one method and threads `surface?: string` into every method that today addresses an implicit surface. The argument is **optional**; the back-compat shim in § 4.4 fills it on the wire when omitted in single-surface mode. Coder must not break existing call sites that pass no surface.

```ts
export interface SurfaceMcpAdapter {
  /** v0.3.0+. Returns surface[0]-only legacy on SurfaceMCP < 0.3 — caller must adapt. */
  surface_list_surfaces(): Promise<SurfaceListSurfacesResult>;

  // EXTENDED — surface arg added (optional for single-surface back-compat):
  surface_describe_self(args?: { surface?: string }): Promise<SurfaceDescribeSelfResult>;
  surface_list_pages(args?: { surface?: string; filter?: { pathPrefix?: string; lazy?: boolean } }): Promise<SurfaceListPagesResult>;
  surface_list_navigations(args?: { surface?: string; filter?: { method?: string; kind?: string } }): Promise<SurfaceListNavigationsResult>;
  surface_login_status(args: { role: string; surface?: string }): Promise<SurfaceLoginStatusResult>;
  surface_relogin(args: { role: string; surface?: string }): Promise<{ ok: boolean; error?: string }>;
  surface_describe_auth(args: { role: string; surface?: string }): Promise<DescribeAuthResult>;
  surface_routes_for_page(args: { pagePath: string; surface?: string }): Promise<SurfaceRoutesForPageResult>;
  surface_enumerate_routes_runtime(args?: { surface?: string }): Promise<SurfaceRuntimeEnumScript>;
  surface_postprocess_runtime_routes(args: { raw: unknown; surface?: string }): Promise<SurfacePostprocessResult>;

  // surface_list_tools — already aggregates across surfaces server-side per upstream § 7.3.
  // The adapter adds `filter.surface?: string` for scoping (already in upstream signature):
  surface_list_tools(filter?: {
    method?: string; sideEffect?: string; pathPrefix?: string; confidence?: string;
    surface?: string;  // NEW — optional scope to one surface
  }): Promise<SurfaceListToolsResult>;

  // surface_call, surface_describe_tool, surface_probe, surface_sample_inputs:
  // tool resolution is by name (which is now `<surface>:<bareName>` in multi-surface mode)
  // OR by toolId (globally unique per upstream § 5.5). NO new surface arg here —
  // the prefix on `name` does the routing.
  // ... (other methods unchanged in signature) ...
}
```

The HTTP impl `HttpSurfaceMcpAdapter.mcpCall<T>` already passes `args` straight to the MCP call params. Adding the `surface` field requires no code change in `mcpCall` itself; only the per-method wrappers need to forward the new optional field. The MCP SDK / wire protocol does not change.

### 4.4 Single-surface back-compat shim

The new `BoundSurfaceMcpAdapter` class (added to `surface-mcp.ts` — do not create a new file) wraps an `HttpSurfaceMcpAdapter` and a fixed `surface: string`. Every method automatically threads the bound surface name into the MCP call. This is what `runMultiSurfacePipeline` constructs per surface and passes downward (§ 3). The downstream phases (`runValidate`, `runDiscover`, etc.) call methods without supplying `surface`; the wrapper supplies it. Bound-adapter methods that already take a surface (a no-op for them, e.g. `surface_list_surfaces`) pass through unchanged.

```ts
export class BoundSurfaceMcpAdapter implements SurfaceMcpAdapter {
  constructor(private readonly inner: SurfaceMcpAdapter, private readonly surfaceName: string) {}
  surface_describe_self(args?: { surface?: string }): Promise<SurfaceDescribeSelfResult> {
    return this.inner.surface_describe_self({ surface: args?.surface ?? this.surfaceName });
  }
  // ... same shape for every other method that takes `surface` ...
  surface_list_surfaces(): Promise<SurfaceListSurfacesResult> {
    return this.inner.surface_list_surfaces();   // global, not surface-scoped
  }
  // ... etc.
}
```

The single-surface fast-path: when `runMultiSurfacePipeline` sees `surfaces.length === 1`, it still constructs a `BoundSurfaceMcpAdapter` for the single surface. SurfaceMCP's single-surface mode (upstream § 5.7) ignores the `surface` arg if it matches the only surface present; the call shape is identical. v0.42 users and v0.42 fixtures see zero observable change.

When `surface_list_surfaces` itself is unavailable (SurfaceMCP < 0.3), the wrapper falls back to constructing a **synthetic single-surface summary** from `surface_describe_self()`'s legacy fields. This handles users on a stale SurfaceMCP without forcing a coupled upgrade. See § 4.5.

### 4.5 SurfaceMCP version detection

`runMultiSurfacePipeline`'s first call is `surface_list_surfaces`. If it throws (tool not present on SurfaceMCP < 0.3), we fall back to:

```
fallback:
  legacy = await surface.surface_describe_self()
  return {
    surfaceMcpVersion: '<unknown:legacy>',
    surfaces: [{
      name: legacy.name,
      stack: legacy.stack,
      baseUrl: legacy.baseUrl,
      state: { kind: 'ready' },
      toolCount: 0, pageCount: 0, navigationCount: 0,
      toolRevision: legacy.toolRevision,
      capabilities: { ...legacy.capabilities, listNavigations: legacy.capabilities.listNavigations ?? false,
                      enumerateRoutesRuntime: legacy.capabilities.enumerateRoutesRuntime ?? false,
                      crawlSeed: legacy.capabilities.crawlSeed ?? false },
    }],
  }
```

This is the last back-compat seam. After v53 ships, everything downstream sees the v0.3+ shape regardless of upstream version. A `log.info` records which path we took (`multi_surface_topology: native | legacy_shim`) for diagnostic clarity.

### 4.6 Negative requirements (DO NOT)

- **DO NOT** introduce a new file outside `packages/cli/src/adapters/surface-mcp.ts`. The wrapper class lives in the same file as the interface and the HTTP impl.
- **DO NOT** add a "default surface" parsing of bare tool names on the BugHunter side. SurfaceMCP rejects bare names in multi-surface mode with `bare_name_ambiguous` (upstream § 5.7). The adapter passes through what `surface_list_tools` returns — already prefixed in multi-surface configs.
- **DO NOT** widen the `mcpCall` SSE branch to accept anything new. The wire format is unchanged.
- **DO NOT** strip the legacy `name`/`stack`/`baseUrl`/`toolRevision`/`pageRevision`/`capabilities` fields from `SurfaceDescribeSelfResult`. They remain populated by SurfaceMCP for back-compat (upstream § 7.2). They map to `surfaces[0]` semantics; we do not rely on them in multi-surface code paths but we keep them in the type so single-surface callers compile.
- **DO NOT** touch `SurfaceCallInput` / `SurfaceCallResult`. Tool resolution is by `name` (already prefixed) or `toolId` (globally unique). No new fields needed.

---

## 5. Cluster signature change

### 5.1 Default rule: surface as discriminator

`packages/cli/src/cluster/signature.ts` is updated so that **every** cluster signature begins with `<surfaceName>|`. The same `react_error|message|stack` on `self-spa` and `v24-deferred-bugs` becomes two clusters. This is the right default: a `react_error` in the SPA is a different bug from a `react_error` in the agentic-app fixture; they have different stacks, different reproduction steps, and different fix locations.

### 5.2 Implementation

The function signature stays:

```ts
export function clusterSignature(detection: BugDetection): ClusterKey;
```

The change is internal: a single helper `surfacePrefix(detection)` returns `${detection.surface ?? 'unknown'}|`, and every `case` in the switch prepends it. To avoid 50+ line edits, refactor the function body to compute the existing per-kind suffix into a local `body`, then `return surfacePrefix(detection) + body;`. The set of fields each kind hashes is unchanged.

### 5.3 Detection field addition

`BugDetection` (in `packages/cli/src/types.ts:1213`) gains:

```ts
export type BugDetection = {
  // ...existing fields unchanged...
  /** v0.43+: surface that produced this detection. Set by the detector emit path; never undefined in v0.43+ runs. */
  surface?: string;
};
```

The field is optional in the type for back-compat with replays of pre-v0.43 artifacts. New runs always populate it. The cluster signature treats `undefined` as the literal string `'unknown'` (not as missing) so a malformed detection gets its own cluster rather than silently joining everyone else's.

### 5.4 Per-kind exceptions (cross-surface aggregation)

Two kinds explicitly do NOT include `surface` in the signature:

- **`oversized_bundle`** — describes the bundle on disk. The same Vite SPA shipped under multiple surfaces (e.g. dev vs. staging fixtures) produces the same bundle finding; we cluster across surfaces.
- **`memory_leak_suspected:run`** — already a run-scoped sentinel; the existing signature is the literal string `'memory_leak_suspected:run'`. Adding a surface prefix would split it per-surface, which is wrong (the sentinel is "this run leaked memory; one detector can attribute it later").

Every other kind gets the `<surface>|` prefix. The exceptions are listed by name in a `const SURFACE_AGNOSTIC_KINDS: readonly BugKind[] = [...]` constant adjacent to `clusterSignature`, with a unit test asserting the constant matches the case-by-case expectation.

### 5.5 Test stability

`packages/cli/src/cluster/signature.test.ts` already exists with extensive coverage. The test update is a single fixture transform: every test case that asserts an exact cluster key now wraps the expected value in `'<surface>|' + expected`. Tests with no surface set on the detection assert the `'unknown|'` prefix.

Cluster signatures recorded in v0.42 artifacts are NOT migrated. The clusterCount counter resets across major versions; the on-disk signature change is a tracked behaviour change in the v0.43 release notes.

---

## 6. Per-surface auth model

### 6.1 Read first

- `/root/BugHunter/packages/cli/src/types.ts:1594` — current `BugHunterConfig.auth?: { kind: 'none' }` definition.
- `/root/BugHunter/packages/cli/src/phases/discover.ts:48` — current `config.auth?.kind === 'none'` skip path. This is the tactical-fix call site; the proper fix subsumes it.
- `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/.bughunter/config.json` — existing top-level `auth` shape we must not break.

### 6.2 Schema

Add to `BugHunterConfig`:

```ts
export type BugHunterConfig = {
  // ...existing fields unchanged...
  /** Top-level auth hint. When kind is 'none', browser login is skipped entirely. Default fall-through for surfaces without their own auth. */
  auth?: { kind: 'none' };
  /**
   * v0.43+: per-surface overrides. When a surface name appears here, its `auth` and `roles` win
   * over the top-level `config.auth` and `config.roles`. Surfaces NOT listed inherit top-level.
   * Single-surface configs do not need to populate this and continue to use top-level fields.
   */
  surfaces?: Record<string, {
    auth?: { kind: 'none' };
    roles?: string[];
    /** Per-surface concurrency override. Falls through to top-level concurrency / apiConcurrency. */
    concurrency?: number;
    apiConcurrency?: number;
    /** Per-surface budget cap (ms). Falls through to budgetMs. */
    budgetMs?: number;
    /** Per-surface excludedRoutes (additive with top-level). */
    excludedRoutes?: string[];
  }>;
};
```

Validation (Zod schema where applicable; no new file): `surfaces` keys are strings matching the SurfaceMCP name regex `^[a-zA-Z0-9_-]+$`. Unknown surface keys (not present in the live `surface_list_surfaces` topology) emit a `log.warn` once at validate time but do not abort — the user may have stale config.

### 6.3 Resolution algorithm

`mergePerSurfaceConfig(config: BugHunterConfig, surfaceName: string): BugHunterConfig` computes the effective per-surface config:

```
mergePerSurfaceConfig(config, surfaceName):
  override = config.surfaces?.[surfaceName] ?? {}
  return {
    ...config,
    auth: override.auth ?? config.auth,
    roles: override.roles ?? config.roles,
    concurrency: override.concurrency ?? config.concurrency,
    apiConcurrency: override.apiConcurrency ?? config.apiConcurrency,
    budgetMs: override.budgetMs ?? config.budgetMs,
    excludedRoutes: [...(config.excludedRoutes ?? []), ...(override.excludedRoutes ?? [])],
  }
```

This is the value `runMultiSurfacePipeline` passes to `runDiscover/runPlan/runExecute` for the current surface. Downstream code reads `config.auth?.kind === 'none'` exactly as today; the difference is `config` is now the merged value, not the global one.

### 6.4 Migration semantics

- A v0.42 single-surface config with `config.auth = { kind: 'none' }` and no `config.surfaces` keeps working: every (one) surface inherits the top-level skip-login.
- A v0.42 single-surface config with `config.auth` set and `config.surfaces = { foo: { auth: { kind: 'none' } } }` opts that one surface out of login. Other surfaces still attempt login per top-level.
- The 6-surface BugHunter self-test fixture: top-level `config.auth = { kind: 'none' }` is sufficient because every fixture surface has `auth: { kind: 'none' }` in its `surfacemcp.config.json`. The fixture does not need `config.surfaces`.

### 6.5 The `auth.kind === 'none'` skip path becomes per-surface

`runDiscover` calls `runBrowserLoginPhase(config, ...)` (`packages/cli/src/phases/discover.ts:41`) with the merged config — the skip happens correctly at line 48 (`config.auth?.kind === 'none' ? 'auth.kind=none' : ...`) without code changes there. `runValidate` (the validate-time login probe per role) similarly receives the merged config and skips when the surface's effective auth kind is `'none'`. This subsumes the smoke #9 tactical fix described in § 8.

---

## 7. Telemetry & run summary

### 7.1 BugDetection field

Already specced in § 5.3: `surface: string` populated on emit. The detector emit path (in execute-phase classifiers) gets the surface name from the bound adapter via a new method `getSurfaceName(): string` on `SurfaceMcpAdapter`:

```ts
export interface SurfaceMcpAdapter {
  // ...existing methods unchanged...
  /** v0.43+: returns the bound surface name in single-surface mode, or undefined for the multi-surface root adapter. */
  getSurfaceName?(): string | undefined;
}
```

Implementation: `BoundSurfaceMcpAdapter.getSurfaceName()` returns the bound name. `HttpSurfaceMcpAdapter.getSurfaceName()` returns `undefined`. Detectors that emit `BugDetection` and currently take a `SurfaceMcpAdapter` arg call `surface.getSurfaceName?.()` and stamp the result on the detection. Detectors that don't have an adapter in scope (most of them) get the surface via the `runState` parameter, which `runMultiSurfacePipeline` augments with `runState.currentSurface: string`.

### 7.2 Run summary aggregation

`packages/cli/src/cli/run.ts`'s `summary` writer (current path: writes `runState.bugs.jsonl`, `summary.json`) gains:

```ts
type RunSummary = {
  // ...existing fields unchanged...
  /** v0.43+: one entry per surface that was attempted. Includes failed surfaces. */
  surfaces?: Array<{
    name: string;
    state: SurfaceLifecycleState;
    pipelineRan: boolean;
    discoveredPages: number;
    discoveredApiTools: number;
    testCasesPlanned: number;
    testCasesExecuted: number;
    clustersFound: number;
  }>;
};
```

The aggregate `clustersFound` at the top level is the sum of per-surface clusters, plus the global cross-surface clusters (the § 5.4 exceptions).

### 7.3 Logging

Every log line emitted from a surface-scoped pipeline pass includes `{ surface: <name> }` in its structured-log fields. This mirrors upstream § 3.2's pino pattern and makes per-surface log filtering trivial. The `log` module already accepts arbitrary structured fields; no log-API change is needed.

---

## 8. Tactical fixes from smoke #9 (already in flight)

The smoke #9 agent applied workarounds in its worktree to unblock the cross-cutting smoke:

1. **`packages/cli/src/phases/validate.ts`** — skip the per-role `surface_login_status` / `surface_relogin` probe when `config.auth?.kind === 'none'`. The proper fix (§ 6.5) subsumes this: when the merged-config skip flag is set, the probe is skipped per-surface.
2. **`fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json`** — every surface gained an `{ name: 'anonymous', credentials: {} }` role entry. Without it, SurfaceMCP threw `Unknown role: anonymous` at login probe. **Keep this as fixture hygiene.** It is independent of v53 and the right thing for the fixture regardless. The v53 implementation must NOT depend on the role being declared — `auth.kind === 'none'` should skip the role probe entirely.
3. **`fixtures/bughunter-self-deliberate-bugs/.bughunter/config.json`** — explicit `auth: { kind: 'none' }` was added at the top level. This stays under the v0.43 schema; v53 does not require it to move into `config.surfaces.*.auth`.

The implementation PR for v53.1 supersedes (1) by routing through `mergePerSurfaceConfig`; (2) and (3) remain in place as fixture state.

---

## 9. Existing code map

### 9.1 Files you MUST read before writing any code

- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — the contract surface; ADD types, ADD `BoundSurfaceMcpAdapter`, EXTEND existing methods. Do NOT create a new file.
- `/root/BugHunter/packages/cli/src/phases/validate.ts` — login probe loop at line 130; consume merged config.
- `/root/BugHunter/packages/cli/src/phases/discover.ts` — orchestrator; passes `config.auth?.kind === 'none'` at line 48. This call site does not change; the `config` it receives is now the merged value.
- `/root/BugHunter/packages/cli/src/phases/plan.ts` — planner consumes `discovery.apiTools` and `discovery.pages`; per-surface call is unchanged.
- `/root/BugHunter/packages/cli/src/phases/execute.ts` — runs tests; receives merged `config`, bound `surface`, and a populated `runState.currentSurface`.
- `/root/BugHunter/packages/cli/src/discovery/pages.ts:29` — calls `surface.surface_describe_self()` with no arg. After v53 the `surface` here is a `BoundSurfaceMcpAdapter`, so the no-arg call still works (the wrapper supplies the name). NO change needed at the call site.
- `/root/BugHunter/packages/cli/src/cluster/signature.ts` — surface prefix added per § 5.
- `/root/BugHunter/packages/cli/src/types.ts` — `BugHunterConfig`, `BugDetection`, `RunSummary` updates per § 6 and § 7.
- `/root/BugHunter/packages/cli/src/cli/run.ts` — orchestration site at lines 464–660; ADD `runMultiSurfacePipeline` wrapping the existing per-phase calls.
- `/root/SurfaceMCP/SPEC_MULTI_SURFACE.md` — the wire-format reference.
- `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs/.bughunter/config.json` and `surfacemcp.config.json` — the integration target.

### 9.2 Patterns to follow

- **Adapter wrapping** mirrors the existing `HttpSurfaceMcpAdapter` style: a class implementing the interface, all methods delegate, no inheritance gymnastics.
- **Optional fields on existing types** mirror the pattern in `SurfaceDescribeSelfResult` (e.g. `crawlSeed?:`) — comment with the version it was added.
- **Discriminated unions over flag soup** for `SurfaceLifecycleState` per `/root/.claude/CLAUDE.md` § "Type Discipline".
- **Test pattern for cluster signature** mirrors `signature.test.ts`'s existing fixture-and-assert style. Add per-surface test cases adjacent to existing per-kind cases.
- **Log structured fields** mirror upstream § 3.2: `log.info({ surface: name, ... }, 'message')`.

### 9.3 DO NOT

- DO NOT introduce a new file outside this list.
- DO NOT use `as any` to bridge the bound-adapter wrapping. The interface is fully typed; the wrapper class must compile under `strict: true`.
- DO NOT change the `BugHunterConfig` field semantics. Only ADD `surfaces`. The existing `auth`, `roles`, `concurrency`, `apiConcurrency`, `budgetMs`, `excludedRoutes` keep their meaning.
- DO NOT include `surface` in the cluster signature for the two named exceptions (§ 5.4).
- DO NOT split `runValidate` per-surface. It runs once globally and verifies SurfaceMCP / browser MCP reachability. The per-surface login probe inside it is the only thing that becomes per-surface, and it does so by reading the merged config.
- DO NOT make the bound-adapter wrap dynamic-method based (`Proxy`, etc.). Explicit method delegation only — TypeScript needs to verify each call site.
- DO NOT introduce concurrency across surfaces in this PR. The `for (const surface of surfaces)` loop is sequential. v53.4 (B) is where parallelism happens.
- DO NOT mutate `process.env` from the orchestrator wrapper. Per-surface state lives in the wrapper's local scope.

---

## 10. Phasing

The v53 family ships in four sub-versions, each independently shippable and verifiable.

### V53.1 — adapter contract change + N-pipeline orchestration + cluster signature

**Scope:** § 4 (adapter), § 3 (orchestrator), § 5 (cluster). The minimum that fixes the recall blocker.

**Done when:**
- `BoundSurfaceMcpAdapter` exists; both pre-existing meta-tool calls thread `surface` to the wire.
- `runMultiSurfacePipeline` runs N pipelines and aggregates results.
- Every `BugDetection` in v0.43+ runs has `surface` set.
- Cluster signature begins with `<surface>|` for all kinds except § 5.4's two exceptions.

### V53.2 — per-surface auth config schema + migration shim

**Scope:** § 6.

**Done when:**
- `config.surfaces?.[name].auth` overrides top-level `config.auth` for that surface.
- v0.42 single-surface configs work unchanged (Acceptance § 12.4 passes).
- The merged-config skip path subsumes the smoke #9 tactical fix.

### V53.3 — telemetry per-surface + run summary attribution

**Scope:** § 7.

**Done when:**
- `summary.json.surfaces[]` is populated.
- Failed surfaces appear with their `state.error` and `pipelineRan: false`.
- Per-surface log-line filtering works (`grep '"surface":"idor-bad"' run.log` returns only that surface's lines).

### V53.4 — single-pass surface-aware pipeline (Architecture B) — **deferred**

Named here for traceability; out of scope for v53. Triggered when (a) wall-clock cost of N pipelines becomes a measurable user-visible problem, OR (b) cross-surface composition use cases (cross-surface auth, cross-surface clustering by intent) become real.

---

## 11. Acceptance criteria

### 11.1 Cross-cutting kind coverage on the 6-surface fixture

Against `/root/BugHunter/fixtures/bughunter-self-deliberate-bugs`, a single BugHunter run after v53.1 must detect both UI-origin and API-origin BugKinds in the same run. Specifically:

- **At minimum one cluster** from `coop_coep_violation`, `seo_*` (any of `seo_title_missing` / `seo_meta_description_missing` / `seo_canonical_missing` / `seo_h1_missing_or_multiple` / `seo_robots_blocking_crawl`), OR `react_error` (UI-origin).
- **AND at minimum one cluster** from `command_injection`, `sql_injection`, OR `auth_bypass_via_unauthed_route` (API-origin).
- Same run, same fixture, no manual surface-by-surface invocation.

The next smoke after #9 (call it smoke #10) asserts this in CI.

### 11.2 Single-surface fixtures unchanged

Running BugHunter v0.43 against any v0.42 single-surface fixture (e.g. `fixtures/v52-visual-regression`, `fixtures/v51-cross-browser`, `fixtures/agentic-stub`) produces a result whose top-level cluster count equals or exceeds the v0.42 baseline. The cluster signatures themselves change (now `<surface>|` prefixed), but the COUNT of distinct clusters is invariant under the surface-prefix renaming.

### 11.3 Multi-surface with missing per-surface auth

A multi-surface config that omits `config.surfaces` entirely and has only top-level `config.auth = { kind: 'none' }` works: every surface inherits the skip-login, no role-probe abort. This is the BugHunter self-test fixture's exact shape.

### 11.4 No abort on legacy auth field absence

If a v0.43 multi-surface config has neither `config.auth` nor `config.surfaces[*].auth`, BugHunter logs a warning and proceeds with default behaviour (attempt login per role per surface, treat failures as soft skips per surface). The CLI must NOT abort on this shape.

### 11.5 SurfaceMCP < 0.3 fallback

A BugHunter v0.43 binary against a SurfaceMCP v0.2.x server (where `surface_list_surfaces` does not exist) falls through to the legacy single-surface shim (§ 4.5) and runs exactly as v0.42 did. Tested in `packages/cli/test/contract/surface-mcp-legacy.contract.test.ts`.

### 11.6 Failed surface isolation

If SurfaceMCP reports surface `pen-bad` as `state.kind === 'failed'`, the run still completes; `surfaces[]` in the summary records the failure; clusters from the other five surfaces are emitted normally. The exit code is non-zero only if the user passed `--fail-on-surface-error` (new optional flag, defaults off).

---

## 12. Test strategy

### 12.1 Unit tests

| Test                                                                          | File (new or existing)                                  |
|-------------------------------------------------------------------------------|---------------------------------------------------------|
| `BoundSurfaceMcpAdapter` threads surface arg into every meta-tool call        | `packages/cli/src/adapters/surface-mcp.test.ts` (NEW)   |
| `BoundSurfaceMcpAdapter.surface_list_surfaces` does NOT inject surface arg    | same                                                    |
| `BoundSurfaceMcpAdapter.surface_call` does NOT inject surface arg             | same                                                    |
| `mergePerSurfaceConfig` — per-surface auth wins over top-level                | `packages/cli/src/cli/run.test.ts` (EXTEND)             |
| `mergePerSurfaceConfig` — top-level auth fall-through                         | same                                                    |
| `mergePerSurfaceConfig` — `excludedRoutes` is additive                        | same                                                    |
| Cluster signature includes surface prefix for `react_error`                   | `packages/cli/src/cluster/signature.test.ts` (EXTEND)   |
| Cluster signature includes surface prefix for `sql_injection`                 | same                                                    |
| Cluster signature does NOT include surface for `oversized_bundle`             | same                                                    |
| Cluster signature does NOT include surface for `memory_leak_suspected`        | same                                                    |
| `runMultiSurfacePipeline` skips `state.kind === 'failed'` surfaces            | `packages/cli/src/cli/run.test.ts` (NEW describe)       |
| Legacy SurfaceMCP < 0.3 fallback constructs a synthetic single-surface summary| `packages/cli/src/adapters/surface-mcp.test.ts` (NEW)   |

### 12.2 Integration tests

`packages/cli/test/integration/multi-surface.integration.test.ts` (NEW):

1. Boot a SurfaceMCP v0.3 against the BugHunter self-test fixture's `surfacemcp.config.json` (6 surfaces). Wait for `surface_list_surfaces` to return all six in `state.kind === 'ready'` (or, where dev servers are not auto-launched, in `failed` with `phase: 'extract'`).
2. Run BugHunter end-to-end with `--max-runtime=120s` and the fixture config.
3. Assert `summary.json.surfaces.length === 6`.
4. Assert `summary.json.surfaces.find(s => s.name === 'self-spa').discoveredPages > 0` (the SPA surface produces UI tests).
5. Assert `summary.json.surfaces.find(s => s.name === 'self-api').discoveredApiTools > 0` (the API surface produces API tests).
6. Assert acceptance § 11.1's UI-origin AND API-origin cluster pair is present.

### 12.3 Contract tests

`packages/cli/test/contract/surface-mcp-multi.contract.test.ts` (NEW):

- Construct `HttpSurfaceMcpAdapter` against a running SurfaceMCP v0.3 with a 2-surface fixture.
- Call `surface_list_surfaces` and assert the response shape matches `SurfaceListSurfacesResult`.
- Construct a `BoundSurfaceMcpAdapter(http, 'surface-a')` and call `surface_describe_self()`. Assert the request body sent on the wire includes `{ arguments: { surface: 'surface-a' } }`.
- Call `surface.surface_call({ name: 'surface-b:get_users', role: 'anon', input: {} })`. Assert the call routes correctly and the result has `revisionAtCall >= 0`.

`packages/cli/test/contract/surface-mcp-legacy.contract.test.ts` (NEW):

- Construct `HttpSurfaceMcpAdapter` against a SurfaceMCP v0.2.x server (or a stub that throws on `surface_list_surfaces`).
- Call the multi-surface topology resolver (the new helper in `runMultiSurfacePipeline`).
- Assert the legacy fallback synthesizes one `SurfaceSummary` from `surface_describe_self()` and logs `multi_surface_topology: legacy_shim`.

### 12.4 Smoke #10 (CI gate)

`scripts/smoke-multi-surface-coverage.sh` (NEW):

```bash
cd /root/BugHunter/fixtures/bughunter-self-deliberate-bugs
# Boot SurfaceMCP v0.3 + dev servers via the fixture's launchDevCommand entries.
# Boot BugHunter against the fixture.
bughunter run --max-runtime=180s
# Parse the output and assert the acceptance-§ 11.1 cluster pair is present.
node scripts/assert-cross-cutting-coverage.mjs ./.bughunter/runs/latest/summary.json
```

The assertion script returns non-zero if either the UI-origin OR the API-origin cluster set is empty. CI runs this as the v53 acceptance gate.

---

## 13. Failure modes

### 13.1 One surface fails extract (SurfaceMCP-side)

Already isolated server-side per upstream § 9.3. BugHunter sees `state.kind === 'failed'` in `surface_list_surfaces`, skips that surface's pipeline, and surfaces it in `summary.json.surfaces[]` with the upstream `phase` and `error` fields verbatim. Other surfaces' pipelines run unaffected.

### 13.2 A surface has zero tools and zero pages

Common for backend-only surfaces (e.g. `openapi` stack with an empty spec). The pipeline runs, plan emits zero test cases, execute returns immediately, summary records `testCasesExecuted: 0`. No abort.

### 13.3 Tool name has no prefix (legacy single-surface)

The adapter passes whatever `surface_list_tools` returns into subsequent `surface_call` invocations verbatim. Single-surface SurfaceMCP returns bare names; multi-surface returns prefixed. The adapter does no parsing on the tool name; routing is SurfaceMCP's responsibility (upstream § 6.2). BugHunter's only consumer-side requirement is "do not split on `:` and re-assemble" — and it doesn't.

### 13.4 The `surface` field is missing from a `BugDetection`

`clusterSignature` falls back to the literal string `'unknown'` (§ 5.3). The detection still gets a cluster key; the key signals "this run had a detector that forgot to stamp surface" — actionable, not silent.

### 13.5 Per-surface budget exhaustion

Each surface's `runExecute` honours its merged `budgetMs`. If a surface aborts early, the wrapper logs the abort reason and proceeds to the next surface. The aggregate `--max-runtime` across all surfaces is the sum of per-surface budgets — if a user wants a single overall cap, they set top-level `maxRuntimeMs` and per-surface budgets to fractions thereof. The wrapper enforces the global cap by tracking elapsed wall-clock and short-circuiting subsequent surface pipelines once it's exceeded.

### 13.6 Mismatch between BugHunter's expected surface name and SurfaceMCP's reported name

If `config.surfaces.foo.auth` references a surface name `foo` that does not appear in `surface_list_surfaces`, we log:

```
WARN multi_surface: config.surfaces.foo refers to surface 'foo' but live topology has [self-api, self-spa, race-bad, idor-bad, v24-deferred-bugs, pen-bad]. Override is ignored.
```

…and proceed without the override. Soft warning, not a fatal — this matches the v0.42 idiom of "configured roles not in catalog" (which also warns rather than aborts).

---

## 14. Migration story

### 14.1 Existing single-surface user (the most common shape)

Zero changes required. Their `config.auth` (if set) stays at the top level. Their adapter passes through bare tool names per upstream § 5.7's single-surface back-compat. `summary.json.surfaces` gains one entry; the rest of the summary shape is unchanged.

### 14.2 Existing multi-surface user (the BugHunter self-test fixture; hypothetical others)

Top-level `config.auth = { kind: 'none' }` keeps working — the merged config inherits it for every surface. The user gets multi-surface coverage automatically. No code change required.

If they want to vary auth per surface, they add `config.surfaces.foo.auth` per § 6.2 schema.

### 14.3 Release-note language for v0.43

> **v0.43 — first-class multi-surface.** When SurfaceMCP exposes more than one surface via `surface_list_surfaces`, BugHunter now runs its discover/plan/execute pipeline once per surface and aggregates clusters per surface. Existing single-surface users are unaffected. Cluster signatures gain a `<surface>|` prefix (so the same `react_error` on different surfaces is two clusters). The `BugDetection` type gains a `surface` field. New optional config block: `config.surfaces.[name].auth` and friends — see V53_MULTI_SURFACE_CONSUMER.md § 6. CLI: `--fail-on-surface-error` opts into a non-zero exit code when any surface fails.

The release note explicitly calls out the two cross-surface aggregation exceptions (§ 5.4) and the `BugDetection.surface` addition.

---

## 15. Constraints recap

- No new dependencies.
- No file moves outside this repo.
- No SurfaceMCP-side changes (we are the consumer; v0.3.0 is the contract).
- No `as any`. Strict TypeScript throughout.
- Functions max 40 lines (per `/root/.claude/CLAUDE.md`). The wrapper orchestrator is the only one near the cap; if it grows, decompose.
- The spec is implementable by a Sonnet coder without architectural Q&A. Every type, every method, every file is named.
