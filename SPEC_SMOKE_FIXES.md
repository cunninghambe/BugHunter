# Smoke-Derived Fix Spec — BugHunter v0.1

Source: integration smoke against `/root/spoonworks` on 2026-04-26 with SurfaceMCP `feat/v0.1-implementation`, BugHunter `master`, camofox-mcp HTTP daemon on `127.0.0.1:3104`.

The smoke ran the API-only path end-to-end. 64 tools discovered, Auth.js v5 cookie auto-detection succeeded as `owner`, **183 tests planned, 151 ran, 32 skipped (no browser)**, 100 passed, 0 infrastructure failures, 0 real Spoonworks bugs. Two clusters were false positives explainable as smoke artifacts (one missing-fixture, one probe-inferred-schema gap). The browser path was blocked by `CamofoxBrowserMcpAdapter` returning JSON-parse errors on every call — root cause is not just a tool-name prefix mismatch but a full argument-shape and result-shape drift between the adapter (Playwright-style `selector`/`distance`/`outputPath`) and the live camofox MCP (a11y `tabId`/`ref`/inline-base64).

This spec turns the smoke findings into a contract the coder will implement. **The user has signed off on the full expanded scope** — every defect is specced; nothing is deferred to a future work item except items genuinely outside the smoke's blast radius. Two repositories are in scope: BugHunter (this repo) and SurfaceMCP (sister spec at `/root/SurfaceMCP/SPEC_PROBE_TIGHTENING.md` on branch `spec/probe-and-detection-tightening`, commit `16e1b18`).

---

## 1. Problem statement

The smoke surfaced six concrete defects and three design decisions. They span two repositories:

**BugHunter side**
1. **Bug 1 — `CamofoxBrowserMcpAdapter` is broken end-to-end.** Tool-name prefix mismatch is the surface symptom; underneath, the adapter's argument and result shapes don't match camofox v0.1 at all. Full rewrite required.
2. **Bug 2 — `browserMcpUrl` convention asymmetric with `surfaceMcpUrl`.** Adapter requires `…/mcp` URL while `surfaceMcpUrl` takes a base URL and appends `/mcp`.
3. **Bug 3 — `bughunter init --no-interactive` is silently ignored.** Flag parsed but never threaded into `initCommand`.
4. **Bug 4 — SurfaceMCP local `main` branch is stale (release-hygiene).** Pure git-ops; documented runbook.
5. **CLI improvement — Run summary doesn't surface `planned vs ran vs skipped`.** Diagnosing the camofox failure was harder than necessary.
6. **Question A — Cluster signature merge across kinds.** Add a co-occurrence link (annotative); do not change canonical signatures.
7. **Question B — Body-fixture escape-hatch.** Add `bodyFixtures` to `BugHunterConfig` keyed by `toolId` then `roleName`.

**SurfaceMCP side** (sister spec at `/root/SurfaceMCP/SPEC_PROBE_TIGHTENING.md`)
8. **§ X — `surface_probe` tightening + `'partial'` confidence variant.** Detect manual non-Zod validation via static analysis.
9. **§ Y — `detectExternalIntegrations` precision.** Stop matching free-text inside React page components; restrict to imports.
10. **§ Z — `surfacemcp init` Next.js dev-port autodetection.** Read `package.json scripts.dev` for `-p <port>` / `--port` / env-prefix.

The cross-repo coupling: BugHunter must add `'partial'` to the `InputSchemaConfidence` consumer side and treat it identically to `'unknown'` in `apiTestCases` (i.e. single happy-path call) until a `bodyFixtures` entry covers the tool. The SurfaceMCP spec defines the source-side schema; this spec defines the consumer-side handling.

---

## 2. Existing code map (read these before writing any code)

### BugHunter — files you MUST read before touching anything

- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — full rewrite target for Bug 1; URL normalisation for Bug 2.
- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts:81-126` — pattern to mirror for `browserMcpUrl` normalisation **and** error envelope handling.
- `/root/BugHunter/packages/cli/src/cli/init.ts` — Bug 3.
- `/root/BugHunter/packages/cli/src/cli/main.ts:49-71, 86-88` — flag parsing for Bug 3.
- `/root/BugHunter/packages/cli/src/config.ts:34-58` — Zod schema; extend with `bodyFixtures`.
- `/root/BugHunter/packages/cli/src/types.ts:118-133` (`BugCluster`), `:166-179` (`ToolMeta`), `:316-340` (`BugHunterConfig`).
- `/root/BugHunter/packages/cli/src/cluster/signature.ts:8-33` — Question A reference; `surface_call_failed` line at `:30`.
- `/root/BugHunter/packages/cli/src/phases/cluster.ts:26-98` — Question A: post-cluster annotation pass goes here.
- `/root/BugHunter/packages/cli/src/phases/plan.ts:81-90, 114-140` — Question B threading + `enrichToolSchemas`.
- `/root/BugHunter/packages/cli/src/mutation/apply.ts:37-126` — Question B: `buildApiInput` + `apiTestCases`.
- `/root/BugHunter/packages/cli/src/phases/execute.ts:23-31, 125-253, 277-289` — UI test executor (rewritten by Bug 1's adapter contract change), `surface_call_failed` detection, `extraHeaders` plumbing.
- `/root/BugHunter/packages/cli/src/phases/discover.ts` and `/root/BugHunter/packages/cli/src/discovery/dom-walker.ts:84-152` — UI walker; uses `browser.scroll('body','down',3000)` and `browser.evaluate(...)`. Adapter contract change must keep these working.
- `/root/BugHunter/packages/cli/src/repro/replay.ts:60-93` — replay engine; uses `click(selector)`, `type(selector,text)`. Adapter contract change must keep these working.
- `/root/BugHunter/packages/cli/src/classify/network.ts:53-56` — `normalizePath`; export it for Question A.
- `/root/BugHunter/packages/cli/src/cli/inspect.ts:36-67` — print `relatedClusterIds` line.
- `/root/BugHunter/packages/cli/src/phases/emit.ts:37-72` — run summary; add `planned/ran/skipped` banner.
- `/root/BugHunter/packages/cli/tests/surface-mcp-url.test.ts` — pattern to mirror for new `browser-mcp-url.test.ts` and `browser-mcp-protocol.test.ts`.
- `/root/BugHunter/packages/cli/tests/cluster.test.ts` — existing baseline; must not regress.
- `/root/BugHunter/SPEC.md` § 3.4.1 (line 145), § 3.4.5 (line 190), § 3.5.1 (line 212), § 3.6 (line 235), § 3.7 (line 262), § 4.1 (line 559), § 8 (line 803).
- `/root/BugHunter/dist-skill/bughunt-host.md:133-145` — gotcha block; remove the now-fixed bullets.

### camofox reference (READ-ONLY — do NOT edit)

- `/root/camofox-mcp/src/core/tools.ts:22-165` — registers nine tools unprefixed: `navigate`, `snapshot`, `click`, `type`, `scroll`, `screenshot`, `evaluate`, `list_tabs`, `close_tab`.
- `/root/camofox-mcp/src/core/schemas.ts:3-45` — input schemas. Note: `click({tabId, ref})`, `type({tabId, ref, text, submit?})`, `scroll({tabId, direction, amount?})`, `screenshot({tabId, fullPage?})`, `snapshot({tabId, offset?})`, `evaluate({tabId, expression})`, `close_tab({tabId})`, `list_tabs({})`, `navigate({url, tabId?})`.
- `/root/camofox-mcp/SPEC.md:94-114` — frozen surface, return shapes (e.g. `navigate → {tabId, ok, finalUrl, title?}`, `snapshot → {tabId, snapshot}`, `screenshot → {tabId, dataUrl}`).

### SurfaceMCP reference (sister spec controls; do not edit code)

- `/root/SurfaceMCP/SPEC_PROBE_TIGHTENING.md` — full spec.
- `/root/SurfaceMCP/src/types.ts:29` — adds `'partial'` to `InputSchemaConfidence`. BugHunter mirrors.

### Patterns to follow

- **MCP adapter URL normalisation:** `surface-mcp.ts:87` strips one trailing `/mcp/?` and any trailing slash; `mcpCall` then appends `/mcp`. Mirror exactly in `browser-mcp.ts`.
- **Adapter mock pattern in tests:** `surface-mcp-url.test.ts` uses `vi.stubGlobal('fetch', …)` to capture URLs. Reuse this shape verbatim for `browser-mcp-url.test.ts`.
- **MCP SSE/JSON envelope parsing:** `surface-mcp.ts:107-126` handles both `text/event-stream` and `application/json` content types and surfaces JSON-RPC `error` envelopes as thrown errors. The browser adapter mirrors this.
- **Config Zod schema:** `config.ts:34` — extend the existing `ConfigSchema`, do not create a parallel schema.
- **Discriminated unions for typed errors:** new `BrowserMcpError` is a tagged union — `kind: 'timeout' | 'element_not_found' | 'navigation_failed' | 'snapshot_failed' | 'transport' | 'unknown'`. Callers branch on `kind`.

### DO NOT

- Do not create a parallel adapter file. The Bug 1 rewrite stays in `browser-mcp.ts`. If the file exceeds 300 lines after the rewrite, extract the snapshot parser into a sibling `browser-mcp-snapshot.ts` (tests in the same name pattern) — but only as a last resort.
- Do not change camofox-mcp source. Camofox is correct.
- Do not change `cluster/signature.ts` for Question A's annotative pass (the `surface_call_failed` endpoint shape change DOES affect it — see § 7).
- Do not migrate existing `.bughunter/runs/*` state. Cluster annotations are forward-only.
- Do not add a `--non-interactive` alias for Bug 3. Use `--no-interactive` as documented.
- Do not push or merge anything to remote SurfaceMCP. Bug 4 is a local-only sync.
- Do not implement SurfaceMCP-side changes here. The companion spec lives in that repo and is implemented separately.
- Do not re-introduce the `mcp__camofox__` tool-name prefix anywhere in the new adapter, even guarded by a flag.

### Negative constraints (stack-wide)

- No `as any`. Use `unknown` and narrow.
- No `catch (e: any)` or empty `catch {}`.
- Max 40 lines per function.
- Max 300 lines per file. Browser adapter will grow significantly with the rewrite — split into `browser-mcp.ts` (transport + public API) and `browser-mcp-snapshot.ts` (parser + ref resolution) if it would otherwise cross 300 lines.
- Tests live alongside the file under `tests/` (existing convention).

---

## 3. Bug 1 — Camofox adapter rewrite

### 3.1 Smoke evidence

`/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` lines 73–107: every `mcpCall` invocation passes `mcp__camofox__<tool>`. The HTTP MCP server registers them unprefixed (`/root/camofox-mcp/src/core/tools.ts:22, 39, 57, 73, 91, 107, 126, 143, 155`). The MCP server returns a JSON-RPC `Method not found` error; the adapter parses the error envelope as a result body and surfaces "is not valid JSON".

Even after the prefix is fixed, every call still fails: camofox v0.1 takes `tabId`+`ref` (not `selector`), `direction: 'up'|'down'|'left'|'right'`+`amount` (not `direction: 'up'|'down'`+`distance`), `expression` (not `script`), and returns inline base64 image content from `screenshot` (not a path). The current adapter signatures are Playwright-shaped and incompatible.

### 3.2 Decision

**Full adapter rewrite.** The public `BrowserMcpAdapter` interface (the surface BugHunter code calls) stays selector-shaped and result-path-shaped — `dom-walker.ts`, `replay.ts`, `phases/execute.ts` will not change. The adapter internalises the snapshot→ref resolution sequence, tab tracking, and screenshot path materialisation.

Drop the `mcp__camofox__` prefix unconditionally. There is no v0.1 use case for the prefix — BugHunter speaks JSON-RPC directly to the HTTP MCP server. If a future Claude-proxy adapter is needed, write a separate adapter class.

### 3.3 Boundaries

- **Changes:** `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` (full rewrite + sibling helper if size demands).
- **Does NOT change:** the public `BrowserMcpAdapter` interface signatures (each method's input/output types stay identical so callers in `dom-walker.ts`, `replay.ts`, `phases/execute.ts` are unaffected).
- **Does NOT touch:** camofox-mcp source. Camofox is correct.
- **Does NOT change:** `BugHunterConfig.browserMcpUrl` shape or the run pipeline.

### 3.4 Public interface (unchanged from current `browser-mcp.ts`)

```ts
export interface BrowserMcpAdapter {
  navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult>;
  click(selector: string): Promise<ClickResult>;
  type(selector: string, text: string): Promise<TypeResult>;
  scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult>;
  snapshot(): Promise<SnapshotResult>;
  screenshot(outputPath?: string): Promise<ScreenshotResult>;
  evaluate(script: string): Promise<EvaluateResult>;
  listTabs(): Promise<ListTabsResult>;
  closeTab(tabId: string): Promise<CloseTabResult>;
}
```

The current callers pass `selector` strings (e.g. `'body'`, `'#submit'`, `'.product-card'`) and `direction: 'up' | 'down'`. The new adapter accepts these unchanged. The internal mapping to camofox `ref` and to `direction: 'up'|'down'|'left'|'right'` lives inside the adapter.

### 3.5 Internal architecture

Two sibling files:

- `adapters/browser-mcp.ts` — public `CamofoxBrowserMcpAdapter` class implementing `BrowserMcpAdapter`. Owns the JSON-RPC transport (`mcpCall<T>`), URL normalisation, tab tracking, error mapping, and method dispatch. ~250 LOC budget.
- `adapters/browser-mcp-snapshot.ts` — pure utilities: `parseSnapshot`, `resolveSelectorToRef`, `toCamofoxScrollDirection`. ~150 LOC budget. No I/O. Pure functions only.

```ts
// browser-mcp.ts — adapter outline
export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter {
  private readonly baseUrl: string;
  private currentTabId?: string;

  constructor(baseUrl: string = 'http://127.0.0.1:3100') { /* normalised in §4 */ }

  async navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
    const args = this.currentTabId ? { tabId: this.currentTabId, url } : { url };
    const result = await this.mcpCall<CamofoxNavigateResult>('navigate', args);
    this.currentTabId = result.tabId;
    return { url: result.finalUrl ?? url, title: result.title };
  }

  async click(selector: string): Promise<ClickResult> {
    const tabId = await this.requireTab();
    const ref = await this.resolveRef(tabId, selector);
    await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
    return { clicked: true };
  }

  // …type, scroll, screenshot, evaluate, snapshot, listTabs, closeTab follow the same shape
}
```

### 3.6 Tab tracking

Single tab per session. State: `private currentTabId?: string`.

- `navigate(url)` always uses `tabId` if set; otherwise creates a new tab and stores the returned `tabId`. Camofox's behaviour (`/root/camofox-mcp/src/core/tools.ts:30-36`): with `tabId` it POSTs to `/tabs/<id>/navigate`; without `tabId` it POSTs to `/tabs` (creates a new tab).
- `listTabs()` returns the camofox tab list as-is. Does NOT reset `currentTabId`.
- `closeTab(tabId)` — if `tabId === this.currentTabId`, clear `currentTabId` after close.
- `requireTab()` helper: if `currentTabId` is unset, throws `BrowserMcpError({kind:'no_tab',message:'Adapter has no active tab; call navigate(url) first'})`. **Does not** auto-navigate to a placeholder — the caller's contract is that they navigate first.

The existing `executeUiTest` at `phases/execute.ts:139` calls `browser.navigate(tc.page, headers)` first thing on every test, so `requireTab()` will always succeed in production paths.

`extraHeaders` on navigate: camofox v0.1 does not accept extra headers per-tab (see `/root/camofox-mcp/src/core/schemas.ts:3-6`). Currently BugHunter passes `{ 'X-BugHunter-Run': runId }` so the dev server can correlate. **Decision: drop silently.** The header was a nice-to-have; SurfaceMCP-driven calls already carry the run id via `surface_call`'s `runId` plumbing. Document this in § 3.10 limitations and in the adapter's JSDoc on `navigate`. Do NOT throw on the parameter — accept it and ignore.

### 3.7 Selector → ref resolution algorithm

The riskiest part of the rewrite. Specced precisely.

**Snapshot format (camofox/Playwright a11y tree).** The `snapshot` tool returns `{ tabId, snapshot: <string> }` per `/root/camofox-mcp/SPEC.md:106`. The string is YAML-ish per Playwright convention. Each interactive node carries a stable `[eN]` ref. Example:

```
- generic [e1]:
  - banner [e2]:
    - link "Healthy Spoon" [ref=e3]
  - main [e4]:
    - heading "Sign in" [level=1] [ref=e5]
    - textbox "Email" [ref=e6]
    - textbox "Password" [type=password] [ref=e7]
    - button "Sign in" [ref=e8]
    - link "Forgot password" [ref=e9]
```

Both `[e3]` (bare) and `[ref=e3]` forms appear in the wild; the parser handles both.

**Parsed node shape:**

```ts
type SnapshotNode = {
  ref: string;                  // 'e3'
  role: string;                 // 'button', 'link', 'textbox', etc.
  name?: string;                // accessible name from quoted string
  attrs: Record<string, string>; // 'level', 'type', 'disabled', etc.
  raw: string;                  // the original line, for diagnostics
};

export function parseSnapshot(snapshot: string): SnapshotNode[];
```

The parser walks every line, extracts the role (first word), the first `"<name>"` substring if present, all `[k=v]` attribute pairs, and the ref (matches `\bref=(e\d+)\b` OR `\[(e\d+)\]` at end of line). Lines without a ref are skipped.

**Resolution input.** `resolveSelectorToRef(tabId, selector, snapshot)` accepts:
- Plain CSS selectors that BugHunter currently passes:
  - `#id` — id selector
  - `.class` — class selector
  - `tag` — tag selector (e.g. `body`, `button`)
  - `tag[attr="value"]` — attribute selector (most common case: `tag[aria-label="X"]`, `tag[data-testid="Y"]`)
  - `tag:nth-of-type(N)` — positional fallback from `dom-walker.ts:31`
- Role queries via a structured object — NEW: callers can pass an object `{ role: 'button', name: 'Submit' }` and the adapter accepts it on `click`/`type` only. Add a typed overload:
  ```ts
  click(selector: string | { role: string; name?: string; nth?: number }): Promise<ClickResult>;
  ```
  Existing string callers are unchanged; the structured form is opt-in for future use. Mark the structured overload as the preferred form in JSDoc.

**Resolution algorithm (deterministic, in priority order — first match wins).**

1. **Already a ref.** If `selector` matches `^e\d+$`, return it directly.
2. **Structured `{role, name?}`.** Walk `snapshot` for nodes where `node.role === selector.role` AND (if `name` provided) `node.name === selector.name` (case-insensitive). If `nth` provided, return the nth (0-indexed) match. Otherwise return the first match.
3. **`#id` selector.** Walk snapshot for nodes where `node.attrs.id === <id>` (rare — Playwright doesn't always serialise `id`). If not found, fall back to step 5 (evaluate) with `document.getElementById(<id>)`.
4. **`tag[attr="value"]` selector.** Parse the attr/value pair via regex (`/^(\w+)\[([\w-]+)="([^"]*)"\]$/`). Walk snapshot for nodes where `node.role === tag` AND `node.attrs[attr] === value` OR (when `attr === 'aria-label'` or `attr === 'data-testid'`) `node.name === value`. If not found, fall back to step 5.
5. **`evaluate` fallback.** Run `document.querySelector(<safe-selector>)?.outerHTML?.slice(0, 200)` via `mcpCall('evaluate', {tabId, expression})`. If the result is non-null:
   a. **Re-snapshot** the page (camofox snapshot is computed fresh on every call — no cache invalidation issues) and walk the new tree.
   b. Match by extracting the element's accessible name candidates: `aria-label` attribute, text content (first 80 chars), `placeholder`, `title`, `alt`. For each candidate, walk the snapshot for a node whose `role` matches `tag` (or any role if tag is generic like `div`) AND whose `name` includes the candidate. First match wins.
   c. If no match, throw `BrowserMcpError({kind:'element_not_found', selector, message:'Element exists in DOM but has no accessible name in snapshot'})`. The caller decides whether this is fatal (test failure) or a skip (a11y deficiency in app under test).
6. **Plain `tag` selector with no attrs.** Walk snapshot for first node with matching role. Special case `body`: walk for the root `generic` or `Root` node — almost always `e1`. If snapshot has no root ref, throw.
7. **`.class` selector or `tag:nth-of-type(N)` selector.** Skip steps 2–4 entirely; go straight to step 5. Snapshots don't carry CSS classes; resolution requires DOM access.
8. **No match anywhere.** Throw `BrowserMcpError({kind:'element_not_found', selector, message:'No matching ref in snapshot or DOM'})`.

**Re-snapshot policy.** Only step 5 takes a fresh snapshot. Steps 1–4 reuse the snapshot passed in. Callers that want a fresh snapshot per-action call `await this.snapshot()` themselves; in the standard `click`/`type` flow, the adapter takes one fresh snapshot per call (so multi-step flows always see post-mutation state). Document the trade-off in JSDoc on `click`/`type`.

**Hidden / disabled elements.** A node serialised in the snapshot is, by camofox/Playwright contract, in the a11y tree — so it's not `display:none` and not `aria-hidden`. We do not pre-filter on `disabled` — let camofox's own click handler return the error if the element is disabled, and surface it as `BrowserMcpError({kind:'element_not_actionable'})`.

**Multiple matches.** If steps 2–4 find multiple matches, return the first. Document in JSDoc that ambiguous selectors get the first match in document order. Callers wanting explicit disambiguation should pass `nth` via the structured form (step 2) or refine the selector.

**Dynamic-render race.** If a click/type triggers a navigation or DOM rewrite, the next call's snapshot is fresh. If the adapter is mid-`click` and the page navigates between snapshot and click POST, camofox returns `element_not_found` (because the ref no longer exists in the new tree). The adapter retries ONCE: re-snapshot and re-resolve. Second failure throws. The single retry is implemented inside `click` and `type` only; not used for `scroll` (which doesn't take a ref).

### 3.8 Per-method mapping

| Public method | Camofox tool | Argument mapping | Result mapping |
|---|---|---|---|
| `navigate(url, extraHeaders?)` | `navigate` | `{url, tabId?}` (tabId reused if set; extraHeaders silently dropped) | `{url: result.finalUrl, title: result.title}` |
| `click(selector)` | `click` | `{tabId, ref}` (resolved per § 3.7); single retry on `element_not_found` after re-snapshot | `{clicked: true}` (camofox returns `{tabId, ok}`) |
| `type(selector, text)` | `type` | `{tabId, ref, text, submit:false}`; single retry on `element_not_found` | `{typed: true}` |
| `scroll(selector, direction, distance?)` | `scroll` | `selector` is IGNORED — camofox is whole-page only; `{tabId, direction, amount: distance ?? 500}` | `{scrolled: true}` |
| `snapshot()` | `snapshot` | `{tabId}` | `{snapshot: result.snapshot}` (raw a11y string) |
| `screenshot(outputPath?)` | `screenshot` | `{tabId, fullPage:false}` | base64 → if `outputPath` provided, write file and return `{path: outputPath, data: base64}`; else return `{path: '', data: base64}` |
| `evaluate(script)` | `evaluate` | `{tabId, expression: script}` | `{value: result.result}` (camofox returns the eval result under various keys; adapter normalises) |
| `listTabs()` | `list_tabs` | `{}` | `{tabs: result.tabs.map(...)}` (camofox returns `{tabs: [{id, url, title}]}`; if shape differs, adapter coerces) |
| `closeTab(tabId)` | `close_tab` | `{tabId}` | `{closed: true}`; clears `this.currentTabId` if matches |

**`scroll` selector parameter.** Existing callers (`dom-walker.ts:96-97`, `replay.ts` does not call `scroll`) pass `'body'` as selector with `'down'` direction and `3000` distance. Per the table, the selector is ignored — accept it and document. The `direction: 'up' | 'down'` interface stays; camofox's `'left' | 'right'` are not exposed yet. If a future caller needs them, extend the interface in a follow-up.

**`screenshot` content type.** Camofox returns MCP image content (`{content: [{type: 'image', data: '<base64>', mimeType: 'image/png'}]}`), not the standard `text` envelope. The adapter's transport must check `content[0].type` and branch — text envelopes parse as JSON, image envelopes return `{data, mimeType}` directly. The current `mcpCall<T>` always parses content as JSON, which would throw on image. **Refactor `mcpCall`** to accept an optional `expect: 'json' | 'image'` parameter; default `'json'`; `screenshot` passes `'image'`.

**`evaluate` result key.** Camofox proxies upstream which returns a `{ tabId, result: <any> }` object. Adapter unwraps `.result` to populate `{value: …}`. If the upstream returns a scalar directly, adapter wraps it.

### 3.9 Error mapping

```ts
// adapters/browser-mcp-error.ts (NEW small module)
export type BrowserMcpErrorKind =
  | 'transport'           // network / HTTP layer failure
  | 'no_tab'              // adapter state error: navigate not called
  | 'element_not_found'   // selector resolution failed in both snapshot and DOM
  | 'element_not_actionable'  // resolved ref but click/type failed (disabled, covered, etc.)
  | 'navigation_failed'   // navigate returned ok:false or threw upstream
  | 'snapshot_failed'     // snapshot tool returned error envelope
  | 'screenshot_failed'   // screenshot tool returned error envelope
  | 'evaluate_failed'     // evaluate threw inside the page
  | 'timeout'             // upstream camofox timeout
  | 'unknown';            // anything else — preserve raw error in `cause`

export class BrowserMcpError extends Error {
  constructor(
    public readonly kind: BrowserMcpErrorKind,
    message: string,
    public readonly selector?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrowserMcpError';
  }
}
```

**Mapping rules.**
- HTTP transport errors (`res.ok === false`, `fetch` throws) → `kind: 'transport'` with the status code in the message.
- JSON-RPC `error` envelope from camofox: parse the message; if it contains `"timeout"` → `'timeout'`; if `"not found"` or `"no element"` → `'element_not_found'`; if from `screenshot` → `'screenshot_failed'`; if from `snapshot` → `'snapshot_failed'`; otherwise `'unknown'`.
- Internal `requireTab` failure → `'no_tab'`.
- `parseSnapshot` produced 0 nodes → `'snapshot_failed'` with message `Snapshot parsed 0 elements; tab may have crashed`.
- `resolveSelectorToRef` exhausted all paths → `'element_not_found'`.

**Caller-side branching.** `phases/execute.ts:172-194` currently catches all browser errors and re-throws as `Browser action failed`. Update that block to inspect `err instanceof BrowserMcpError`, and:
- `kind === 'element_not_found'` → record the test as `infra-skipped` with reason `element_not_found` (NOT a bug — it's a test pre-condition failure). Do not flag as infrastructure failure (the broader `surface_unreachable`-style category) — add a new `InfrastructureFailure.kind = 'browser_element_not_found'`. Update `types.ts:158` accordingly.
- `kind === 'transport'` or `'timeout'` → existing `infrastructure_failure` path (`browser_crash` kind).
- All other kinds → preserve current behaviour: throw, treat as infra failure.

### 3.10 Limitations (documented, not bugs)

- `navigate`'s `extraHeaders` is silently dropped. Camofox v0.1 does not support per-tab headers.
- `scroll` ignores its selector argument — camofox is whole-page only.
- `evaluate` runs in the page's main JS context only; cross-frame access is not supported.
- The single retry on dynamic-render race means very fast SPAs with two consecutive DOM rewrites between snapshot and click can still fail. Document; v0.2 may add exponential retry.
- `BrowserMcpAdapter.navigate(url, extraHeaders)` accepts `extraHeaders` but the value is unused. Removing the parameter would break callers; keeping it is forward-compat for a future camofox header-passthrough.

### 3.11 Acceptance criteria

- Given the camofox HTTP MCP daemon running on `127.0.0.1:3104`, `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104').listTabs()` returns a parsed `ListTabsResult` (or throws `BrowserMcpError` with a typed `kind` on transport failure), but **never** throws "is not valid JSON".
- All nine call sites pass the bare tool name. No occurrence of `mcp__camofox__` in the new file.
- `parseSnapshot` returns nodes with `ref`, `role`, `name?`, `attrs` for the seven shapes in the example tree at § 3.7.
- `resolveSelectorToRef` resolves `#id`, `tag[aria-label="X"]`, `tag[data-testid="Y"]`, `tag:nth-of-type(N)`, `body`, structured `{role, name}`, and a bare `eN`. Each in a unit test.
- `resolveSelectorToRef` falls back to `evaluate` on `.class`. Test mocks `mcpCall('evaluate', …)` to return a constructed string and asserts the next walk uses the response.
- `click` retries once on `element_not_found` after a fresh snapshot. Asserted via mock that returns `not found` once then succeeds.
- `screenshot('/tmp/x.png')` writes to disk and returns `{path: '/tmp/x.png', data: <base64>}`. `screenshot()` (no path) returns `{path: '', data: <base64>}`.
- `closeTab(tabId)` clears `currentTabId` when it matches; does nothing when it doesn't.
- A new test `/root/BugHunter/packages/cli/tests/browser-mcp-protocol.test.ts` covers all of the above.
- `BrowserMcpError` instances thrown from the adapter expose `kind` for caller branching.
- The existing high-level callers (`dom-walker.ts`, `replay.ts`, `phases/execute.ts`) compile and run unchanged against the new adapter.

### 3.12 Files to touch

- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — full rewrite (Bug 1) + URL normalisation (Bug 2). Target ~250 LOC.
- `/root/BugHunter/packages/cli/src/adapters/browser-mcp-snapshot.ts` — NEW. `parseSnapshot`, `resolveSelectorToRef`, internal node types. Pure functions only.
- `/root/BugHunter/packages/cli/src/adapters/browser-mcp-error.ts` — NEW. `BrowserMcpError` + `BrowserMcpErrorKind`.
- `/root/BugHunter/packages/cli/src/types.ts:154-163` — extend `InfrastructureFailure.kind` union with `'browser_element_not_found'`.
- `/root/BugHunter/packages/cli/src/phases/execute.ts:172-194` — branch on `BrowserMcpError.kind` for `element_not_found` vs other browser failures.
- `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` — NEW (covers URL normalisation, Bug 2).
- `/root/BugHunter/packages/cli/tests/browser-mcp-protocol.test.ts` — NEW (covers tool-name dispatch, tab tracking, screenshot path, error mapping).
- `/root/BugHunter/packages/cli/tests/browser-mcp-snapshot.test.ts` — NEW (covers parser + selector resolution algorithm).

---

## 4. Bug 2 — `browserMcpUrl` convention asymmetric with `surfaceMcpUrl`

### 4.1 Root cause

`/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts:32-34` (current code) has the default include `/mcp`, and `mcpCall` does not append `/mcp` — so a base-URL config breaks. `surface-mcp.ts:81-97` does the opposite: base URL is canonical; adapter strips `/mcp/?$` and appends `/mcp`.

`/root/BugHunter/SPEC.md` § 3.4.5 documents `surfaceMcpUrl`; nothing analogous for `browserMcpUrl`. `init.ts:21` prompt default is full URL.

### 4.2 Decision

**Align `browserMcpUrl` with `surfaceMcpUrl`.** Base URL is canonical; adapter appends `/mcp`; strip one trailing `/mcp/?` for backward-compat. Document in SPEC.md § 3.4.5 (rename to cover both).

### 4.3 Boundaries

- **Changes:** `browser-mcp.ts` constructor + `mcpCall` URL construction; `init.ts` prompt default + label; SPEC.md § 3.4.5 (rename + extend); SPEC.md § 8 line 811 comment.
- **Does NOT change:** `surfaceMcpUrl` behaviour, `BugHunterConfig` schema, `surface-mcp-url.test.ts`, runtime config-load semantics. The Zod schema for `browserMcpUrl` is `z.string().url().optional()` — both base and full forms parse as valid URLs.

### 4.4 Interface contract

`CamofoxBrowserMcpAdapter` constructor signature unchanged: `constructor(baseUrl?: string)`. New default value: `'http://127.0.0.1:3100'` (base URL). Internal: `this.baseUrl` becomes the trimmed base WITHOUT `/mcp`; `mcpCall` fetches `${this.baseUrl}/mcp`.

### 4.5 Edge cases

- `'http://127.0.0.1:3100'` → `http://127.0.0.1:3100/mcp`.
- `'http://127.0.0.1:3100/'` → `http://127.0.0.1:3100/mcp`.
- `'http://127.0.0.1:3100/mcp'` → strip `/mcp` → `http://127.0.0.1:3100/mcp`.
- `'http://127.0.0.1:3100/mcp/'` → strip `/mcp/` → `http://127.0.0.1:3100/mcp`.
- `'http://127.0.0.1:3100/mcp/extra'` → no strip → `http://127.0.0.1:3100/mcp/extra/mcp`. Intentional. Document.
- HTTPS, port omitted, IPv6 host: handled by Zod URL parsing.
- `browserMcpUrl` unset: adapter default base used. API-only mode still works (no instantiation).

### 4.6 Acceptance criteria

`/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` (new file):

- `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104')` → captured fetch URL on any tool call is `'http://127.0.0.1:3104/mcp'`.
- `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp')` → same captured URL as base form.
- `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp/')` → same captured URL.
- `listTabs()` request body's `params.name === 'list_tabs'` (covers Bug 1 prefix).
- `navigate('https://x')` request body's `params.name === 'navigate'`.
- `click('#submit')` request body's `params.name === 'click'` AND `params.arguments.tabId` and `params.arguments.ref` are present (covers Bug 1 argument shape) — uses a mock that first responds to a `snapshot` call with a constructed tree containing `[ref=e3]` for `#submit`.

### 4.7 SPEC.md edits

§ 3.4.5 — rename heading to **"3.4.5 `surfaceMcpUrl` and `browserMcpUrl` convention"**. Append:

> `BugHunterConfig.browserMcpUrl` follows the same convention as `surfaceMcpUrl`: base URL of the camofox MCP HTTP server (e.g. `http://127.0.0.1:3100`), without the `/mcp` path. The adapter appends `/mcp` internally and strips one trailing `/mcp` (with optional trailing slash) for backward compatibility. The `init` wizard's prompt and default both use the base URL form.

§ 8 line 811: change comment to `// http://127.0.0.1:3100  (base form, /mcp appended internally)`.

### 4.8 Files to touch

- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — constructor regex + default; `mcpCall` `${this.baseUrl}/mcp`. Same file as Bug 1; combine commits.
- `/root/BugHunter/packages/cli/src/cli/init.ts` — prompt default, label.
- `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` — § 3.4.5 + § 8 line 811.

---

## 5. Bug 3 — `bughunter init --no-interactive` ignored

### 5.1 Root cause

`/root/BugHunter/packages/cli/src/cli/main.ts:86-88`:

```ts
case 'init':
  await initCommand(projectDir);
  break;
```

`initCommand` (`init.ts:10-43`) opens readline unconditionally.

### 5.2 Decision

Thread the flag through; add override flags so non-interactive callers can pin values; defaults otherwise; Zod-validate the resolved config and fail loudly on invalid input.

### 5.3 Boundaries

- **Changes:** `main.ts` (init case + flag parse), `init.ts` (signature + body).
- **Does NOT change:** the interactive prompt UX (without `--no-interactive`).
- **Does NOT add:** `--non-interactive` alias.
- **Does NOT add:** `--config-out` path override. Always writes `<cwd>/.bughunter/config.json`.

### 5.4 Interface contract

```ts
export type InitOptions = {
  noInteractive?: boolean;
  projectName?: string;
  surfaceMcpUrl?: string;
  browserMcpUrl?: string;
  resetCommand?: string;
  resetPolicy?: 'transactional' | 'per-test' | 'per-page' | 'per-run';
};

export async function initCommand(projectDir: string, opts?: InitOptions): Promise<void>;
```

`main.ts` USAGE addition:

```
bughunter init [--no-interactive] [--project-name <name>] [--surface-mcp-url <url>]
               [--browser-mcp-url <url>] [--reset-command <cmd>] [--reset-policy <policy>]
```

### 5.5 Behavioural rules

When `noInteractive: true`:
1. **Skip readline entirely.** Do not open `process.stdin`.
2. Resolve each field by precedence: `opts.<field>` → environment variable (`BUGHUNTER_<FIELD>`) → default. Defaults:
   - `projectName`: `path.basename(projectDir)`.
   - `surfaceMcpUrl`: `'http://127.0.0.1:3102'`.
   - `browserMcpUrl`: `undefined` (not set; user opts in).
   - `resetCommand`: `undefined`.
   - `resetPolicy`: `'per-page'`.
3. Validate the resolved config against `ConfigSchema`. On failure throw with the Zod error path so the user knows which field is invalid.
4. Write `.bughunter/config.json` via `saveConfig` exactly as the interactive path does.
5. Print the same "Config written" + "Next steps" output to stdout.

When `noInteractive: false` or unset: existing interactive flow unchanged.

### 5.6 Edge cases

- `.bughunter/config.json` already exists: existing guard runs first regardless; behaviour unchanged.
- `--no-interactive --surface-mcp-url not-a-url`: throw via Zod with `Invalid .bughunter/config.json: surfaceMcpUrl: Invalid url`.
- `--no-interactive --reset-policy bogus`: throw via Zod (resetPolicy enum).
- `BUGHUNTER_PROJECT_NAME` set + `--project-name` flag: flag wins.
- Project dir basename empty (`/`): Zod `min(1)` catches; throw.
- `--no-interactive` without other flags: all defaults; CI-style.
- Flag without `--no-interactive`: silently ignored in interactive mode (do not pre-fill prompts). Document.

### 5.7 Acceptance criteria

- `bughunter init --no-interactive` in a fresh dir writes `.bughunter/config.json` with `projectName=<basename>`, `surfaceMcpUrl='http://127.0.0.1:3102'`, `resetPolicy='per-page'`, no `browserMcpUrl`, no `resetCommand`.
- `bughunter init --no-interactive --project-name myproj --surface-mcp-url http://x:1` writes the overridden values.
- `bughunter init --no-interactive --surface-mcp-url not-a-url` exits non-zero with a clear Zod error message.
- `bughunter init --no-interactive` does not block on stdin; runs to completion in <100 ms in a process with closed stdin.
- New test `/root/BugHunter/packages/cli/tests/init.test.ts` covers: (a) defaults, (b) flag overrides, (c) env var fallback, (d) invalid URL fails Zod, (e) does NOT call readline (mock `node:readline/promises` and assert no call).

### 5.8 Files to touch

- `/root/BugHunter/packages/cli/src/cli/init.ts` — new signature, branching on `noInteractive`.
- `/root/BugHunter/packages/cli/src/cli/main.ts` — parse new flags, build `InitOptions`, pass to `initCommand`. Update USAGE.
- `/root/BugHunter/packages/cli/tests/init.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 4.1 — update the `bughunter init` block.

---

## 6. Bug 4 — SurfaceMCP local `main` is stale (release-hygiene runbook)

### 6.1 Root cause

Local `/root/SurfaceMCP/main` points at `10d1ff14`; `origin/main` already at `86a05b80` (Merge-PR-#1).

### 6.2 Decision

Documented git-ops runbook. No code change.

### 6.3 Runbook (now committed at `/root/BugHunter/docs/RUNBOOKS.md`)

```bash
cd /root/SurfaceMCP
git fetch origin
git checkout main
git merge --ff-only origin/main      # fast-forwards local main to 86a05b8
git log --oneline -3                 # verify 86a05b8 is HEAD

# Optional: prune the merged feature branch locally.
git branch -d feat/v0.1-implementation     # only if local feat tip == origin/main
```

The branch `feat/v0.1-implementation` is left in place; user prunes manually when ready. (Resolved per § 10.2 user decision.)

### 6.4 Boundaries

- **Changes:**
  - `/root/BugHunter/dist-skill/bughunt-host.md:140` — replace the misleading "merge to remote main never landed" line with the resync runbook reference.
  - `/root/BugHunter/dist-skill/bughunt-host.md:136-139` — delete the now-fixed Bug 1 / Bug 2 / Bug 3 / probe-gap bullets after the corresponding fixes land. Coordinate with §9.2 sequencing — drop each bullet in the same commit that fixes the underlying bug.
  - `/root/BugHunter/docs/RUNBOOKS.md` — NEW. Consolidated runbooks page; first runbook is "SurfaceMCP main resync."
- **Does NOT change:** any SurfaceMCP file. Coder must not push/force/merge on origin.

### 6.5 Acceptance criteria

- After running the runbook, `git log --oneline /root/SurfaceMCP/main -1` returns `86a05b8` (or its descendant if SurfaceMCP probe-tightening lands first).
- `dist-skill/bughunt-host.md` no longer contains "merge to remote main never landed" or any of the now-fixed gotchas; it instead points users to `/root/BugHunter/docs/RUNBOOKS.md`.
- `/root/BugHunter/docs/RUNBOOKS.md` exists with at least one section: "SurfaceMCP local main resync."

### 6.6 Files to touch

- `/root/BugHunter/dist-skill/bughunt-host.md` — replace lines 136-140; keep the remaining true-and-still-relevant bullets (server-action exclusion, cluster artifact retention, Auth.js detection).
- `/root/BugHunter/docs/RUNBOOKS.md` — NEW.

---

## 7. Question A — Cluster signature merge across kinds (annotative)

### 7.1 Smoke evidence

Two clusters on the same `toolId` (`0928801337a9 = post_api_admin_alerts_oversell_id_resolve`):
- `v3hv57r5` kind=`404_for_linked_route`, signature `404_for_linked_route|/api/admin/alerts/oversell/<id>/resolve`.
- `khiyrdlh` kind=`surface_call_failed`, signature `surface_call_failed|0928801337a9`.

Both root-caused to a missing `discoveryFixtures` entry for the dynamic `:id`. Same upstream defect, two clusters.

### 7.2 Why the priority hierarchy doesn't fix this

§ 3.5.1 collapses multiple detections per occurrence to one canonical kind; the two clusters here come from different occurrences (UI walker hitting a 404 link vs. API direct-call sending a synthetic id). Per-occurrence priority doesn't reach across occurrences.

### 7.3 Decision: annotative co-occurrence link, NOT signature merge

**Do not change `clusterSignature` for `404_for_linked_route`.** Add a post-cluster co-occurrence pass with a new `BugCluster.relatedClusterIds?: string[]`. Always-on, no flag (resolved per § 10.5 user decision).

Surface_call_failed signature DOES change — see § 7.5. This is necessary to make the linkage tractable and aligns the kind with the existing `network_*` signatures.

### 7.4 Boundaries

- **Changes:** `phases/execute.ts` (endpoint computation), `phases/cluster.ts` (post-pass), `types.ts` (`BugCluster.relatedClusterIds`), `cluster/signature.ts` (no math change but document the surface_call_failed key now uses normalized endpoint), `cli/inspect.ts`, `SPEC.md` § 3.6 + § 3.7.
- **Does NOT change:** `404_for_linked_route` signature.
- **Does NOT change:** existing `cluster.test.ts` baseline (covers `console_error` + `404_for_linked_route` only, not `surface_call_failed`).
- **Does NOT migrate** existing `runs/<id>/bugs.jsonl` — annotations are forward-only.

### 7.5 `surface_call_failed` endpoint shape change

`phases/execute.ts:282-287` currently writes `endpoint: tc.action.toolId`. Replace with `endpoint: \`${meta?.method ?? 'POST'} ${normalizePath(meta?.path ?? tc.action.toolId)}\`` where `meta = toolMap.get(tc.action.toolId)`.

`normalizePath` lives in `classify/network.ts:53-56`. **Export it** (currently file-private). Both `classifyNetworkRequests` and `executeApiTest` import it from the same module.

If `toolMap` lookup misses (rare — cap of 200 clusters means we always have a populated map), fall back to bare `toolId` and log a debug warning. No co-occurrence link possible in that case.

`signature.ts:30` reads `${detection.kind}|${detection.endpoint ?? ''}`. With the new endpoint shape it becomes `surface_call_failed|POST /api/admin/alerts/.../resolve` — matching apples-to-apples with the `404_for_linked_route` `targetPath` after normalization.

### 7.6 Interface contract

```ts
// types.ts — extend BugCluster
export type BugCluster = {
  // …existing fields…
  relatedClusterIds?: string[];
};

// phases/cluster.ts — new helper
function annotateRelatedClusters(clusters: BugCluster[]): void;
```

`annotateRelatedClusters` runs in-place at the end of `runCluster`. For each pair (a, b):
- `a.kind === '404_for_linked_route'` and `b.kind === 'surface_call_failed'` (or vice versa), AND
- `routeKeyOf(a) === routeKeyOf(b)`.

Push `b.id` into `a.relatedClusterIds` and `a.id` into `b.relatedClusterIds` (mutual link). Dedupe within each list.

`routeKeyOf`:
- For `surface_call_failed`: parse `endpoint` (`"METHOD /normalized/path"`); take the path.
- For `404_for_linked_route`: take `targetPath`; run through `normalizePath`.

Comparison: equal normalized paths regardless of method. Intentionally lenient.

### 7.7 Edge cases

- Same path, multiple methods (`POST /x` and `PUT /x`): both surface_call_failed clusters link to the same 404 cluster.
- 404 cluster with no surface_call_failed pair: `relatedClusterIds` undefined; JSONL emit omits the field when empty.
- More than 2 clusters share a path: mutual links across all of them.
- `toolMap` miss: fall back to bare toolId; no link possible; debug warning.

### 7.8 Acceptance criteria

- Given a run that produces `404_for_linked_route` cluster A on path `/api/x/:id/y` and `surface_call_failed` cluster B for the tool whose path is `/api/x/:id/y`: `A.relatedClusterIds` includes `B.id`, `B.relatedClusterIds` includes `A.id`.
- Given an isolated `404_for_linked_route`: `relatedClusterIds` is `undefined`; serialization omits the field.
- Given two `surface_call_failed` clusters with different paths: no link.
- Existing `cluster.test.ts` "404_for_linked_route keyed by targetPath" passes.
- New test `/root/BugHunter/packages/cli/tests/cluster-related.test.ts` covers four cases.
- `bughunter inspect <clusterId>` prints `Related clusters: <id1>, <id2>` when set.

### 7.9 SPEC.md edits

§ 3.6 — add a row to the signature table:

| `surface_call_failed` | `endpoint` (method + normalized path) |

After the table, add:

> **Cross-kind co-occurrence (additive, not collapse).** After clustering, BugHunter walks the cluster set and links clusters that share a normalized route across pair-eligible kinds: `404_for_linked_route` ↔ `surface_call_failed`. Linked clusters reference each other via `relatedClusterIds`. Canonical signatures and cluster ids are unchanged. Use case: a missing `discoveryFixtures` entry for a dynamic route trips both kinds; the link tells the user "these are the same root cause."

§ 3.7 — add `relatedClusterIds?: string[]` to the bugs.jsonl example shape.

### 7.10 Files to touch

- `/root/BugHunter/packages/cli/src/types.ts:118-133` — `BugCluster.relatedClusterIds`.
- `/root/BugHunter/packages/cli/src/phases/execute.ts:277-289` — surface_call_failed `endpoint` becomes `${method} ${normalizedPath}`. Import `normalizePath` from `classify/network.ts`.
- `/root/BugHunter/packages/cli/src/classify/network.ts:53` — `export function normalizePath`.
- `/root/BugHunter/packages/cli/src/phases/cluster.ts:26-98` — new `annotateRelatedClusters`, called at end of `runCluster`.
- `/root/BugHunter/packages/cli/src/cli/inspect.ts:36-67` — print `Related clusters` when set.
- `/root/BugHunter/packages/cli/tests/cluster-related.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 3.6 + § 3.7.

---

## 8. Question B — `bodyFixtures` escape-hatch (per-role)

### 8.1 Smoke evidence

Spoonworks tools using manual `if (!body.memo) throw …` get `inputSchemaConfidence: 'unknown'`. The probe upgrades them but misses required fields. Empty body → 400/422 → false-positive `surface_call_failed`. The SurfaceMCP-side `'partial'` variant (sister spec) reduces this but cannot eliminate it for routes with helper-function-extracted validation.

### 8.2 Decision

Add `bodyFixtures` to `BugHunterConfig`, **keyed by `toolId` then `roleName`**, applied only on the `happy` palette for API direct-call tests. Wildcard `"*"` role key applies to all roles.

Resolution: `'partial'` confidence (from the SurfaceMCP-side spec) is treated identically to `'unknown'` in `apiTestCases` — single happy-path call only, no palette explosion. The `bodyFixtures` entry, when present, supplements the synthesized body for that single call (and would also supplement the four-palette case if confidence is `'introspected'` or `'inferred'`).

### 8.3 Boundaries

- **Changes:** `BugHunterConfig` schema (`config.ts`), `types.ts`, `mutation/apply.ts` (`buildApiInput`, `apiTestCases`), `phases/plan.ts` (thread the config; orphan-fixture warning), `cli/init.ts` (no UI prompt — empty default), SPEC.md § 8 + § 3.4.1.
- **Does NOT change:** form-fill mutation, palette generation for non-happy variants, `surface_sample_inputs` precedence (fixture overrides sample), schema-inference upgrade flow.
- **Does NOT live in:** `surfacemcp.config.json`.

### 8.4 Interface contract

```ts
// types.ts — extend BugHunterConfig
export type BugHunterConfig = {
  // …existing fields…
  bodyFixtures?: Record<string, Record<string, Record<string, unknown>>>;
  // Outer key: toolId. Middle key: roleName (or "*" wildcard). Inner: partial body
  // shallow-merged onto the synthesized happy-palette body. Applies only to API
  // direct-call tests on the 'happy' palette. Use to supplement schemas that
  // surface_probe couldn't fully recover.
};
```

Resolution rule per (toolId, role):
1. If `bodyFixtures[toolId]?.[role]` exists, use it.
2. Else if `bodyFixtures[toolId]?.['*']` exists, use it.
3. Else: no fixture.

Specific role keys win over wildcard; this is the standard "specific overrides general" rule.

```ts
// config.ts — extend ConfigSchema
bodyFixtures: z.record(z.record(z.record(z.unknown()))).optional(),
```

```ts
// mutation/apply.ts — extend buildApiInput
export function buildApiInput(
  tool: ToolMeta,
  palette: PaletteVariant,
  sampleInput: unknown,
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>,
): unknown;
```

`buildApiInput` behaviour:
1. Synthesize body from schema + samples + palette (existing logic).
2. If `palette === 'happy'` and `bodyFixture` is non-null, shallow-merge `bodyFixture` over the synthesized result, fixture-keys winning. Rationale for shallow: predictable; deep-merge of arbitrary user fixtures can produce surprising arrays.
3. For all other palettes: ignore `bodyFixture`.

```ts
// mutation/apply.ts — apiTestCases threads the resolved fixture through
export function apiTestCases(
  runId: string,
  role: string,
  tool: ToolMeta,
  samples: unknown[],
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>,
): TestCase[];
```

`phases/plan.ts:84-90` becomes:

```ts
const fixtureForRole =
  config.bodyFixtures?.[tool.toolId]?.[role] ??
  config.bodyFixtures?.[tool.toolId]?.['*'];
const cases = apiTestCases(runId, role, tool, samples, config.domainHints, fixtureForRole);
```

For `'unknown'`/`'partial'` confidence at `apply.ts:44-61`: also merge `fixtureForRole` over `samples[0] ?? {}` for the single happy-path call. This is the smoke fix path — those are exactly the tools that need the fixture.

**Orphan-fixture warning.** After `enrichToolSchemas` returns the catalog, walk `config.bodyFixtures` keys; for any toolId not in the catalog, `log.warn({toolId, roles: Object.keys(fixtures)}, 'bodyFixture references unknown toolId')`. Continue.

### 8.5 Edge cases

- Fixture supplies a key already synthesized: fixture wins (shallow-merge, fixture last).
- Fixture key not in schema: still merged. User opted in.
- Orphan tool in fixtures: warning at plan time. Run continues.
- Fixture is `null` for a known toolId/role: explicit `null` fails Zod (record requires record values). Good — early failure.
- Tool has `inputSchemaConfidence: 'unknown'` after probe failure: single happy-call path also gets fixture merged.
- Tool has `inputSchemaConfidence: 'partial'` (post-SurfaceMCP-side change): SAME branch as `'unknown'` — single happy-call only, fixture merged. Update `apply.ts:44` from `=== 'unknown'` to `=== 'unknown' || === 'partial'`.
- Server action: filtered out before `apiTestCases`; fixture unused, no warning.
- Wildcard `"*"` role + specific role both present: specific wins (resolution rule above).
- Fixture for role that doesn't exist in `roles` config: orphan warning (separate from toolId-orphan): `bodyFixture for tool ${toolId} has unknown role "${role}"`. Continue.

### 8.6 Acceptance criteria

- Given `bodyFixtures: { 'tool-abc': { 'owner': { memo: 'seeded', amount: 42 } } }`, the `happy`-palette test for `(toolId='tool-abc', role='owner')` has `action.input` containing `memo: 'seeded'` and `amount: 42` regardless of `surface_sample_inputs`.
- Given the same config and role `'member'`: no fixture applied (different role).
- Given `bodyFixtures: { 'tool-abc': { '*': { memo: 'seeded' } } }`: BOTH roles get the wildcard fixture.
- Given `bodyFixtures: { 'tool-abc': { 'owner': { memo: 'A' }, '*': { memo: 'B' } } }`: `owner` gets `'A'`, all other roles get `'B'`.
- Given `null`/`edge`/`out_of_bounds` palette test cases for `toolId 'tool-abc'`: do NOT contain fixture values.
- Given a fixture for an unknown toolId: plan emits warning to log; run continues.
- Given a fixture for an unknown role: plan emits warning to log; run continues.
- Given `bodyFixtures: {}` (the default): no behaviour change vs. today.
- Tool with `inputSchemaConfidence: 'partial'` AND a matching fixture: single happy-path call uses sample-merged-with-fixture as input.
- New test `/root/BugHunter/packages/cli/tests/body-fixtures.test.ts` covers the eight cases above.
- Zod schema accepts and rejects test inputs as documented (5 representative shapes).

### 8.7 SPEC.md edits

§ 3.4.1 — append:

> Where probe recovery is incomplete (e.g. routes using manual, non-Zod validation), users can supplement happy-palette bodies via `BugHunterConfig.bodyFixtures` (keyed by `toolId` then `roleName`). The fixture is shallow-merged over the synthesized happy body before the call. A `"*"` role key acts as a wildcard. Other palette variants (`null`, `edge`, `out_of_bounds`) ignore fixtures by design.

§ 8 — add to the `BugHunterConfig` block:

```ts
bodyFixtures?: Record<string, Record<string, Record<string, unknown>>>;
// toolId → roleName ("*" wildcard supported) → partial body merged onto happy
// palette synthesized input
```

Also extend the `InputSchemaConfidence` union comment in § 8 to mention `'partial'` (consumer of SurfaceMCP-side change).

### 8.8 Files to touch

- `/root/BugHunter/packages/cli/src/types.ts` — `BugHunterConfig.bodyFixtures`; extend `InputSchemaConfidence` union to include `'partial'` (mirror SurfaceMCP).
- `/root/BugHunter/packages/cli/src/config.ts:34-58` — Zod schema entry.
- `/root/BugHunter/packages/cli/src/mutation/apply.ts:37-126` — `buildApiInput`, `apiTestCases` signatures + behaviour; treat `'partial'` like `'unknown'`.
- `/root/BugHunter/packages/cli/src/phases/plan.ts:84-90, 122` — fixture resolution; treat `'partial'` like `'unknown'` (do NOT call `surface_probe` again on a `'partial'` tool — it's already been processed).
- `/root/BugHunter/packages/cli/tests/body-fixtures.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 3.4.1 + § 8.

---

## 9. CLI improvement — Run summary `planned vs ran vs skipped`

### 9.1 Smoke evidence

Smoke output: 183 tests planned, 151 ran, 32 skipped (no browser configured). Diagnosing why 32 were skipped required digging through logs. A pre-execution banner and post-execution recap would make this immediate.

### 9.2 Decision

Two improvements, both small:

1. **Pre-execution banner.** Right before phase 3 (execute) starts in `phases/execute.ts:42-43`, log a one-liner:
   ```
   Executing 183 planned tests: 151 will run (api), 32 skipped (no browserMcpUrl configured)
   ```
   Skipped reason is one of: `no browserMcpUrl configured` (when `opts.browser` is undefined and there are UI tests in queue), `no apiTools available` (when API queue is empty), or `--route filtered all` (when filter excluded everything).
2. **Post-execution recap in `phases/emit.ts:55-71`.** Add three lines to the human stdout summary:
   ```
   Tests: 183 planned, 151 ran, 32 skipped
   Skipped: no browserMcpUrl configured (32 ui tests)
   ```
   Also persist `testsPlanned`, `testsRan`, `testsSkipped`, `skippedReasons` on the `RunSummary` JSON in `summaryFile`.

### 9.3 Boundaries

- **Changes:** `phases/execute.ts` (banner before drain), `phases/emit.ts` (recap + JSON), `types.ts` (RunSummary fields), `phases/plan.ts` (return planned breakdown so emit can use it), `RunState` plumbing.
- **Does NOT change:** test execution behaviour.

### 9.4 Interface contract

```ts
// types.ts — extend RunSummary
export type RunSummary = {
  // …existing fields…
  testsPlanned: number;
  testsRan: number;
  testsSkipped: number;
  skippedReasons: Array<{ reason: string; count: number }>;
};

// phases/execute.ts — emit a banner via process.stdout.write before drainQueue
// phases/emit.ts — read counts from runState (testCases.length, results.length,
//                  results.filter(...).length); compute reasons in execute and persist
```

`RunState` already carries `testCases` (planned) and `testResults` (ran). The "skipped" count is `testCases.length - testResults.length`. The reason categorisation lives in `runExecute`:

```ts
const skipReasons: Array<{ reason: string; count: number }> = [];
if (!browser && uiQueue.length > 0) {
  skipReasons.push({ reason: 'no browserMcpUrl configured', count: uiQueue.length });
}
// other reasons added as future work; v0.1 ships with this one
runState.skipReasons = skipReasons;
```

### 9.5 Acceptance criteria

- Running with browser unset and UI tests in queue: stdout contains `Executing N planned tests: M will run (api), K skipped (no browserMcpUrl configured)` before any test runs.
- Run summary stdout contains `Tests: N planned, M ran, K skipped` and a `Skipped:` line.
- `summary.json` has `testsPlanned`, `testsRan`, `testsSkipped`, `skippedReasons`.
- New test `/root/BugHunter/packages/cli/tests/run-summary.test.ts` (or extension of an existing one) asserts the counters in a small synthetic run.

### 9.6 Files to touch

- `/root/BugHunter/packages/cli/src/types.ts` — `RunSummary` + `RunState.skipReasons`.
- `/root/BugHunter/packages/cli/src/phases/execute.ts:42-44` — banner before drain.
- `/root/BugHunter/packages/cli/src/phases/emit.ts:37-72` — recap + JSON fields.
- `/root/BugHunter/packages/cli/tests/run-summary.test.ts` — NEW.

---

## 10. Open questions

The fixes above are deterministic given user agreement on §3–§9. After this expansion pass, only one item remains:

### 10.1 Browser-side test plan validation in CI

The smoke ran without browser. With Bug 1's adapter rewrite, browser tests will execute. **Question for follow-up (NOT for this spec):** should the project gain a CI-friendly browser-mode smoke that runs against a fixture Next.js app under `fixtures/`, with camofox spun up via pm2 in the CI runner? Out of scope — open ended infra question. Listed only so it's not lost.

All other items previously in this section have been resolved:
- §10.1 (camofox argument-shape drift) → folded into § 3 as a full rewrite.
- §10.2 (feature-branch retention) → confirmed in § 6.3.
- §10.3 (per-role bodyFixtures) → folded into § 8 with `Record<toolId, Record<role, body>>`.
- §10.4 (probe tightening) → sister spec at `/root/SurfaceMCP/SPEC_PROBE_TIGHTENING.md`; consumer side covered in § 8.
- §10.5 (cluster relations always-on) → confirmed in § 7.
- §10.6 (runbook docs location) → confirmed in § 6.

---

## 11. Risk & sequencing

### 11.1 Independence

| Item | Repo | Depends on | Notes |
|---|---|---|---|
| Bug 1 (camofox rewrite) | BugHunter | none structurally — touches `browser-mcp.ts` + new sibling | Largest commit; selector→ref algorithm is the riskiest part. |
| Bug 2 (browserMcpUrl convention) | BugHunter | Bug 1 (same file) | Land in same PR as Bug 1. |
| Bug 3 (`--no-interactive`) | BugHunter | none | Independent file set. |
| Bug 4 (SurfaceMCP runbook) | BugHunter (docs only) | none | Pure docs. Update bullets in dist-skill in lockstep with each fix. |
| § 9 (run summary) | BugHunter | none | Small. |
| Question A (related clusters) | BugHunter | endpoint shape change in `phases/execute.ts` | See § 11.3. |
| Question B (bodyFixtures) | BugHunter | SurfaceMCP § A (`'partial'` variant) for full effect; works without it for tools at `'unknown'` | Land BugHunter-side first; SurfaceMCP-side enables the `'partial'` path. |
| SurfaceMCP § A–D | SurfaceMCP | none structurally | Independent of BugHunter. Land first or in parallel. |

### 11.2 Recommended landing order

**Phase 1 — pure docs (no code risk).**
1. Bug 4 (BugHunter dist-skill update + RUNBOOKS.md).

**Phase 2 — BugHunter low-risk.**
2. Bug 3 (`--no-interactive`).
3. § 9 (run summary).

**Phase 3 — BugHunter browser path.**
4. Bug 1 + Bug 2 (camofox rewrite + URL convention) — single PR; commits in this order: URL normalisation, then full rewrite, then test files.

**Phase 4 — SurfaceMCP-side (parallel to BugHunter Phase 4).**
5. SurfaceMCP § A (`'partial'` variant).
6. SurfaceMCP § B (manual-validation analyser).
7. SurfaceMCP § C (grep-init precision).
8. SurfaceMCP § D (port autodetect).

**Phase 5 — BugHunter consumes SurfaceMCP changes.**
9. Question B (bodyFixtures) — depends on SurfaceMCP § A having shipped (so `'partial'` enum exists in SurfaceMCP responses); can land BugHunter-side type extension first since it's a forward-compat change.

**Phase 6 — clustering.**
10. Question A (related clusters) — last; biggest blast radius on cluster signatures.

### 11.3 Highest risk: Question A's `surface_call_failed` endpoint change

Switching `surface_call_failed.endpoint` from bare `toolId` to `"METHOD /normalized/path"` rewrites the cluster signature for that kind. Persisted state from prior runs will not match. Mitigations:

- **No fixture migration.** Old runs stay on disk under old keys; new runs cluster under new keys. Users prune old runs or accept the gap.
- **Tests:** existing `cluster.test.ts` does not exercise `surface_call_failed`; verify with grep before commit.
- **`bughunter retest`:** the contract is "given a clusterId from THIS run, retest its occurrences." Cross-run cluster-id stability has never been promised.
- **Land Question A AFTER Question B.** With Question B working, the smoke produces fewer surface_call_failed clusters — easier to verify the annotation logic on a smaller cluster set.

### 11.4 Risk: camofox snapshot format drift

The selector→ref algorithm parses the upstream snapshot text format (Playwright a11y tree). If camofox's upstream `/tabs/<id>/snapshot` returns a different format than the example at § 3.7, `parseSnapshot` produces zero nodes and every `click`/`type` throws `snapshot_failed`.

Mitigations:
- The parser is forgiving: any line with a `[ref=eN]` or trailing `[eN]` token contributes a node. Indentation, role spelling, attribute quoting variations don't break it.
- A `snapshot_failed` error message includes the first 200 chars of the raw snapshot for diagnosis. Easy to debug.
- A defensive regression test in `browser-mcp-snapshot.test.ts` parses three concrete sample snapshot strings (sign-in form, product list, dashboard) and asserts the right counts/refs come out.

### 11.5 Sequencing tests

- Run `npx vitest run` after each fix lands. Each fix has its own test file; cumulative test count grows monotonically.
- After all BugHunter fixes: re-run integration smoke against `/root/spoonworks` (API path) → confirm 100/151 still pass, 0 infra failures, the false-positive `surface_call_failed` cluster is gone (Question B), remaining co-occurring clusters carry `relatedClusterIds` (Question A).
- After all SurfaceMCP-side fixes: re-run smoke with `'partial'`-confidence routes producing partial schemas; verify `_suggestedExternalIntegrations` no longer lists page components.
- After full cross-repo set: run smoke WITH `browserMcpUrl` set → expect render/click/type tests to actually execute end-to-end against Spoonworks.

---

## 12. Test plan summary

| Test file | Status | Covers |
|---|---|---|
| `tests/browser-mcp-url.test.ts` | NEW | Bug 1 prefix dispatch + Bug 2 URL normalization |
| `tests/browser-mcp-protocol.test.ts` | NEW | Bug 1: tab tracking, screenshot path materialisation, error mapping, retry-on-element-not-found |
| `tests/browser-mcp-snapshot.test.ts` | NEW | Bug 1: snapshot parser + selector→ref algorithm (eight resolution cases per § 3.7) |
| `tests/init.test.ts` | NEW | Bug 3 |
| `tests/body-fixtures.test.ts` | NEW | Question B (per-role fixtures) |
| `tests/cluster-related.test.ts` | NEW | Question A |
| `tests/run-summary.test.ts` | NEW | § 9 (planned/ran/skipped counters) |
| `tests/cluster.test.ts` | unchanged | regression baseline |
| `tests/surface-mcp-url.test.ts` | unchanged | regression baseline |

Run `npx vitest run` after each commit; expect the count to grow at each step.

---

## 13. Definition of done

- All items above land per § 11.2 sequencing.
- All listed acceptance criteria pass.
- `npx tsc --noEmit` clean.
- `npx eslint . --max-warnings 0` clean.
- `npx vitest run` green.
- Re-run smoke against `/root/spoonworks`:
  - **API path (no browser):** 0 false-positive `surface_call_failed` clusters on tools listed in `bodyFixtures`. Remaining `404_for_linked_route` and `surface_call_failed` clusters that share a route carry mutual `relatedClusterIds`. Run summary stdout contains `Tests: N planned, M ran, K skipped` line.
  - **Browser path (with `browserMcpUrl` set to camofox `:3104`):** every render/click/type test executes end-to-end. No `Method not found`, no `is not valid JSON`, no JSON-RPC envelope leaks. Real Spoonworks bugs (if any) are produced in `bugs.jsonl` instead of smoke artifacts.
  - `bughunter init --no-interactive` runs without prompting (smoke this in a temp dir).
- `dist-skill/bughunt-host.md` updated; gotchas list reflects the post-fix state.
- `/root/BugHunter/docs/RUNBOOKS.md` exists.
- SurfaceMCP local `main` synced per the runbook.
- SurfaceMCP-side spec (`/root/SurfaceMCP/SPEC_PROBE_TIGHTENING.md`, branch `spec/probe-and-detection-tightening`, commit `16e1b18`) is ready for its own coder pass.
