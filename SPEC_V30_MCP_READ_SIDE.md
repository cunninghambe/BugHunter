# SPEC — v0.30 "MCP Read-Side Tools (parity with CLI)"

**Status:** Draft 1 — ready for `@coder` assignment ·
**Author:** `@architect` (Opus, ultrathink) ·
**Date:** 2026-04-30 ·
**Predecessor:** v0.18 (V-spec format reference); current MCP server at `packages/mcp/src/server.ts` + `tools.ts` (4 tools: `bughunt_run`, `bughunt_status`, `bughunt_latest_bugs`, `bughunt_replay`). ·
**Sibling specs (parallel-shippable):** V26 detector registry, V27 history.db / cross-run diff, V28 explanations cache, V29 severity. ·
**Strategic source:** `SPEC_PATH_TO_EXHAUSTIVE.md` §5 (MCP surface), §5.1 (read-side), §5.3 (streaming).

This spec adds **12 read-side MCP tools + 2 streaming resources** to `bughunter-mcp` so every CLI inspection operation is reachable from a Claude / Hermes / generic MCP client. Today the MCP exposes 4 tools — that's enough to *trigger* a run but not enough to *drive a review session* without shelling out. After V30, an MCP-only consumer can list runs, drill into clusters, fetch artifacts, diff across runs, browse history, get LLM-summarized explanations, and live-tail an active run.

Write-side tools (suppress / triage / minimize / fix-dispatch) are explicitly **out of scope** — they are V31. Read-side parity is the larger and lower-risk lift; landing it first unblocks all read-only consumers and validates the registration / schema patterns before write-side touches state.

---

## 1. Objective

Add **12 new MCP tools** and **2 streaming resources** to `bughunter-mcp` covering the entire read-side CLI surface plus live-tail. Every tool has:

1. A descriptive name (`bughunt_*`) that an LLM can choose without prompting.
2. An LLM-readable description matching the CLI command it mirrors.
3. A Zod input schema with explicit `.describe()` text on every field.
4. A typed output (TypeScript-checkable end-to-end with the CLI types).
5. Clear error semantics (`runId not found` → `not_found` code; transient I/O → `error` code).
6. CLI parity — for every tool, the `bughunter <command>` it mirrors must be cited in the spec and the tool description.

**In scope**

- `bughunt_clusters`, `bughunt_cluster_detail`, `bughunt_occurrence`, `bughunt_artifact`, `bughunt_runs_list`, `bughunt_run_summary`, `bughunt_detectors`, `bughunt_diff`, `bughunt_history`, `bughunt_explain`, `bughunt_project_describe`, `bughunt_config_get` (12 tools).
- Streaming resources: `bughunter://tail/<runId>` (new clusters) and `bughunter://progress/<runId>` (phase changes / counters).
- Polling fallbacks for clients that don't support MCP resource subscriptions.
- Per-client API-key auth (Express middleware reading `Authorization: Bearer ...`), wired before any tool runs.
- Cursor pagination scheme (base64-encoded JSON `{ offset, runId }`).

**Out of scope (deferred)**

- Write-side tools (`bughunt_suppress`, `bughunt_triage`, `bughunt_minimize`, `bughunt_baseline_save`, `bughunt_fix_dispatch`, etc.) — V31.
- `bughunt_config_set` — write-side; V31.
- `bughunt_replay_minimized` — write-side prerequisite (`bughunt_minimize`) lives in V31.
- A signed-URL artifact server. V30 inlines bytes (base64 for binary, text for utf-8); rationale and trade-off in §6.4.
- WebSocket transport for streaming. MCP `StreamableHTTPServerTransport` provides server-sent events; we use that.
- Mutating CLI commands (`fix-summary`, `forbidden-path-gate`, `retest`) — already partly covered by `bughunt_replay` and entirely a write concern.

**Acceptance target**

A Claude Code session connected to `bughunter-mcp` over HTTP with one project's API key can:

1. `bughunt_runs_list` → pick the latest run.
2. `bughunt_run_summary({ runId })` → see counts.
3. `bughunt_clusters({ runId, severity: 'critical' })` → 5 critical clusters.
4. `bughunt_cluster_detail({ runId, clusterId })` → first cluster with all occurrences.
5. `bughunt_artifact({ runId, occurrenceId, kind: 'screenshot' })` → base64 PNG.
6. `bughunt_explain({ runId, clusterId })` → human-readable explanation.
7. `bughunt_diff({ runIdOld, runIdNew })` → `{ new: [...], persistent: [...], gone: [...], regressed: [...] }`.

…all without shelling out, without writing a single file, and without round-tripping through `bughunter run`.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/mcp/src/server.ts` (43 lines) | Express app + MCP transport. **Add** API-key middleware before `app.post('/mcp', ...)`. **Do not** restructure the per-request `new McpServer()` pattern. |
| `packages/mcp/src/tools.ts` (175 lines) | Existing 4 tools registered via `server.tool(name, desc, zodShape, handler)`. **Mirror exactly** — same response shape (`toolOk` / `toolErr`), same `importCli()` pattern for any cross-package work, same dynamic import. |
| `packages/cli/src/types.ts` (1199 lines) | Types this MCP exposes: `BugCluster` (l.197), `OccurrenceFull`/`OccurrenceSummary` (l.156-191), `RunSummary` (l.1104), `BugKind` (l.23), `ClusterVerdict` (l.220), `BugHunterConfig` (l.955). |
| `packages/cli/src/store/filesystem.ts` (91 lines) | `runPaths(projectDir, runId)` returns the canonical paths. `listRunIds(projectDir)` enumerates runs. **Reuse** instead of re-deriving paths. |
| `packages/cli/src/cli/list.ts` | CLI parity for `bughunt_runs_list` (cross-run list). |
| `packages/cli/src/cli/inspect.ts` | CLI parity for `bughunt_cluster_detail` and `bughunt_occurrence`. |
| `packages/cli/src/cli/status.ts` | CLI parity for `bughunt_run_summary`. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §5 | Tool naming + intended semantics. |

### 2.2 Patterns to follow

- **Tool registration shape.** Every tool is registered via `server.tool(name, description, zodShape, handler)`. The handler is `async (args) => Promise<ToolOk | ToolErr>`. Match `tools.ts` line 64-106 (`bughunt_run`) exactly.
- **Response shape.** Use the existing `toolOk(data)` and `toolErr(code, message)` helpers from `tools.ts` line 29-35. Do NOT introduce a new envelope.
- **Filesystem-backed reads.** Use `runPaths()` (filesystem.ts:22) to derive paths — never hand-build `${projectDir}/.bughunter/runs/...` strings. The existing `bughunt_latest_bugs` (tools.ts:120) does this wrong; **do not copy the wrong-paths anti-pattern** — fix the locally-defined `bugsFilePath` in tools.ts:43 to use `runPaths` while you're there.
- **Project resolution.** Every read-side tool takes either `runId` (when the run is unambiguously identified globally) OR `(project, runId?)` (when scoped to a project). For V30, runs are scoped to a project — every tool that takes `runId` MUST also take `project: string` (the project directory). The MCP server is multi-tenant; `runId` is not globally unique.
- **Zod `.describe()` on every field.** Existing tools do this (tools.ts:69-73). LLM tool selection depends on it. Required.
- **Error codes.** `not_found` for missing project/run/cluster/occurrence; `invalid_argument` for Zod parse failure (handled by SDK automatically); `not_implemented` for tools whose dependency (V26/V27/V28) isn't yet wired; `error` for transient I/O. Discriminated.

### 2.3 DO NOT

- **Do not** create a new MCP server. Add to `packages/mcp/src/tools.ts`. Split into per-family files only as described in §10.
- **Do not** add a database layer to MCP. All reads go through the CLI's existing filesystem layout (or, for V27 cross-run, through V27's history.db once it lands).
- **Do not** load the whole `bugs.jsonl` into memory for `bughunt_clusters` once a run grows beyond the `--max-bugs` cap. **Stream** with `readline`, decode JSON line-by-line, filter, paginate. See §6.5.
- **Do not** inline >1MB artifacts. `bughunt_artifact` rejects with a `payload_too_large` code and points the caller to mount the project filesystem directly. See §6.4.
- **Do not** change the existing 4 tools' contracts. They stay byte-compatible. New tools are additive.
- **Do not** assume V26/V27/V28 are landed. Each tool that depends on a sibling spec MUST guard with a "feature-detect" branch returning `not_implemented` if the dependency surface is missing. Concrete patterns in §6.7.
- **Do not** introduce a new auth scheme. API-key bearer only. No JWT, no OAuth, no per-tool ACL.
- **Do not** trust `args.project`. Resolve, normalize, and verify it points to a directory containing `.bughunter/`. Reject otherwise.

---

## 3. Tool catalog

Each subsection: **name** · **CLI parity** · **MCP description (LLM-readable)** · **Zod input** · **output shape** · **error cases** · **server.ts slot**.

### 3.1 `bughunt_clusters`

**CLI parity:** mirrors `bughunter inspect <runId>` (filtered list view) + future `bughunter list --kind X --severity critical`.

**MCP description (verbatim, used by LLM tool-picker):**
> List bug clusters from a run with filtering and cursor-paginated results. Use this to browse findings before drilling into a specific cluster. Filters: kind, role, route pattern, verdict, severity, minimum cluster size. Returns cluster summaries (id, kind, severity, size, root cause, suspected files, verdict). For full cluster detail including occurrences, call `bughunt_cluster_detail` after.

**Zod input:**
```ts
z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).optional().describe('Run id; defaults to latest run for the project'),
  kind: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Filter to one or more BugKinds (e.g. "xss_reflected" or ["slow_lcp","high_cls"])'),
  role: z.string().min(1).optional().describe('Filter to clusters whose occurrences include this role'),
  routePattern: z.string().min(1).optional().describe('Glob over occurrence.page (e.g. "/api/users/*")'),
  verdict: z.enum([
    'verified_fixed','verified_fixed_by_removal','not_fixed',
    'partially_verified','architect_refused',
  ]).optional().describe('Filter to clusters with this verdict'),
  severity: z.enum(['critical','major','minor','info']).optional()
    .describe('V29-defined severity. Returns not_implemented until V29 lands.'),
  minClusterSize: z.number().int().min(1).optional().describe('Minimum number of occurrences in cluster'),
  limit: z.number().int().min(1).max(200).default(50).describe('Page size; default 50, max 200'),
  cursor: z.string().optional().describe('Opaque pagination token from previous call'),
})
```

**Output shape (TS):**
```ts
type ClustersOutput = {
  clusters: Array<{
    id: string;
    bugIdentity?: string;          // V27-defined, optional until V27 lands
    kind: BugKind;
    severity?: 'critical'|'major'|'minor'|'info';  // V29-defined, optional until V29
    clusterSize: number;
    rootCause: string;
    suspectedFiles: string[];
    verdict?: ClusterVerdict;
  }>;
  nextCursor?: string;             // present iff more results
  total?: number;                  // best-effort total before pagination, optional
};
```

**Error cases:**
- `not_found` if `project` has no `.bughunter/runs/`.
- `not_found` if explicit `runId` doesn't exist under that project.
- `not_implemented` if `severity` is supplied AND V29 hasn't landed (no `severity` field in `BugCluster`). Detect via `'severity' in firstCluster`.
- `invalid_argument` (auto via Zod) on malformed `cursor`.

**server.ts slot:** new file `packages/mcp/src/tools/clusters.ts`, registered from `tools.ts` after the existing 4 tools (line 175).

---

### 3.2 `bughunt_cluster_detail`

**CLI parity:** mirrors `bughunter inspect <runId> --cluster <clusterId>` (full single-cluster detail).

**Description:**
> Get the full BugCluster including all occurrences (lightweight + full-artifact), suspected files, fix hints, and verdict. Use after `bughunt_clusters` to drill into one finding. Occurrences contain action logs, screenshots refs, console logs, network logs.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
})
```

**Output:** the full `BugCluster` type from `packages/cli/src/types.ts:197`. NO transformation — pass-through. Includes the full `Occurrence[]` array.

**Error cases:**
- `not_found` if cluster doesn't exist in the run's `bugs.jsonl`.
- `payload_too_large` if cluster's serialized form (with all `Occurrence` records inlined) exceeds 4MB. Caller should fetch occurrences individually via `bughunt_occurrence` (see §6.4 thresholds).

**server.ts slot:** `packages/mcp/src/tools/cluster-detail.ts`.

---

### 3.3 `bughunt_occurrence`

**CLI parity:** mirrors `bughunter inspect <runId> --occurrence <occId>`.

**Description:**
> Get one occurrence — the smallest unit of evidence. Returns either OccurrenceFull (with screenshot/dom/console/network/action-log path references) or OccurrenceSummary (lightweight; created when retention budget caps full-artifact storage). The `fullArtifacts` discriminator tells you which.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
})
```

**Output:** `OccurrenceFull | OccurrenceSummary` (l.156-191 of types.ts). Pass-through. Note this returns paths to artifacts, not bytes — use `bughunt_artifact` to get bytes.

**Error cases:**
- `not_found` if occurrence not found in any cluster of the run.
- `error` for I/O failure.

**server.ts slot:** `packages/mcp/src/tools/occurrence.ts`.

---

### 3.4 `bughunt_artifact`

**CLI parity:** none — CLI users open the file directly. MCP clients lack filesystem access in many deployments.

**Description:**
> Fetch the bytes of one artifact (screenshot PNG, DOM HTML, console log, network HAR, action log). Use after `bughunt_occurrence` returned a path. Binary artifacts come back base64-encoded; text artifacts as utf-8. Subject to a 4MB cap — exceeding artifacts return `payload_too_large` with a path that the caller can read directly if it has filesystem access.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
  kind: z.enum(['screenshot','dom','console','network','action-log']),
})
```

**Output (TS discriminated union):**
```ts
type ArtifactOutput =
  | { kind: 'screenshot'; contentType: 'image/png'; base64: string; bytes: number }
  | { kind: 'dom';        contentType: 'text/html'; text: string; bytes: number }
  | { kind: 'console';    contentType: 'application/x-ndjson'; text: string; bytes: number }
  | { kind: 'network';    contentType: 'application/json'; text: string; bytes: number }
  | { kind: 'action-log'; contentType: 'application/json'; text: string; bytes: number };
```

**Error cases:**
- `not_found` if occurrence is `OccurrenceSummary` (no full artifacts retained — retention budget hit). Error message names the retention reason.
- `not_found` if the artifact path on disk doesn't exist (cleaned up post-prune).
- `payload_too_large` if file > 4MB. Error body includes `{ path: string }` so callers with filesystem access can fall back. See §6.4.

**server.ts slot:** `packages/mcp/src/tools/artifact.ts`.

---

### 3.5 `bughunt_runs_list`

**CLI parity:** mirrors `bughunter list`.

**Description:**
> List runs for a project (or across all known projects if V27 history.db is available). Returns lightweight summaries: runId, startedAt, phase, cluster count, by-kind counts. Use this to find the run id to feed into other tools.

**Input:**
```ts
z.object({
  project: z.string().min(1).optional()
    .describe('Project directory. If omitted AND V27 history.db is available, returns runs across all known projects.'),
  limit: z.number().int().min(1).max(200).default(20)
    .describe('Max runs to return; default 20 most recent'),
  since: z.string().datetime().optional()
    .describe('ISO-8601 cutoff; only return runs started at or after this'),
})
```

**Output:**
```ts
type RunsListOutput = Array<{
  runId: string;
  project: string;          // resolved absolute path
  startedAt: string;        // ISO
  phase: RunPhase;
  bugsFiled?: number;       // from summary.json if present, else from state.json clusterCount
  byKind?: Record<string, number>;
}>;
```

**Error cases:**
- `invalid_argument` if both `project` is omitted AND V27 history.db is missing — caller must scope.
- `error` for I/O failure.

**server.ts slot:** `packages/mcp/src/tools/runs.ts` (shared by `bughunt_runs_list` and `bughunt_run_summary`).

---

### 3.6 `bughunt_run_summary`

**CLI parity:** mirrors `bughunter status <runId>` (summary view).

**Description:**
> Read summary.json for one run: counts (filed / fixed / persistent / skipped), by-kind / by-role aggregations, vision telemetry, perf summary, bundle summary, seed-hook executions, pen-testing telemetry. The full RunSummary type.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
})
```

**Output:** the full `RunSummary` type from `types.ts:1104` (78 lines of fields). Pass-through `summary.json`.

**Error cases:**
- `not_found` if run doesn't exist.
- `not_found` if `summary.json` doesn't exist (run was killed mid-emit). Error message says `run_in_progress`.
- `error` for parse failure (corrupted summary.json).

**server.ts slot:** `packages/mcp/src/tools/runs.ts` (same file as 3.5).

---

### 3.7 `bughunt_detectors`

**CLI parity:** mirrors `bughunter detectors [--kind <bugkind>] [--status wired|dead|deferred]`.

**Description:**
> Coverage transparency: for every BugKind, report whether it has a wired detector, the file:line of that detector, the input source (production paths vs synthetic-only), and last-fired-at across runs. Use this to answer "why didn't BugHunter flag X" with an actionable answer. Depends on V26 (DETECTOR_REGISTRY).

**Input:**
```ts
z.object({
  project: z.string().min(1).optional()
    .describe('When provided, last-fired-at is computed from this project\'s runs; otherwise null'),
  status: z.enum(['wired','dead','deferred']).optional(),
  kind: z.string().min(1).optional().describe('Filter to one BugKind'),
})
```

**Output (V26 shape, projected):**
```ts
type DetectorsOutput = Array<{
  kind: BugKind;
  status: 'wired'|'dead'|'deferred';
  detectorFile?: string;             // e.g. 'packages/cli/src/security/xss-reflected.ts'
  detectorLine?: number;
  runnerInputSource: 'production'|'synthetic-only'|'unknown';
  severity: 'critical'|'major'|'minor'|'info';   // from V29
  specRef?: string;                  // e.g. 'SPEC_V07_XSS.md'
  lastFiredAt?: string;              // ISO; null if never fired (or project unscoped)
}>;
```

**Error cases:**
- `not_implemented` if V26's `DETECTOR_REGISTRY` export is missing from the CLI package. The MCP code attempts a dynamic `await import('bughunter/src/detectors/registry.js')` and falls back to `not_implemented` on `ERR_MODULE_NOT_FOUND`. See §6.7.

**server.ts slot:** `packages/mcp/src/tools/detectors.ts`.

---

### 3.8 `bughunt_diff`

**CLI parity:** mirrors `bughunter diff <runId-old> <runId-new>`.

**Description:**
> Cross-run diff. Compares two runs by stable bugIdentity and returns four buckets: clusters new in <runIdNew>, clusters present in both (persistent), clusters fixed in <runIdNew> (gone), and clusters that were verified-fixed in <runIdOld> but reappear in <runIdNew> (regressed). Returns SARIF if requested. Depends on V27 (history.db + bugIdentity + diff implementation).

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runIdOld: z.string().min(1),
  runIdNew: z.string().min(1),
  format: z.enum(['json','sarif']).default('json'),
})
```

**Output (json format):**
```ts
type DiffOutput = {
  new: BugCluster[];
  persistent: BugCluster[];
  gone: BugCluster[];
  regressed: BugCluster[];
};
```

**Output (sarif format):** an object conforming to SARIF 2.1.0; opaque to V30 (V27 owns the shape). MCP just passes through.

**Error cases:**
- `not_found` for either runId.
- `not_implemented` if V27's `diff()` function isn't exported. Detect via dynamic import of `bughunter/src/history/diff.js`.

**server.ts slot:** `packages/mcp/src/tools/diff.ts`.

---

### 3.9 `bughunt_history`

**CLI parity:** mirrors `bughunter history --kind <kind>`.

**Description:**
> Per-kind or per-bugIdentity timeline across runs: when did this bug class first appear, when was it fixed, did it regress, what's the median time-to-fix. Read from V27 history.db. Use to answer "is bug X new or has it been around?" Depends on V27.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  kind: z.string().min(1).optional()
    .describe('Filter to one BugKind. Mutually exclusive with bugIdentity.'),
  bugIdentity: z.string().min(1).optional()
    .describe('Filter to one stable identity. Mutually exclusive with kind.'),
  limit: z.number().int().min(1).max(500).default(50),
}).refine(
  (o) => !(o.kind && o.bugIdentity),
  { message: 'kind and bugIdentity are mutually exclusive' },
)
```

**Output:**
```ts
type HistoryOutput = Array<{
  runId: string;
  startedAt: string;       // ISO
  kind: BugKind;
  bugIdentity?: string;
  clusterSize: number;
  verdict?: ClusterVerdict;
}>;
```

**Error cases:**
- `not_implemented` if V27's history.db doesn't exist.
- `error` for SQLite I/O failure.

**server.ts slot:** `packages/mcp/src/tools/history.ts`.

---

### 3.10 `bughunt_explain`

**CLI parity:** mirrors `bughunter explain <bug-id>`.

**Description:**
> Get a human-readable LLM explanation of a cluster: what the bug is, why it matters, what code likely caused it, what fix is sketched. Cached per (runId, clusterId, file-content-hashes-of-suspectedFiles). Costs ~5¢/explain on cache miss. Depends on V28's explanations cache.

**Input:**
```ts
z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  noCache: z.boolean().default(false).describe('Force regeneration even if cached'),
})
```

**Output:**
```ts
type ExplainOutput = {
  explanation: string;       // markdown
  cached: boolean;
  costUsd?: number;          // present iff cache miss; undefined if cached
  generatedAt: string;       // ISO; either now or cache hit time
};
```

**Error cases:**
- `not_found` if cluster doesn't exist.
- `not_implemented` if V28's `explainCluster()` API isn't exported. Detect via dynamic import.
- `error` if Anthropic API fails (preserve as-is — caller may retry with `noCache: true`).

**server.ts slot:** `packages/mcp/src/tools/explain.ts`.

---

### 3.11 `bughunt_project_describe`

**CLI parity:** mirrors `bughunter doctor` (project-scoped, structured output).

**Description:**
> Health check for a project: SurfaceMCP reachable? camofox / browser MCP reachable? Vision auth? config valid? .bughunter directory present and writable? Disk space? Active hooks? Returns a structured report with ok/warn/error severity per check.

**Input:**
```ts
z.object({
  projectDir: z.string().min(1),
})
```

**Output:**
```ts
type ProjectDescribeOutput = {
  projectDir: string;
  ok: boolean;                    // overall — true iff every check is 'ok'
  checks: Array<{
    name: string;                 // 'surfaceMcp'|'browserMcp'|'visionAuth'|'config'|'disk'|'hooks'|...
    status: 'ok'|'warn'|'error'|'skip';
    detail: string;
    suggestion?: string;          // human-readable remediation when status != 'ok'
  }>;
  config?: {
    surfaceMcpUrl?: string;
    framework?: string;           // detected (next, vite, etc.)
    forbiddenPaths?: string[];
  };
};
```

**Error cases:** never errors — always returns a report; missing dependencies are reflected as `status: 'error'` per check, not as a tool error.

**server.ts slot:** `packages/mcp/src/tools/project.ts`.

---

### 3.12 `bughunt_config_get`

**CLI parity:** mirrors `bughunter config show [--resolved]`.

**Description:**
> Read a project's BugHunter config, either raw (the contents of .bughunter/config.json) or resolved (with all defaults applied via Zod parse). Use `resolved: true` when you need to see the effective settings the run will use.

**Input:**
```ts
z.object({
  projectDir: z.string().min(1),
  resolved: z.boolean().default(false),
})
```

**Output:** the full `BugHunterConfig` type (l.955 of types.ts). Pass-through if `resolved: false`; Zod-parsed-with-defaults if `resolved: true`.

**Error cases:**
- `not_found` if `.bughunter/config.json` doesn't exist.
- `invalid_argument` with the Zod issue list if the file is malformed.
- `error` for I/O failure.

**server.ts slot:** `packages/mcp/src/tools/config.ts`.

---

## 4. Streaming resources

MCP supports two delivery models: **tool calls** (request/response) and **resource subscriptions** (server-pushed). V30 adds two resources, both of which also expose a polling-fallback tool for clients that don't support `resources/subscribe`.

### 4.1 `bughunter://tail/<runId>`

**Subscription semantics:** every time a new cluster is appended to `bugs.jsonl` during an active execute phase, the resource emits a notification. Subscribers receive the cluster summary (same shape as `bughunt_clusters[i]`). Drops on run completion (phase == 'done').

**Polling fallback tool:**
```ts
bughunt_tail({
  project: z.string().min(1),
  runId: z.string().min(1),
  sinceClusterId: z.string().min(1).optional()
    .describe('Return clusters appended after this id; if omitted, returns clusters appended in last 5s'),
}): {
  clusters: Array<ClustersOutput['clusters'][number]>,
  runDone: boolean,           // true if run reached phase=done since last poll
  asOfClusterId?: string,     // latest clusterId at time of read; pass to next call as sinceClusterId
}
```

**Implementation note:** Tail reads `bugs.jsonl` from offset; tracks file position per subscriber. Run-done detected via `state.json.phase`.

**Error cases:**
- `not_found` if run doesn't exist.
- `gone` if run already completed (call `bughunt_clusters` instead).

### 4.2 `bughunter://progress/<runId>`

**Subscription semantics:** emits one event per phase transition (`validate→discover→plan→execute→classify→cluster→emit→done`) plus per-phase counter updates (testsPlanned, testsRan, clustersFound). Backed by polling `state.json` every 2s server-side and emitting on change.

**Polling fallback tool:**
```ts
bughunt_progress({
  project: z.string().min(1),
  runId: z.string().min(1),
}): {
  phase: RunPhase,
  startedAt: string,
  testsPlanned: number,
  testsRan: number,
  clusterCount: number,
  consecutiveInfraFailures: number,
  done: boolean,                      // true iff phase === 'done'
}
```

**Error cases:**
- `not_found` if run doesn't exist.

### 4.3 Streaming auth + multiplexing

- Resource subscriptions inherit the connection's API key (auth check happens at SSE-establish time).
- One subscriber per (apiKey, runId) tuple; duplicate subscribes are idempotent (return the same SSE stream).
- Server-side resource fanout uses one filesystem watcher per (project, runId), shared across subscribers.

### 4.4 Polling-fallback contract

For both resources, the polling tool is the canonical fallback. Documented in tool description. Clients that don't speak `resources/subscribe` SHOULD poll the fallback every ~2s; over-polling is rate-limited at 10 calls/sec/runId/apiKey, returning `rate_limited` after.

---

## 5. Auth

Currently the MCP HTTP server accepts unauthenticated POST `/mcp` requests (server.ts:14). For multi-tenant deployment (`SPEC_PATH_TO_EXHAUSTIVE.md` §5 says "per-client API key (current pattern)" — that's aspirational, not actual). V30 establishes the pattern.

### 5.1 Middleware

Add Express middleware **before** the `/mcp` route registration (server.ts:14):

```ts
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) {
    res.status(401).json({ error: 'unauthenticated', message: 'Missing Bearer token' });
    return;
  }
  const token = match[1];
  // V30: trust any non-empty token; project scoping happens per-tool via args.project.
  // V31 (deferred) will associate tokens with project-scope ACLs.
  if (token.length < 16) {
    res.status(401).json({ error: 'invalid_token', message: 'Token too short' });
    return;
  }
  (req as Request & { apiKey: string }).apiKey = token;
  next();
}
app.post('/mcp', requireApiKey, async (req, res) => { ... });
```

### 5.2 Health endpoint

`/health` (server.ts:31) stays unauthenticated. It's used by load balancers and reveals nothing project-specific.

### 5.3 Why opaque tokens, not JWT, in V30

- Simpler. JWT requires a signing key + rotation. V30 doesn't need claims.
- V31 will introduce per-token project scope; can replace at that boundary without breaking existing clients (token format stays opaque).
- Aligns with the existing Paperclip-MCP pattern (`pcp_board_THEIR_KEY`) which is also opaque.

### 5.4 Configuration

Token is provided client-side; server-side has no shared secret. **Any non-empty bearer ≥16 chars is accepted in V30.** That's intentional — the server is bound to `127.0.0.1` (server.ts:40), not exposed publicly. Public deployment is an explicit V31 sub-task with hashed-token allowlist.

---

## 6. Edge cases

### EC-1. `runId` not found
Every tool that takes `runId` checks `runPaths(project, runId).runDir` exists. Returns `not_found` with message `run <id> not found in project <project>`. Lists available run ids in the message body (capped at 5).

### EC-2. Project directory not a BugHunter project
`args.project` validates: directory exists, is readable, contains a `.bughunter/` child. Otherwise `invalid_argument` with message `not a bughunter project: <path>`.

### EC-3. `bugs.jsonl` is partially-written (run in progress)
Reader skips malformed JSON lines silently for `bughunt_clusters` and `bughunt_tail`. For `bughunt_cluster_detail` (which expects exact match), partial last-line means the cluster may not be retrievable yet — return `not_found` with message `cluster <id> not yet emitted (run still in execute phase)`.

### EC-4. Large response truncation
- `bughunt_cluster_detail` response > 4MB → returns the cluster *without* full-artifact occurrence inlining (occurrences become `OccurrenceSummary` shape; client fetches via `bughunt_occurrence` + `bughunt_artifact`). Caller-visible: a warning string is added at the top level: `truncated: true, originalOccurrenceCount: N`.
- `bughunt_artifact` > 4MB → `payload_too_large`. See §6.4 below.
- `bughunt_clusters` paginated; `limit` capped at 200 enforced server-side.

### EC-5. Streaming during a non-active run
If subscriber connects to `bughunter://tail/<runId>` for a run already in `phase: 'done'`, server emits no events and immediately closes the stream with a final notification `{ runDone: true, reason: 'already_completed' }`. Tool fallback (`bughunt_tail`) returns `runDone: true, clusters: []`.

### EC-6. Missing history.db (V27 not yet implemented)
`bughunt_diff`, `bughunt_history` use a feature-detect helper:

```ts
async function v27Available(): Promise<boolean> {
  try { await import('bughunter/src/history/diff.js'); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND' ? true : false; }
}
```

When unavailable, return `not_implemented` with message `tool <name> requires V27 (history.db). Land V27 first.` Same pattern for V26 (`detectors`) and V28 (`explanations cache`).

### EC-7. Missing `DETECTOR_REGISTRY` (V26 not yet)
`bughunt_detectors` returns `not_implemented` with a structured fallback: `{ availableViaCli: false, suggestion: 'Run `bughunter detectors` after V26 lands.' }`.

### EC-8. Suspicious `project` paths (path traversal)
Reject `project` containing `..` or symlinks pointing outside the resolved real path. Use `fs.realpathSync` and verify the resolved path doesn't contain `..` segments.

### EC-9. `bughunt_clusters` cursor pointing to a different run
Cursor encodes `{ offset: number, runId: string }`. If `args.runId !== cursor.runId`, return `invalid_argument` with `cursor scoped to a different run`.

### EC-10. Concurrent run during `bughunt_clusters` pagination
Between page 1 (offset 0) and page 2 (offset 50), the run may emit 10 more clusters. Pagination is by offset on the file as it exists at first read; subsequent pages may include or skip new clusters. Documented; the tool description says "snapshot at first call." Clients that need consistency call `bughunt_clusters({ limit: 200 })` and paginate client-side.

### EC-11. Occurrence on disk but artifacts pruned
If `bughunt_occurrence` returns `OccurrenceFull` but the underlying artifact files have been pruned (`bughunter prune` ran), `bughunt_artifact` returns `not_found` with message `artifact pruned`. The occurrence record stays as historical metadata; the artifact path is stale.

### EC-12. SARIF format in `bughunt_diff` when V27 doesn't support SARIF yet
If V27 lands but only supports JSON diff, `format: 'sarif'` returns `not_implemented` with message `SARIF output deferred to V27 phase 2`. Don't synthesize SARIF in MCP; that's V27's responsibility.

### EC-13. `bughunt_explain` cache key mismatch
V28's cache keys on `(clusterId, contentHash(suspectedFiles))`. If the suspected file changed between cache write and read, V28 invalidates and regenerates. MCP does NOT cache its own copy — sole source of truth is V28's cache.

### EC-14. Resource subscription disconnects
If the SSE connection drops, the server-side watcher for that subscriber is cleaned up. Reconnecting clients re-subscribe and will miss any events emitted during the gap. Documented; clients that need at-most-once-with-replay should poll instead.

### EC-15. Multiple consumers tail the same run
Server-side fanout: one filesystem watcher per (project, runId), shared across all subscribers. No per-subscriber state on the file (offsets are tracked in-memory per subscriber via the SSE handler closure).

### EC-16. `bughunt_run_summary` for an in-progress run
`summary.json` only exists post-emit. For in-progress runs, return `not_found` with `run still in progress; phase=<phase>; call bughunt_progress for live state`.

### EC-17. `bughunt_artifact` for `OccurrenceSummary`
`OccurrenceSummary.fullArtifacts === false`. Tool returns `not_found` with `occurrence has summary-only retention; full artifacts not retained`. The retention rationale (cluster size cap, disk budget) is included in the error message when computable from `RunSummary`.

### EC-18. Different run formats across MCP versions
The MCP server reads files written by the CLI. If the CLI writes a future format (e.g. V31 adds new fields to `BugCluster`), MCP must pass through unknown fields without stripping. Use `JSON.parse` + return as-is; do NOT validate with a Zod schema on the read path. Validation is on the input side only.

---

## 7. Pagination — cursor encoding

Cursors are **opaque base64-encoded JSON** with the shape:

```ts
type Cursor = {
  offset: number;        // 0-indexed cluster index after filters
  runId: string;         // scopes the cursor to one run
  filterHash: string;    // sha256 of the filter args, hex-truncated to 16
};
```

Encoded as `Buffer.from(JSON.stringify(cursor)).toString('base64url')`.

**Filter-hash rationale:** if the caller changes `kind: 'foo' → 'bar'` between pages, the cursor would point to the wrong offset. We reject mismatched-filter cursors with `invalid_argument` (not silent reset — silent reset hides bugs in callers). The `filterHash` is a sha256 of `JSON.stringify({ kind, role, routePattern, verdict, severity, minClusterSize })` with stable key ordering.

**Why not opaque server-side state?** Server has no session; the MCP transport is request-scoped (server.ts:14-18 creates a new `McpServer` per request). Stateless cursors are required.

**Why not last-cluster-id-pointer?** Clusters are appended; an offset-based cursor is correct against an append-only file. ID-pointer cursors require a unique-ordered field (clusterId is unique but not ordered chronologically without scanning).

---

## 8. Types — single source of truth

V30 introduces ZERO new types. Every input / output type already exists in `packages/cli/src/types.ts`:

| MCP output field | Source type | Source line |
|---|---|---|
| Cluster summary | `BugCluster` (subset) | types.ts:197 |
| Cluster detail | `BugCluster` | types.ts:197 |
| Occurrence | `OccurrenceFull \| OccurrenceSummary` | types.ts:156, 173 |
| Run summary | `RunSummary` | types.ts:1104 |
| Run phase | `RunPhase` | types.ts:767 |
| Verdict | `ClusterVerdict` | types.ts:220 |
| Config | `BugHunterConfig` | types.ts:955 |

V26 introduces `DetectorMetadata` (with `severity`); V29 may expand it. MCP imports the type; doesn't redefine it.

**Do NOT** copy the local `BugCluster` shorthand from `tools.ts:10-17` into new files. Import the canonical type:
```ts
import type { BugCluster, RunSummary, OccurrenceFull, OccurrenceSummary, RunPhase, ClusterVerdict, BugHunterConfig } from 'bughunter/src/types.js';
```

The existing `tools.ts:10-17` short type definition was a pre-workspace-deps shim; we MUST replace it as part of the V30 PR. Existing 4 tools need to compile against the canonical types.

---

## 9. Negative requirements

- Do **not** introduce write-side tools. (V31's job.)
- Do **not** add a database connection pool. Reads are per-request.
- Do **not** load an entire run's `bugs.jsonl` into a single `JSON.parse`. Use line-by-line readline streams.
- Do **not** silently truncate; always return a discriminator (`truncated: true` or `payload_too_large`).
- Do **not** synthesize SARIF in MCP. Pass through V27's output.
- Do **not** cache responses at the MCP layer (except `bughunt_explain`'s thin pass-through to V28's cache). The CLI owns caches.
- Do **not** add new dependencies to `packages/mcp/package.json` except: `glob` for routePattern matching (~5KB) — only if Node's built-in `path.matchesGlob` (Node 22+) is unavailable. Default: use the Node built-in.
- Do **not** expose internal IDs that aren't already in the CLI types. No new `mcpRequestId`, no internal trace ids.
- Do **not** swallow errors. Every catch transforms-and-returns `toolErr(code, message)`; never `catch {}`.
- Do **not** allow tools to call into the CLI's `runCommand`/`replayCommand`. Read-side ONLY reads files + (for V26-V28) calls pure exported functions.
- Do **not** introduce per-tool middleware. Auth runs once at the Express layer.

---

## 10. Files to touch / add

### 10.1 Modified

| File | Change |
|---|---|
| `packages/mcp/src/server.ts` | Add `requireApiKey` middleware (§5). Pass `req.apiKey` to MCP server context. ~25 lines added. |
| `packages/mcp/src/tools.ts` | (a) Replace local `BugCluster` shorthand (l.10-17) with canonical import. (b) Use `runPaths()` from `packages/cli/src/store/filesystem.js` instead of locally-defined `bugsFilePath`. (c) Append `register*` calls for the 12 new tool families + 2 streaming resources. ~30 lines net change before splits. |

### 10.2 New (one file per tool family for cleanliness)

| File | Tool(s) | Approx lines |
|---|---|---|
| `packages/mcp/src/tools/clusters.ts` | `bughunt_clusters` | 90 |
| `packages/mcp/src/tools/cluster-detail.ts` | `bughunt_cluster_detail` | 60 |
| `packages/mcp/src/tools/occurrence.ts` | `bughunt_occurrence` | 60 |
| `packages/mcp/src/tools/artifact.ts` | `bughunt_artifact` | 90 |
| `packages/mcp/src/tools/runs.ts` | `bughunt_runs_list`, `bughunt_run_summary` | 110 |
| `packages/mcp/src/tools/detectors.ts` | `bughunt_detectors` | 80 |
| `packages/mcp/src/tools/diff.ts` | `bughunt_diff` | 70 |
| `packages/mcp/src/tools/history.ts` | `bughunt_history` | 70 |
| `packages/mcp/src/tools/explain.ts` | `bughunt_explain` | 70 |
| `packages/mcp/src/tools/project.ts` | `bughunt_project_describe` | 110 |
| `packages/mcp/src/tools/config.ts` | `bughunt_config_get` | 60 |
| `packages/mcp/src/tools/tail.ts` | `bughunt_tail` (poll fallback) + `bughunter://tail/<runId>` resource | 130 |
| `packages/mcp/src/tools/progress.ts` | `bughunt_progress` (poll fallback) + `bughunter://progress/<runId>` resource | 100 |
| `packages/mcp/src/auth.ts` | `requireApiKey` middleware + token-shape helpers | 40 |
| `packages/mcp/src/cursor.ts` | Cursor encode / decode / verify | 60 |
| `packages/mcp/src/io/runs.ts` | Shared filesystem-read helpers (read summary.json, scan bugs.jsonl, resolve project) — single source of truth for run resolution | 120 |
| `packages/mcp/src/feature-detect.ts` | V26/V27/V28 dynamic-import probes; module-level memoized | 50 |

Each tool file follows this template (copy literally):

```ts
// packages/mcp/src/tools/clusters.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveProject, listClustersFiltered } from '../io/runs.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import { toolOk, toolErr, type ToolOk, type ToolErr } from '../envelope.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).optional(),
  // ... full schema from §3.1
});

export function registerClustersTool(server: McpServer): void {
  server.tool(
    'bughunt_clusters',
    'List bug clusters from a run with filtering and cursor-paginated results. ...', // verbatim §3.1 description
    InputSchema.shape,
    async (args): Promise<ToolOk | ToolErr> => {
      try {
        const { projectDir, runId } = await resolveProject(args.project, args.runId);
        const cursor = args.cursor ? decodeCursor(args.cursor) : undefined;
        if (cursor && cursor.runId !== runId) {
          return toolErr('invalid_argument', 'cursor scoped to a different run');
        }
        const result = await listClustersFiltered({ projectDir, runId, ...args, cursorOffset: cursor?.offset ?? 0 });
        return toolOk({
          clusters: result.clusters,
          nextCursor: result.hasMore ? encodeCursor({ offset: result.nextOffset, runId, filterHash: result.filterHash }) : undefined,
        });
      } catch (e) {
        if (isNotFound(e)) return toolErr('not_found', String(e));
        return toolErr('error', String(e));
      }
    },
  );
}
```

The `envelope.ts` helper (extracted from current `tools.ts:29-35`) keeps `toolOk` / `toolErr` shared. Existing `tools.ts` re-imports them after the extraction.

### 10.3 Tests (one per tool file)

| Test file | Coverage |
|---|---|
| `packages/mcp/src/tools/clusters.test.ts` | Filter combinations, cursor pagination round-trip, severity-not-implemented branch |
| `packages/mcp/src/tools/cluster-detail.test.ts` | Truncation > 4MB, occurrence summarization fallback |
| `packages/mcp/src/tools/occurrence.test.ts` | Full vs summary discriminator |
| `packages/mcp/src/tools/artifact.test.ts` | Each kind round-trips bytes; `payload_too_large` on > 4MB |
| `packages/mcp/src/tools/runs.test.ts` | Cross-run list ordering; `since` filter; missing summary.json |
| `packages/mcp/src/tools/detectors.test.ts` | V26-not-landed → `not_implemented` |
| `packages/mcp/src/tools/diff.test.ts` | V27-not-landed → `not_implemented` |
| `packages/mcp/src/tools/history.test.ts` | V27-not-landed → `not_implemented` |
| `packages/mcp/src/tools/explain.test.ts` | V28-not-landed → `not_implemented`; `noCache` flag honored |
| `packages/mcp/src/tools/project.test.ts` | Each check status (ok/warn/error) |
| `packages/mcp/src/tools/config.test.ts` | Raw vs resolved |
| `packages/mcp/src/tools/tail.test.ts` | Append during read; run-done detection |
| `packages/mcp/src/tools/progress.test.ts` | Phase progression observed |
| `packages/mcp/src/auth.test.ts` | Missing header, malformed header, short token |
| `packages/mcp/src/cursor.test.ts` | Round-trip; tampered cursor rejected |

### 10.4 Fixtures

`packages/mcp/test-fixtures/sample-run/` — a minimal `.bughunter/runs/<runId>/` tree with: `state.json`, `bugs.jsonl` (10 clusters, mixed kinds), `summary.json`, 1 occurrence with full artifacts (small PNG), 1 occurrence with summary-only. Used by every read-test.

---

## 11. Task breakdown

Each task is independently completable, ~30 min human-equivalent, max 3 files modified.

| # | Task | Assignee | Files (modified \| created) | Depends on | Test command | Done when |
|---|---|---|---|---|---|---|
| 1 | Extract `toolOk` / `toolErr` to `envelope.ts` | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/envelope.ts` | none | `npm test -- envelope` | tools.ts re-imports; existing 4 tools still pass |
| 2 | Replace local `BugCluster` shim with canonical type import; replace local `bugsFilePath` with `runPaths()` | @coder | `packages/mcp/src/tools.ts` \| (none) | 1 | `npm test --workspaces` + `npx tsc --noEmit` | No local types; `bughunt_latest_bugs` still byte-compatible |
| 3 | Add `requireApiKey` middleware + auth tests | @coder | `packages/mcp/src/server.ts` \| `packages/mcp/src/auth.ts`, `packages/mcp/src/auth.test.ts` | 1 | `npm test -- auth` | Missing token → 401; valid token → request reaches MCP layer |
| 4 | Cursor encode/decode + tests | @coder | (none) \| `packages/mcp/src/cursor.ts`, `packages/mcp/src/cursor.test.ts` | 1 | `npm test -- cursor` | Round-trips; tampered cursor rejected |
| 5 | Shared run/project resolution helpers | @coder | (none) \| `packages/mcp/src/io/runs.ts` | 1, 2 | `npm test -- runs.ts` | `resolveProject` + `listClustersFiltered` covered |
| 6 | Feature-detect helper for V26/V27/V28 | @coder | (none) \| `packages/mcp/src/feature-detect.ts` | 1 | `npm test -- feature-detect` | Returns false on `ERR_MODULE_NOT_FOUND`; memoized |
| 7 | `bughunt_clusters` tool + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/clusters.ts`, `packages/mcp/src/tools/clusters.test.ts` | 4, 5 | `npm test -- clusters` | All filters; pagination round-trip; severity → `not_implemented` if V29 absent |
| 8 | `bughunt_cluster_detail` tool + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/cluster-detail.ts`, `cluster-detail.test.ts` | 5 | `npm test -- cluster-detail` | Truncation behavior verified |
| 9 | `bughunt_occurrence` tool + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/occurrence.ts`, `occurrence.test.ts` | 5 | `npm test -- occurrence` | Full vs summary both fetch |
| 10 | `bughunt_artifact` tool + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/artifact.ts`, `artifact.test.ts` | 5 | `npm test -- artifact` | Each `kind`; > 4MB → `payload_too_large` |
| 11 | `bughunt_runs_list` + `bughunt_run_summary` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/runs.ts`, `runs.test.ts` | 5 | `npm test -- runs` | List ordering; missing summary handled |
| 12 | `bughunt_detectors` + tests (with V26 stub) | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/detectors.ts`, `detectors.test.ts` | 6 | `npm test -- detectors` | V26-absent → `not_implemented`; V26-present → list |
| 13 | `bughunt_diff` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/diff.ts`, `diff.test.ts` | 6 | `npm test -- diff` | V27-absent → `not_implemented`; SARIF passthrough |
| 14 | `bughunt_history` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/history.ts`, `history.test.ts` | 6 | `npm test -- history` | Mutex `kind`/`bugIdentity`; V27-absent path |
| 15 | `bughunt_explain` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/explain.ts`, `explain.test.ts` | 6 | `npm test -- explain` | V28-absent → `not_implemented`; `noCache` flag |
| 16 | `bughunt_project_describe` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/project.ts`, `project.test.ts` | 5 | `npm test -- project` | Each check produces correct status |
| 17 | `bughunt_config_get` + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/config.ts`, `config.test.ts` | 5 | `npm test -- config` | Raw vs resolved differ; missing → `not_found` |
| 18 | `bughunt_tail` poll-fallback tool + filesystem watcher + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/tail.ts`, `tail.test.ts` | 5 | `npm test -- tail` | Append during read returns new clusters; rate-limit at 10 calls/sec |
| 19 | `bughunter://tail/<runId>` MCP resource subscription | @coder | `packages/mcp/src/tools.ts` \| (extends tools/tail.ts) | 18 | `npm test -- tail-resource` | Subscriber receives notification on append |
| 20 | `bughunt_progress` poll-fallback tool + tests | @coder | `packages/mcp/src/tools.ts` \| `packages/mcp/src/tools/progress.ts`, `progress.test.ts` | 5 | `npm test -- progress` | Phase progression observed |
| 21 | `bughunter://progress/<runId>` MCP resource subscription | @coder | `packages/mcp/src/tools.ts` \| (extends tools/progress.ts) | 20 | `npm test -- progress-resource` | Phase change emits notification |
| 22 | Test fixtures: `packages/mcp/test-fixtures/sample-run/` | @coder | (none) \| fixture tree | none | (used by 7-21) | Shared by all tests |
| 23 | Integration test: end-to-end MCP client driving §1 acceptance scenario | @qa | `packages/mcp/test/e2e.test.ts` | 7-21 | `npm test -- e2e` | All 7 steps succeed |
| 24 | Update `packages/mcp/package.json` deps if needed | @architect (review) | `packages/mcp/package.json` | 7 | (n/a) | Net-zero new deps unless Node `path.matchesGlob` unavailable |

Total: 24 tasks. Each independently shippable behind a feature gate (the new tools are additive; existing 4 tools work without any new tool wired). PR can land in stages.

---

## 12. Acceptance criteria

Concrete, testable.

| Criterion | Verifier |
|---|---|
| All new MCP tool unit tests pass | `npm test --workspace bughunter-mcp` (every test file in §10.3) |
| `npx tsc --noEmit` clean | Across `packages/mcp` and `packages/cli` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Existing 4 tools (`bughunt_run`, `bughunt_status`, `bughunt_latest_bugs`, `bughunt_replay`) byte-compatible | E2E integration test invokes each with the V0.21 contract |
| §1 acceptance scenario passes end-to-end | `e2e.test.ts` task 23 |
| Auth: missing Bearer → 401; short token → 401; valid token → 2xx | `auth.test.ts` |
| Cursor pagination: 100 clusters → 5 pages of 20, no duplicates, no skips | `clusters.test.ts` |
| `bughunt_artifact`: 5MB PNG → `payload_too_large` with path; 100KB PNG → base64 round-trip | `artifact.test.ts` |
| `bughunt_tail`: subscribe, write 5 clusters, observe 5 notifications + run-done | `tail.test.ts` |
| `bughunt_progress`: subscribe, walk phases, observe one notification per phase change | `progress.test.ts` |
| Feature-detect: V27-absent → `bughunt_diff` returns `not_implemented` (not 500) | `diff.test.ts` |
| `bughunt_runs_list` returns runs sorted DESC by `startedAt` | `runs.test.ts` |
| `bughunt_run_summary` for in-progress run returns `not_found` with phase detail | `runs.test.ts` |

---

## 13. Risks + escape hatches

- **Risk:** MCP `StreamableHTTPServerTransport` doesn't support resource subscriptions in the SDK version pinned in `package.json` (`@modelcontextprotocol/sdk@1.29.0`). **Mitigation:** ship the polling-fallback tools (`bughunt_tail`, `bughunt_progress`) first; resource subscription is task 19/21, deferable behind a flag. Verify SDK capability in task 0 (pre-spec verification).

- **Risk:** Multi-tenant project resolution leaks paths. **Mitigation:** every tool requires `args.project`; server is `127.0.0.1`-bound (server.ts:40). V31 adds per-token allowlist for public deployments.

- **Risk:** Filesystem watcher count grows unbounded under many subscribers. **Mitigation:** one watcher per (project, runId), shared. Cap at 100 active subscriptions per server process; reject with `resource_exhausted` after.

- **Risk:** V26/V27/V28 ship with different export names than projected here. **Mitigation:** feature-detect by trying `.import()`; spec the **expected** export names but make the detect helper robust to renames (try multiple paths).

- **Risk:** `bugs.jsonl` line-by-line scan is slow for runs with 10K clusters. **Mitigation:** cap is `--max-bugs 200` by default in the CLI; 200 lines scans in <5ms. For pathological cases, document; V31 may add an SQLite index.

- **Escape hatch:** if `requireApiKey` breaks any existing client, set `BUGHUNTER_MCP_REQUIRE_AUTH=0` to bypass (V30-only escape; removed in V31). Default is auth-on.

---

## 14. Done-when

- All 24 tasks complete and PR'd.
- §12 acceptance criteria all green.
- `packages/mcp/README.md` updated with the new tool list (one-line description each) — this is the only doc change required.
- `tools.ts` no longer contains the local `BugCluster` shim or the local `bugsFilePath` helper (replaced by canonical imports).
- An MCP client (Claude Code's `claude mcp add bughunter ...`) can invoke every new tool against a real BugHunter run on `Aspectv3` and receive structured responses.
- No existing CLI behavior changed.

---

## 15. Open questions

1. **Cursor encoding: base64-JSON vs HMAC-signed?** V30 uses unsigned base64-JSON with `filterHash` for tamper-detection. HMAC adds a server secret. Given `127.0.0.1` deployment and `filterHash` invariant, unsigned is safe. **Defer signing to V31** if public deployment lands.

2. **Inline base64 artifacts vs signed-URL fetch?** V30 inlines (under 4MB cap). Signed URLs require a separate static-file server, port allocation, URL signing key, and an additional auth boundary — too much surface for V0.30. **Defer to V31** when the multi-tenant story matures. Document in `bughunt_artifact` description that 4MB is the cap.

3. **Should `bughunt_tail` use Node's `fs.watch` or polling?** `fs.watch` is faster but unreliable on some filesystems (Docker volume-mounts, NFS). **Default to polling at 1s interval; allow `BUGHUNTER_MCP_TAIL_USE_WATCH=1` to opt-in to watch.** Polling is correct everywhere; watch is an optimization.

4. **`bughunt_runs_list` without `project` — require V27, or fall back to scanning a default registry?** Spec says "requires V27." A pre-V27 fallback would be `~/.bughunter/projects.json` (mentioned as future work in §7.3 of the strategic spec) but that doesn't exist yet. **Decision: require V27 for cross-project; require `project` until then.** Document.

5. **Should `bughunt_explain` stream the LLM tokens (server-sent) instead of returning the whole markdown?** Streaming improves UX but doubles the implementation cost. V28's CLI explain returns a full string; mirror that. **Defer streaming explain to V31** (when V28 itself supports streaming).

6. **`bughunt_artifact` for `action-log` — should this return parsed steps or raw JSONL?** Raw JSONL keeps MCP simple; parsing is V31's `bughunt_action_log_steps` (write-side dependency). **V30: raw JSONL text.** Caller parses.

7. **Auth: should the API key be tied to a project at the token level (token X can only see project Y)?** V30: no, every authenticated request can supply any `project`. V31 introduces per-token scope. Document the deferral so deployers don't expose pre-scope MCP publicly.

8. **Hardest design call: how strict to be about `payload_too_large`?** A 5MB cluster with 50 occurrences inlining all artifact paths is rare but possible. The choice is: (a) hard-cap with `payload_too_large`, forcing the client to re-fetch via per-occurrence calls (chatty but predictable); (b) silent `OccurrenceSummary`-fallback truncation (smooth but invisible). **Decision: hybrid (a)+(b)** — `bughunt_cluster_detail` truncates via `OccurrenceSummary` fallback with `truncated: true` flag (loud but smooth); `bughunt_artifact` hard-fails with `payload_too_large` (artifacts are atomic — partial bytes are useless). Documented in §6.4 (EC-4).
