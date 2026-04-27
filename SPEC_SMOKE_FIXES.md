# Smoke-Derived Fix Spec — BugHunter v0.1

Source: integration smoke against `/root/spoonworks` on 2026-04-26 with SurfaceMCP `feat/v0.1-implementation`, BugHunter `master`, camofox-mcp HTTP daemon on `127.0.0.1:3104`.

The smoke ran the API-only path end-to-end. 64 tools discovered, Auth.js v5 cookie auto-detection succeeded as `owner`, 151 tests ran, 100 passed, 0 infrastructure failures, 0 real Spoonworks bugs. Two clusters were false positives explainable as smoke artifacts (one missing-fixture, one probe-inferred-schema gap). The browser path was blocked by `CamofoxBrowserMcpAdapter` returning JSON-parse errors on every call.

This spec turns the smoke findings into a contract the coder will implement. **Do not implement until the user accepts the spec.**

---

## 1. Problem statement

Four concrete defects and two design questions surfaced from the smoke. They are independent enough to land on small commits but share enough surface area (`browser-mcp.ts`, `init.ts`, `cluster/signature.ts`, `BugHunterConfig` schema, `SPEC.md`) that a coordinated spec is cheaper than four individual ones.

The fix set, in priority order:

1. **Bug 1 — `CamofoxBrowserMcpAdapter` tool-name prefix.** Adapter calls camofox tools as `mcp__camofox__navigate` etc.; the live server registers them unprefixed. Every browser-layer call fails. **Blocks the browser path entirely.**
2. **Bug 2 — `browserMcpUrl` convention.** The adapter requires the full `…/mcp` URL while `surfaceMcpUrl` is documented as a base URL with the adapter appending `/mcp`. The asymmetry is undocumented and bit the smoke run.
3. **Bug 3 — `bughunter init --no-interactive` is silently ignored.** The flag is parsed by `main.ts`-style passthrough but `initCommand` always opens a readline prompt.
4. **Bug 4 — SurfaceMCP local `main` branch is stale (release-hygiene).** The PR #1 merge already landed on `origin/main`; the local checkout just hasn't pulled. Pure git-ops fix, no SurfaceMCP code change.
5. **Question A — Cluster signature merge across kinds.** Add a co-occurrence link (annotative); do not change canonical signatures. See §6.
6. **Question B — Body-fixture escape-hatch.** Add `bodyFixtures` to `BugHunterConfig`, applied only on the `happy` palette for API direct-call tests. See §7.

Out of scope of this spec — see "Open questions" §10:

- Camofox argument-shape / result-shape drift in `CamofoxBrowserMcpAdapter` (separate from prefix bug; needs user input).
- Re-tightening `surface_probe` to detect manual (non-Zod) validation. SurfaceMCP-side change, owned by that repo.

---

## 2. Existing code map (read these before writing any code)

### Files you MUST read before touching anything:
- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — every change in Bugs 1 & 2 lives here.
- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — pattern to mirror for `browserMcpUrl` normalization (see lines 81–88).
- `/root/BugHunter/packages/cli/src/cli/init.ts` — Bug 3.
- `/root/BugHunter/packages/cli/src/cli/main.ts` — flag parsing for Bug 3 (lines 49–71, 86–88).
- `/root/BugHunter/packages/cli/src/config.ts` — Zod schema; add `bodyFixtures` field for Question B.
- `/root/BugHunter/packages/cli/src/types.ts` — `BugHunterConfig` type (lines 316–340); `BugDetection` (270–285); `BugCluster` (118–133).
- `/root/BugHunter/packages/cli/src/cluster/signature.ts` — Question A reference (do not change signature math).
- `/root/BugHunter/packages/cli/src/phases/cluster.ts` — Question A: post-cluster pass goes here.
- `/root/BugHunter/packages/cli/src/phases/plan.ts` — Question B: `enrichToolSchemas`, `apiTestCases` call site.
- `/root/BugHunter/packages/cli/src/mutation/apply.ts` — Question B: `buildApiInput` is where bodyFixtures merge applies.
- `/root/BugHunter/packages/cli/src/phases/execute.ts` — context for surface_call_failed detection (lines 277–289).
- `/root/BugHunter/packages/cli/src/classify/network.ts` — context for 404_for_linked_route detection (line 41).
- `/root/BugHunter/packages/cli/tests/surface-mcp-url.test.ts` — pattern to mirror for new `browser-mcp-url.test.ts`.
- `/root/BugHunter/packages/cli/tests/cluster.test.ts` — existing cluster signature tests; **do not modify** unless explicitly required by §6.
- `/root/BugHunter/SPEC.md` § 3.4.5 (line 190), § 3.6 (line 235), § 3.5.1 (line 212), § 4.1 (line 559), § 8 (line 803).

### Patterns to follow:
- **MCP adapter URL normalisation:** `surface-mcp.ts:87` strips one trailing `/mcp/?` and any trailing slash, then appends `/mcp` on every call. Mirror this exactly in `browser-mcp.ts`.
- **Adapter mock pattern in tests:** `surface-mcp-url.test.ts` uses `vi.stubGlobal('fetch', …)` to capture URLs. Reuse this shape verbatim.
- **Config Zod schema:** `config.ts:34` — extend the existing `ConfigSchema`, do not create a parallel schema.

### DO NOT:
- Do not create a new adapter file. All Bug 1 / Bug 2 changes are inside `browser-mcp.ts`.
- Do not change camofox argument or result shapes — see §10 "Open questions". The prefix fix may surface follow-up errors; that is expected and a separate work item.
- Do not modify `cluster/signature.ts` for Question A. The decision is annotative only.
- Do not migrate existing `.bughunter/runs/*` state. Cluster annotations are forward-only.
- Do not add a `--non-interactive` alias for Bug 3 unless the user asks. Use `--no-interactive` as documented.
- Do not push or merge anything to remote SurfaceMCP. Bug 4 is a local-only sync fix.

### Negative constraints (stack-wide):
- No `as any`. Use `unknown` and narrow.
- No `catch (e: any)` or empty `catch {}`.
- Max 40 lines per function (existing `mcpCall` already approaches this — extract a helper if needed).
- Max 300 lines per file. `browser-mcp.ts` will grow modestly; if it crosses 250 lines, extract `parseMcpResponse` into a sibling helper.
- Tests live alongside the file under `tests/` (existing convention).

---

## 3. Bug 1 — Camofox tool-name prefix mismatch

### 3.1 Root cause

`/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` lines 73–107: every `mcpCall` invocation passes a tool name like `mcp__camofox__navigate`. The HTTP MCP server at `/root/camofox-mcp/src/core/tools.ts` registers tools by their bare names (`navigate`, `snapshot`, `click`, `type`, `scroll`, `screenshot`, `evaluate`, `list_tabs`, `close_tab` — confirmed at `tools.ts:23, 40, 58, 74, 92, 108, 127, 144, 156`). The MCP server returns a JSON-RPC error `Method not found` (or similar); BugHunter then tries to parse the error envelope as the result body and surfaces "MCP error … is not valid JSON".

The `mcp__<server>__<tool>` convention is a Claude Code proxy-side prefix applied when Claude Code routes tool calls to a registered MCP server. When BugHunter speaks JSON-RPC directly to the HTTP MCP, that proxy is not in the loop and the prefix must not be applied.

### 3.2 Decision

**Drop the prefix unconditionally.** BugHunter's `CamofoxBrowserMcpAdapter` is, by design, a direct HTTP client — it never routes through a Claude proxy. There is no v0.1 use case for the prefix, and adding a config flag introduces a footgun (the exact one we just hit: a "harmless"-looking config produces 100% failure). If a future Claude-proxy adapter is needed, write a separate adapter class.

### 3.3 Boundaries

- **Changes:** call sites in `CamofoxBrowserMcpAdapter` only.
- **Does NOT change:** the `BrowserMcpAdapter` interface (line 16), result types, the `mcpCall` helper, response parsing, error handling, the error message text on failure modes other than the prefix.
- **Does NOT touch:** camofox-mcp source. Camofox is correct.

### 3.4 Interface contract

No public interface changes. Internal call sites only.

### 3.5 Edge cases

- **Camofox upgrade adds a new tool:** new tool must be added unprefixed.
- **Camofox renames an existing tool:** test failure if hard-coded names go stale; acceptable — caught by integration smoke.
- **Adapter is invoked through a future Claude proxy:** out of scope. Spec a new `ProxiedBrowserMcpAdapter` then; do not retrofit this one.

### 3.6 Acceptance criteria

- Given the camofox HTTP MCP daemon running on `127.0.0.1:3104`, `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104').listTabs()` returns a parsed `ListTabsResult` (or throws on a transport-level failure), but **never** throws "is not valid JSON" caused by a `Method not found` error envelope.
- All nine call sites (`navigate`, `click`, `type`, `scroll`, `snapshot`, `screenshot`, `evaluate`, `listTabs`, `closeTab`) pass the bare tool name.
- A new test in `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` (see §4.6) asserts the captured request body has `params.name` matching `/^(navigate|click|type|scroll|snapshot|screenshot|evaluate|list_tabs|close_tab)$/` for one representative call.

### 3.7 Files to touch

- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — replace nine `mcp__camofox__<tool>` literals with their unprefixed forms.
- `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` — **NEW**; covers Bug 1 and Bug 2 together.

---

## 4. Bug 2 — `browserMcpUrl` convention asymmetric with `surfaceMcpUrl`

### 4.1 Root cause

`/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts:32-34`:
```ts
constructor(baseUrl: string = 'http://127.0.0.1:3100/mcp') {
  this.baseUrl = baseUrl.replace(/\/$/, '');
}
```
The default contains `/mcp`; the constructor only trims a trailing slash. `mcpCall` at line 43 then `fetch(`${this.baseUrl}`)` — no `/mcp` append. So:
- `'http://127.0.0.1:3104'` (base only) → fetches `http://127.0.0.1:3104/` → connect works but JSON-RPC fails because the MCP endpoint is at `/mcp`.
- `'http://127.0.0.1:3104/mcp'` (full URL, what the smoke had to use as workaround) → works.
- The default works because the default ALREADY has `/mcp`.

`surface-mcp.ts:81-88` does the opposite (base URL is canonical, adapter appends `/mcp`, strips one trailing `/mcp/?` for backward-compat). SPEC.md § 3.4.5 documents the surfaceMcpUrl convention; nothing analogous exists for `browserMcpUrl`.

The `init.ts:21` prompt default for `browserMcpUrl` is `'http://127.0.0.1:3100/mcp'` — full URL. SPEC.md § 8 line 811 just declares `browserMcpUrl?: string` with no convention note.

### 4.2 Decision

**Align `browserMcpUrl` with `surfaceMcpUrl`: base URL is canonical, adapter appends `/mcp`, strip one trailing `/mcp/?` for backward-compat.** Document the convention in SPEC.md § 3.4.5 alongside the existing `surfaceMcpUrl` paragraph (rename the section heading to cover both, or add a sibling § 3.4.6).

Rationale:
- Symmetry: users only need to remember one rule for MCP URLs.
- Migration: backward-compat strip means existing configs with `/mcp` keep working.
- Default change: the `init` prompt default becomes `'http://127.0.0.1:3100'` (base form) to match the documented convention. Existing `init.ts:21` default with `/mcp` continues to be accepted by the adapter (strip-one-trailing branch covers it), but the prompt should advertise the canonical form.

### 4.3 Boundaries

- **Changes:** `browser-mcp.ts` constructor + `mcpCall` URL construction; `init.ts` prompt default + label; SPEC.md § 3.4.5 (rename + extend); SPEC.md § 8 comment for `browserMcpUrl`.
- **Does NOT change:** `surfaceMcpUrl` behaviour, `BugHunterConfig` schema, tests for `surface-mcp-url.test.ts`, runtime config-load semantics. The Zod schema for `browserMcpUrl` is `z.string().url().optional()` — both base and full forms parse as valid URLs.

### 4.4 Interface contract

`CamofoxBrowserMcpAdapter` constructor signature unchanged: `constructor(baseUrl?: string)`. New default value: `'http://127.0.0.1:3100'` (base URL). Internal: `this.baseUrl` becomes the trimmed base WITHOUT `/mcp`; `mcpCall` fetches `${this.baseUrl}/mcp`.

### 4.5 Edge cases

- Input `'http://127.0.0.1:3100'` → fetches `http://127.0.0.1:3100/mcp`.
- Input `'http://127.0.0.1:3100/'` → fetches `http://127.0.0.1:3100/mcp`.
- Input `'http://127.0.0.1:3100/mcp'` → trailing `/mcp` stripped → fetches `http://127.0.0.1:3100/mcp`.
- Input `'http://127.0.0.1:3100/mcp/'` → trailing `/mcp/` stripped → fetches `http://127.0.0.1:3100/mcp`.
- Input `'http://127.0.0.1:3100/mcp/extra'` → does NOT strip (regex anchored at end with optional slash); fetches `http://127.0.0.1:3100/mcp/extra/mcp`. This is intentional — sub-path users opted out of normalization. Document in SPEC.
- Input with HTTPS, port omitted, IPv6 host: handled by the regex (which only matches `/mcp/?$`); URL parsing per Zod validation.
- No `browserMcpUrl` set in config: adapter uses default base. `surface_call`-only API mode still works, no instantiation needed.

### 4.6 Acceptance criteria

A new test file `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` mirrors `surface-mcp-url.test.ts` exactly:

- Given `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104')`, the captured fetched URL on any tool call is `'http://127.0.0.1:3104/mcp'`.
- Given `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp')`, the captured URL equals the base-URL form.
- Given `new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp/')`, the captured URL equals the base-URL form.
- Given a call to `listTabs()`, the request body's `params.name` is `'list_tabs'` (covers Bug 1).
- Given a call to `navigate('https://x')`, the request body's `params.name` is `'navigate'` (covers Bug 1).

### 4.7 SPEC.md edits

Edit § 3.4.5 — rename heading to **"3.4.5 `surfaceMcpUrl` and `browserMcpUrl` convention"**. Append a paragraph:

> `BugHunterConfig.browserMcpUrl` follows the same convention as `surfaceMcpUrl`: it is the **base URL** of the camofox MCP HTTP server (e.g. `http://127.0.0.1:3100`), without the `/mcp` path. The adapter appends `/mcp` internally on every call and strips one trailing `/mcp` (with optional trailing slash) for backward compatibility. The `init` wizard's prompt and default both use the base URL form.

Edit § 8 (line 811): change comment to `// http://127.0.0.1:3100  (base form, /mcp appended internally)`.

### 4.8 Files to touch

- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` — constructor regex + default; `mcpCall` `${this.baseUrl}/mcp`.
- `/root/BugHunter/packages/cli/src/cli/init.ts` — prompt default, label.
- `/root/BugHunter/packages/cli/tests/browser-mcp-url.test.ts` — NEW, see §4.6.
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
The flags object built at lines 49-71 captures `--no-interactive` correctly but is not threaded into `initCommand`. `initCommand` (lines 10-43 of `init.ts`) unconditionally opens a readline interface and prompts.

### 5.2 Decision

Thread the flag through. Add additional override flags so non-interactive callers can specify values; otherwise apply documented defaults. Fail loudly if the resolved config is invalid (Zod validation).

### 5.3 Boundaries

- **Changes:** `main.ts` (init case), `init.ts` (signature + body).
- **Does NOT change:** the interactive prompt UX. Without `--no-interactive`, behaviour is unchanged.
- **Does NOT add:** `--non-interactive` (alias). One flag, one spelling.
- **Does NOT add:** a config file path override (`--config-out`). Always writes `<cwd>/.bughunter/config.json`.

### 5.4 Interface contract

`initCommand` signature changes:

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

`main.ts` parses these CLI flags into an `InitOptions` and calls `initCommand(projectDir, opts)`. Existing call (no opts) is preserved as `initCommand(projectDir)` — backward-compatible.

CLI flags added to USAGE help text:

```
bughunter init [--no-interactive] [--project-name <name>] [--surface-mcp-url <url>]
               [--browser-mcp-url <url>] [--reset-command <cmd>] [--reset-policy <policy>]
```

### 5.5 Behavioural rules

When `noInteractive: true`:
1. **Skip readline entirely.** Do not open `process.stdin`. (CI environments may have no stdin.)
2. Resolve each field by precedence: `opts.<field>` → environment variable (`BUGHUNTER_<FIELD>`, e.g. `BUGHUNTER_SURFACE_MCP_URL`) → default. Defaults match the interactive defaults:
   - `projectName`: `path.basename(projectDir)`.
   - `surfaceMcpUrl`: `'http://127.0.0.1:3102'`.
   - `browserMcpUrl`: `undefined` (not set; user opts into UI mode by overriding).
   - `resetCommand`: `undefined`.
   - `resetPolicy`: `'per-page'`.
3. Validate the resolved config against the existing Zod schema in `config.ts`. On failure, throw with the Zod error path so the user knows which field is invalid (e.g. surfaceMcpUrl is not a URL).
4. Write `.bughunter/config.json` via `saveConfig` exactly as the interactive path does.
5. Print the same "Config written" + "Next steps" output to stdout.

When `noInteractive: false` or unset: run the existing interactive flow unchanged.

### 5.6 Edge cases

- **`.bughunter/config.json` already exists:** existing `if (fs.existsSync(...))` guard runs first regardless of `noInteractive`; behaviour unchanged.
- **`--no-interactive` with `--surface-mcp-url not-a-url`:** throw via Zod with the message `Invalid .bughunter/config.json: surfaceMcpUrl: Invalid url`.
- **`--no-interactive` with `--reset-policy bogus`:** throw via Zod (`resetPolicy` enum).
- **Env var `BUGHUNTER_PROJECT_NAME` set, `--project-name` also passed:** flag wins (precedence rule 2).
- **Project dir basename empty (e.g. `/`):** Zod `min(1)` catches; throw.
- **`--no-interactive` without any other flags:** all defaults apply; project dir basename used. This is the CI-style default.
- **Flag without `--no-interactive`:** flags are silently ignored in interactive mode (do not pre-fill prompts). Document behaviour in USAGE.

### 5.7 Acceptance criteria

- `bughunter init --no-interactive` in a fresh dir writes `.bughunter/config.json` with `projectName=<basename>`, `surfaceMcpUrl='http://127.0.0.1:3102'`, `resetPolicy='per-page'`, no `browserMcpUrl`, no `resetCommand`.
- `bughunter init --no-interactive --project-name myproj --surface-mcp-url http://x:1` writes the overridden values.
- `bughunter init --no-interactive --surface-mcp-url not-a-url` exits non-zero with a clear Zod error message.
- `bughunter init --no-interactive` does not block waiting on stdin; runs to completion in <100ms in a process with closed stdin.
- A new test `/root/BugHunter/packages/cli/tests/init.test.ts` covers: (a) defaults applied, (b) flag overrides, (c) env var fallback, (d) invalid URL fails Zod, (e) does not call `readline`. Use `vi.mock('node:readline/promises', …)` to assert non-call.

### 5.8 Files to touch

- `/root/BugHunter/packages/cli/src/cli/init.ts` — new signature, branching on `noInteractive`.
- `/root/BugHunter/packages/cli/src/cli/main.ts` — parse new flags, build `InitOptions`, pass to `initCommand`. Update USAGE.
- `/root/BugHunter/packages/cli/tests/init.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 4.1 — update the `bughunter init` block to list the flags.

---

## 6. Question A — Cluster signature merge across kinds

### 6.1 Smoke evidence

Two clusters on the same `toolId` (`0928801337a9` = `post_api_admin_alerts_oversell_id_resolve`):
- `v3hv57r5` kind=`404_for_linked_route`, signature `404_for_linked_route|/api/admin/alerts/oversell/<id>/resolve`.
- `khiyrdlh` kind=`surface_call_failed`, signature `surface_call_failed|0928801337a9`.

Both root-caused to a missing `discoveryFixtures` entry for the dynamic `:id` segment. Same upstream defect, two clusters.

### 6.2 Why the priority hierarchy doesn't fix this

SPEC § 3.5.1 collapses multiple detections **per occurrence** to one canonical kind. The two clusters here come from **different occurrences** (one from the UI walker hitting a 404 link, one from the API direct-call test sending a synthetic id). § 3.5.1 doesn't reach across occurrences.

### 6.3 Decision: annotative co-occurrence link, NOT signature merge

**Do not change `clusterSignature` for `404_for_linked_route` or `surface_call_failed`.** Reasons:

1. **Signature change has the largest blast radius in this spec.** It silently rebreaks any persisted run state (clusters keyed under old signatures don't merge with new). It also breaks `bughunter retest`'s assumption that a clusterId is stable across re-runs of the same test plan.
2. **The two kinds carry genuinely different diagnostic signal.** `404_for_linked_route` says "this link is broken from the user's perspective." `surface_call_failed` says "this API endpoint rejects a happy-palette body." Same root cause, different surface — and the user often wants both signals. Surface-call-failed without the corresponding 404 means the link exists but the endpoint is broken; 404 without surface_call_failed means the link is wrong but the endpoint is fine. Collapsing loses that.
3. **The right fix for the smoke artifact is upstream — `discoveryFixtures`.** Once the user provides a fixture id, both clusters disappear.
4. **The annotation gives the user the merge they want at report time** without changing storage.

Add a **post-cluster co-occurrence annotation pass**. New `BugCluster` field `relatedClusterIds?: string[]`. After all clusters are built in `runCluster` (`phases/cluster.ts`), walk the cluster set and link clusters that:

- Reference the same canonical route (method + normalized path), AND
- Are of pair-eligible kinds: `404_for_linked_route` ↔ `surface_call_failed`.

The `endpoint` field on `surface_call_failed` is currently the bare `toolId`. To compute "same canonical route", surface_call_failed detection must store enough info. Update `phases/execute.ts:282-287`:

```ts
bugs.push({
  kind: 'surface_call_failed',
  rootCause: `surface_call failed with status ${status} for tool ${tc.action.toolId}`,
  endpoint: `${meta?.method ?? 'POST'} ${normalizePath(meta?.path ?? tc.action.toolId)}`,
  status,
  responseBodyShape: result.error?.message,
});
```

…where `meta = toolMap.get(tc.action.toolId)` and `normalizePath` is the same helper as `classify/network.ts:53`. This change DOES affect the existing `surface_call_failed` cluster signature (signature.ts:30 uses `endpoint`). Acceptable because:

- The signature still keys per-tool — same tool's failures still cluster together.
- The signature now compares apples-to-apples with `network_4xx_unexpected` (which already uses `${method} ${normalizedPath}`).
- The "10 known stacks → 3 clusters" cluster.test.ts fixture covers `console_error` only, not `surface_call_failed`.

This brings `surface_call_failed`'s key into line with what SPEC § 3.6 says for `network_*` ("`endpoint` (method + normalized path) + `status`"). SPEC § 3.6 currently has no row for `surface_call_failed`; add one.

### 6.4 Boundaries

- **Changes:** `phases/execute.ts` (endpoint computation), `phases/cluster.ts` (post-pass), `types.ts` (`BugCluster.relatedClusterIds`), `cluster/signature.ts` (no math change, but document that surface_call_failed key uses normalized endpoint), `SPEC.md` § 3.6 + § 3.7.
- **Does NOT change:** `404_for_linked_route` signature.
- **Does NOT change:** existing cluster fixture test (`cluster.test.ts:120-136`) — those test `network_5xx` and `404_for_linked_route` specifically, both unchanged.
- **Does NOT migrate** existing `runs/<id>/bugs.jsonl` — annotations are forward-only.

### 6.5 Interface contract

```ts
// types.ts — extend BugCluster
export type BugCluster = {
  // …existing fields…
  relatedClusterIds?: string[];  // co-occurring clusters; same canonical route + paired kinds
};

// phases/cluster.ts — new helper
function annotateRelatedClusters(clusters: BugCluster[]): void;
```

`annotateRelatedClusters` runs in-place at the end of `runCluster`. For each pair (a, b) where:
- `a.kind === '404_for_linked_route'` and `b.kind === 'surface_call_failed'` (or vice versa), AND
- `routeKeyOf(a) === routeKeyOf(b)`,

…push `b.id` into `a.relatedClusterIds` and `a.id` into `b.relatedClusterIds` (mutual link).

`routeKeyOf`:
- For `surface_call_failed`: parse `endpoint` (now `"METHOD /normalized/path"`). Take the path, ensure leading `/`.
- For `404_for_linked_route`: take `targetPath`, run through the same `normalizePath` from `classify/network.ts:53`.

Comparison: equal normalized paths regardless of method (the 404 path doesn't carry method info). This is intentionally lenient — the surface_call_failed event is on a specific method but the 404 simply means "GET on this path returns 404," which often co-indicates the path is wrong/missing across all methods.

### 6.6 Edge cases

- **Same path, multiple tools (e.g. `POST /x` and `PUT /x` both registered as tools):** both surface_call_failed clusters link to the same 404 cluster. Acceptable.
- **404 cluster has no surface_call_failed pair:** `relatedClusterIds` stays undefined. JSONL emit must omit the field when empty (don't write `[]`).
- **More than 2 clusters share a path:** mutual links across all of them. `relatedClusterIds` may have multiple entries.
- **No tool meta found for a `surface_call_failed` (toolMap miss):** fall back to bare toolId in `endpoint` (preserves current behavior); no co-occurrence link possible. Log a debug warning.

### 6.7 Acceptance criteria

- Given a run that produces `404_for_linked_route` cluster A on path `/api/x/:id/y` and `surface_call_failed` cluster B for the tool whose path is `/api/x/:id/y`, after `runCluster` returns: `A.relatedClusterIds` includes `B.id`, `B.relatedClusterIds` includes `A.id`.
- Given an isolated `404_for_linked_route` cluster with no matching `surface_call_failed`: `relatedClusterIds` is `undefined`, and the JSON serialization omits the field.
- Given two `surface_call_failed` clusters with *different* normalized paths: no link between them.
- Existing `cluster.test.ts` test "404_for_linked_route keyed by targetPath" passes unchanged.
- A new test `/root/BugHunter/packages/cli/tests/cluster-related.test.ts` covers the four cases above.
- `bughunter inspect <clusterId>` output (existing command in `cli/inspect.ts`) prints `Related clusters: <id1>, <id2>` when set; existing output unchanged when not.

### 6.8 SPEC.md edits

§ 3.6 — add a row to the signature table:

| `surface_call_failed` | `endpoint` (method + normalized path) + `status` |

…and after the table, add a paragraph:

> **Cross-kind co-occurrence (additive, not collapse).** After clustering, BugHunter walks the cluster set and links clusters that share a normalized route across pair-eligible kinds: `404_for_linked_route` ↔ `surface_call_failed`. Linked clusters reference each other via `relatedClusterIds`. This is purely metadata — the canonical signatures and cluster ids are unchanged. Use case: a missing `discoveryFixtures` entry for a dynamic route trips both kinds; the link tells the user "these are the same root cause."

§ 3.7 — add `relatedClusterIds?: string[]` to the bugs.jsonl example shape.

### 6.9 Files to touch

- `/root/BugHunter/packages/cli/src/types.ts` — `BugCluster.relatedClusterIds`.
- `/root/BugHunter/packages/cli/src/phases/execute.ts` — surface_call_failed `endpoint` becomes `${method} ${normalizedPath}`. Reuse `normalizePath` from `classify/network.ts` (export it if currently private).
- `/root/BugHunter/packages/cli/src/classify/network.ts` — export `normalizePath`.
- `/root/BugHunter/packages/cli/src/phases/cluster.ts` — new `annotateRelatedClusters`, called at end of `runCluster`.
- `/root/BugHunter/packages/cli/src/cli/inspect.ts` — print `Related clusters` line when set.
- `/root/BugHunter/packages/cli/tests/cluster-related.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 3.6 + § 3.7.

---

## 7. Question B — `bodyFixtures` escape-hatch for incomplete probe-inferred schemas

### 7.1 Smoke evidence

Spoonworks tools that don't use Zod (manual `if (!body.memo) throw …`) get `inputSchemaConfidence: 'unknown'`. `surface_probe` upgrades them to `'inferred'` but the inferred schema misses required fields, so the `happy` palette sends an empty body and trips 400/422. False-positive `surface_call_failed` cluster.

### 7.2 Decision

**Add `bodyFixtures` to `BugHunterConfig`, keyed by toolId, applied only on the `happy` palette for API direct-call tests.** Tightening `surface_probe` (the alternative) is a SurfaceMCP-side change and out of scope here; the escape-hatch unblocks users immediately.

Rationale for keying by `toolId` (not name):
- `toolId` is a stable hash — survives renames.
- SPEC § 4.1 already exposes `toolId` as the primary identifier (`surface_call({ toolId, … })`).
- Tool names can collide across stacks in monorepos.

Apply only on `happy` because the other palettes (`null`, `edge`, `out_of_bounds`) are deliberately constructed to violate the schema and expose error handling. A fixture would defeat their purpose. Apply only to API direct-call tests (`apiTestCases`); UI form fill-and-submit has its own discovery path.

### 7.3 Boundaries

- **Changes:** `BugHunterConfig` schema (`config.ts`), `types.ts`, `mutation/apply.ts` (`buildApiInput`), `phases/plan.ts` (thread the config through to `apiTestCases`), `cli/init.ts` (no UI prompt — empty default), SPEC.md § 8 + § 3.4.1.
- **Does NOT change:** form-fill mutation logic, palette generation for non-`happy` variants, `surface_sample_inputs` precedence (fixture overrides sample), the schema-inference upgrade flow itself.
- **Does NOT live in:** `surfacemcp.config.json`. Even though fixtures are project-scoped, `surfacemcp.config.json` is owned by SurfaceMCP and describes the project topology; BugHunter-test-data lives in BugHunter config (mirrors `discoveryFixtures`).

### 7.4 Interface contract

```ts
// types.ts — extend BugHunterConfig
export type BugHunterConfig = {
  // …existing fields…
  bodyFixtures?: Record<string, Record<string, unknown>>;
  // Key: toolId. Value: partial body merged onto the synthesized happy-palette
  // body BEFORE the call. Applies only to API direct-call tests on the
  // 'happy' palette. Use to supplement schemas that surface_probe couldn't
  // fully recover (e.g. routes using manual non-Zod validation).
};
```

```ts
// config.ts — extend ConfigSchema
bodyFixtures: z.record(z.record(z.unknown())).optional(),
```

```ts
// mutation/apply.ts — extend buildApiInput
export function buildApiInput(
  tool: ToolMeta,
  palette: PaletteVariant,
  sampleInput: unknown,
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>,  // NEW
): unknown;
```

`buildApiInput` behaviour:
1. Synthesize body from schema + samples + palette as it does today.
2. **Only when `palette === 'happy'` and `bodyFixture` is non-null**: shallow-merge `bodyFixture` over the synthesized result, fixture-keys winning. Rationale for shallow (not deep): predictable; deep-merge of arbitrary user fixtures can produce surprising arrays; users wanting nested overrides can specify the full nested object — they win at the top level.
3. For all other palettes: ignore `bodyFixture`. Return the synthesized body as today.

```ts
// mutation/apply.ts — apiTestCases threads the fixture through
export function apiTestCases(
  runId: string,
  role: string,
  tool: ToolMeta,
  samples: unknown[],
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>,  // NEW
): TestCase[];
```

`phases/plan.ts:88` becomes:
```ts
const cases = apiTestCases(
  runId, role, tool, samples,
  config.domainHints,
  config.bodyFixtures?.[tool.toolId],
);
```

### 7.5 Edge cases

- **Fixture supplies a key already synthesized:** fixture wins (shallow-merge, fixture last).
- **Fixture key not in schema:** still merged. The user explicitly opted in; accept the over-broad body. (Server may 400 — that's a real bug; record it.)
- **Fixture references a different tool than the test plan generates:** orphan fixture; logged as warning at plan time. Run continues.
- **Fixture is `null` for a known toolId:** treat as "no fixture." Zod's `z.record(z.record(z.unknown()))` requires record values to be records, so explicit `null` fails validation — good.
- **Tool with `inputSchemaConfidence: 'unknown'` AFTER probe failure:** the single happy-call path at `apply.ts:46-61` also gets the fixture merged. Update that branch identically (and merge over `samples[0] ?? {}`).
- **Tool is a server action (excluded from API tests):** fixture is unused. No warning needed (server actions are filtered out before `apiTestCases`).
- **Per-role fixtures (different bodies for different roles):** out of scope v0.1. Keying is `toolId`-only. Add a § 10 open question if the user wants role-keying.

### 7.6 Acceptance criteria

- Given `BugHunterConfig.bodyFixtures = { 'tool-abc': { memo: 'seeded memo', amount: 42 } }`, the `happy`-palette test case for `toolId 'tool-abc'` has `action.input` containing both `memo: 'seeded memo'` and `amount: 42` regardless of what `surface_sample_inputs` returned.
- Given the same config, the `null`/`edge`/`out_of_bounds` palette test cases for `toolId 'tool-abc'` do NOT contain `memo: 'seeded memo'` (unless they synthesized it independently).
- Given a `bodyFixture` for a `toolId` that does not appear in the catalog, plan emits a warning to the log and the run continues without error.
- Given a config with `bodyFixtures: {}` (the default after `init`): no behaviour change vs. today.
- A new test `/root/BugHunter/packages/cli/tests/body-fixtures.test.ts` covers the four cases above.
- The Zod schema accepts and rejects test inputs as documented (5 representative shapes).

### 7.7 SPEC.md edits

§ 3.4.1 — append to the "Pre-plan schema enrichment" paragraph:

> Where probe recovery is incomplete (e.g. routes using manual, non-Zod validation), users can supplement happy-palette bodies via `BugHunterConfig.bodyFixtures` (keyed by `toolId`). The fixture is shallow-merged over the synthesized happy body before the call. Other palette variants (`null`, `edge`, `out_of_bounds`) ignore fixtures by design.

§ 8 — add to the `BugHunterConfig` block:
```ts
bodyFixtures?: Record<string, Record<string, unknown>>;
// toolId → partial body merged onto happy-palette synthesized input
```

### 7.8 Files to touch

- `/root/BugHunter/packages/cli/src/types.ts` — `BugHunterConfig.bodyFixtures`.
- `/root/BugHunter/packages/cli/src/config.ts` — Zod schema entry.
- `/root/BugHunter/packages/cli/src/mutation/apply.ts` — `buildApiInput`, `apiTestCases` signatures + behaviour.
- `/root/BugHunter/packages/cli/src/phases/plan.ts` — thread `config.bodyFixtures?.[tool.toolId]` into `apiTestCases`. Add orphan-fixture warning loop after `enrichToolSchemas`.
- `/root/BugHunter/packages/cli/tests/body-fixtures.test.ts` — NEW.
- `/root/BugHunter/SPEC.md` § 3.4.1 + § 8.

---

## 8. Bug 4 — SurfaceMCP local `main` is stale (release-hygiene runbook)

### 8.1 Root cause

Local `/root/SurfaceMCP/main` points at `10d1ff14` (spec commits only).
`origin/main` already points at `86a05b80` (the Merge-PR-#1 commit), as confirmed by:

```bash
$ cd /root/SurfaceMCP && git log --oneline origin/main -3
86a05b8 Merge pull request #1 from cunninghambe/feat/v0.1-implementation
0292f76 auth: detect Auth.js v5 (authjs.session-token) by default
0492736 fix: remove as any from schemas.ts, use ZodSchema<unknown>; pin lockfile
```

`feat/v0.1-implementation` (local) `== origin/main` at `86a05b80`. The merge already happened on GitHub (`86a05b8` is a merge commit). The local checkout simply hasn't pulled.

### 8.2 Decision: documented git-ops runbook, no code changes

This is a **runbook step, not a code change**. Coder must NOT modify any SurfaceMCP source. Add a short section to `/root/BugHunter/REVIEW.md` (or a new `/root/BugHunter/docs/RUNBOOKS.md` if the project prefers a separate file — defer to user — see § 10) describing the resync procedure. Also remove the misleading "merge to remote main never landed" line from `/root/BugHunter/dist-skill/bughunt-host.md:140`.

### 8.3 Runbook

```bash
cd /root/SurfaceMCP
git fetch origin
git checkout main
git merge --ff-only origin/main      # fast-forwards local main to 86a05b8
# Verify:
git log --oneline -3
# Expect:
#   86a05b8 Merge pull request #1 from cunninghambe/feat/v0.1-implementation
#   0292f76 auth: detect Auth.js v5 ...
#   0492736 fix: remove as any from schemas.ts ...

# Optional: prune the merged feature branch locally.
git branch -d feat/v0.1-implementation     # only if local feat tip == origin/main
# If git refuses (-d → -D risk): inspect first.
```

### 8.4 Boundaries

- **Changes:** `/root/BugHunter/dist-skill/bughunt-host.md` line 140 (the gotcha bullet that misleadingly says "merge never landed").
- **Does NOT change:** any SurfaceMCP file. Coder must not run any push/force/merge operation on origin SurfaceMCP.
- **Does NOT push:** anything to GitHub.

### 8.5 Acceptance criteria

- After running the runbook, `git log --oneline /root/SurfaceMCP/main -1` returns `86a05b8`.
- `dist-skill/bughunt-host.md` no longer contains the line "merge to remote main never landed."
- Replacement bullet documents the correct expectation: "Local SurfaceMCP `main` may be stale on first checkout; run `git fetch && git merge --ff-only origin/main` to sync."

### 8.6 Files to touch

- `/root/BugHunter/dist-skill/bughunt-host.md` — update the bullet at line 140.
- (No SurfaceMCP files. The runbook is executed by the user.)

---

## 9. Risk & sequencing

### 9.1 Independence

| Bug / Question | Depends on | Notes |
|---|---|---|
| Bug 1 (camofox prefix) | none | One-file mechanical change. Lowest risk. |
| Bug 2 (browserMcpUrl convention) | Bug 1 (same file, same test file) | Land together — one PR, two commits OR one commit. |
| Bug 3 (`--no-interactive`) | none | Independent file set (init.ts, main.ts). |
| Bug 4 (SurfaceMCP runbook) | none | Pure docs; no code dependency. |
| Question A (related clusters) | none structurally; touches `surface_call_failed` endpoint shape — **do not also include in cluster-changing PRs landing in parallel** | See § 9.3. |
| Question B (bodyFixtures) | none | Pure additive; default behaviour unchanged. |

### 9.2 Recommended landing order

1. **Bug 4 (runbook)** — instant, no code, unblocks the rest of the team's mental model.
2. **Bugs 1 + 2 together** — unblocks the browser path. Tests live in one new file.
3. **Bug 3 (`--no-interactive`)** — unblocks CI / scripted setup.
4. **Question B (bodyFixtures)** — unblocks the Spoonworks smoke false-positive.
5. **Question A (related clusters)** — last; biggest blast radius.

### 9.3 Highest risk: Question A's `surface_call_failed` endpoint change

Switching `surface_call_failed.endpoint` from bare `toolId` to `"METHOD /normalized/path"` rewrites the cluster signature for that kind. Persisted cluster state from prior runs will not match new state. Mitigations:

- **No fixture migration.** Old runs stay on disk under old keys; new runs cluster under new keys. `bughunter list` shows both; users either prune old runs or accept the gap.
- **Tests:** existing `cluster.test.ts` does not exercise `surface_call_failed`; verify with grep before commit.
- **`bughunter retest <runId> <clusterId>`:** the contract is "given a clusterId from THIS run, retest its occurrences." Cross-run cluster-id stability has never been promised. No regression.
- **Land Question A AFTER Question B.** If Question B works, the Spoonworks smoke produces fewer surface_call_failed clusters — easier to verify Question A's annotation logic on a smaller cluster set.

### 9.4 Hidden risk: Bug 1's prefix fix may unmask wire-protocol drift

The smoke shows the prefix bug. But camofox tools take `tabId` and `ref` (not `selector`); `screenshot` returns image bytes, not a path; `scroll` takes `direction: up|down|left|right` and `amount` (not `distance`). The current `BrowserMcpAdapter` interface (`browser-mcp.ts:16-26`) wraps the legacy Playwright/Puppeteer signature.

If the coder lands only Bug 1, the next browser smoke will fail with new errors (zod-validation failures inside camofox, or undefined `tabId`). **Document this in the PR description** so the user is not surprised. The follow-up is in § 10.

### 9.5 Sequencing tests

- Run `npx vitest run` after each fix lands. Each fix has its own test file; cumulative test count grows monotonically.
- After all six fixes: run the integration smoke against `/root/spoonworks` (API-only path) and confirm 100/151 pass, 0 infrastructure failures, and that the false-positive `surface_call_failed` cluster on the dynamic resolve route is gone (Question B did its job) and the remaining missing-fixture clusters carry mutual `relatedClusterIds` (Question A did its job).

---

## 10. Open questions (must resolve before coder proceeds)

The fixes above are deterministic given user agreement on the decisions in §3–§8. The following items DO require user input and are deliberately NOT speccified:

### 10.1 Camofox argument-shape and result-shape drift (extends Bug 1)

`CamofoxBrowserMcpAdapter`'s method signatures wrap `selector` / `text` / `direction: 'up'|'down'` / `distance` / `outputPath`, while camofox v0.1 takes `tabId` / `ref` / `direction: 'up'|'down'|'left'|'right'` / `amount`, and `screenshot` returns inline base64 (no path). The prefix fix unblocks JSON-RPC connectivity but every subsequent call will fail at the camofox zod validation layer.

**Decision needed:** is the next work item a full adapter rewrite to match camofox's actual surface, or do we keep the existing high-level interface (`navigate(url)`, `click(selector)`) and have the adapter own the snapshot→ref→action sequence internally? The latter requires the adapter to call `snapshot` before each `click`/`type`, parse the a11y tree, and resolve `selector` → `ref`. That's substantial.

**Recommendation:** spec a separate work item `Camofox v1 adapter rewrite` after Bug 1 lands. This spec's Bug 1 only fixes the prefix.

### 10.2 SurfaceMCP feature-branch retention

After Bug 4's runbook, should `feat/v0.1-implementation` be deleted (locally and/or on origin)? GitHub typically auto-deletes after merge but the local + remote-tracking refs persist. Default position: leave it; user prunes when they want.

### 10.3 Per-role bodyFixtures (extends Question B)

Should `bodyFixtures` be keyed `Record<toolId, Record<role, body>>` instead of `Record<toolId, body>`? Use case: an admin role has different valid input than a member role. Smoke didn't surface this need (single role). v0.1 spec is `toolId` → body only. **Add per-role keying iff a real use case appears**; don't speculate.

### 10.4 SurfaceMCP `surface_probe` tightening

Out of scope for this spec (SurfaceMCP-side change). The escape-hatch (Question B) is the BugHunter-side mitigation. If the user wants the probe tightened to detect manual non-Zod validation, write a separate SurfaceMCP spec.

### 10.5 Should related-cluster annotation be opt-in?

Question A's annotation pass is always-on. Should it be gated behind a config flag (`enableClusterRelations: true`)? Default position: always-on, no flag. Annotation is purely additive metadata; no downside if the user ignores it. **Add a flag iff it produces noisy reports in real runs.**

### 10.6 Runbook docs location

Bug 4's "Files to touch" is `dist-skill/bughunt-host.md`. Should runbooks also live under `/root/BugHunter/docs/RUNBOOKS.md`? Default: do not create a new file unless the user asks. Update the dist-skill bullet only.

---

## 11. Test plan summary

| Test file | Status | Covers |
|---|---|---|
| `tests/browser-mcp-url.test.ts` | NEW | Bug 1 + Bug 2 |
| `tests/init.test.ts` | NEW | Bug 3 |
| `tests/body-fixtures.test.ts` | NEW | Question B |
| `tests/cluster-related.test.ts` | NEW | Question A |
| `tests/cluster.test.ts` | unchanged | regression baseline |
| `tests/surface-mcp-url.test.ts` | unchanged | regression baseline |

Run `npx vitest run` after each commit; expect the count to grow by the new file's tests at each step.

---

## 12. Definition of done

- Six items above land per § 9.2 sequencing.
- All listed acceptance criteria pass.
- `npx tsc --noEmit` clean.
- `npx eslint . --max-warnings 0` clean.
- Re-run smoke against `/root/spoonworks` (API-only):
  - 0 false-positive `surface_call_failed` clusters on tools listed in `bodyFixtures`.
  - Remaining `404_for_linked_route` and `surface_call_failed` clusters that share a route carry mutual `relatedClusterIds`.
  - `bughunter init --no-interactive` runs without prompting (smoke this in a temp dir).
- `dist-skill/bughunt-host.md` updated; SurfaceMCP local `main` synced.
