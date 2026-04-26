# BugHunter — v0.1 spec

**Status:** Draft · **Author:** @architect (Opus) · **Date:** 2026-04-25 · **Depends on:** [SurfaceMCP](https://github.com/cunninghambe/SurfaceMCP), a browser MCP (camofox), [ClaudeMCP](https://github.com/cunninghambe/ClaudeMCP) (optional, for auto-fix)

---

## 1. Problem Statement

Vibe-coded apps are fast to write and slow to verify. Manual testing of every button × slider × form × user-role combination is the longest part of a release. UI-only test agents check that pages return 200 and miss the actual broken interactions; API-only tests miss the UI-state regressions. Humans manually clicking everything takes hours and gets skipped under time pressure.

BugHunter exhaustively walks an app's surface — every route, every interactive element, every declared role — applying a bounded mutation palette to inputs. It dual-executes via SurfaceMCP (API direct) and a browser MCP (UI), captures every failure with full repro context (action sequence, DOM snapshot, console, network, screenshot), clusters by root cause but logs every occurrence so post-fix verification works, and optionally dispatches Claude Code via ClaudeMCP to fix the bugs and open a PR.

Output: a structured JSONL bug log that another agent can act on, plus a human-readable summary.

## 2. Boundaries

**In scope (v0.1)**
- Exhaustive route × role × element matrix across the project
- Bounded mutation palette per input type: `null`, `happy`, `edge`, `out_of_bounds`
- Dual execution (SurfaceMCP for API + camofox MCP for UI) where both are available
- Bug clustering by root cause + per-occurrence logging
- JSONL output with full repro context
- Stop-and-emit at 200 bugs
- Optional `--auto-fix` flag dispatching ClaudeMCP for fix PRs
- CLI engine + Claude skill wrapper + optional MCP wrapper
- Local apps only

**Out of scope (v0.1)**
- Production / staging environments — local dev only
- Load testing, performance benchmarking — different problem
- Visual regression diffing pixel-by-pixel — too noisy. We rely on console errors / 5xx / state-change failures
- Fuzz testing of binary protocols
- Mobile UI testing
- Cross-browser matrix (we run one Chromium via camofox; "works in Firefox" is out of scope)
- WebSocket / SSE testing (paired with SurfaceMCP scope)
- Auto-fix that touches schema / migrations (those go to a human; auto-fix only handles code-level bugs)

**External dependencies**
- Node 20+, TypeScript strict
- A live SurfaceMCP instance for the target project
- A browser MCP server (`mcp__camofox__*` or compatible)
- ClaudeMCP at `http://127.0.0.1:3101/mcp` (optional, only for auto-fix)
- `axe-core` for accessibility heuristics
- `playwright` for the underlying browser driver if camofox isn't preferred for headless runs (camofox preferred when available)

## 3. Architecture Decisions

### 3.1 Three-layer packaging

```
bughunter/
├── packages/cli/         # the engine. node CLI, can run anywhere
├── packages/skill/       # markdown skill files + thin wrapper that shells to the CLI
└── packages/mcp/         # optional HTTP MCP wrapping the CLI for ClaudeMCP / Hermes integration
```

CLI is the load-bearing thing. Skill is the pleasant manual UX. MCP exposes BugHunter to non-Claude agents.

### 3.2 Phase pipeline (single run)

```
0. validate  — check SurfaceMCP reachable, browser MCP reachable, project dir valid
1. discover  — enumerate routes (API + UI), per role
2. plan      — generate test cases (route × role × element × mutation)
3. execute   — run cases in bounded parallel pool; capture every observation
4. classify  — what counts as a bug per § 3.5
5. cluster   — group occurrences by root cause
6. emit      — write JSONL + summary; stop at 200 unique bugs
7. fix?      — if --auto-fix, dispatch ClaudeMCP; else exit
```

Each phase is a separate module. State persists between phases in `.bughunter/runs/<run_id>/state.json` so a crashed run can resume.

### 3.3 Discovery

**API side (via SurfaceMCP):** `surface_list_tools()` → catalog of all generated route tools with method, path, schema, sideEffectClass, sourceFile.

**UI side (via browser MCP + sitemap):**
1. Login as each role (using the same auth flow SurfaceMCP uses)
2. Start at `baseUrl`; recursively follow same-origin links from page DOM until no new URLs found, capped at 1000 pages per role
3. For each visited page, enumerate interactive elements via DOM walk:
   - `<button>`, `<a>` (with href), `<input>` (all types), `<select>`, `<textarea>`, `<form>`, elements with `[role="button"]`, `[role="link"]`, `[onclick]`, `[contenteditable]`
   - Disabled elements logged but skipped from interaction
4. For each form, identify the submit endpoint. Cross-reference with SurfaceMCP catalog to know which API tool the form fires.

Output: `runs/<id>/discovery.json` listing pages × elements × api-tool-cross-refs.

### 3.4 Test plan generation

The "exhaustive" rule:
- Every (role, page) pair gets a "render" test (visit, capture, observe)
- Every (role, page, link) gets a "navigate" test
- Every (role, page, button) gets a "click" test
- Every (role, page, form) gets four fill-and-submit tests, one per palette
- Every (role, api_tool) gets four direct-call tests, one per palette (for tools where input schema is known; tools with `unknown` schema get only a "happy path" call with empty/sample object)

The mutation palette per input type:

| Input | null | happy | edge | out_of_bounds |
|---|---|---|---|---|
| text | `""` | `"valid example"` | very long string at the input's `maxlength` if known else `"a".repeat(255)` | `"a".repeat(100000)` plus one with `<script>` |
| email | `""` | `"a@b.co"` | `"a@b.co" + "_".repeat(60)` (RFC max local part) | `"not-an-email"` |
| number | `null` (omitted) | `1` | min/max if known else `0` | `Number.MAX_SAFE_INTEGER + 1` and `NaN` |
| date | `null` | `new Date()` | far past `1900-01-01` and far future `2100-12-31` | `"not-a-date"` |
| select | `null` | first option | last option | unlisted value injected |
| checkbox | unchecked | checked | n/a (only 2 states) | n/a — collapses to 2 cases |
| file | no file | small valid jpeg | exactly-at-limit bytes | wrong MIME (.exe), over-limit |
| boolean (form) | `null` | `true` | n/a | `false` |
| array (multi-select) | `[]` | one item | all items | non-existent items |

Project can override or extend the palette via `.bughunter/palette.json`.

For complex composite inputs (e.g. nested form fields), each leaf field cycles through the palette while siblings stay at "happy."

### 3.5 What counts as a bug (classification)

| Class | Detection |
|---|---|
| `console_error` | Browser DevTools console-level `error`. Warnings ignored except React-specific ones (see below). |
| `react_error` | "Warning: ", "Cannot update during render", hydration mismatches, error boundary stack traces |
| `network_5xx` | Any 5xx response during the action |
| `network_4xx_unexpected` | 4xx that doesn't match the action's expected outcome (e.g. 400 on a happy-path form submit; 401 from a logged-in role; 403 on a route the role should access) |
| `404_for_linked_route` | A page links to a URL that returns 404 |
| `missing_state_change` | Action that should change observable state didn't (form submitted but URL unchanged AND no toast AND no DOM mutation in the affected region within 5s) |
| `unhandled_exception` | Uncaught error in browser context |
| `accessibility_critical` | axe-core `critical` or `serious` violation introduced after the action (delta vs pre-state) |
| `dom_error_text` | Element with text matching `(?i)(something went wrong|an error occurred|unable to|failed to)` appears post-action where it wasn't pre-action |
| `surface_call_failed` | SurfaceMCP `surface_call` returns `ok: false` for a `mutating` tool with happy-path input |

Heuristic, not exhaustive — specs and acceptance criteria help when present, but BugHunter shouldn't depend on them. False-positive tolerance is ~10%; the auto-fix loop has its own verification step that re-tests before committing.

### 3.6 Bug clustering

Cluster signature is a tuple:

```ts
{
  kind: BugKind,                       // from § 3.5
  // For console / react / unhandled:
  errorMessageNormalized?: string,     // strip locations, hashes, ids
  stackTraceFingerprint?: string,      // top 3 frames, normalized paths
  // For network:
  endpoint?: string,                   // method + normalized path (params replaced with :param)
  status?: number,
  responseBodyShape?: string,          // top-level keys
  // For missing_state_change / dom_error_text:
  pageRoute?: string,                  // normalized URL pattern
  selectorClass?: string,              // CSS class fragment of the offending element
}
```

Two occurrences are clustered if their signatures are equal (after normalization). Each cluster has 1+ occurrences; every occurrence retains its full context.

### 3.7 Bug log format

`.bughunter/runs/<run_id>/bugs.jsonl` — one line per cluster:

```json
{
  "id": "bug-cuid",
  "runId": "run-cuid",
  "kind": "react_error",
  "rootCause": "TypeError: Cannot read properties of undefined (reading 'map')",
  "stackTraceFingerprint": "ProductList.tsx:42|useProducts.ts:18|ProductsPage.tsx:7",
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
        "via": "ui"
      },
      "preState": {
        "url": "/admin/inventory/products",
        "title": "Products — Spoonworks Admin",
        "consoleErrorCount": 0
      },
      "postState": {
        "url": "/admin/inventory/products",
        "title": "Products — Spoonworks Admin",
        "consoleErrors": [
          { "level": "error", "text": "TypeError: Cannot read...", "stack": "..." }
        ],
        "networkRequests": [
          { "method": "GET", "path": "/api/admin/products/123", "status": 500, "duration": 412, "responseBodySnippet": "..." }
        ],
        "domErrorTextDetected": false
      },
      "screenshotPath": "screenshots/occ-cuid.png",
      "domSnapshotPath": "dom/occ-cuid.html",
      "consoleLogPath": "console/occ-cuid.log",
      "networkLogPath": "network/occ-cuid.har",
      "reproSteps": [
        "Login as owner",
        "Navigate to /admin/inventory/products",
        "Click 'Edit' on first product row"
      ],
      "reproPlaywrightPath": "repro/occ-cuid.playwright.ts",
      "reproSurfaceMCPPath": "repro/occ-cuid.surfacemcp.json"
    },
    /* ... 6 more occurrences ... */
  ],
  "suspectedFiles": [
    "src/features/products/ProductList.tsx",
    "src/features/products/useProducts.ts"
  ],
  "fixHints": [
    "products.map call at ProductList.tsx:42 — products may be undefined when API errors. Add a guard or default to [].",
    "API returned 500; check src/app/api/admin/products/[id]/route.ts:18 for the underlying error."
  ]
}
```

Every cluster includes `suspectedFiles` (extracted from stack trace) and `fixHints` (LLM-generated, since the agent has the cluster + suspect files in scope).

### 3.8 Execution model

- Default concurrency: 4 browser contexts in parallel (one per role at a time, or one per role for parallel-by-role mode if `--parallel-roles` is set).
- Per-test timeout: 30s. Test that times out is logged as a `test_timeout` cluster (separate from bugs, since timeout might mean slow CI not a real bug).
- Run-level timeout: 4h default, configurable. If hit, BugHunter finishes the in-flight tests, emits the partial report.
- Stop-and-emit at 200 unique clusters: yes. After 200, the executor stops scheduling new tests, finishes in-flight, emits.
- Resume: `bughunter run --resume <run_id>` continues from the saved state.

### 3.9 Auto-fix loop

When `--auto-fix`:

1. After emit, BugHunter calls ClaudeMCP `claude_run` with:
   ```
   prompt: |
     You are fixing bugs from a BugHunter run.
     Run log: .bughunter/runs/{{run_id}}/bugs.jsonl
     For each cluster in the log:
       1. Read suspectedFiles + fixHints
       2. Investigate the root cause (use gitnexus_impact if available)
       3. Write a fix
       4. Add a regression test that exercises the same action sequence
       5. Commit with a message that includes the bug id
     Do NOT push. Open a PR for the user to review.
     Stop after fixing all clusters or after 60 minutes per cluster.
   project: {{project_name}}     # registered in ClaudeMCP
   timeoutMs: 14400000           # 4h
   ```

2. ClaudeMCP returns a `jobId`. BugHunter polls.
3. When the job completes, BugHunter re-runs the affected test cases (every occurrence's action sequence). For each cluster:
   - If zero occurrences reproduce the failure: cluster is `verified_fixed`.
   - If any occurrence still fails: cluster is `not_fixed`, kept open.
4. Final report distinguishes:
   - `bugs_filed`: total clusters from initial run
   - `bugs_attempted_fix`: clusters Claude tried to fix
   - `bugs_verified_fixed`: clusters confirmed fixed by re-test
   - `bugs_persistent`: clusters where fix didn't work
   - `bugs_skipped`: clusters Claude refused to fix (deemed too risky)

`bughunter fix` (no `run` first) reads the latest run's bugs.jsonl and dispatches the fix loop without re-running discovery.

### 3.10 Run isolation & data state

Each run starts from a clean app state where possible:
- If config declares a `resetCommand` (e.g. `npm run db:reset && npm run db:seed`), BugHunter runs it before discovery.
- Otherwise, accepts existing state and tests against it.

This is important because mutation tests (delete user, drop product, etc.) corrupt state; without reset, sequential runs amplify drift.

## 4. Interface Contract

### 4.1 CLI

```
bughunter init
  Walks project; writes .bughunter/config.json template. Prompts for SurfaceMCP URL,
  browser MCP URL, ClaudeMCP URL, role list (mirrors SurfaceMCP roles by default).

bughunter run [options]
  --auto-fix              After emit, dispatch fixes via ClaudeMCP
  --route <pattern>       Limit to routes matching a glob
  --role <name>           Limit to a single role (default: all roles)
  --max-bugs <n>          Stop-and-emit at N (default 200)
  --max-runtime <ms>      Run-level timeout (default 4h)
  --concurrency <n>       Parallel test slots (default 4)
  --reset                 Run resetCommand before discovery
  --resume <run-id>       Continue from saved state

bughunter fix
  Read latest run's bugs.jsonl; dispatch ClaudeMCP fix loop. Skips run.

bughunter list
  Show last 20 runs with bug counts.

bughunter status <run-id>
  Detailed status of a run; pretty-prints bugs.jsonl.

bughunter open <bug-id>
  Open the bug's screenshot, DOM snapshot, and repro script in a viewer.

bughunter palette
  Print active mutation palette. Edit .bughunter/palette.json to override.
```

### 4.2 Skill (`/bughunt`)

```
/bughunt                 → bughunter run
/bughunt --auto-fix      → bughunter run --auto-fix
/bughunt fix             → bughunter fix
/bughunt status          → bughunter list (latest 5)
```

The skill markdown teaches Claude how to interpret the bug log and present it concisely. Includes:
- Always cite the cluster id when discussing a bug
- When summarizing for a human, group by `kind` and rank by clusterSize
- After `--auto-fix`, summarize the verified-fixed vs persistent split

### 4.3 MCP wrapper (optional)

```ts
bughunt_run({ project: string, autoFix?: boolean, ... })
  → { jobId: string }

bughunt_status({ jobId })
  → { state, runId?, bugCounts?, ... }

bughunt_latest_bugs({ project, limit? })
  → Array<{ id, kind, clusterSize, rootCause, suspectedFiles }>
```

For Hermes / Paperclip agents that want to trigger a bug hunt without a Claude session.

## 5. Edge Cases

1. **Browser MCP unreachable.** Fail validation phase with clear instruction to start camofox / playwright server. Don't run without the browser side.
2. **SurfaceMCP unreachable.** Same. BugHunter is dual-execution; UI-only mode is degraded but supported via `--ui-only`.
3. **App in a state that breaks login** (e.g. owner password rotated). All roles report login failure during validation. Run aborts with the failing role list.
4. **Test that creates state required by other tests.** v0.1 tests are independent (no chain) — don't rely on order. Tests that need fixture data use the `resetCommand` + seed-data approach. (Test chaining is a Phase-2 feature — observed-state graphs.)
5. **Action triggers external service** (Stripe, SendGrid). SurfaceMCP marks these `sideEffectClass: external`. BugHunter skips them by default; `--include-external` opt-in for users who have test-mode credentials wired.
6. **Action requires user confirmation modal** (e.g. "Are you sure?"). The browser MCP is told to auto-confirm. Tracked under "the action's side effect chain" and logged as part of the action sequence.
7. **Action navigates away mid-test.** Detected; tracked as part of post-state observation. Not a bug unless it broke navigation expectations.
8. **Page with infinite scroll / lazy-load.** Discovery walker honors `<a href>` only; lazy-loaded content is skipped from element enumeration unless the discoverer scrolls. v0.1: scroll until network goes quiet, then enumerate. Documented limitation.
9. **Internationalized routes** (`/en/products`, `/fr/products`). Treated as separate routes by URL. Could explode the matrix; user can configure `routeAliases` to collapse them.
10. **Long-running async actions.** Action returns 202 + polls. v0.1 polls for up to 30s and treats final state as the post-state. Configurable via `asyncMaxWaitMs`.
11. **Role that has zero accessible routes.** Logged as a config issue. Run continues for other roles.
12. **Auto-fix Claude session destroys data integrity.** Possible if the fix touches the DB / migrations. Out of scope for v0.1; auto-fix is gated to "code-only" by a server-side check in ClaudeMCP that BugHunter passes (rejected fix categories: schema migrations, package version changes, env var changes, .gitignore, anything in `prisma/migrations/` etc.). Out-of-scope categories filed as `bugs_skipped`.
13. **Bug cluster from a transient flake.** Re-run mode: every occurrence runs twice; if the second occurrence doesn't reproduce, the bug is downgraded to `flaky` and not auto-fixed. `--strict` disables this and treats every reproduction as confirmed.

## 6. Acceptance Criteria

1. `npx tsc --noEmit` clean across all three packages.
2. `npx vitest run` green. Unit coverage:
   - Mutation palette generates the right cases per input type
   - Cluster signature normalization (paths, ids, line numbers stripped)
   - Bug classification per § 3.5
   - Stop-and-emit at 200
   - Resume from saved state
   - Cluster-vs-occurrence accounting (clusterSize = occurrences.length)
3. Manual smoke against Spoonworks (Next.js + SurfaceMCP):
   - `bughunter init` writes valid config
   - `bughunter run` discovers ~50 API routes (from SurfaceMCP) + ~20 UI pages
   - Generates a couple thousand test cases
   - Completes in < 1 hour for the full matrix on this size project
   - Captures real bugs (introduce a deliberate one — `throw new Error(...)` in a route — and verify it's caught and clustered correctly)
4. Auto-fix smoke: introduce a deliberate bug, run with `--auto-fix`, verify ClaudeMCP gets the dispatch, verify a fix PR is opened, verify re-run shows `verified_fixed` for that cluster.
5. Skill smoke: `/bughunt` from a Claude session correctly shells to the CLI and reports back a summary in the conversation.
6. Resume smoke: kill `bughunter run` mid-execution; `bughunter run --resume <run-id>` picks up from saved state without re-running completed cases.

## 7. Files / Repo Layout

```
BugHunter/
├── SPEC.md
├── README.md
├── package.json                      # workspace root
├── tsconfig.json
├── packages/
│   ├── cli/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── cli/
│   │   │   │   ├── init.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── fix.ts
│   │   │   │   ├── list.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── open.ts
│   │   │   │   └── palette.ts
│   │   │   ├── phases/
│   │   │   │   ├── validate.ts
│   │   │   │   ├── discover.ts
│   │   │   │   ├── plan.ts
│   │   │   │   ├── execute.ts
│   │   │   │   ├── classify.ts
│   │   │   │   ├── cluster.ts
│   │   │   │   ├── emit.ts
│   │   │   │   └── auto-fix.ts
│   │   │   ├── adapters/
│   │   │   │   ├── surface-mcp.ts
│   │   │   │   ├── browser-mcp.ts
│   │   │   │   └── claude-mcp.ts
│   │   │   ├── mutation/
│   │   │   │   ├── palette.ts
│   │   │   │   └── apply.ts
│   │   │   ├── classify/
│   │   │   │   ├── console.ts
│   │   │   │   ├── network.ts
│   │   │   │   ├── react.ts
│   │   │   │   ├── state-change.ts
│   │   │   │   ├── dom-error-text.ts
│   │   │   │   └── accessibility.ts
│   │   │   ├── cluster/
│   │   │   │   ├── signature.ts
│   │   │   │   └── normalize.ts
│   │   │   ├── repro/
│   │   │   │   ├── playwright-script.ts
│   │   │   │   └── surface-mcp-calls.ts
│   │   │   ├── store/
│   │   │   │   ├── run-state.ts
│   │   │   │   └── filesystem.ts
│   │   │   ├── config.ts
│   │   │   ├── log.ts
│   │   │   └── types.ts
│   │   └── tests/
│   ├── skill/
│   │   ├── package.json
│   │   ├── skills/
│   │   │   ├── bughunt.md            # primary skill markdown
│   │   │   └── bughunt-fix.md
│   │   └── src/
│   │       └── shell.ts              # thin wrapper that shells to the CLI
│   └── mcp/
│       ├── package.json
│       └── src/
│           ├── server.ts             # express + MCP SDK
│           └── tools.ts
├── fixtures/                         # tiny fake apps for integration tests
└── scripts/
```

## 8. Configuration

`.bughunter/config.json` in target project:

```ts
type BugHunterConfig = {
  projectName: string;
  surfaceMcpUrl: string;               // http://127.0.0.1:3102/mcp
  browserMcpUrl?: string;              // ws://127.0.0.1:9222 or whatever camofox exposes
  claudeMcpUrl?: string;               // http://127.0.0.1:3101/mcp — only required for --auto-fix
  roles?: string[];                    // default: all roles from SurfaceMCP config
  resetCommand?: string;               // e.g. "npm run db:reset && npm run db:seed"
  paletteOverridePath?: string;        // default: .bughunter/palette.json if present
  routeAliases?: Record<string, string>;  // collapse i18n routes etc.
  maxBugs?: number;                    // default 200
  maxRuntimeMs?: number;               // default 14_400_000 (4h)
  concurrency?: number;                // default 4
  asyncMaxWaitMs?: number;             // default 30_000
  reRunForFlakes?: boolean;            // default true
  excludedRoutes?: string[];           // glob patterns
  externalIntegrationsAllowed?: boolean;  // default false
  autoFixDispatchProject?: string;     // ClaudeMCP project name (default: same as projectName)
};
```

## 9. Definition of Done

A reviewer can:
```
cd /root/spoonworks
# Assume SurfaceMCP is running on :3102 for spoonworks
# Assume camofox MCP is running
npx bughunter init
# (fills in URLs, roles)
npx bughunter run
```

…and after the run completes:
- `.bughunter/runs/<id>/bugs.jsonl` exists and is well-formed
- Each cluster has at least one occurrence with screenshot + DOM + console + network attached
- The summary printed to stdout shows: total clusters, by-kind breakdown, by-role breakdown
- A deliberately-introduced bug is caught and clustered correctly
- `npx bughunter run --auto-fix` (with ClaudeMCP also running) dispatches the fix loop, attempts fixes, re-runs verification, and prints final `bugs_verified_fixed` / `bugs_persistent` counts

…and from a Claude Code session inside the project:
- `/bughunt` shells to the CLI and reports a short summary back in the conversation
- `/bughunt fix` reads the latest run and dispatches the fix loop
