# BugHunter — v0.1 spec (revised)

**Status:** Draft, post-review, post-smoke · **Author:** @architect (Opus) · **Reviewer:** @architect (independent Opus pass) · **Date:** 2026-04-25 · **Depends on:** [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP) (revised), camofox MCP, **a Claude Code session for auto-fix orchestration**

This revision incorporates the architect review of the original draft. See [`REVIEW.md`](REVIEW.md) for findings + resolutions.

---

## 1. Problem Statement

Vibe-coded apps are fast to write, slow to verify. UI-only test agents check 200 responses and miss broken interactions; API-only tests miss UI-state regressions. Manual click-through of every button × slider × form × user-role combination eats hours and gets skipped under time pressure.

BugHunter walks an app's surface — every route, every interactive element, every declared role — applying a bounded mutation palette to inputs. Same-shape elements collapse to one representative test (so the matrix stays tractable on real apps). It dual-executes via SurfaceMCP for the API layer and a browser MCP (camofox) for the UI layer. Captures every failure with full repro context (action sequence, DOM snapshot, console, network, screenshot). Clusters by root cause but retains every occurrence (with bounded artifact keeping). The auto-fix loop is **orchestrated from a Claude Code session via the `/bughunt fix` skill** — Claude reads the bug log and per-cluster invokes `Agent(architect, opus)` to write a fix spec, then `Agent(coder, sonnet)` to implement, calling BugHunter CLI helpers for the forbidden-path gate and retest verification.

Output: a structured JSONL bug log a downstream agent can act on, plus a human-readable summary.

## 2. Boundaries

**In scope (v0.1)**
- Route × role × element matrix across the project, with same-shape element collapsing per § 3.4
- Bounded mutation palette per input type with `null` / `happy` / `edge` / `out_of_bounds` for primitive types, plus `slug` / `foreign_id` palette via `domainHints` config or `surface_sample_inputs`
- Three-source route discovery: SurfaceMCP catalog + AST page-component scan + DOM walker
- Dual execution (SurfaceMCP for API + camofox MCP for UI) where both are available
- Bug clustering by root cause + per-occurrence logging with bounded full-artifact retention
- JSONL output with structured action logs; `bughunter replay <occurrenceId>` for re-execution
- Stop-and-emit at 200 unique clusters
- Auto-fix is **skill-driven from a Claude Code session** (the `/bughunt fix` skill). The skill orchestrates `Agent(subagent_type='architect', model='opus')` → `Agent(subagent_type='coder', model='sonnet')` per cluster, calling BugHunter CLI helpers (`forbidden-path-gate`, `retest`) for the operational steps. No ClaudeMCP integration in BugHunter itself — the proven Claude Code Agent tool is the right primitive
- CLI engine + skill markdown (the orchestrator) + optional MCP wrapper for non-Claude triggers
- Local apps only

**Out of scope (v0.1)**
- Production / staging environments — local dev only
- Load testing, performance benchmarking — different problem
- Visual regression diffing — too noisy
- Mobile UI testing
- Cross-browser matrix (one Chromium via camofox; "works in Firefox" out of scope)
- WebSocket / SSE testing (paired with SurfaceMCP scope)
- Auto-fix touching schema / migrations / dep version / env vars (rejected by post-hoc gate)
- Headless / unattended auto-fix with no Claude session involved. v0.1's auto-fix requires a Claude Code session; for unattended runs, point a tmux/background Claude session at the project. ClaudeMCP-driven dispatch deferred to v0.2 if user demand emerges
- Next.js parallel routes, intercepted routes, modal-only routes — v0.2
- Closure-bound Next.js server actions (paired with SurfaceMCP scope) — v0.2
- Playwright code-emission for repros (replaced by JSON action log + `replay` command) — v0.2 if user demand
- Generated `.next` / `node_modules` source-file fixes (caught by `bugs_skipped: third_party_or_generated`)

**External dependencies**
- Node 20+, TypeScript strict
- A live SurfaceMCP instance for the target project
- camofox MCP (https://github.com/...) — chosen because already deployed on this host
- A Claude Code session running with the `bughunt.md` skill mounted (only for auto-fix orchestration)
- `axe-core` for accessibility heuristics (gated behind `--a11y`)
- Internal: `playwright-core` for browser context APIs camofox doesn't surface

## 3. Architecture Decisions

### 3.1 Two-package layout

```
bughunter/
├── packages/cli/                    # the engine + skill markdown. Load-bearing.
│   ├── bughunt.md                   # the Claude skill (mounted via symlink in target projects)
│   └── ...
└── packages/mcp/                    # optional HTTP MCP wrapping the CLI for Hermes / Paperclip / etc.
```

The skill is a markdown file (`packages/cli/bughunt.md`), not a package. Target projects mount it by symlinking into their `.claude/skills/`. The CLI is the engine and exposes all behavior; the skill teaches Claude how to read the JSONL and present it.

### 3.2 Phase pipeline (single run)

```
0. validate     — SurfaceMCP reachable; browser MCP reachable; project dir valid; resume
                  validity (revision + reset timestamp + resetCommand last-run)
1. discover     — three sources: SurfaceMCP catalog, AST page scan, DOM walk per role
2. plan         — schema enrichment via surface_probe / surface_sample_inputs;
                  generate test cases with same-shape collapsing + budget estimate;
                  surface projected runtime
3. execute      — bounded-parallel dispatch; per-test pre/post observation
4. classify     — heuristic bug classification per § 3.5; record expectedOutcome
5. cluster      — by stable signature; cap full-artifact occurrences per cluster
6. emit         — write JSONL + summary; stop-and-emit at 200 clusters
7. fix?         — orchestrated externally by the /bughunt fix skill (§ 3.9), not by `bughunter run`
8. retest?      — post-fix verification per cluster; output classification
```

Each phase persists state in `.bughunter/runs/<runId>/state.json`. Crashed runs resume on validity check.

### 3.3 Discovery — three sources

**API surface** (via SurfaceMCP):
```
surface_list_tools() → catalog with toolId, method, path, schema, sideEffectClass, sourceFile
```

**Filesystem-routed UI pages** (AST scan):
- Next.js: walk `app/**/page.tsx` and `pages/**/!(api)/*.tsx`. Each path translates to a route via Next conventions
- Other frameworks: extract from server-side route definitions where they map to URL paths

**Dynamic routes** (e.g. `/admin/products/[id]`): require `discoveryFixtures` config:
```json
{
  "discoveryFixtures": {
    "/admin/inventory/products/[id]": ["seeded-product-1", "seeded-product-2"],
    "/admin/orders/[id]": ["seeded-order-1"]
  }
}
```
If absent, the route is logged as `discovery_skipped: missing_fixture` and skipped.

**Per-role DOM walking**:
1. Login as role (using SurfaceMCP's same auth)
2. For each route, visit, parse interactive elements via DOM walk
3. Collect: `<button>`, `<a>` with href, `<input>` (all types), `<select>`, `<textarea>`, `<form>`, `[role="button"]`, `[role="link"]`, `[onclick]`, `[contenteditable]`
4. Disabled elements logged but skipped
5. Set `X-BugHunter-Run: <runId>` header on every browser request via camofox extra-headers

**Form → API cross-reference**:
For each form, call `surface_routes_for_page({ pagePath })` to get the likely API tool(s). If unresolved, fall back to BugHunter's own URL-string scan in the page component. If still unresolved, skip-by-default; log warning.

**External-side-effect skip-list**:
Cross-referenced API tools tagged `sideEffectClass: 'external'` (e.g. Stripe checkout, SendGrid send) are added to a per-page skip-list unless `externalIntegrationsAllowed: true`. The corresponding form/button is not exercised. Logged in discovery output.

Output: `runs/<id>/discovery.json` with pages × elements × api-tool cross-refs × skip-list.

**Out of scope v0.1**: Next.js parallel routes (`@modal/...`), intercepted routes (`(.)photo/...`), modal-only routes reachable solely via `router.push()` from button handlers. These are documented; user must surface them via fixtures or `discoveryHints` config.

### 3.4 Test plan generation — exhaustive with same-shape collapsing

The "exhaustive" rule applies at the level of **distinct interaction patterns**, not literal elements. Same-shape elements collapse to one representative test. The collapse signature for elements is:

```
(elementTag, role-attr, type-attr, data-testid prefix up to first colon, ancestor stack signature)
```

If two buttons share this signature, they collapse to one click test (per role). Same-shape forms across pages (signature: ordered field names + types) collapse to one fill-and-submit pattern + one variant per palette.

Per (role, page):
- One **render** test (visit, capture, observe). Always run.
- One **navigate** test per distinct link target.
- One **click** test per distinct (collapsed) button.
- For each distinct (collapsed) form, **four fill-and-submit tests** — one per palette (`null`, `happy`, `edge`, `out_of_bounds`).
- Per (role, api_tool) with `inputSchemaConfidence: 'introspected' | 'inferred'`: **four direct-call tests**.
- Per (role, api_tool) with `inputSchemaConfidence: 'unknown'` AFTER probe upgrade: same four tests.
- Per (role, api_tool) where probe failed to recover: **one happy-path call** with `surface_sample_inputs` value or empty body.
- **Server actions are excluded from API direct-call tests.** Tools where `isServerAction === true` cannot be invoked via plain HTTP POST — they require Next.js's form-submit dispatch (`Next-Action` header or `<form action={fn}>` POST format). API direct-call tests against them produce false-positive 404s (smoke 2026-04-25 confirmed). Server actions are exercised only via the UI form-submit path during the DOM-walker phase. SurfaceMCP exposes `isServerAction` on `ToolMeta`; the planner filters on it.

#### 3.4.1 Pre-plan schema enrichment

Before generating test cases:
- For every tool with `inputSchemaConfidence: 'unknown'`: call `surface_probe`. If recovered, the tool is treated as `inferred` for this run. If not, log and downgrade per above.
- For every tool: call `surface_sample_inputs` to seed `happy`-palette values. If the result is empty, generate values from the schema (boundary-aware via `format`, `enum`, `minLength`, etc.).

#### 3.4.2 Mutation palette per input type

| Input | null | happy | edge | out_of_bounds |
|---|---|---|---|---|
| text | `""` | sample value (from `surface_sample_inputs` or generated) | at `maxLength` if known else 255 chars | `maxLength + 1` chars; one with `<script>` |
| email | `""` | `bughunter+<runId>@test.local` | local-part 64 chars (RFC limit) | `"not-an-email"` |
| number | omitted | sample or `1` | `minimum` and `maximum` if known else `0` | `Number.MAX_SAFE_INTEGER + 1`; `NaN` |
| date | `null` | today | far past `1900-01-01`, far future `2100-12-31` | `"not-a-date"` |
| select | `null` | first option | last option | unlisted value injected |
| checkbox | unchecked | checked | n/a | n/a |
| file | no file | small valid jpeg | exactly-at-limit bytes | wrong MIME (.exe), over-limit |
| boolean | `null` | `true` | n/a | `false` |
| array (multi) | `[]` | one item | all items | non-existent items |
| tel | `""` | `+15555550100` | format-extreme valid | non-numeric chars |
| url | `""` | `https://test.local/x` | `https://` + 2000 char path | `"not-a-url"`, malformed scheme |
| password | `""` | sample meeting policy | at `minLength` boundary | `"a".repeat(10000)` |
| color | `null` | `"#000000"` | `"#ffffff"` | `"red"`, malformed |
| range | min | midpoint | min and max | min-1, max+1 |
| slug | `""` | sample from fixture / `domainHints` | hyphen-heavy / max length | spaces, special chars |
| foreign_id | `null` | from fixture / `domainHints` | non-existent id | wrong type (string vs int) |

Project can extend via `.bughunter/palette.json`. For nested forms, each leaf field cycles through the palette while siblings stay at `happy`.

Each test plan record stores `expectedOutcome: 'success' | 'expected_failure' | 'unknown'` so the classifier (§ 3.5) can interpret 4xx responses correctly.

#### 3.4.3 Negative-test auth handling

All test cases with `expectedOutcome: 'expected_failure'` (i.e. anything other than `happy` palette in mutation tests) call SurfaceMCP with `noAutoRelogin: true`. Auto-relogin only fires for happy-path calls, where 401s indicate genuine session loss.

#### 3.4.4 Budget calculator

After test plan generation, the `plan` phase emits:
```
Projected: 12,400 tests · concurrency 4 (browser) + 16 (api) · est. 6h 18m
Set --max-runtime to a higher value or pass --budget <ms> to time-box this run.
```

The user can abort, refine, or proceed.

### 3.4.5 `surfaceMcpUrl` convention

`BugHunterConfig.surfaceMcpUrl` is the **base URL** of the SurfaceMCP HTTP server (e.g. `http://127.0.0.1:3102`), without the `/mcp` path. The adapter appends `/mcp` internally on every call. The `init` wizard's prompt and default both use the base URL form. Configurations that include a trailing `/mcp` are accepted (the adapter strips one trailing `/mcp` if present) for backward compatibility, but the documented form is base-URL-only.

### 3.5 What counts as a bug (classification)

| Class | Detection |
|---|---|
| `console_error` | DevTools console-level `error`. Warnings ignored except React-specific (next row) |
| `react_error` | "Warning: ", "Cannot update during render", hydration mismatches, error boundary stack traces |
| `network_5xx` | Any 5xx response during the action |
| `network_4xx_unexpected` | 4xx that doesn't match `expectedOutcome`. Specifically: a 4xx where `expectedOutcome='success'`, OR a 401/403 where the role should be authorized for the route |
| `404_for_linked_route` | A page links to a URL that returns 404 |
| `missing_state_change` | Action that should change observable state didn't. Detection: from action-fire, run a `MutationObserver`; the observation window closes on (URL change OR network completion OR 30s ceiling). After window closes, check for state change in target region. No state change AND no toast AND no URL change AND no relevant network completion = bug |
| `unhandled_exception` | Uncaught error in browser context |
| `accessibility_critical` | axe-core `critical`/`serious` violations introduced after the action (delta vs pre-state). Off by default; enabled with `--a11y` |
| `dom_error_text` | Element with text matching `(?i)(something went wrong|an error occurred|unable to|failed to)` appears post-action where it wasn't pre-action |
| `surface_call_failed` | `surface_call` returns `ok: false` for a `mutating`-class tool with `happy`-palette input |
| `infrastructure_failure` | Browser MCP error / camofox crash / SurfaceMCP unreachable. **NOT a bug.** Logged separately in `infrastructure.jsonl`, not `bugs.jsonl`. After 20 consecutive: abort run with explicit error |

False-positive tolerance: ~10%. The auto-fix loop has its own retest verification before committing fixes.

#### 3.5.1 Priority hierarchy (canonical kind per occurrence)

A single occurrence often satisfies multiple classification rules — e.g. a server action returning 404 trips `404_for_linked_route` AND `surface_call_failed` AND `network_4xx_unexpected`. Without a priority rule, that single event creates three clusters and burns three slots of the `--max-bugs` budget. Smoke 2026-04-25 confirmed.

The classifier emits **one canonical kind per occurrence**, picked by this priority (highest wins):

```
1. unhandled_exception
2. network_5xx
3. react_error
4. surface_call_failed         (mutating tool with happy input failed)
5. network_4xx_unexpected      (4xx where expectedOutcome='success')
6. 404_for_linked_route        (intra-app navigation to a 404)
7. dom_error_text
8. missing_state_change
9. console_error
10. accessibility_critical     (only when --a11y is enabled)
```

Other observations that fired but lost the priority race are recorded on the occurrence as `secondaryObservations: Array<{ kind, detail }>` for diagnostic — they don't create separate clusters.

This is a **classification-time rule**, applied before clustering. Two occurrences from different events can still legitimately produce the same canonical kind and cluster together via the § 3.6 signature.

### 3.6 Bug clustering — fingerprint normalization

Cluster signature per kind:

| Kind | Signature components |
|---|---|
| `console_error` / `react_error` / `unhandled_exception` | `errorMessageNormalized` + `stackTraceFingerprint` |
| `network_5xx` / `network_4xx_unexpected` | `endpoint` (method + normalized path) + `status` + `responseBodyShape` |
| `missing_state_change` / `dom_error_text` | `pageRoute` + `selectorClass` + (for state-change) `triggeringAction.kind` |
| `404_for_linked_route` | `targetPath` |

**`errorMessageNormalized`**: first 80 chars of the error message, lowercased, with: numeric ids stripped (`/\b\d{4,}\b/` → `<num>`), quoted string literals stripped (`/"[^"]*"/` → `<str>`, `/'[^']*'/` → `<str>`), `Hex SHA1`/`UUIDs` stripped to `<id>`.

**`stackTraceFingerprint`**:
- Strip line numbers entirely (`:42` → empty)
- Strip column numbers
- Prefer non-framework frames: filter out `node_modules/**`, `webpack-internal:///`, `react-dom`, `next/dist/**`, `.next/**`
- Take the top 3 user-code frames (file path + function name only)
- Concatenate with `|` separator

**`responseBodyShape`** (for network):
- If `Content-Type: application/json`: top-level keys, sorted, joined with `,`
- If HTML: extract `<pre>` first 80 chars (Next.js dev stack-trace) or `<title>` text
- Else: SHA1 of first 200 bytes of body (hex first 12 chars)

Two occurrences cluster if their signatures are equal. Each cluster keeps every occurrence; full artifacts are bounded per § 3.7.

### 3.7 Bug log format

`.bughunter/runs/<runId>/bugs.jsonl` — one line per cluster.

**Per-cluster occurrence retention**:
- First 3 occurrences AND the most-recent 1 occurrence: full artifacts (screenshot, DOM snapshot, console log, network HAR, JSON action log)
- All other occurrences: lightweight summary `{ occurrenceId, role, page, action, timestamp }`
- Total artifact budget per run capped at 4 GB; oldest full-artifact occurrences degrade to summary if cap is reached
- `bughunter inspect <occurrenceId>` reads full artifacts on demand for any occurrence (lightweight ones get re-execution offer)

```json
{
  "id": "bug-cuid",
  "runId": "run-cuid",
  "kind": "react_error",
  "rootCause": "TypeError: Cannot read properties of undefined (reading 'map')",
  "stackTraceFingerprint": "ProductList.tsx:render|useProducts.ts:fetchProducts|ProductsPage.tsx:default",
  "errorMessageNormalized": "typeerror: cannot read properties of undefined (reading <str>)",
  "firstSeenAt": "2026-04-25T18:32:00Z",
  "lastSeenAt": "2026-04-25T18:39:14Z",
  "clusterSize": 7,
  "occurrences": [
    {
      "occurrenceId": "occ-cuid",
      "role": "owner",
      "page": "/admin/inventory/products",
      "action": {
        "kind": "click",
        "selector": "[data-testid='product-row-0'] button[aria-label='Edit']",
        "via": "ui",
        "expectedOutcome": "success",
        "palette": "happy"
      },
      "preState": { "url": "/admin/inventory/products", "title": "Products", "consoleErrorCount": 0 },
      "postState": {
        "url": "/admin/inventory/products",
        "title": "Products",
        "consoleErrors": [{ "level": "error", "text": "TypeError: Cannot read...", "stack": "..." }],
        "networkRequests": [{ "method": "GET", "path": "/api/admin/products/123", "status": 500, "duration": 412, "responseBodySnippet": "..." }],
        "domErrorTextDetected": false,
        "mutationObserverWindowMs": 412
      },
      "fullArtifacts": true,
      "screenshotPath": ".bughunter/runs/<runId>/screenshots/occ-cuid.png",
      "domSnapshotPath": ".bughunter/runs/<runId>/dom/occ-cuid.html",
      "consoleLogPath": ".bughunter/runs/<runId>/console/occ-cuid.log",
      "networkLogPath": ".bughunter/runs/<runId>/network/occ-cuid.har",
      "actionLogPath": ".bughunter/runs/<runId>/action-logs/occ-cuid.json",
      "reproSteps": [
        "Login as owner",
        "Navigate to /admin/inventory/products",
        "Click 'Edit' on first product row"
      ],
      "replayCommand": "bughunter replay occ-cuid"
    },
    {
      "occurrenceId": "occ-cuid-2",
      "role": "owner",
      "page": "/admin/inventory/products",
      "action": { "kind": "click", "selector": "...", "via": "ui", "palette": "happy" },
      "fullArtifacts": false,
      "timestamp": "2026-04-25T18:33:14Z"
    }
  ],
  "suspectedFiles": ["src/features/products/ProductList.tsx", "src/features/products/useProducts.ts"],
  "fixHints": [
    "products.map call at ProductList.tsx — products may be undefined when API errors. Add a guard or default to []",
    "API returned 500; check the underlying handler"
  ],
  "thirdPartyOrGenerated": false
}
```

`thirdPartyOrGenerated: true` if any `suspectedFiles` are in `node_modules/**`, `.next/**`, `dist/**`, or `<root>/build/**`. These clusters are flagged `bugs_skipped: { reason: "third_party_or_generated" }` in auto-fix.

In-flight tests after the 200-cluster cap: occurrences append to existing clusters; never create a 201st cluster.

### 3.8 Execution model

- Default browser concurrency: 4 (parallel browser contexts)
- Default API concurrency: 16 (separate pool for direct-API tests)
- Per-test timeout: 30s. Test that times out is logged in `infrastructure.jsonl` with `timeout` (not bug)
- Run-level timeout: 24h default, configurable via `--max-runtime`
- `--budget <ms>`: time-box; on budget exhaust, finish in-flight tests, emit
- Stop-and-emit at 200 unique clusters: stop scheduling new tests, finish in-flight, emit
- Resume: `bughunter run --resume <runId>` validates SurfaceMCP `revision` and resetCommand last-run; refuses if differ unless `--force-resume`

### 3.8.1 Browser-side failure isolation

Per-test browser-MCP errors retry once with a fresh browser context. Then mark `infrastructure_failure` (not a bug). After 20 consecutive infrastructure failures, abort the run with explicit error and partial-emit. Counter resets on a successful test.

### 3.9 Auto-fix loop — orchestrated by the `/bughunt fix` skill from a Claude Code session

The auto-fix workflow lives in the skill markdown (`packages/cli/bughunt.md`), not in BugHunter's CLI. BugHunter's CLI exposes operational helpers; the skill teaches Claude how to orchestrate them, and uses the `Agent` tool to dispatch architect/coder sub-agents per cluster. This is the proven workflow used elsewhere in the project (CLAUDE.md, project memory `feedback_spec_then_sonnet.md`).

This decision is intentional. ClaudeMCP-driven dispatch was the prior design (committed as `577a1ba`); smoke 2026-04-25 confirmed the systems compose, but the model routing was prompt-based only — both phases ran on whatever model ClaudeMCP's `claude -p` defaulted to. Reusing the Claude Code `Agent` tool gives real Opus-for-architect, Sonnet-for-coder routing for free, and removes ~250 lines of in-CLI dispatch code.

#### 3.9.1 What BugHunter's CLI provides (operational helpers)

```
bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]
  Runs `git diff <baseBranch>..<branch> --name-only` against the configured
  forbiddenPaths list. Returns JSON:
    { ok: true, violations: [] }
  or
    { ok: false, violations: ["prisma/migrations/...", ".env"], reset: true }
  When `--reset` is passed and violations exist, hard-resets the branch
  to baseBranch via `git update-ref` before returning.

bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]
  Refreshes the SurfaceMCP catalog. Replays each occurrence of the cluster
  with revision-aware input regeneration (see § 3.9.4). Returns JSON:
    { verdict: "verified_fixed" | "verified_fixed_by_removal" |
               "partially_verified" | "not_fixed" | "bugs_lost_to_revision",
      replayedOccurrences: N, passedOccurrences: M, details: [...] }

bughunter fix-summary <runId>
  Prints a per-cluster table of verdicts after a /bughunt fix orchestration.
  Reads .bughunter/runs/<runId>/fix-state.json which the skill maintains.
```

Each helper is single-purpose, idempotent, and JSON-output by default. They're designed to be called by the skill — not by humans, and not by ClaudeMCP. Humans get pretty-printed output via `bughunter inspect` / `bughunter list`.

#### 3.9.2 What the skill (`bughunt.md`) does

The skill is a markdown file with explicit step-by-step orchestration instructions for Claude. When the user invokes `/bughunt fix`:

```
For each cluster in .bughunter/runs/<latest>/bugs.jsonl
   (skipping clusters where thirdPartyOrGenerated === true):

  1. Create branch bughunter/<runId>/<clusterId> from baseBranch.

  2. Phase A — architect (Opus). Spawn:
       Agent(
         subagent_type: 'architect',
         model: 'opus',
         prompt: <architect brief, see § 3.9.3>
       )
     The architect reads the cluster, suspectedFiles, exemplar occurrence;
     investigates; writes a focused fix spec to:
       .bughunter/runs/<runId>/specs/<clusterId>.md
     Commits the spec on the cluster branch. Returns when committed.

  3. If the spec content begins with "REFUSE:" (after stripping leading
     blank lines), record verdict = "architect_refused" with the architect's
     reasoning. Skip to step 6.

  4. Phase B — coder (Sonnet). Spawn:
       Agent(
         subagent_type: 'coder',
         model: 'sonnet',
         prompt: <coder brief, see § 3.9.4>
       )
     The coder reads the spec; implements; runs tests; commits. Returns
     with last commit SHA.

  5. Phase C — forbidden-path gate. Call:
       bughunter forbidden-path-gate bughunter/<runId>/<clusterId>
                                     --base <baseBranch>
                                     --reset
     If violations: record verdict = "touched_forbidden_path" with paths.
     Skip to step 6.

  6. Phase D — retest. Call:
       bughunter retest <runId> <clusterId>
                        --base <baseBranch>
                        --branch bughunter/<runId>/<clusterId>
     Record the verdict from the JSON output.

  7. Append the verdict to .bughunter/runs/<runId>/fix-state.json.

After the loop:
  Call: bughunter fix-summary <runId>
  Pretty-print the table to the user.
```

The skill is the orchestrator; BugHunter's CLI is the operational toolbox. This separates "what should happen per cluster" (skill prose, easy to update) from "how the operations execute" (CLI code, tested).

#### 3.9.3 Architect brief (passed by the skill to `Agent`)

```
You are an architect writing a focused fix spec for a single BugHunter cluster.
You DO NOT implement the fix — you produce a spec for the implementer.

Project: <projectName>
Cluster: <clusterId>
Bug log: .bughunter/runs/<runId>/bugs.jsonl

Suspected files: <list>
Fix hints: <list>
Exemplar occurrence (full repro context): <inline JSON>

Investigate the root cause. Read the suspected files. Form a hypothesis.
If gitnexus is registered for this project, use gitnexus_impact to assess
blast radius before recommending the fix.

Write a focused spec to:
  .bughunter/runs/<runId>/specs/<clusterId>.md

Use the project's spec discipline (Problem / Root cause with file:line /
Boundaries / Interface change if any / Edge cases / Acceptance criteria /
Files to touch).

If the fix is impossible or unsafe (requires schema migration, forbidden-path
changes, or genuinely uncertain root cause), instead write a spec whose
first non-blank line is "REFUSE: <reason>". The implementer will see this
and skip the cluster.

Commit the spec on branch bughunter/<runId>/<clusterId>. Do NOT implement
the fix. Do NOT push.
```

#### 3.9.4 Coder brief (passed by the skill to `Agent`)

```
You are a coder. Implement the fix specified at:
  .bughunter/runs/<runId>/specs/<clusterId>.md

You're on branch bughunter/<runId>/<clusterId> which already has the spec
committed by the architect. Read the spec; treat it as the contract; do not
re-derive its decisions; do not exceed its boundaries.

Steps:
  1. Implement exactly as specified.
  2. Add a regression test exercising one of the cluster's occurrences.
  3. Run the project's tests; they must pass before you commit.
  4. Commit on the same branch with a message referencing <clusterId>.
  5. Output the last commit SHA.

Do NOT push. Do NOT touch (will be hard-reset by the post-hoc gate):
  prisma/migrations/**, prisma/schema.prisma, package.json, package-lock.json,
  yarn.lock, pnpm-lock.yaml, .env*, .gitignore, migrations/**, alembic/**,
  .next/**, node_modules/**, dist/**, build/**
```

#### 3.9.5 Retest verdicts (`bughunter retest` output schema)

```ts
type RetestResult = {
  verdict:
    | 'verified_fixed'
    | 'verified_fixed_by_removal'   // toolId no longer in catalog
    | 'partially_verified'           // full-artifact pass; lightweight unverifiable
    | 'not_fixed'
    | 'bugs_lost_to_revision';       // toolId removed AND no replay possible
  replayedOccurrences: number;
  passedOccurrences: number;
  details: Array<{
    occurrenceId: string;
    via: 'verbatim' | 'regenerated' | 'tool_removed';
    passed: boolean;
    error?: string;
  }>;
};
```

Schema-change retest behavior is preserved from prior § 3.9.4: when `inputSchema.hash` differs between catalog snapshot at original-run-time and post-fix, BugHunter re-derives input via `buildApiInput(newToolMeta, palette, sampleInput, domainHints)`. Otherwise replays verbatim.

#### 3.9.6 Final report (printed by `bughunter fix-summary`)

Distinguishes:
- `bugs_filed`: total clusters from initial run
- `bugs_specced`: architect produced a spec
- `bugs_attempted_fix`: coder dispatched
- `bugs_architect_refused`: architect returned `REFUSE:`
- `bugs_verified_fixed`: retest passed
- `partially_verified`: some occurrences pass; full set unverifiable
- `bugs_persistent`: retest failed
- `bugs_skipped`: touched forbidden path / third-party / generated
- `bugs_lost_to_revision`: pre-existing toolId removed AND no replay possible

#### 3.9.7 Why not ClaudeMCP?

ClaudeMCP-driven dispatch was the prior design (commit `577a1ba`). It worked structurally — two jobs per cluster, role-setting via prompts — but the model routing was prompt-based only; both phases ran whatever model ClaudeMCP's `claude -p` defaulted to (Sonnet). Real Opus-for-architect routing would have required ClaudeMCP to gain a `model` parameter, the runner to pass `--model` to spawned `claude`, BugHunter to thread it through. Three changes across two repos.

Switching to the skill-driven flow gets real model routing for free (the `Agent` tool already has it), removes the ClaudeMCP dependency from BugHunter's auto-fix path, and aligns with the workflow pattern already in use everywhere else on this host. The trade-off: auto-fix requires a Claude Code session running. For unattended runs, the user keeps a tmux'd session with the skill loaded — same pattern as the Discord bridge.

ClaudeMCP-driven dispatch may return as a v0.2 option for headless contexts (Hermes/Paperclip triggers) but isn't in v0.1 scope.

### 3.10 Run isolation & state drift

Each run starts with the configured `resetPolicy`:

| Policy | When reset runs | Cost | Recommended for |
|---|---|---|---|
| `transactional` | DB transaction begun before run; rolled back at end | Cheapest if app supports it | Local dev with seedable DB; recommended |
| `per-test` | Before every mutating test | Slowest but correct | Suite tests with cheap reset (<1s) |
| `per-page` | Before each (role, page) test group | Balance | Default for v0.1 |
| `per-run` | Once at run start | Fastest, drifts | Read-heavy apps |

Default: `per-page`. User can set in `.bughunter/config.json`.

`resetCommand` runs at the policy's specified frequency. SurfaceMCP-driven runs are revision-pinned (`pinRevision` on every `surface_call`); if revision changes mid-run (e.g. dev hot-reload), the call returns `error: { code: "revision_changed" }` and BugHunter treats it as `infrastructure_failure` (not a bug).

## 4. Interface Contract

### 4.1 CLI

```
bughunter init [--no-interactive] [--project-name <name>] [--surface-mcp-url <url>]
               [--browser-mcp-url <url>] [--reset-command <cmd>] [--reset-policy <policy>]
  Walks project; writes .bughunter/config.json template. Without --no-interactive, prompts for:
    SurfaceMCP URL (base form, e.g. http://127.0.0.1:3102), browser MCP URL,
    discoveryFixtures for known dynamic routes,
    resetPolicy + resetCommand, forbiddenPaths additions.
  With --no-interactive: skips readline entirely; resolves each field by precedence:
    flag > BUGHUNTER_<FIELD> env var > default. Fails loudly via Zod on invalid input.

bughunter run [options]
  --route <pattern>       Limit to routes matching a glob
  --role <name>           Limit to a single role
  --max-bugs <n>          Stop-and-emit at N (default 200)
  --max-runtime <ms>      Run-level timeout (default 86_400_000 = 24h)
  --budget <ms>           Time-box; emit partial result at exhaust
  --concurrency <n>       Browser concurrency (default 4)
  --api-concurrency <n>   API concurrency (default 16)
  --reset                 Run resetCommand before discovery
  --resume <runId>        Continue from saved state
  --force-resume          Resume even if SurfaceMCP revision differs
  --a11y                  Enable accessibility_critical class
  --include-external      Allow side-effect-class=external API calls

  Note: there is no --auto-fix flag. Auto-fix is orchestrated by the
  /bughunt fix skill from a Claude Code session — see § 3.9.

bughunter replay <occurrenceId>
  Reads action-logs/<occurrenceId>.json; re-executes against current dev server.

bughunter inspect <occurrenceId|clusterId>
  Pretty-prints from JSONL + lists artifact paths (no GUI viewer).

bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]
  JSON-output operational helper called by the /bughunt fix skill (§ 3.9.1).
  Runs `git diff <baseBranch>..<branch> --name-only` against the configured
  forbiddenPaths list. Returns:
    { ok: true, violations: [] }
  or
    { ok: false, violations: [...], reset: true }
  When --reset is passed and violations exist, hard-resets the branch via
  `git update-ref` before returning.

bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]
  JSON-output operational helper called by the /bughunt fix skill (§ 3.9.1).
  Refreshes the SurfaceMCP catalog; replays each occurrence with revision-
  aware input regeneration; returns RetestResult per § 3.9.5.

bughunter fix-summary <runId>
  Pretty-prints per-cluster verdicts after a /bughunt fix orchestration.
  Reads .bughunter/runs/<runId>/fix-state.json which the skill maintains.

bughunter list
  Show last 20 runs with cluster counts + verdicts (if /bughunt fix ran).

bughunter status <runId>
  Detailed status of a run.

bughunter palette
  Print active mutation palette. Edit .bughunter/palette.json to override.

bughunter prune
  Delete .bughunter/runs/<id> directories older than 30 days.
```

### 4.2 Skill (`bughunt.md`)

A markdown file mounted at `.claude/skills/bughunt.md` in target projects (via symlink or copy). The skill has two responsibilities:

**`/bughunt`** — for status / triage. Teaches Claude:
- When to invoke `bughunter run` (e.g. user asks "find bugs", "test the app")
- How to interpret `bugs.jsonl`: cite cluster id, group by kind, rank by clusterSize
- How to read `infrastructure.jsonl` (those are NOT bugs to report)
- How to use `bughunter inspect` to drill into a specific cluster

**`/bughunt fix`** — the orchestrator. Per § 3.9.2, the skill walks the latest run's bugs.jsonl and per cluster:
1. Creates branch `bughunter/<runId>/<clusterId>` from baseBranch.
2. Spawns `Agent(subagent_type='architect', model='opus', prompt=<§ 3.9.3>)`. Architect commits a focused fix spec.
3. If spec begins `REFUSE:` → records `architect_refused`; skips to step 6.
4. Spawns `Agent(subagent_type='coder', model='sonnet', prompt=<§ 3.9.4>)`. Coder implements + tests + commits.
5. Calls `bughunter forbidden-path-gate <branch> --reset`. On violation → records `touched_forbidden_path`; skips to step 6.
6. Calls `bughunter retest <runId> <clusterId>`. Records the verdict.
7. Appends to `.bughunter/runs/<runId>/fix-state.json`.

After the loop, calls `bughunter fix-summary <runId>` and pretty-prints to the user.

This is **prose**, not code. The skill ships in `packages/cli/bughunt.md` and is mounted by target projects via symlink.

### 4.3 MCP wrapper (optional)

```ts
bughunt_run({ project: string, routePattern?: string, roles?: string[], maxBugs?: number, budget?: number })
  → { jobId: string }

bughunt_status({ jobId })
  → { state: 'queued'|'running'|'done'|'failed', runId?, bugCounts?: { filed }, error? }

bughunt_latest_bugs({ project, limit?: number, kind?: string })
  → Array<{ id, kind, clusterSize, rootCause, suspectedFiles, verdict? }>

bughunt_replay({ project, occurrenceId })
  → { ok: boolean, observation: object }
```

For Hermes / Paperclip agents that want to trigger a discovery bug hunt without a Claude session. Note: **the MCP wrapper does NOT expose auto-fix** — that's intentional. Auto-fix is a Claude-skill-driven workflow per § 3.9. Non-Claude agents can collect bugs but not fix them in v0.1.

## 5. Edge Cases

1. **Browser MCP unreachable.** Validation phase fails with explicit error. Don't run dual-mode without browser. `--ui-only false` for API-only mode.
2. **SurfaceMCP unreachable.** Validation phase fails. `--api-only false` for UI-only degraded mode.
3. **Login fails for a role.** Validation catches it; run aborts with the failing role list.
4. **Test creates state required by other tests.** Tests are independent; `resetPolicy` handles drift.
5. **Action triggers external service.** SurfaceMCP marks `external`. BugHunter respects on both API + UI side via cross-reference.
6. **Action requires user-confirmation modal.** Browser MCP auto-confirms; logged as part of action sequence.
7. **Action navigates away mid-test.** Detected; tracked as part of post-state.
8. **Page with infinite scroll / lazy-load.** Discovery scrolls until network goes quiet (10s max), then enumerates.
9. **Internationalized routes** (`/en/products`, `/fr/products`). User configures `routeAliases` to collapse.
10. **Long-running async actions.** Polls for up to 30s; final state is post-state. Configurable `asyncMaxWaitMs`.
11. **Role with zero accessible routes.** Logged as config issue; run continues for other roles.
12. **Auto-fix touches a forbidden path.** Post-hoc gate hard-resets the branch; cluster marked `bugs_skipped: touched_forbidden_path`.
13. **Cluster from a transient flake.** Re-run mode (default): every occurrence runs twice; if second doesn't reproduce, downgrade to `flaky`, exclude from auto-fix. `--strict` disables.
14. **Hot-reload during run.** SurfaceMCP `revision_changed` error → `infrastructure_failure` (not bug). Run continues; affected test re-queued unless `--no-requeue`.
15. **Modal/parallel/intercepted Next.js routes.** Out of scope v0.1. User must surface via fixtures or `discoveryHints`.
16. **Suspected file in `node_modules` or `.next/`.** `thirdPartyOrGenerated: true` flag; `bugs_skipped: third_party_or_generated` in auto-fix.
17. **Headless run, no `$BROWSER`.** `bughunter inspect` works without a viewer; `bughunter open` is removed.

## 6. Acceptance Criteria

1. `npx tsc --noEmit` clean in both packages.
2. `npx vitest run` green. Unit coverage:
   - Mutation palette generates correct cases per input type, including new types (tel, url, password, color, range, slug, foreign_id)
   - Same-shape element collapsing produces expected reduction on a fixture with 50 buttons sharing one signature
   - Cluster signature normalization: 10 known stack traces produce 3 expected clusters (test fixture)
   - `errorMessageNormalized` strips ids/strings consistently
   - Bug classification per § 3.5 honors `expectedOutcome`
   - `infrastructure_failure` does not enter `bugs.jsonl`
   - Stop-and-emit at 200; in-flight after cap appends to existing clusters
   - Cluster size > 50: only first-3 + last-1 retain full artifacts
   - Resume validity check refuses on revision mismatch unless `--force-resume`
   - Forbidden-path gate hard-resets branch and marks cluster `bugs_skipped`
   - `replay` re-executes a captured action log against the dev server
   - `surface_probe` invocation in plan phase upgrades unknown → inferred
   - `forbidden-path-gate <branch>` returns JSON; on violation + `--reset`, hard-resets the branch
   - `retest <runId> <clusterId>` returns RetestResult with verdict + per-occurrence details
   - The `bughunt.md` skill markdown contains the orchestration instructions (architect/coder dispatch, REFUSE handling) — verify by grep that the markdown references `Agent(subagent_type='architect', model='opus')` and `Agent(subagent_type='coder', model='sonnet')` and the CLI helpers
   - Server-action tools (`isServerAction: true`) are excluded from API direct-call test plan
   - Classifier priority hierarchy: a single occurrence triggering `404_for_linked_route` + `surface_call_failed` + `network_4xx_unexpected` clusters to the **highest-priority** kind only (here: `surface_call_failed`); the others land in `secondaryObservations`
   - `surfaceMcpUrl` adapter strips one trailing `/mcp` if present (backward-compat); init wizard default is base URL `http://127.0.0.1:3102` without `/mcp`
3. **Manual smoke against Spoonworks** (Next.js + revised SurfaceMCP):
   - `bughunter init` writes valid config
   - `bughunter run` discovers ~50 API routes (from SurfaceMCP) + filesystem-routed pages + DOM elements per page
   - Plan phase reports projected runtime; user can abort
   - Run completes within `--max-runtime` 24h default
   - Captures real bugs (introduce a deliberate `throw new Error(...)` in a route — verify it's caught and clustered correctly)
   - Same deliberate bug introduced in two routes clusters to one entry with two occurrences (signature normalization works)
4. **Auto-fix smoke** (manual, from a Claude Code session):
   - Introduce a deliberate bug; `bughunter run` to capture it
   - From a Claude session in the project, invoke `/bughunt fix`
   - Verify the skill creates branch `bughunter/<runId>/<clusterId>`, dispatches `Agent(architect, opus)`, then `Agent(coder, sonnet)`
   - Forbidden-path gate test: introduce a bug whose "fix" the architect-or-coder would apply by editing `prisma/schema.prisma`; verify `bughunter forbidden-path-gate --reset` hard-resets and the skill records `bugs_skipped: touched_forbidden_path`
   - Verify `bughunter retest` distinguishes `verified_fixed` / `verified_fixed_by_removal` / `not_fixed`
5. **Skill smoke**: `/bughunt` from a Claude session (skill markdown mounted) invokes the CLI and reports a summary citing cluster ids. Confirm the skill file is markdown-only, no executable code in `packages/skill/`.
6. **Resume smoke**: kill `bughunter run` mid-execution; `bughunter run --resume <runId>` picks up from saved state. Then change a SurfaceMCP-tracked file; resume refuses without `--force-resume`.
7. **Headless inspect**: `bughunter inspect <bug-id>` prints the cluster summary + artifact paths without requiring a viewer.

## 7. Files / Repo Layout

```
BugHunter/
├── SPEC.md
├── REVIEW.md                        # architect review pass + resolution table
├── README.md
├── package.json                     # workspace root
├── tsconfig.json
├── packages/
│   ├── cli/
│   │   ├── package.json
│   │   ├── bughunt.md               # the skill — mounted into target projects
│   │   ├── src/
│   │   │   ├── cli/
│   │   │   │   ├── init.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── replay.ts
│   │   │   │   ├── inspect.ts
│   │   │   │   ├── fix.ts
│   │   │   │   ├── list.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── prune.ts
│   │   │   │   └── palette.ts
│   │   │   ├── phases/
│   │   │   │   ├── validate.ts
│   │   │   │   ├── discover.ts      # 3-source discovery
│   │   │   │   ├── plan.ts          # schema enrichment + budget
│   │   │   │   ├── execute.ts
│   │   │   │   ├── classify.ts
│   │   │   │   ├── cluster.ts
│   │   │   │   └── emit.ts
│   │   │   ├── adapters/
│   │   │   │   ├── surface-mcp.ts   # surface_call/list_tools/probe/sample_inputs
│   │   │   │   └── browser-mcp.ts   # camofox client
│   │   │   ├── discovery/
│   │   │   │   ├── filesystem-pages.ts  # AST scan of app/**
│   │   │   │   ├── dom-walker.ts
│   │   │   │   ├── form-cross-ref.ts
│   │   │   │   └── element-collapse.ts  # same-shape signature
│   │   │   ├── mutation/
│   │   │   │   ├── palette.ts
│   │   │   │   ├── apply.ts
│   │   │   │   └── domain-hints.ts
│   │   │   ├── classify/
│   │   │   │   ├── console.ts
│   │   │   │   ├── network.ts
│   │   │   │   ├── react.ts
│   │   │   │   ├── state-change.ts  # MutationObserver-based
│   │   │   │   ├── dom-error-text.ts
│   │   │   │   └── accessibility.ts # delta-only
│   │   │   ├── cluster/
│   │   │   │   ├── signature.ts
│   │   │   │   └── normalize.ts
│   │   │   ├── repro/
│   │   │   │   ├── action-log.ts    # JSON action log writer
│   │   │   │   └── replay.ts        # action-log replay engine
│   │   │   ├── store/
│   │   │   │   ├── run-state.ts
│   │   │   │   ├── filesystem.ts
│   │   │   │   └── artifact-budget.ts
│   │   │   ├── ops/                 # operational helpers exposed as CLI subcommands
│   │   │   │   ├── forbidden-paths.ts   # bughunter forbidden-path-gate
│   │   │   │   ├── retest.ts            # bughunter retest (revision-aware verify)
│   │   │   │   └── fix-summary.ts       # bughunter fix-summary
│   │   │   ├── config.ts
│   │   │   ├── log.ts
│   │   │   └── types.ts
│   │   └── tests/
│   └── mcp/
│       ├── package.json
│       └── src/
│           ├── server.ts
│           └── tools.ts
├── fixtures/
│   ├── nextjs-deliberate-bugs/      # for acceptance smoke
│   └── stack-trace-clustering/      # for signature unit tests
└── scripts/
```

## 8. Configuration

`.bughunter/config.json` in target project:

```ts
type BugHunterConfig = {
  projectName: string;
  surfaceMcpUrl: string;                // http://127.0.0.1:3102/mcp
  browserMcpUrl?: string;
  // claudeMcpUrl removed in v0.1: auto-fix is now skill-driven via Claude
  // Code's Agent tool, not ClaudeMCP. May return as v0.2 option.
  roles?: string[];                     // default: all roles from SurfaceMCP
  resetCommand?: string;
  resetPolicy?: 'transactional'|'per-test'|'per-page'|'per-run';  // default 'per-page'
  paletteOverridePath?: string;         // default .bughunter/palette.json if present
  domainHints?: Record<string, string[]>;   // e.g. { "slug": ["product-a", "product-b"], "foreign_id": [123, 456] }
  discoveryFixtures?: Record<string, string[]>;  // dynamic-route → ids
  routeAliases?: Record<string, string>;
  maxBugs?: number;                     // default 200
  maxRuntimeMs?: number;                // default 86_400_000 (24h)
  budgetMs?: number;                    // optional time-box
  concurrency?: number;                 // browser, default 4
  apiConcurrency?: number;              // default 16
  asyncMaxWaitMs?: number;              // default 30_000
  reRunForFlakes?: boolean;             // default true
  excludedRoutes?: string[];
  externalIntegrationsAllowed?: boolean;  // default false
  enableA11y?: boolean;                 // default false
  // autoFixDispatchProject removed in v0.1; the skill operates in the cwd's project
  forbiddenPaths?: string[];            // user-extensible; defaults baked in
  extraHeaders?: Record<string, string>;  // e.g. { "X-Test-Mode": "true" } added to UI calls
  artifactBudgetBytes?: number;         // default 4 GB; oldest full artifacts degrade to summaries
};
```

Default `forbiddenPaths`:
```
prisma/migrations/**, prisma/schema.prisma, package.json, package-lock.json,
yarn.lock, pnpm-lock.yaml, .env*, .gitignore, migrations/**, alembic/**,
.next/**, node_modules/**, dist/**, build/**
```

## 9. Definition of Done

A reviewer can:
```
cd /root/spoonworks
# Assume SurfaceMCP is running on :3102 for spoonworks (revised v0.1)
# Assume camofox MCP is running
# (no ClaudeMCP needed for auto-fix in v0.1 — that's the skill's job)
npx bughunter init                    # writes .bughunter/config.json
npx bughunter run                     # full exhaustive run
```

…and after the run completes:
- `.bughunter/runs/<id>/bugs.jsonl` exists; well-formed
- `infrastructure.jsonl` (if any) is separate
- Each cluster has full artifacts on first-3 + last-1 occurrences
- The summary printed to stdout shows: total clusters, by-kind breakdown, by-role breakdown, projected-vs-actual runtime
- A deliberately-introduced bug is caught and clustered correctly
- A second deliberately-introduced bug in a different file with the same root-cause shape clusters to the same entry
- From a Claude session in the project, invoking `/bughunt fix` orchestrates per-cluster architect→coder dispatch, gates against forbidden paths, retests, prints verified-vs-persistent counts via `bughunter fix-summary`

…and from a Claude Code session inside the project:
- `/bughunt` invokes the CLI and reports a summary citing cluster ids
- `/bughunt fix` reads latest run and dispatches the per-cluster fix loop
- `bughunter inspect <occurrenceId>` prints cluster + artifact paths in a headless terminal
