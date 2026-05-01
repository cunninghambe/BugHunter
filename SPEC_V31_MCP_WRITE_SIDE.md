# SPEC — v0.31 "MCP write-side + auto-fix coordination"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-04-30
**Depends on:** V27 (bugIdentity + history.db), V28 (suppressions.json + suppressions-audit.log + triage.jsonl), V30 (read-side MCP tools — shares `packages/mcp/src/server.ts` and tool-registration pattern).
**Sibling specs (parallel):** V27, V28, V29, V30.
**Source motivation:** `SPEC_PATH_TO_EXHAUSTIVE.md` §5.2 (write-side tools), §5.4 (auto-fix coordination), §5.5 (project context — `bughunt_config_set`).

---

## 1. Objective

The current MCP HTTP server (`packages/mcp/src/server.ts`, `packages/mcp/src/tools.ts`) exposes four read-skewed tools: `bughunt_run`, `bughunt_status`, `bughunt_latest_bugs`, `bughunt_replay`. V30 (sibling) adds ~12 read-side tools. **V31 adds 12 write-side tools** so that non-Claude agents (Hermes, custom orchestrators, CI scripts) can drive the full BugHunter loop — triage, suppress, dispatch a fix subprocess, gate the fix branch, retest, snapshot a baseline — without dropping to the CLI.

After V31, an MCP client runs end-to-end (`bughunt_run` → `_status` → `_clusters` (V30) → `_triage` → `_suppress` (FPs) → `_fix_dispatch` → `_fix_status` → `_fix_gate` → `_fix_retest` → `_baseline_save`) without ever invoking `bughunter <cmd>`.

**In scope:**
- 12 new MCP tools across 6 new files in `packages/mcp/src/tools/`.
- Subprocess management for `bughunt_fix_dispatch` (track, capture, kill-on-disconnect, lifetime cap).
- File-write concurrency: atomic-rename for JSON, `O_APPEND` for JSONL, mkdir-lock for read-modify-write.
- Action-log minimization via delta-debugging (`ddmin`).
- Baseline save/compare (visual + perf), wrapping V13 vision baseline + V06 perf-budget infra.

**Out of scope (deferred):** notification webhooks (V32); Linear/Jira sync MCP wrappers (V29 CLI export covers — MCP shim is V32 follow-up); streaming / live-tail (`bughunt_tail`, `bughunt_progress` — V30 owns); multi-user write-token tiering (v0.7, see §13.1); triage TUI (CLI workstream); severity calibration (`bughunt_severity_set` — defer with V27 `DetectorMetadata`); `bughunt_explain` (V30); `bughunt_fix_cancel` (V32 — covered by `maxRuntimeMs` fuse + transport disconnect for now).

**Acceptance target:**
A single MCP client (Hermes, headless `mcp-cli`, custom Python `httpx` client) drives a fix loop on the bundled `fixtures/bughunter-self-deliberate-bugs/` fixture, end-to-end, producing the same `fix-state.json` verdict tally as the CLI flow. Zero CLI invocations during the loop.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/mcp/src/server.ts:14-29` | Express + StreamableHTTP transport. Per-request `new McpServer()` — module-level state must be hoisted. |
| `packages/mcp/src/tools.ts:19,26-35,64-75` | `server.tool(name, desc, zodShape, handler)` pattern; `toolOk`/`toolErr` helpers; `jobs: Map` hoist pattern (mirror for `fixJobs`). |
| `packages/cli/src/ops/forbidden-paths.ts:9-47` | `forbiddenPathGate(projectDir, branch, baseBranch, doReset): ForbiddenPathGateResult`. Reuse as-is. |
| `packages/cli/src/ops/retest.ts:33-40, 304-321` | `retestOp(...) → Promise<RetestResult>`. `RetestResult` is the canonical fix-retest return shape — export unchanged. |
| `packages/cli/src/cli/fix-summary.ts:7-23, 25-82` | Currently print-only. **V31 must extract** `tally + readFixState → FixSummary` into a pure function for JSON return; print path keeps using it. |
| `packages/cli/src/repro/replay.ts:10-19, 44-50` | `replayActionLog(...) → Promise<ReplayResult>`. Minimizer drives this in a loop. |
| `packages/cli/src/repro/action-log.ts:1-50` | `ActionLog` type, `readActionLog`, `writeActionLog`. Minimizer reads + writes. |
| `packages/cli/src/config.ts:58-200` | `ConfigSchema` (Zod), `loadConfig`, `saveConfig`. `_config_set` re-validates whole config after dot-path patch. |
| `packages/cli/src/store/filesystem.ts:6-95` | `runPaths`, `appendJsonl`, `writeJsonFile`, `readJsonFile`, `fileExists`, `listRunIds`. **Reuse — do NOT inline `fs.writeFileSync`.** |
| `packages/cli/src/adapters/vision-claude-cli.ts:32-90` | Reference for `spawn(claude --print …)`: stdio piping, timeout, JSON-on-stdout. Dispatch follows this skeleton but does NOT block on stdout — streams to log file. |
| `packages/cli/src/types.ts:497-520` | `TestResult` — referenced by `bughunt_replay_minimized` return. |

### 2.2 Sibling artifact paths (all under `<projectDir>/.bughunter/`)

V28 owns: `suppressions.json`, `suppressions-audit.log`, `triage.jsonl`. V27 owns: `history.db` (SQLite). Existing: `runs/<runId>/fix-state.json`. **NEW in V31:** `runs/<runId>/fix-jobs/<jobId>.{log,meta.json}`, `baselines/visual/<runId>/`, `baselines/perf/<runId>/`, `baselines/<kind>/current` (symlink).

**V27/V28 are parallel specs.** If V31 lands first, suppress/triage tools must `safeParse` defensively — empty-list-on-missing-file, never crash. See §10 EC-S1.

### 2.3 Patterns to follow

- **Tool registration:** mirror `registerTools(server)` in `tools.ts`. Each new file exports `register{Group}Tools(server, deps)`; `server.ts` calls each in turn.
- **Module-level state:** `jobs: Map` (tools.ts:19) is hoisted outside `createApp` because per-request `McpServer` instances must share state. Same rule for `fixJobs: Map`.
- **Return envelope:** `toolOk(data)` / `toolErr(code, message)` only (tools.ts:29-35). All tools return JSON in `content[0].text`.
- **Zod input:** declare as `z.object({...}).shape` for the SDK's `tool()` second arg (matches tools.ts:68-74, 122-128).
- **Error codes:** reuse V30's `ErrorCode` enum from `packages/mcp/src/tools/errors.ts` — `not_found`, `invalid_input`, `conflict`, `forbidden`, `concurrent_write`, `subprocess_failed`, `timeout`, `error`, `cannot_repro`.
- **No Express state:** never write to `app.locals`. State lives module-level in tool files.
- **Filesystem I/O:** use `store/filesystem.ts` helpers; never inline `fs.writeFileSync` directly.

### 2.4 DO NOT

- Mutate V27/V28 schemas — coordinate via @architect.
- Write a parallel Zod validator for `BugHunterConfig` — use `ConfigSchema` from `packages/cli/src/config.ts`.
- Spawn the fix-dispatch subprocess inline; spawn detached, return jobId immediately.
- Keep subprocess stdout/stderr in memory — stream to a log file (subprocess may run tens of minutes).
- Call `child.kill()` without SIGTERM-then-SIGKILL-after-5s grace.
- Swallow `ZodError` in `bughunt_config_set` — surface in `errors` field.
- Define new error envelope shapes — use `toolErr(code, message)`.
- Add `proper-lockfile` or any new runtime dep without architect sign-off. mkdir-lock (§7.2) is sufficient.
- Import types from V30 if V30 hasn't landed; copy `RetestResult` / `BugCluster` via direct workspace import from `bughunter/src/types.js` (same idiom as `tools.ts:61`).

---

## 3. Tool surface — overview

| # | Tool | File | Mutates | CLI parity |
|---|---|---|---|---|
| 1 | `bughunt_suppress` | `tools/suppress.ts` | `suppressions.json`, `suppressions-audit.log` | `bughunter suppress` (V28) |
| 2 | `bughunt_unsuppress` | `tools/suppress.ts` | `suppressions.json`, `suppressions-audit.log` | `bughunter unsuppress` (V28) |
| 3 | `bughunt_triage` | `tools/triage.ts` | `triage.jsonl`, `history.db` | `bughunter triage` (V28) |
| 4 | `bughunt_fix_dispatch` | `tools/fix-coord.ts` | `fix-jobs/<jobId>.{log,meta.json}`, git branch | new (no CLI parity yet — exposed first via MCP) |
| 5 | `bughunt_fix_status` | `tools/fix-coord.ts` | none (read-only over `fix-state.json` + `fix-jobs/`) | `bughunter fix-summary` |
| 6 | `bughunt_fix_gate` | `tools/fix-coord.ts` | git branch ref (when `reset=true`) | `bughunter forbidden-path-gate` |
| 7 | `bughunt_fix_retest` | `tools/fix-coord.ts` | none (replays in dev server) | `bughunter retest` |
| 8 | `bughunt_config_set` | `tools/config.ts` | `.bughunter/config.json` | (no CLI parity — `bughunter init` is one-shot) |
| 9 | `bughunt_minimize` | `tools/minimize.ts` | `action-logs/<occurrenceId>.minimized.json` | `bughunter minimize` (deferred CLI per §4.6 of exhaustive spec) |
| 10 | `bughunt_replay_minimized` | `tools/minimize.ts` | none (executes minimized log) | none |
| 11 | `bughunt_baseline_save` | `tools/baseline.ts` | `baselines/{visual,perf}/<runId>/` | (no CLI parity yet) |
| 12 | `bughunt_baseline_compare` | `tools/baseline.ts` | none | (no CLI parity yet) |

**Wiring:** `server.ts:16` currently calls `registerTools(server)`. After V31 (and V30), the per-request handler also calls `registerSuppressTools`, `registerTriageTools`, `registerFixCoordTools`, `registerConfigTools`, `registerMinimizeTools`, `registerBaselineTools` (plus V30's `registerReadTools`). Each lives in its own `tools/<group>.ts` and exports its `register{Group}Tools(server)` function.

---

## 4. Per-tool specifications

### 4.1 `bughunt_suppress` (suppress.ts)

**Description:** "Add a suppression rule. Subsequent runs skip clusters matching the pattern."

**Zod input:**
```ts
const SuppressInput = z.object({
  project: z.string().min(1),
  pattern: z.string().min(1),
    // matches against clusterId | kind | endpoint glob | suspectedFile glob.
    // Format follows V28 §3.1: `kind:<BugKind>` | `cluster:<id>` | `endpoint:<glob>` | `file:<glob>`.
  reason: z.string().min(8),  // V28 audit: reason mandatory, ≥8 chars to reject "wip"
  expiresAt: z.string().datetime().optional(),  // ISO 8601 UTC
  clusterId: z.string().optional(),  // explicit cluster link for audit (optional but encouraged)
  bugIdentity: z.string().optional(),  // V27 stable identity. If provided, suppression is anchored to identity, not pattern.
  addedBy: z.string().min(1).optional(),  // override the auto-detected git author
});
```

**Output:** `{ ok: true, entryId: string /* cuid2 */, suppressed: number /* clusters across all runs the rule matches */ }`.

**Error cases:**
- `invalid_input` — Zod fail (missing `reason`, malformed `pattern`).
- `concurrent_write` — lock acquisition timed out after 5s. Caller retries.
- `error` — disk full / permissions.

**Side effects (under mkdir-lock at `<projectDir>/.bughunter/.suppressions.lock`, §7.2):**
1. Read `suppressions.json` (init empty list if missing).
2. `addedBy`: input override → `git config user.email` (`execSync`, cwd = projectDir) → `'unknown@mcp'`.
3. Append entry `{ entryId, pattern, reason, expiresAt?, clusterId?, bugIdentity?, addedBy, addedAt: ISO }`.
4. Atomic-write back (§7.1).
5. Append `{ action: 'add', entryId, pattern, reason, addedBy, ts }` to `suppressions-audit.log` (one JSON per line, `O_APPEND`).
6. Release lock.

After lock release, compute `suppressed` count by scanning `bugs.jsonl` across all runs and counting clusters whose signature matches `pattern`.

**CLI parity:** equivalent to `bughunter suppress <pattern> --reason '<text>' [--expires <iso>]` (V28 §4.3).

**Server.ts insertion:** new file `tools/suppress.ts`, registered after `registerTools`. Lines added in `server.ts`: ~2.

---

### 4.2 `bughunt_unsuppress` (suppress.ts)

**Description:** "Remove a suppression rule by entryId or by exact pattern match."

**Zod input:**
```ts
const UnsuppressInput = z.object({
  project: z.string().min(1),
  entryId: z.string().optional(),
  pattern: z.string().optional(),
}).refine(d => d.entryId !== undefined || d.pattern !== undefined,
         { message: 'entryId or pattern required' });
```

**Output:** `{ ok: true, removed: number /* 0 if no match */ }`.

**Error cases:** `invalid_input`, `concurrent_write`, `error`.

**Side effects (under same lock as 4.1):** read → filter out matching entries (by `entryId` exact OR `pattern` exact-string) → atomic-write back → audit-log one `{ action: 'remove', entryId|pattern, removedBy, ts }` per removed entry → release lock.

**CLI parity:** `bughunter unsuppress <entryId|pattern>`.

---

### 4.3 `bughunt_triage` (triage.ts)

**Description:** "Mark a cluster's triage verdict. Subsequent `bughunter run` consults this for stop-and-emit decisions."

**Zod input:**
```ts
const TriageInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  mark: z.enum(['bug', 'fix-priority', 'false-positive', 'known']),
  note: z.string().optional(),
});
```

**Output:** `{ ok: true, triageEntryId: string /* cuid2 */ }`.

**Error cases:**
- `not_found` — `runId` or `clusterId` doesn't exist.
- `invalid_input` — Zod.
- `error`.

**Side effects:**
1. Validate cluster exists: read `<runDir>/bugs.jsonl`, find `id === clusterId` (else `not_found`).
2. Append `{ triageEntryId, runId, clusterId, mark, note?, triagedBy, triagedAt }` to `triage.jsonl` via `appendJsonl` (filesystem.ts:54). `triagedBy` follows §4.1's git-config-fallback rule.
3. If V27's `history.db` exists, `INSERT INTO triage_history` via better-sqlite3 (V27 owns the schema; coordinate with V27 author on the exact statement).
4. **No lock needed** — `O_APPEND` atomicity holds for records under `PIPE_BUF` (4 KiB); triage records are ~200 B.

**CLI parity:** `bughunter triage` (interactive TUI in V28; this is the headless write).

---

### 4.4 `bughunt_fix_dispatch` (fix-coord.ts)

**Description:** "Spawn a fix-attempt subprocess for one cluster. Returns a jobId immediately; caller polls `bughunt_fix_status`."

**Zod input:**
```ts
const FixDispatchInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  agent: z.enum(['architect', 'coder']),
  model: z.string().min(1),  // free-form; passed to `claude -p --model <model>`
  prompt: z.string().min(1),
  binary: z.string().optional(),  // default: process.env.BUGHUNTER_FIX_BINARY ?? 'claude'
  branch: z.string().optional(),  // default: `fix/<runId>/<clusterId>` (computed)
  maxRuntimeMs: z.number().int().positive().max(3_600_000).optional(),  // default 1_800_000 (30m), cap 1h
});
```

**Output:** `{ ok: true, jobId: string, branchName: string, dispatched: 'shell' /* future: 'mcp' for in-process */ }`.

**Error cases:**
- `not_found` — cluster absent.
- `conflict` — branch already exists with diverged commits (refuse to overwrite).
- `subprocess_failed` — `spawn()` synchronously threw (e.g., binary not found).
- `invalid_input`.

**Side effects:**
1. Validate cluster exists (same as §4.3).
2. `branchName = input.branch ?? \`fix/${runId}/${clusterId}\``.
3. Branch creation: `git checkout -b ${branchName}` from current HEAD if absent. If exists at same HEAD as base → reuse; if diverged → `conflict`.
4. `mkdir -p <runDir>/fix-jobs/`.
5. Spawn (full lifecycle in §7.3): args = `['-p', '--input-format', 'text', '--output-format', 'json', '--model', model]`; `stdio: ['pipe', logFd, logFd]`; `detached: true`; env = filtered whitelist + `BUGHUNTER_FIX_AGENT`, `BUGHUNTER_FIX_BRANCH`. Pipe `prompt` to stdin; `child.unref()`.
6. Persist `<runDir>/fix-jobs/<jobId>.meta.json` = `{ jobId, runId, clusterId, agent, model, branch, pid, startedAt, maxRuntimeMs, state: 'running' }`.
7. Track in `fixJobs: Map`. Return `{ ok, jobId, branchName, dispatched: 'shell' }`.

**CLI parity:** none — currently lives only inside the `/bughunt fix` Claude skill; V31 makes it agent-agnostic.

---

### 4.5 `bughunt_fix_status` (fix-coord.ts)

**Description:** "Per-cluster verdict snapshot for a run. Mirrors `bughunter fix-summary` but JSON."

**Zod input:**
```ts
const FixStatusInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
});
```

**Output:**
```ts
{
  ok: true,
  fixState: FixStateEntry[],          // exact shape from cli/fix-summary.ts:7-12
  counters: Counters,                  // exact shape from cli/fix-summary.ts:14-23
  liveJobs: Array<{
    jobId: string, clusterId: string,
    state: 'running'|'done'|'failed'|'killed',
    startedAt: string /* ISO */, durationMs: number, exitCode?: number,
  }>,
}
```

**Error cases:** `not_found` (run absent), `error`.

**Side effects:** none. Read-only over `fix-state.json` + `fix-jobs/*.meta.json`.

**Refactor required:** extract `tally()` and `readFixState()` from `cli/fix-summary.ts:25-82` into a pure helper `packages/cli/src/ops/fix-summary.ts` exporting `computeFixSummary(projectDir, runId): FixSummary`. The print path keeps using it via the existing CLI shim. **Done-when:** `npm test` passes a snapshot test that asserts CLI print output is byte-identical before/after extraction.

**CLI parity:** `bughunter fix-summary <runId>` (print) ↔ `bughunt_fix_status` (JSON). Counters identical.

---

### 4.6 `bughunt_fix_gate` (fix-coord.ts)

**Description:** "Run forbidden-path gate against a fix branch. Optionally reset the branch on violation."

**Zod input:**
```ts
const FixGateInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),  // default 'main'
  reset: z.boolean().optional(),  // default false
});
```

**Output:** `{ ok: boolean, violations: string[], reset: boolean }` — mirrors `ForbiddenPathGateResult` (`ops/forbidden-paths.ts:9-11`).

**Error cases:** `invalid_input`, `error` (e.g., `git diff` failure).

**Side effects:** if `reset === true` and violations exist → branch ref hard-reset to `baseBranch` (already done by `forbiddenPathGate`).

**Implementation:** thin wrapper over `forbiddenPathGate(projectDir, branch, baseBranch ?? 'main', reset ?? false)`. **No new logic** — V31 only exposes the existing op via MCP.

**CLI parity:** `bughunter forbidden-path-gate <branch> [--reset]`.

---

### 4.7 `bughunt_fix_retest` (fix-coord.ts)

**Description:** "Re-replay all action logs for one cluster against the current dev server. Returns the fix verdict."

**Zod input:**
```ts
const FixRetestInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  branch: z.string().min(1).optional(),  // recorded in response only; replay always hits the live dev server
  baseBranch: z.string().min(1).optional(),
});
```

**Output:** `{ ok: true, result: RetestResult }` — `RetestResult` shape mirrored 1:1 from `ops/retest.ts:33-40`. Re-derive the Zod schema from the TS type at the top of `tools/fix-coord.ts`; do not invent a divergent shape.

**Error cases:** `not_found`, `error`.

**Side effects:** none on disk (replay hits the dev server).

**Implementation:** `await retestOp(projectDir, runId, clusterId, baseBranch, branch)`. The op already handles static-rerun vs action-log replay via `cluster.replayKind` (retest.ts:286-301).

---

### 4.8 `bughunt_config_set` (config.ts)

**Description:** "Programmatic edit to `.bughunter/config.json` with Zod re-validation."

**Zod input:**
```ts
const ConfigSetInput = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
    // dot-path: 'maxBugs' | 'auth.successCheck.kind' | 'roles.0.name'.
    // Numeric segments treated as array indices.
  value: z.unknown(),
});
```

**Output:** `{ ok: boolean, validated: boolean, errors?: Array<{ path: (string|number)[], message: string }> }` — `errors` populated only when `validated === false`.

**Error cases:**
- `invalid_input` — Zod fail on the input shape itself.
- `error` — config file missing (project not initialized), disk full.

**Side effects (under lock at `<projectDir>/.bughunter/.config.lock`):**
1. `loadConfig(projectDir)`.
2. Apply patch via internal `setByPath(obj, key, value)` (~20 lines, no lodash dep): split key on `.`; clone shallowly down the path; numeric segments coerced to array indices when parent is array; reject traversal through non-object/non-array.
3. Re-parse **entire patched config** through `ConfigSchema.safeParse`. If fail → `{ ok: false, validated: false, errors }`, **do not write**.
4. Atomic-write (§7.1) — replaces `saveConfig`'s plain `fs.writeFileSync` for crash safety.
5. Release lock; return `{ ok: true, validated: true }`.

**Negative requirement:** **never** write a config that fails Zod. The acceptance test (§9) asserts: after a failing `config_set`, the on-disk file is byte-identical to the pre-call state.

**CLI parity:** none yet — `bughunter init` only writes once. `bughunter config set` is a deferred CLI follow-up.

---

### 4.9 `bughunt_minimize` (minimize.ts)

**Description:** "Action-log minimization via delta-debugging. Returns the shortest action log that still reproduces the bug."

**Zod input:**
```ts
const MinimizeInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
  maxBudgetMs: z.number().int().positive().max(1_800_000).optional(),  // default 600_000 (10m), cap 30m
  maxIterations: z.number().int().positive().optional(),  // default 200
});
```

**Output:** `{ ok: true, minimizedActionLogPath: string, originalSteps: number, minimizedSteps: number, iterations: number, budgetMsUsed: number, reproduced: true }` (if can't repro: `cannot_repro` error, no `reproduced` field).

**Error cases:**
- `not_found` — `occurrenceId` action log absent.
- `cannot_repro` — original action log doesn't reproduce the bug on the live server (precondition fails). Caller should re-run a fresh smoke first.
- `timeout` — exceeded `maxBudgetMs` before convergence; partial result may be returned in error payload.

**Algorithm — see §7.4 for full pseudocode.** Brief: classical `ddmin` (Zeller's delta debugging) with sequential drop fallback. Each iteration calls `replayActionLog`. Termination when no single-step removal still reproduces.

**Side effects:** writes `<runDir>/action-logs/<occurrenceId>.minimized.json`. **Does not overwrite** the original `<occurrenceId>.json`.

---

### 4.10 `bughunt_replay_minimized` (minimize.ts)

**Description:** "Replay the minimized action log produced by `bughunt_minimize`."

**Zod input:**
```ts
const ReplayMinInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
});
```

**Output:** same shape as `ReplayResult` (`packages/cli/src/repro/replay.ts:10-19`): `{ ok: boolean, observation: { finalUrl?: string, consoleErrors: unknown[], networkRequests: unknown[], domSnapshot?: string }, error?: string }`.

**Error cases:** `not_found` (no `.minimized.json`), `error`.

**Implementation:** read `<runDir>/action-logs/<occurrenceId>.minimized.json` → call `replayActionLog` with current adapters (same construction as `replayCommand` in `cli/replay.ts:11-40`).

---

### 4.11 `bughunt_baseline_save` (baseline.ts)

**Description:** "Lock the current run's visual or perf metrics as the baseline. Future runs compare to this baseline."

**Zod input:**
```ts
const BaselineSaveInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(['visual', 'perf']),
});
```

**Output:** `{ ok: true, baselinePath: string /* abs path */, artifactCount: number }`.

**Error cases:**
- `not_found` — run absent.
- `invalid_input` — run has no visual/perf data (e.g., `kind: 'visual'` but `screenshots/` is empty).
- `error`.

**Side effects:**
1. Validate run exists (`runPaths(...).runDir`).
2. Eligibility — `visual`: `screenshots/` non-empty AND `summary.json.vision.called > 0`. `perf`: `summary.json.perf` present with ≥1 metric.
3. `mkdir -p <projectDir>/.bughunter/baselines/<kind>/<runId>/`.
4. **Visual:** copy all `screenshots/*.png`; write `manifest.json` `{ runId, savedAt, files: [{path, sha256}] }`.
5. **Perf:** extract `summary.json.perf` → `<baselineDir>/perf.json`; manifest records `{ runId, savedAt, metrics }`.
6. Atomic symlink swap: `baselines/<kind>/current → <runId>/` via `fs.symlinkSync(target, current.tmp)` + `fs.renameSync(current.tmp, current)`.

**CLI parity:** none yet.

---

### 4.12 `bughunt_baseline_compare` (baseline.ts)

**Description:** "Compare the current run against the locked baseline."

**Zod input:**
```ts
const BaselineCompareInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(['visual', 'perf']).optional(),  // default: both
});
```

**Output:**
```ts
{
  ok: true,
  visual?: {
    regressions: Array<{ file: string, diffPixels: number, diffRatio: number, baselinePath: string, currentPath: string }>,
    unchanged: number, improvements: number,
  },
  perf?: {
    regressions: Array<{ metric: string, baseline: number, current: number, delta: number, regressionPct: number }>,
    unchanged: number, improvements: number,
  },
}
```
(One or both of `visual` / `perf` populated based on `kind` input and locked-baseline availability.)

**Error cases:**
- `not_found` — no locked baseline of the requested kind.
- `error`.

**Side effects:** none.

**Implementation:** visual diff via existing pixelmatch / SSIM tooling — **defer the diff impl to V13's vision-baseline module.** V31 only specifies the MCP wrapper surface; the visual-diff function is imported via `import { compareVisualBaseline } from 'bughunter/src/vision/baseline.js'`. If the vision module doesn't yet expose this function, the coder lands a stub that returns `{ regressions: [], unchanged: 0, improvements: 0 }` and files a follow-up issue tagged `v0.13-finish`.

Perf diff: `regressionPct = (current - baseline) / baseline`. Threshold for "regression" comes from `config.perfBudget.regressionThresholdPct ?? 0.10` (10%).

---

## 5. Auth model

**Per-client API key** (current pattern from `Authorization: Bearer pcp_…` in the user's MCP setup). V31 inherits the read-side V30 enforcement: the same key authorizes both read and write.

**Documentation requirement:** add a NOTE in the package README that an MCP API key issued for V31 has full mutation authority over the project — suppressions, config edits, branch creation, subprocess spawn — and should be treated as a deploy-key-equivalent secret.

**Multi-tier auth (separate read-token / write-token / dispatch-token) is deferred to v0.7.** See open question §13.1.

**Subprocess spawn is the highest-privilege primitive.** Mitigations:
- `binary` defaults to `process.env.BUGHUNTER_FIX_BINARY ?? 'claude'`. Spec: validate that `binary` is a basename (no `/`) **OR** an absolute path under `process.env.BUGHUNTER_FIX_BINARY_ALLOWLIST` (colon-separated). Reject everything else with `forbidden`.
- `prompt` is pipe-fed via stdin (not argv). Cannot inject CLI flags.
- `env` is a **whitelist**, not pass-through: only `PATH`, `HOME`, `BUGHUNTER_FIX_AGENT`, `BUGHUNTER_FIX_BRANCH`, `ANTHROPIC_API_KEY`. Everything else is dropped.

---

## 6. Concurrency strategy

### 6.1 File-write contention map

| File | Access | Strategy |
|---|---|---|
| `suppressions.json`, `config.json` | RMW | mkdir-lock (§7.2) + atomic-rename (§7.1) |
| `suppressions-audit.log`, `triage.jsonl` | append | `fs.appendFileSync` (`O_APPEND` atomic ≤4 KiB; records <500 B) |
| `history.db` | RMW | SQLite WAL mode handles concurrency natively |
| `fix-state.json` | V31 read-only | no contention |
| `fix-jobs/<jobId>.meta.json`, `action-logs/<id>.minimized.json` | one-writer per unique path | no lock needed |
| `baselines/<kind>/<runId>/*` | one-writer per runId | atomic via `current` symlink swap |

### 6.2 Server-process contention

Multiple concurrent clients share the per-request `McpServer` indirectly via module-level `fixJobs: Map` and `jobs: Map`. Node's event loop serializes JS mutation; on-disk races are covered by §6.1.

### 6.3 Audit log integrity

`suppressions-audit.log` is the trust artifact (exhaustive spec §6.5). `O_APPEND` guarantees atomicity for single `write(2)` syscalls under PIPE_BUF — audit records are <500 B, safe.

---

## 7. Hard subsystems

### 7.1 Atomic write+rename pattern

```ts
function atomicWriteJson(target: string, data: unknown): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, target);  // atomic on POSIX same-filesystem
}
```

Same FS guarantee — `<projectDir>/.bughunter/` is always one filesystem.

### 7.2 mkdir-lock pattern

```ts
async function withLock<T>(lockDir: string, timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);                                  // atomic; EEXIST if held
      try { return await fn(); } finally { fs.rmdirSync(lockDir); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) throw new Error('lock_timeout');
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    }
  }
}
```

**Stale-lock detection:** before each retry, check `fs.statSync(lockDir).mtimeMs`. If >30 s old (process crashed mid-edit), force-`rmdirSync` and proceed. Lives in `tools/locks.ts`, shared across suppress / triage / config.

### 7.3 Subprocess lifecycle for `bughunt_fix_dispatch`

**Track (module-level, hoisted like `tools.ts:19`):**
```ts
type FixJobHandle = {
  jobId: string; runId: string; clusterId: string;
  pid: number; child: ChildProcess; startedAt: number;
  state: 'running'|'done'|'failed'|'killed';
  exitCode?: number; logPath: string; metaPath: string;
  killTimer: NodeJS.Timeout;
};
const fixJobs = new Map<string, FixJobHandle>();
```

**Spawn:**
```ts
const logFd = fs.openSync(logPath, 'a');
const child = spawn(binary, args, {
  cwd: projectDir, stdio: ['pipe', logFd, logFd],
  detached: true, env: filteredEnv,
});
child.stdin.write(prompt); child.stdin.end();
child.unref();             // server can exit without waiting
fs.closeSync(logFd);       // FD inherited by child; safe to close in parent
```

**Events:**
- `child.on('exit', code => { handle.state = code === 0 ? 'done' : 'failed'; handle.exitCode = code ?? -1; clearTimeout(handle.killTimer); persistMeta(handle); })`
- `child.on('error', () => { handle.state = 'failed'; persistMeta(handle); })`

**Kill fuse:** `setTimeout` at `maxRuntimeMs` calls `killProcessTree(pid)` → `process.kill(-pid, 'SIGTERM')` (negative pid = process group, because `detached`); 5s later `SIGKILL`. Then `state = 'killed'; persistMeta`.

**Disconnect:** `res.on('close', () => transport.close())` (server.ts:19) tears down the per-request `McpServer`, but `fixJobs` is module-level — children **outlive** the request. Intentional. Long-running dispatch survives disconnect; caller polls via `bughunt_fix_status`.

**Server restart:** on `createApp()` boot, scan `<projectDir>/.bughunter/runs/*/fix-jobs/*.meta.json`. For each `state: 'running'`, check `pid` liveness (`process.kill(pid, 0)`). Alive → keep meta; dead → mark `state: 'killed'`. **No auto-restart.**

**Concurrency cap:** `MAX_CONCURRENT_FIX_JOBS = 4` (configurable per §13.2). Beyond cap: `conflict` with `'too many running fix jobs (4); poll bughunt_fix_status'`.

### 7.4 Minimization algorithm (`ddmin`)

Reference: Zeller, "Yesterday, my program worked. Today, it does not. Why?" §`ddmin`.

**Pseudocode:**
```
INPUT: actionLog (N steps), maxBudgetMs, maxIter
PRECONDITION: replay(actionLog) reproduces the bug. Else: cannot_repro.
steps = actionLog.actions; n = 2  // partition granularity

while len(steps) >= 2 and iter < maxIter and elapsed < maxBudgetMs:
  partitions = chunk(steps, n); found_smaller = false
  for c in partitions:                          // try each partition alone
    if replay(c) reproduces: steps = c; n = 2; found_smaller = true; break
  if not found_smaller:
    for c in partitions:                        // try each complement
      cc = steps - c
      if replay(cc) reproduces: steps = cc; n = max(n - 1, 2); found_smaller = true; break
  if not found_smaller:
    if n >= len(steps): break                   // converged
    n = min(n * 2, len(steps))                  // increase granularity

write <id>.minimized.json; return { originalSteps: N, minimizedSteps: len(steps), iterations }
```

**Reproducibility check:** re-run `replayActionLog`; bug "reproduces" if `result.observation.consoleErrors.length > 0 || result.ok === false`. (Coarse — refine to `clusterSignature` match in V32; see §13.5.) Each check runs **twice** (EC-M3) to defang flakes.

**Termination:** each successful reduction strictly decreases `len(steps)` (≤N reductions); granularity doubles when stuck (≤log₂N per step-count). Worst case **O(N²)** replays; with N=100 and replay≈10 s ≈17 min. `maxBudgetMs` (default 10 min) caps wall-clock.

**`cannot_repro`:** original log doesn't reproduce → error, no `.minimized.json`. Caller re-smokes first.

---

## 8. Negative requirements

- Do not create new schema files for suppressions / triage / fix-state — V27/V28 own them.
- Do not copy CLI op logic; call `forbiddenPathGate`, `retestOp` directly.
- Do not spawn fix subprocess synchronously or with `execSync`.
- Do not add `proper-lockfile` or any runtime dep — mkdir-lock is sufficient.
- Do not capture subprocess stdout/stderr in memory — stream to `fix-jobs/<jobId>.log` via FD inheritance.
- Do not invoke `git` outside `forbiddenPathGate` and the explicit `git checkout -b` in `bughunt_fix_dispatch`.
- Do not write a config that fails Zod re-validation — the pre-write gate is non-negotiable.
- Do not log suppression `reason` to telemetry — free-text may contain redacted-once credentials. Audit log stays local.
- Do not mutate the original action log in `bughunt_minimize` — always produce `<id>.minimized.json`.
- Do not save a zero-artifact baseline — reject with `invalid_input`.
- Do not add tools without registering in `server.ts` — registration test fails otherwise.

---

## 9. Acceptance criteria

| # | Criterion | Verifier |
|---|---|---|
| AC-1 | `npm test -- packages/mcp` passes; each tool has a unit test | vitest |
| AC-2 | `npx tsc --noEmit -p packages/mcp/tsconfig.json` clean | tsc |
| AC-3 | `npx eslint packages/mcp/src --max-warnings 0` clean | eslint |
| AC-4 | E2E MCP loop on `fixtures/bughunter-self-deliberate-bugs/`: run → triage → suppress → fix-dispatch → status-poll → gate → retest produces `bugs_verified_fixed >= 1` | `tests/e2e/v31-mcp-write-loop.test.ts` |
| AC-5 | 10 parallel `bughunt_suppress` calls with distinct patterns: all 10 entries persist, audit log has 10 lines, no JSON parse error | `tests/concurrency/v31-suppress-race.test.ts` |
| AC-6 | `_config_set` with invalid value: `{ok:false, validated:false, errors}`; on-disk config byte-identical | unit |
| AC-7 | `_fix_dispatch` then transport-disconnect: subprocess survives; `_fix_status` 60s later reflects exit code | manual |
| AC-8 | `_fix_dispatch` exceeds `maxRuntimeMs`: SIGTERM → SIGKILL+5s → `state: 'killed'`, `exitCode: -1` | unit (mock binary = `sleep 9999`) |
| AC-9 | `_minimize` on 20-step log where only step 5 triggers bug: returns 1-step minimized log | integration |
| AC-10 | `_minimize` on flake: `cannot_repro`; no `.minimized.json` written | unit |
| AC-11 | `_baseline_save kind=visual` then `_baseline_compare` on identical run: zero regressions | integration |
| AC-12 | `_fix_dispatch` branch-name conflict: `conflict`; no subprocess, no branch creation | unit |
| AC-13 | 5th dispatch beyond `MAX_CONCURRENT_FIX_JOBS=4`: `conflict` with stable error code | unit |
| AC-14 | Server restart with live + dead orphan jobs: live → `running`, dead → `killed` | restart test |
| AC-15 | Subprocess `binary` outside allowlist: `forbidden` | unit |
| AC-16 | Existing 4 read-side tools regression-pass | regression |

---

## 10. Edge cases

| ID | Scenario | Behavior |
|---|---|---|
| EC-S1 | V28 hasn't landed; `suppressions.json` missing | `bughunt_suppress` initializes empty list + creates file. `bughunt_unsuppress` returns `{removed: 0}`. |
| EC-S2 | Concurrent `bughunt_suppress`, same pattern | Lock serializes; both entries written with distinct `entryId`s. Dedup is V28's job. |
| EC-S3 | `expiresAt` in the past | Allowed at write (audit signal); V28 run-time enforcement skips expired. |
| EC-T1 | `bughunt_triage` on cluster already marked differently | Append new entry — history preserved; latest wins for `bughunter run` consultation. |
| EC-T2 | `bughunt_triage` on pruned `runId` | `not_found` — triage requires cluster file to validate `clusterId`. |
| EC-F1 | `bughunt_fix_dispatch` on non-existent `clusterId` | `not_found`; no branch, no subprocess. |
| EC-F2 | Branch exists at same commit as base | Reuse, return `{branchName, dispatched:'shell'}`. |
| EC-F3 | Branch exists with diverged commit | `conflict`; caller resets via `bughunt_fix_gate reset=true` then retries. |
| EC-F4 | `spawn()` throws synchronously (binary missing) | Catch → `subprocess_failed`; no Map entry, no meta file. |
| EC-F5 | Subprocess never exits | `maxRuntimeMs` fuse kills it. State `killed`. |
| EC-F6 | MCP server crashes mid-run | Detached + unref'd subprocess survives. On restart: reconciled per §7.3. |
| EC-F7 | `_fix_gate reset=true` on currently checked-out branch | `conflict`; reset would corrupt working tree. |
| EC-C1 | `_config_set key='maxBugs' value=-1` | `ConfigSchema` rejects → `{ok:false, validated:false, errors}`; file unchanged. |
| EC-C2 | `_config_set key='auth.successCheck' value={...}` | Replaces nested object atomically; re-validation passes. |
| EC-C3 | `_config_set key='nonExistentField'` | `setByPath` creates it; today's non-strict schema accepts (see §13.4). Documented behavior. |
| EC-M1 | `_minimize` on 1-step log | Same log; `minimizedSteps == originalSteps == 1`; iterations 0. |
| EC-M2 | `_minimize` finds no reducible partition | Returns original log, converged; sizes equal. |
| EC-M3 | `_minimize` on flake | Each repro-check runs **twice**; bug must reproduce in **both**. Doubles cost; reduces flake-driven over-minimization. |
| EC-B1 | `_baseline_save kind='visual'` with `vision.called=0` | `invalid_input`: "no visual artifacts in this run". |
| EC-B2 | `_baseline_compare` with no locked baseline | `not_found`: "no <kind> baseline locked yet". |
| EC-B3 | `_baseline_save` on already-baselined run | Overwrite via `current` symlink swap; old baseline dir kept (not deleted) to enable revert via re-save of prior runId. |

---

## 11. Files to touch / add

### 11.1 New files (with LOC budget; impl + co-located `.test.ts` unless noted)

| File | Purpose | LOC (impl/test) |
|---|---|---|
| `packages/mcp/src/tools/suppress.ts` | `bughunt_suppress`, `bughunt_unsuppress` | 140 / 150 |
| `packages/mcp/src/tools/triage.ts` | `bughunt_triage` | 80 / 80 |
| `packages/mcp/src/tools/fix-coord.ts` | `bughunt_fix_dispatch`/`_status`/`_gate`/`_retest` + `fixJobs` Map + lifecycle | 280 / 250 |
| `packages/mcp/src/tools/config.ts` | `bughunt_config_set` + `setByPath` | 80 / 100 |
| `packages/mcp/src/tools/minimize.ts` | `bughunt_minimize`, `bughunt_replay_minimized` + `ddmin` | 200 / 150 |
| `packages/mcp/src/tools/baseline.ts` | `bughunt_baseline_save`, `bughunt_baseline_compare` | 140 / 80 |
| `packages/mcp/src/tools/locks.ts` | shared `withLock`, `atomicWriteJson` | 50 / 40 |
| `packages/mcp/src/tools/errors.ts` | shared `ErrorCode` (import from V30 if present) | 20 / — |
| `packages/cli/src/ops/fix-summary.ts` | extracted `computeFixSummary` from CLI print path | 80 / 60 |
| `tests/e2e/v31-mcp-write-loop.test.ts` | end-to-end fixture loop (AC-4) | — / 200 |
| `tests/concurrency/v31-suppress-race.test.ts` | concurrent-write race (AC-5) | — / 100 |

### 11.2 Modified files

| File | Change |
|---|---|
| `packages/mcp/src/server.ts` (lines 14-29) | Inside the per-request handler, after `registerTools(server)`, also call `registerSuppressTools`, `registerTriageTools`, `registerFixCoordTools`, `registerConfigTools`, `registerMinimizeTools`, `registerBaselineTools`. Plus V30's `registerReadTools`. |
| `packages/cli/src/cli/fix-summary.ts` | Refactor `tally + readFixState` out into `ops/fix-summary.ts`; print path becomes a 30-line shim that calls `computeFixSummary` and formats. |
| `packages/mcp/package.json` | Add no new runtime deps. Verify `better-sqlite3` is added by V27 (V31 uses it for `triage` history-db inserts). |
| `tsconfig.json` (mcp) | No change — new files inherit. |

### 11.3 NOT touched

`ops/forbidden-paths.ts`, `ops/retest.ts`, `repro/replay.ts`, `config.ts`'s `ConfigSchema`, `store/filesystem.ts` — all imported as-is. V27/V28 schema files — sibling specs own them.

---

## 12. Task breakdown (agent-sized)

Each task is one file (or one file pair: impl + test), independently testable, ~30 min human-equivalent.

| # | Task | Assignee | Files | Depends | Test |
|---|---|---|---|---|---|
| 1 | Extract `computeFixSummary` from `cli/fix-summary.ts` into `ops/fix-summary.ts` | @coder | `packages/cli/src/cli/fix-summary.ts`, `packages/cli/src/ops/fix-summary.ts`, test | none | `npm test -- fix-summary` |
| 2 | Implement `tools/locks.ts` (mkdir-lock + atomicWriteJson) + tests | @coder | `packages/mcp/src/tools/locks.ts`, `locks.test.ts` | none | `npm test -- locks` |
| 3 | Implement `tools/errors.ts` (or import from V30) | @coder | `packages/mcp/src/tools/errors.ts` | none | typecheck |
| 4 | Implement `tools/suppress.ts` (`bughunt_suppress`, `bughunt_unsuppress`) + tests | @coder | `tools/suppress.ts`, `suppress.test.ts` | 2, 3, V28 schema | `npm test -- suppress` |
| 5 | Implement `tools/triage.ts` (`bughunt_triage`) + tests | @coder | `tools/triage.ts`, `triage.test.ts` | 3, V27 history.db, V28 triage.jsonl | `npm test -- triage` |
| 6 | Implement `tools/config.ts` (`bughunt_config_set` + `setByPath`) + tests | @coder | `tools/config.ts`, `config.test.ts` | 2, 3 | `npm test -- config` |
| 7 | Implement `tools/baseline.ts` (`bughunt_baseline_save`, `_compare`) + tests | @coder | `tools/baseline.ts`, `baseline.test.ts` | 3 | `npm test -- baseline` |
| 8 | Implement `tools/fix-coord.ts` partial: `_status`, `_gate`, `_retest` + tests | @coder | `tools/fix-coord.ts`, `fix-coord.test.ts` (subset) | 1, 3 | `npm test -- fix-coord` |
| 9 | Implement `tools/fix-coord.ts` finish: `_dispatch` + subprocess lifecycle + tests | @coder | `tools/fix-coord.ts` (extend), `fix-coord.test.ts` (extend) | 8 | `npm test -- fix-coord-dispatch` (incl. mock-binary) |
| 10 | Implement `tools/minimize.ts` (`_minimize` ddmin + `_replay_minimized`) + tests | @coder | `tools/minimize.ts`, `minimize.test.ts` | 3 | `npm test -- minimize` |
| 11 | Wire all new tools into `server.ts` | @coder | `packages/mcp/src/server.ts` | 4-10 | `npm test -- mcp-server` |
| 12 | E2E loop test on fixture | @qa | `tests/e2e/v31-mcp-write-loop.test.ts` | 11 | `npm test -- v31-mcp-write-loop` |
| 13 | Concurrency race test for suppressions | @qa | `tests/concurrency/v31-suppress-race.test.ts` | 4 | `npm test -- v31-suppress-race` |
| 14 | README note on auth model | @architect | `packages/mcp/README.md` | 11 | review |

**Critical path:** 2 → 3 → (4 ‖ 5 ‖ 6 ‖ 7 ‖ 8) → 9 → 10 → 11 → 12. ~10–14 work-days serial; 5–7 parallel.

---

## 13. Open questions

1. **Write-token gating?** Same key authorizes read + write today. Multi-tier (read-only / write / dispatch tokens) deferred to v0.7. Coder-impact for V31: none; document security implication in README.
2. **`MAX_CONCURRENT_FIX_JOBS` configurable?** **Yes** — add `mcp.maxConcurrentFixJobs?: number` to `ConfigSchema`, default 4, cap 16. One Zod field. (Resolved in this spec.)
3. **Global minimize budget across in-flight calls?** No for V31 — per-call `maxBudgetMs` only; pathological callers saturate the dev server before hitting any global cap (natural backpressure).
4. **`ConfigSchema` strict mode?** Keep non-strict (backward-compat). Document EC-C3 behavior. `ConfigSchemaStrict` variant deferred to V32. (Resolved.)
5. **Minimize reproducibility check fidelity.** V31 ships coarse signal (`consoleErrors.length > 0 OR result.ok === false`) + doubled-replay flake mitigation (§10 EC-M3). V32 to refine using the cluster's `BugDetection.signature` via `clusterSignature` + re-classify. **Architect decides at merge.**
6. **Subprocess env whitelist completeness.** §5 whitelist may be incomplete (e.g., `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_PATH`). **Action:** integration-test in stripped env; extend whitelist explicitly with discovered needs.
7. **Explicit cancel RPC (`bughunt_fix_cancel`)?** Defer to V32. V31 covers via `maxRuntimeMs` fuse + transport disconnect.

---

## 14. Definition of Done

1. AC-1 through AC-16 (§9) all green on the V27 + V28 + V30 + V31 integration branch.
2. `npm run build` and `npx tsc --noEmit` clean across all packages.
3. `npx eslint . --max-warnings 0` clean.
4. E2E fixture loop (AC-4) runs in <5 min on the reference dev box with non-trivial `bugs_verified_fixed`.
5. `packages/mcp/README.md` updated with §5 auth note + 12-tool one-liner index.
6. `CHANGELOG.md` V31 release note links back to this spec.
7. Open questions §13.1, 3, 5, 6, 7 explicitly answered (defer/do) by architect at merge. §13.2 + §13.4 already resolved in this spec.

---

## 15. Risks + escape hatches

- **Subprocess spawn = attack surface.** Mitigation: §5 binary allowlist + env whitelist + stdin-only prompt. Hatch: `BUGHUNTER_MCP_DISABLE_DISPATCH=1` env var disables tools 4-7 (read-mostly mode).
- **ddmin wall-clock explosion.** Mitigation: `maxBudgetMs` mandatory, capped at 30m. Hatch: `maxIterations: 50` for fast bounded minimize.
- **V27/V28 schema drift mid-implementation.** Mitigation: V31 reads go through V27/V28 helper modules (not direct file I/O) — schema change auto-fails typecheck. Hatch: stub helpers (empty list / no-op insert) until V27/V28 merge.
- **mkdir-lock + atomic-rename fail on Windows.** V31 explicitly targets POSIX; existing CLI already assumes POSIX. Document.
- **Baseline storage grows unbounded.** `bughunter prune --baselines` is V32; V31 ships without auto-prune.

---

