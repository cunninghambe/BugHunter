# SPEC — v0.14 "Seed-data hooks"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Sibling spec:** `SPEC_V15_VISION_CONSISTENCY.md` · **Predecessor:** PR #34 login robustness · **Successor:** v0.15 vision consistency.

This spec is the implementation contract for project-level seed-data hooks. Today BugHunter runs against whatever state the target's dev DB happens to be in. Empty tables and missing fixtures cause most detectors to silently no-op — the Aspectv3 run surfaced "0 results" / empty-list states across the majority of routes. Real bugs (table clip, count mismatch, stale data after mutation, focus-on-row issues) only fire when the UI has realistic content to render. Seed hooks let the user supply project-specific shell or HTTP commands that run at well-defined points in the BugHunter lifecycle.

---

## 1. Objective

Add a `seedHooks` configuration block that runs project-supplied commands at four lifecycle points: before discovery, after auth (per-role), before each phase, and after the run. Each hook is one of two transport kinds: `shell` (local command) or `http` (request against a target endpoint). Failures abort the run by default; `continueOnError: true` per-hook opts into best-effort.

**In scope:**
- `seedHooks.beforeRun` — runs once before discovery
- `seedHooks.afterLogin` — runs once per role after browser-login completes
- `seedHooks.beforeExecute` — runs once after plan, before execute
- `seedHooks.cleanup` — runs once at end of run regardless of success
- Two transport kinds: `shell` (spawns a process) and `http` (single fetch call)
- Telemetry: `seedHookExecutions` array on `summary.json` with kind, target, durationMs, status, exit code or HTTP status
- Cleanup runs even on infra failure / abort (best-effort, with timeout)

**Out of scope (deferred):**
- SQL kind (would need pg/mysql clients shipped) — users can shell out to `psql` if needed; v0.16
- Rollback / transactional seeding — v0.16
- Conditional seeding (e.g. "only if table is empty") — v0.16
- Snapshot / restore (Postgres `pg_dump`-style) — v0.17
- Resource cleanup tied to specific findings — v0.17

**Acceptance target on Aspectv3:**
With a `beforeRun` hook that POSTs to `/v1/admin/seed-test-data` (or similar) creating 50 sample records, the next smoke run produces **at least 3 BugKinds** that did NOT fire on the empty-state run. Likely candidates: `missing_state_change` cases that need rows to operate on, `dom_error_text` from real error states, `visual_anomaly` from layout bugs that only show up at scale.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugHunterConfig` shape. Add `seedHooks` block as optional. |
| `packages/cli/src/config.ts` | Zod schema for config. Add Zod schema for `SeedHookConfig` discriminated union. |
| `packages/cli/src/cli/run.ts` | The orchestrator. Wire the four lifecycle points: line ~135 (beforeRun, before SurfaceMCP probe), line ~150 (afterLogin, after browser-login each role), line ~235 (beforeExecute, after plan before execute), and at the end (cleanup, in finally block). |
| `packages/cli/src/log.ts` | Structured logger. Use it; do not `console.log`. |
| `packages/cli/src/store/filesystem.ts` | `runPaths(projectDir, runId)`. Hook telemetry written to `runs/<runId>/seed-hooks.jsonl` for trace; summary aggregates. |
| `packages/cli/src/static/runner.ts` | Pattern for `child_process.spawn` with timeout, captured stdout/stderr, and structured error. **Mirror this pattern for the shell-kind seed hook.** |
| `packages/cli/src/security/header-probe.ts` | Pattern for an HTTP-fetch helper. Mirror for the http-kind seed hook. |

### 2.2 Patterns to follow

- **Adapter pattern:** the seed-hook executor lives in `packages/cli/src/seed/runner.ts` (new file). Tests mock `child_process.spawn` and `fetch`.
- **Discriminated-union returns:** `runSeedHook(hook): Promise<{ ok: true; durationMs: number; output?: string }> | { ok: false; reason: string; durationMs: number }`.
- **No global mutable state.** Each hook execution is self-contained.
- **Timeouts.** Default 60s per hook; configurable per-hook via `timeoutMs`.
- **Cleanup never aborts the run.** If cleanup throws, log a warning and continue to emit phase.

### 2.3 DO NOT

- Do **not** add new runtime dependencies (no `pg`, `mysql2`, `axios`, etc.). Use Node's built-in `child_process` and `fetch`.
- Do **not** make hooks blocking on user input (no interactive prompts).
- Do **not** capture or log secrets from hook output. If a hook prints API keys or tokens, redact via the existing log redaction pattern (or simply truncate stdout to first 500 chars in telemetry).
- Do **not** run hooks in parallel — strictly sequential within a lifecycle point. Per-role afterLogin runs once per role in role order.
- Do **not** swallow hook failures by default. `continueOnError` must be opt-in per hook.

---

## 3. Configuration shape

Add to `types.ts`:

```ts
export type SeedHookKind = 'shell' | 'http';

export type SeedHookShell = {
  kind: 'shell';
  command: string;            // exact command line, no shell interpolation by default
  cwd?: string;               // default: projectDir
  timeoutMs?: number;         // default: 60_000
  env?: Record<string, string>; // additional env vars
  continueOnError?: boolean;  // default: false
  description?: string;       // human-readable label for logs/telemetry
};

export type SeedHookHttp = {
  kind: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;                // absolute URL or relative to appBaseUrl
  headers?: Record<string, string>;
  body?: unknown;             // serialized as JSON if non-string
  timeoutMs?: number;         // default: 60_000
  expectedStatus?: number | number[]; // default: 2xx
  continueOnError?: boolean;  // default: false
  description?: string;
};

export type SeedHook = SeedHookShell | SeedHookHttp;

export type SeedHooksConfig = {
  beforeRun?: SeedHook[];
  afterLogin?: SeedHook[];                     // applied to ALL roles
  perRole?: Record<string, SeedHook[]>;        // role-scoped, runs after afterLogin
  beforeExecute?: SeedHook[];
  cleanup?: SeedHook[];                        // runs in `finally` block
};
```

Add to `BugHunterConfig`:

```ts
export type BugHunterConfig = {
  // ... existing fields ...
  seedHooks?: SeedHooksConfig;
};
```

### 3.1 Zod schema (in `config.ts`)

Use a discriminated union on `kind`. Required fields enforced by Zod. Validate URLs at parse time; relative URLs are allowed and resolved against `appBaseUrl` at execution time.

### 3.2 Example user config

```json
{
  "projectName": "aspect-v3",
  "appBaseUrl": "http://localhost:5173",
  "roles": ["owner", "anon"],
  "seedHooks": {
    "beforeRun": [
      {
        "kind": "shell",
        "command": "pnpm --filter @aspect/synthetic-seed seed -- --scale medium",
        "cwd": "/root/Aspectv3",
        "timeoutMs": 120000,
        "description": "synthetic seed (medium)"
      }
    ],
    "afterLogin": [
      {
        "kind": "http",
        "method": "POST",
        "url": "/v1/admin/test/reset-counters",
        "expectedStatus": 200,
        "description": "reset audit-log counters"
      }
    ],
    "perRole": {
      "owner": [
        {
          "kind": "http",
          "method": "POST",
          "url": "/v1/admin/test/grant-fixtures",
          "expectedStatus": 200,
          "description": "owner-only fixtures"
        }
      ]
    },
    "cleanup": [
      {
        "kind": "shell",
        "command": "pnpm --filter @aspect/synthetic-seed reset",
        "continueOnError": true,
        "description": "reset DB"
      }
    ]
  }
}
```

---

## 4. Module surface

### 4.1 `packages/cli/src/seed/runner.ts` (new file)

```ts
export type SeedHookExecution = {
  hookKind: 'shell' | 'http';
  description: string;        // user-supplied or generated
  durationMs: number;
  ok: boolean;
  reason?: string;            // error if !ok
  output?: string;            // truncated stdout/response body (first 500 chars)
  exitCode?: number;          // for shell
  status?: number;            // for http
  lifecyclePoint: 'beforeRun' | 'afterLogin' | 'perRole' | 'beforeExecute' | 'cleanup';
  role?: string;              // when lifecyclePoint is 'afterLogin' or 'perRole'
};

export async function runSeedHook(
  hook: SeedHook,
  context: { projectDir: string; appBaseUrl?: string; role?: string; lifecyclePoint: SeedHookExecution['lifecyclePoint'] }
): Promise<SeedHookExecution>;

export async function runSeedHooksAt(
  hooks: SeedHook[] | undefined,
  context: { projectDir: string; appBaseUrl?: string; role?: string; lifecyclePoint: SeedHookExecution['lifecyclePoint'] }
): Promise<SeedHookExecution[]>;
```

### 4.2 Behavior contract

**Shell hook:**
1. `child_process.spawn(commandParts[0], commandParts.slice(1), { cwd, env: { ...process.env, ...hook.env }, stdio: ['ignore', 'pipe', 'pipe'] })`
2. Set timer for `timeoutMs`. On expiry: `child.kill('SIGTERM')`, then `SIGKILL` after 5s grace.
3. Capture stdout + stderr (memory-bounded — drop after 64KB per stream to avoid OOM on chatty seeders).
4. Resolve with `{ ok: exitCode === 0, durationMs, exitCode, output: truncate(stdout, 500) }`.
5. Use `commandParts = parseShellCommand(hook.command)` — splits on whitespace, respects quoted strings. Implement minimally; do **not** invoke a shell interpreter (`sh -c`) unless the command contains shell metacharacters AND the user passes a magic prefix (e.g. `sh:`). Keep this conservative.

**Http hook:**
1. Resolve URL: if relative (no scheme), prefix with `appBaseUrl`. Throw if neither is set.
2. Serialize body: if undefined, no body; if string, send as-is; otherwise `JSON.stringify` and add `Content-Type: application/json` if absent.
3. AbortController with `timeoutMs` deadline.
4. `fetch(url, { method, headers, body, signal })`.
5. `expectedStatus` defaults to 200-299 range. Compare `response.status`.
6. Resolve with `{ ok: statusInRange, durationMs, status, output: truncate(await response.text(), 500) }`.

**Error handling:**
- Any thrown error → `{ ok: false, reason: String(err), durationMs }`.
- If `hook.continueOnError !== true` and `!ok`: caller (orchestrator) aborts the run.

### 4.3 Orchestrator integration in `cli/run.ts`

Insert lifecycle calls (pseudocode):

```ts
// Line ~135 — before SurfaceMCP probe
const beforeRunResults = await runSeedHooksAt(resolved.seedHooks?.beforeRun, {
  projectDir: opts.projectDir, appBaseUrl: resolved.appBaseUrl, lifecyclePoint: 'beforeRun'
});
seedHookTelemetry.push(...beforeRunResults);
if (beforeRunResults.some(r => !r.ok && !isContinueOnError(r))) {
  throw new Error(`seed: beforeRun failed: ${firstFailure(beforeRunResults).reason}`);
}

// Line ~150 — after browser-login (in the per-role login loop)
for (const role of effectiveRoles) {
  await loginInBrowser(...);
  const afterLoginResults = await runSeedHooksAt(resolved.seedHooks?.afterLogin, {
    projectDir: opts.projectDir, appBaseUrl: resolved.appBaseUrl, role, lifecyclePoint: 'afterLogin'
  });
  const perRoleResults = await runSeedHooksAt(resolved.seedHooks?.perRole?.[role], {
    projectDir: opts.projectDir, appBaseUrl: resolved.appBaseUrl, role, lifecyclePoint: 'perRole'
  });
  seedHookTelemetry.push(...afterLoginResults, ...perRoleResults);
  // Abort on hard failure unless continueOnError
}

// Line ~235 — before runExecute
const beforeExecuteResults = await runSeedHooksAt(resolved.seedHooks?.beforeExecute, {...});
seedHookTelemetry.push(...beforeExecuteResults);

// In a finally block — cleanup
try {
  // ... rest of run ...
} finally {
  const cleanupResults = await runSeedHooksAt(resolved.seedHooks?.cleanup, {...});
  seedHookTelemetry.push(...cleanupResults);
}
```

Pass `seedHookTelemetry` array to `runEmit` so it lands in `summary.json.seedHookExecutions`.

### 4.4 Telemetry on `summary.json`

```ts
seedHookExecutions: SeedHookExecution[];   // every hook run, in order
```

### 4.5 Logging

- Each hook start: `log.info('seed: hook starting', { lifecyclePoint, kind, description })`
- Each hook complete: `log.info('seed: hook complete', { lifecyclePoint, kind, ok, durationMs, exitCode/status })`
- Each hook fail (when not continueOnError): `log.error('seed: hook failed', { lifecyclePoint, kind, reason, output })`

---

## 5. Edge cases

### EC-1. Hook command not found
`spawn` resolves with `error.code === 'ENOENT'`. Treat as `{ ok: false, reason: 'command_not_found: <command>' }`.

### EC-2. Hook produces 1MB+ stdout
Stop capturing after 64KB per stream. Truncate to 500 chars in telemetry. Process kept alive until exit so the seeder can finish writing to disk.

### EC-3. HTTP hook URL is malformed
Caught at Zod validation time for absolute URLs. Relative URLs deferred to runtime — if `appBaseUrl` is unset, throw `seed: http hook with relative URL but no appBaseUrl`.

### EC-4. Cleanup throws during `finally`
Log a warning, do NOT re-throw. The run already has its primary result.

### EC-5. Hook calls a route that requires auth, but afterLogin hasn't fired yet
User error — document in spec. The order is `beforeRun` → discover → login → `afterLogin` → `perRole` → plan → `beforeExecute` → execute → emit → `cleanup`. If they need an authed seed call, put it in `afterLogin` or `perRole`, not `beforeRun`.

### EC-6. Concurrent runs against the same target
Out of scope. If two BugHunter instances run against one target with seed hooks, they race. Document in spec; consider a `--seed-mutex` flag in v0.16.

### EC-7. Per-role hooks for an unconfigured role
Silently skip with `log.info('seed: perRole hook skipped (role not in active roles)')`.

### EC-8. timeoutMs 0 or negative
Zod rejects (positive integer required).

### EC-9. Hook process spawns a long-running child that survives the parent
Best-effort cleanup via `process.kill(-pid)` on Node platforms that support process groups. On platforms that don't, log a warning and let the child orphan.

---

## 6. Test plan

### 6.1 Unit tests (`seed/runner.test.ts`)

- Shell hook: `echo hello` → `{ ok: true, output: "hello\n" }`
- Shell hook: `false` → `{ ok: false, exitCode: 1 }`
- Shell hook: command not found → `{ ok: false, reason: contains 'command_not_found' }`
- Shell hook: timeout → `{ ok: false, reason: contains 'timeout' }` after `SIGTERM`
- Shell hook: stdout > 64KB → truncated, hook still resolves
- HTTP hook (mocked fetch): 200 response → `{ ok: true, status: 200 }`
- HTTP hook: 500 response with `expectedStatus: 200` → `{ ok: false }`
- HTTP hook: 500 response with `expectedStatus: [200, 500]` → `{ ok: true }`
- HTTP hook: relative URL with appBaseUrl → resolves correctly
- HTTP hook: relative URL with no appBaseUrl → throws

### 6.2 Integration test (`tests/integration/seed-hooks.test.ts`)

Spin up a tiny test HTTP server. Configure a BugHunter run with `beforeRun` and `cleanup` hooks. Verify hook executions appear in `summary.json.seedHookExecutions` in the right order with the right `lifecyclePoint` values.

### 6.3 Smoke verification (manual, on Aspectv3)

1. Add a `beforeRun` shell hook to Aspectv3's `.bughunter/config.json` invoking `pnpm --filter @aspect/synthetic-seed seed -- --scale medium` (or equivalent — confirm the actual seed script in `/root/Aspectv3/package.json`).
2. Run the smoke as before.
3. Compare cluster count + new BugKinds against the empty-state baseline (run `ix35541uzes109c7t8z6poia` — 68 clusters, 4 distinct BugKinds).
4. Acceptance: ≥ 3 NEW distinct BugKinds OR ≥ 50% growth in cluster count, AND `seedHookExecutions[0].ok === true`.

---

## 7. Negative requirements

- Do **not** ship a SQL transport in v0.14.
- Do **not** add a runtime dep for HTTP (use built-in `fetch`).
- Do **not** invoke `sh -c` by default.
- Do **not** run hooks in parallel.
- Do **not** capture full stdout in telemetry — truncate at 500 chars.
- Do **not** allow hook output to leak into `bugs.jsonl`.
- Do **not** treat seed-hook failures as `BugDetection`s. They are infrastructure events; surface via `summary.json` and the structured logger.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `SeedHook*` + `SeedHooksConfig` types | `types.ts` | none |
| 2 | Add Zod schema for `seedHooks` block in `BugHunterConfig` | `config.ts` | 1 |
| 3 | Implement `seed/runner.ts` shell + http executors | `seed/runner.ts` (new) | 1, 2 |
| 4 | Wire `beforeRun` + `cleanup` lifecycle points | `cli/run.ts` | 3 |
| 5 | Wire `afterLogin` + `perRole` lifecycle points | `cli/run.ts` | 3 |
| 6 | Wire `beforeExecute` lifecycle point | `cli/run.ts` | 3 |
| 7 | Add `seedHookExecutions` to `summary.json` via `phases/emit.ts` | `phases/emit.ts`, `types.ts` | 3 |
| 8 | Unit tests for runner (10+ cases per §6.1) | `seed/runner.test.ts` (new) | 3 |
| 9 | Integration test with tiny test HTTP server | `tests/integration/seed-hooks.test.ts` (new) | 3-7 |
| 10 | Manual smoke against Aspectv3 with seed config | (manual) | 4-7 |

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All 10 unit tests pass | `npm test` |
| Integration test passes | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Aspectv3 smoke with `beforeRun` seed hook produces ≥3 new BugKinds OR ≥50% cluster growth vs. empty-state baseline | manual smoke + summary diff |
| `seedHookExecutions` appears in `summary.json` with one entry per hook run | `jq` over `summary.json` |
| Cleanup hook runs even when execute phase aborts on max_infra_failures | manual abort test |

---

## 10. Risks + escape hatches

- **Risk: a malicious `seedHooks.beforeRun` shell command opens a remote shell.** The user owns their config; this is no different from Make targets, npm scripts, or pre-commit hooks. We document the trust model: `bughunter.config.json` is trusted local config; do not load it from untrusted sources.
- **Risk: timeoutMs not honored on Windows.** Spec ships Linux/macOS support only for v0.14; on Windows, log a warning if process kill is best-effort.
- **Risk: HTTP hook against an authed endpoint without auth context.** The HTTP hook does NOT inherit BugHunter's session cookies. Document that auth-required seed calls must use `headers: { Authorization: 'Bearer <token>' }` set explicitly via `$env:` resolution, OR shell out to `curl` with the token.
- **Escape hatch:** `--no-seed` CLI flag disables ALL hooks. Useful for debugging detector issues without seed-data variance.

---

## 11. Killer-demo runbook (Aspectv3)

```bash
# 1. Identify Aspectv3's seed command
grep -A 2 '"perf:setup"\|"seed"' /root/Aspectv3/package.json

# 2. Add seed hook to /root/Aspectv3/.bughunter/config.json
{
  "seedHooks": {
    "beforeRun": [
      {
        "kind": "shell",
        "command": "pnpm --filter @aspect/synthetic-seed seed -- --scale small",
        "cwd": "/root/Aspectv3",
        "timeoutMs": 180000,
        "description": "Aspectv3 synthetic seed (small)"
      }
    ]
  }
}

# 3. Re-run smoke
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local \
  ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --max-bugs 100 --budget 2400000 --a11y --a11y-strict --seo

# 4. Compare against ix35541uzes109c7t8z6poia
diff <(jq '.byKind' /root/Aspectv3/.bughunter/runs/ix35541uzes109c7t8z6poia/summary.json) \
     <(jq '.byKind' /root/Aspectv3/.bughunter/runs/<NEW>/summary.json)
```

Expected: new BugKinds in `byKind` such as `dom_error_text` (real error states surface), additional `missing_state_change` (mutations that need rows), more `visual_anomaly` (table-clip findings on populated tables).

---

## 12. Open questions

1. Should `afterLogin` hooks include the role's session cookies as headers automatically? Spec says NO (caller responsibility) for v0.14 simplicity. Reconsider in v0.16.
2. Should a hook's `output` be added to `bugs.jsonl` when it correlates with a finding? Spec says NO — hooks are infrastructure, not bugs.
3. Should `beforeRun` run BEFORE or AFTER SurfaceMCP probe? Spec says BEFORE so a hook can spin up SurfaceMCP if needed. Confirm with @architect on review.
