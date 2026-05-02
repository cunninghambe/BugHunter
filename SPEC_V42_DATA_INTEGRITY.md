# SPEC — v0.42 "Data-integrity invariants"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.14 seed-data hooks (lifecycle plumbing, `SeedHookExecution` telemetry, `child_process`/`fetch` runner). **Sibling:** v0.16 active pen-testing (mutating-action coverage), v0.19 race conditions (lost-update overlap). **Phase:** E (`SPEC_PATH_TO_EXHAUSTIVE.md` §3.7, §9 Phase E).

This spec adds the `seedHooks.afterEach` lifecycle point and a declarative invariant DSL on top of it, so BugHunter can detect data-integrity classes that live entirely outside the browser surface: orphans after delete, decimal precision drift, cache staleness across mutate→read, idempotency-key replay duplication, audit-log absence on mutating actions, and soft-delete consistency. Every invariant violation becomes a typed `BugDetection` with one of six new `BugKind` values. Implementation reuses the v0.14 transport runners (shell + http); no new runtime deps.

---

## 1. Objective

Add one new lifecycle point — `seedHooks.afterEach` — that fires after every mutating action in the execute phase, plus a declarative invariant block (`BugHunterConfig.dataIntegrity.invariants[]`) that the after-each runner evaluates, comparing observed values against expectations. Failures emit a `BugDetection` with the matching `BugKind`. The user authors invariants once in config; BugHunter automatically attaches them to mutating actions and runs them in-band.

Six new `BugKind` values:

| BugKind | Triggers when |
|---|---|
| `data_integrity_orphan` | After a mutation, a `query` invariant returns rows in a downstream FK-related table whose parent row no longer exists. |
| `money_math_precision` | A money-typed field round-trips through the API and loses precision (`0.1 + 0.2 !== 0.3` storage), or a UI display value disagrees with stored value beyond tolerance. |
| `cache_staleness` | After a write, the next read of the same resource returns the pre-write state (read-after-write fails on the canonical read endpoint). |
| `idempotency_key_violation` | A `POST` replayed with the same `Idempotency-Key` header produces a different response body, a different `id`, or duplicates the underlying mutation (counted via a `count` query before/after). |
| `audit_log_missing_for_mutation` | A mutating action completed (2xx) but no audit-log entry referencing the action exists when the trusted audit endpoint is queried. |
| `soft_delete_consistency` | A soft-deleted row is still visible from a list endpoint that should hide it, OR is missing from an admin/audit endpoint that should include it. |

**In scope:**
- `seedHooks.afterEach` lifecycle wired into the execute loop in `runExecute`, fired only for actions whose `sideEffectClass === 'mutating'`.
- `BugHunterConfig.dataIntegrity` block with an `invariants[]` array of declarative checks: each carries `name`, `bugKind`, `appliesTo` (action filter), one or more `query` definitions (`http` or `shell`), and an `expectation` clause.
- Built-in expectation operators: `equals`, `notEquals`, `lengthEquals`, `lengthGte`, `lengthLte`, `numericEquals` (with `tolerance`), `contains`, `notContains`, `matches` (regex), `jsonPath` extraction.
- Per-invariant pre/post snapshotting: an invariant may declare `before` (snapshot before the mutation) and `after` (snapshot after) and the expectation operates on the `(before, after)` pair (e.g. `lengthDelta: 1`).
- A new `dataIntegrity` channel in `summary.json` reporting every invariant evaluation (pass and fail), shaped like `seedHookExecutions`.
- Six new `BugKind` enum entries with discriminated-union `extra` payloads on `BugDetection`.

**Out of scope (deferred):**
- SQL transport for invariants (use `kind: 'shell'` invoking `psql -c` if required) — v0.43.
- Generative property-based fuzzing of money fields — v0.46 (§3.4).
- Cross-process distributed-transaction integrity (saga checks) — v0.47.
- Auto-discovery of mutating endpoints' downstream tables — v0.45; for v0.42 the user lists them.
- Snapshot-and-restore of DB state between invariant runs — out of band; that is `pg_dump`/`pg_restore` territory.
- DOM-side display assertions for `money_math_precision` (e.g. `2.99` rendered as `2.989999`). v0.42 only catches API-level precision drift; UI drift is v0.44.
- Time-travel re-evaluation of past runs (the `dataIntegrity` block runs live; reading historical mutations and replaying them is v0.49).

**Acceptance target on Aspectv3:**
With three invariants configured (`orphan-after-project-delete`, `audit-log-on-mutation`, `idempotency-replay`), the next smoke run produces:
- ≥ 1 invariant evaluation per mutating action class (counts in `summary.json.dataIntegrity.evaluations`).
- 0 `surface_call_failed` bugs caused by the invariant runner itself.
- A clear `summary.json.dataIntegrity.violations[]` list when invariants fire (or empty array if Aspectv3 is healthy on these axes).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/seed/runner.ts` (created in v0.14) | The shell + http executors. **REUSE** these; do NOT fork. The invariant `query` payload is just a `SeedHook`-shaped descriptor that returns parseable output. |
| `packages/cli/src/types.ts` | `BugKind` enum (line ~23), `BugDetection` shape (line ~700+), `SeedHookExecution`. Add six new BugKind entries. ADD to this file; do NOT create a new types file. |
| `packages/cli/src/config.ts` | Zod schema for `BugHunterConfig`. ADD a `dataIntegritySchema` and reference it from `BugHunterConfigSchema`. |
| `packages/cli/src/cli/run.ts` | Orchestrator. Today wires five lifecycle points (line ~135 beforeRun, ~150 afterLogin, ~235 beforeExecute, finally cleanup). **DO NOT** add the `afterEach` plumbing here — see `phases/execute.ts`. |
| `packages/cli/src/phases/execute.ts` | The execute loop. Each action is dispatched here; this is where we insert the post-action invariant evaluation. Read carefully — this is the integration point. |
| `packages/cli/src/types.ts` (Action / SideEffectClass) | `SideEffectClass = 'safe' \| 'mutating' \| 'external'` (line 105). The `afterEach` only fires on `'mutating'`. |
| `packages/cli/src/store/filesystem.ts` | `runPaths(projectDir, runId)`. Telemetry emits to `runs/<runId>/data-integrity.jsonl` (one row per evaluation). |
| `packages/cli/src/phases/emit.ts` | Aggregator that builds `summary.json`. Add a new `dataIntegrity` channel summary. |
| `packages/cli/src/log.ts` | Structured logger. Use it; never `console.log` from invariant code. |
| `SPEC_V14_SEED_DATA_HOOKS.md` §4.2 | The runner contract is fixed. Re-read before extending. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §3.7 | Source-of-truth for the seven classes; only six map to BugKinds in v0.42 (lost-updates rolls into v0.19). |

### 2.2 Patterns to follow

- **Discriminated unions over string conventions.** Invariant kinds, expectation operators, and query transports are all discriminated unions on `kind` / `op`. No string switches scattered across files.
- **Reuse v0.14 transport.** A `query` is a `{ kind: 'http', method, url, headers?, body? }` or `{ kind: 'shell', command, cwd? }`. Internally call `runSeedHook(...)` and parse `output`. Do not implement a second HTTP/shell stack.
- **Snapshots are queries that ran earlier.** A `before` snapshot is the same query shape; the runner stores its parsed output keyed by `(invariant.name, action.id)` and compares in the after-pass.
- **Tolerance on numeric compare.** Default `tolerance: 0` (strict). Money invariants set `tolerance: 0.005` typically.
- **No silent skips.** If an invariant cannot evaluate (e.g. its `query` failed), emit a `BugDetection` with `bugKind: 'surface_call_failed'` AND a `dataIntegrity.evaluations[]` row with `ok: false, reason: 'query_failed'` — do not silently ignore.
- **Per-invariant timeout.** Default 30s (vs 60s for v0.14 hooks). Invariants run inside the execute loop; long invariants slow the run.

### 2.3 DO NOT

- Do **not** introduce a new `dataIntegrity/runner.ts` if `seed/runner.ts` already covers it. The invariant evaluator is `dataIntegrity/evaluator.ts` and **calls** the seed runner; the seed runner stays single-source.
- Do **not** include invariant evaluation results inside `seedHookExecutions`. They go to a separate `dataIntegrity.evaluations` channel for clarity.
- Do **not** allow invariants to mutate state. Queries are read-only by contract; an invariant authoring a `POST /admin/clear` is a config bug, not a feature. Document but do not enforce technically (we cannot tell).
- Do **not** auto-attach invariants to non-mutating actions. Mutating-only is the contract; otherwise we'd evaluate against every page load and burn the budget.
- Do **not** add a runtime dep for JSONPath. Implement the dotted-path subset already used in v0.18 (`a.b.c`, `a[0].b`). If a real JSONPath need surfaces, defer to v0.43.
- Do **not** promote `data_integrity_orphan` etc. into `bugs.jsonl` from inside the runner. Emit them through the existing `BugDetection` builder so dedupe + cluster + suppress all work as usual.
- Do **not** parallelize `afterEach` invariants for one action; run sequentially. (Two actions in different phases ARE parallel in execute already; per-action invariants stay sequential within their action's branch.)
- Do **not** require all invariants to run for every mutating action. The `appliesTo` filter narrows by route pattern, HTTP method, action `palette`, or explicit list of action IDs.

---

## 3. Per-BugKind subsection

### 3.1 `data_integrity_orphan`

**Signal:** After a `DELETE /api/projects/:id` action returns 2xx, a query against `/api/issues?projectId=:id` (or a downstream FK relation) still returns rows. Those rows are orphans — their parent project no longer exists.

**Invariant shape:**
```jsonc
{
  "name": "no-orphan-issues-after-project-delete",
  "bugKind": "data_integrity_orphan",
  "appliesTo": { "method": "DELETE", "urlPattern": "^/api/projects/[^/]+$" },
  "extract": { "parentId": { "from": "actionUrl", "regex": "/api/projects/([^/]+)" } },
  "after": {
    "query": { "kind": "http", "method": "GET", "url": "/api/issues?projectId={{parentId}}&includeDeleted=false" },
    "parse": "json",
    "expect": { "op": "lengthEquals", "jsonPath": "data", "value": 0 }
  }
}
```

**Edge cases:**
- Parent ID embedded in body, not URL: `extract.parentId.from = "actionRequestBody"`, `jsonPath: "id"`.
- Multi-table FK fan-out (issues + comments + attachments): user authors three invariants, one per downstream table. v0.43 may add `queries[]` for fan-out.
- The `?includeDeleted=false` is critical — without it, the API may return soft-deleted children and we falsely fire. v0.42 documents that the user must construct queries that match the production "live" semantics.
- Cascading deletes: if the API guarantees cascade, this invariant just stays at length 0 and never fires. That's fine. The invariant is the spec the API claims to honor; if it does, we never see violations.

**`extra` payload on the BugDetection:**
```ts
{ kind: 'data_integrity_orphan', invariantName: string, parentId: string, downstreamTable: string, orphanCount: number, sampleOrphanIds: string[] /* up to 5 */ }
```

### 3.2 `money_math_precision`

**Signal:** A money-typed field, after a write, comes back from the API as a value that disagrees with what was sent beyond a configured tolerance. Classic case: send `0.1 + 0.2`, server stores `0.30000000000000004` (FP) instead of `0.30` (decimal/int-cents).

**Invariant shape:**
```jsonc
{
  "name": "invoice-amount-roundtrip",
  "bugKind": "money_math_precision",
  "appliesTo": { "method": "POST", "urlPattern": "^/api/invoices$" },
  "injectInputs": [
    { "field": "amount", "values": [0.1, 0.2, 0.3, 9999999.99, 0.000001] }
  ],
  "after": {
    "query": { "kind": "http", "method": "GET", "url": "/api/invoices/{{responseId}}" },
    "parse": "json",
    "expect": { "op": "numericEquals", "jsonPath": "amount", "value": "{{sentAmount}}", "tolerance": 0.005 }
  }
}
```

**Edge cases:**
- Server stores in cents (integer), API returns `amount` as integer cents. The invariant compares `sentAmount * 100 === returnedCents` — the user expresses this with a `transform: "multiplyBy: 100"` clause. v0.42 supports `multiplyBy`, `divideBy`, `parseFloat`, `parseInt`; nothing more.
- Currency-scoped tolerance: USD $0.01 tolerance is sane; BTC tolerance is `1e-8`. Per-invariant `tolerance` covers it.
- The `injectInputs` clause is the single mutation point where v0.42 actively shapes the action's input. Otherwise invariants are passive observers. **This is the one place v0.42 touches the planner.**
- Display drift (UI shows `$2.989999` vs API `2.99`) — out of scope; v0.44.

**`extra`:**
```ts
{ kind: 'money_math_precision', invariantName: string, sentValue: number, storedValue: number | string, tolerance: number, field: string }
```

### 3.3 `cache_staleness`

**Signal:** After a `PATCH /api/users/me { name: 'New' }`, the next `GET /api/users/me` returns the old name. The cache (browser, CDN, server-side) is serving stale.

**Invariant shape:**
```jsonc
{
  "name": "user-name-read-after-write",
  "bugKind": "cache_staleness",
  "appliesTo": { "method": "PATCH", "urlPattern": "^/api/users/me$" },
  "extract": { "newName": { "from": "actionRequestBody", "jsonPath": "name" } },
  "after": {
    "query": { "kind": "http", "method": "GET", "url": "/api/users/me", "headers": { "Cache-Control": "no-cache" } },
    "parse": "json",
    "expect": { "op": "equals", "jsonPath": "name", "value": "{{newName}}" }
  }
}
```

**Edge cases:**
- ETag/If-None-Match could 304 the read and return no body. Force `Cache-Control: no-cache` AND `Pragma: no-cache`; document.
- Eventually-consistent backends (Cassandra, Dynamo) — give the read a small grace window via `retry: { count: 3, delayMs: 200 }`. Default no retry; the user opts in.
- Read-your-own-write semantics may differ between user-scoped and admin-scoped reads. The invariant runs in the same session as the mutation by default (uses the role's cookie jar / Authorization header from the active execute context). Admin-scoped reads need `useRole: 'admin'` (deferred to v0.43; v0.42 always uses the action's role).

**`extra`:**
```ts
{ kind: 'cache_staleness', invariantName: string, expectedValue: unknown, observedValue: unknown, fieldPath: string }
```

### 3.4 `idempotency_key_violation`

**Signal:** Replay a `POST /api/payments` with the same `Idempotency-Key` header. Per RFC, the second call MUST return the same response (same `id`) and MUST NOT mutate twice. Detection: invariant captures `before` count of payments, executes the action, replays it once with the same key, compares response bodies, and re-counts.

**Invariant shape:**
```jsonc
{
  "name": "payments-idempotency",
  "bugKind": "idempotency_key_violation",
  "appliesTo": { "method": "POST", "urlPattern": "^/api/payments$" },
  "before": {
    "query": { "kind": "http", "method": "GET", "url": "/api/payments?count=1" },
    "parse": "json",
    "store": { "totalCount": "data.total" }
  },
  "replay": { "withSameIdempotencyKey": true, "expectSameResponseShape": true },
  "after": {
    "query": { "kind": "http", "method": "GET", "url": "/api/payments?count=1" },
    "parse": "json",
    "expect": { "op": "equals", "jsonPath": "data.total", "value": "{{before.totalCount + 1}}" }
  }
}
```

**Edge cases:**
- If the action did NOT include an `Idempotency-Key` header, the invariant logs `skipped: no-idempotency-key` and emits no bug. (The lack of an idempotency key on a mutating endpoint is a separate concern — could be a future BugKind, deferred.)
- Replay timing: replay immediately after the original, same session, same headers (including the idempotency key). Document a 100ms gap between original and replay to avoid in-flight collisions.
- 2nd replay returning a different status (e.g. `409 Conflict` instead of `200 OK`) — that's also a violation; the invariant compares `status` AND body shape.
- Body byte-equality is too strict (timestamps differ). The expectation by default checks `id`, not full body. User can override with explicit `jsonPath`.

**`extra`:**
```ts
{ kind: 'idempotency_key_violation', invariantName: string, idempotencyKey: string, originalResponse: { status: number; bodySnippet: string }, replayResponse: { status: number; bodySnippet: string }, mutationCounted: boolean }
```

### 3.5 `audit_log_missing_for_mutation`

**Signal:** A mutating action completed 2xx, but the trusted audit endpoint (`GET /api/audit-log?since=<ts>&actor=<user>`) shows no entry referencing the action.

**Invariant shape:**
```jsonc
{
  "name": "audit-log-on-mutation",
  "bugKind": "audit_log_missing_for_mutation",
  "appliesTo": { "method": ["POST", "PATCH", "PUT", "DELETE"] },
  "before": {
    "query": { "kind": "http", "method": "GET", "url": "/api/audit-log?actor={{currentUserId}}&limit=1" },
    "parse": "json",
    "store": { "lastEntryId": "data[0].id", "lastEntryTs": "data[0].ts" }
  },
  "after": {
    "query": { "kind": "http", "method": "GET", "url": "/api/audit-log?actor={{currentUserId}}&since={{before.lastEntryTs}}" },
    "parse": "json",
    "expect": { "op": "lengthGte", "jsonPath": "data", "value": 1 }
  }
}
```

**Edge cases:**
- Audit log is async (queued, written within ~1s). The invariant supports `retry: { count: 5, delayMs: 500 }` to accommodate; default is 1 immediate check.
- Audit-log endpoint requires admin role — same role-scoping caveat as cache_staleness. v0.42 limits to the action's session. If audit endpoint isn't reachable from the current role, log a `surface_call_failed` and move on.
- High-frequency mutations may produce multiple audit entries — a `lengthGte: 1` is correct; we don't insist on exactly-one.
- Idempotent re-reads (GET) shouldn't produce audit entries. The `appliesTo.method` filter excludes them.

**`extra`:**
```ts
{ kind: 'audit_log_missing_for_mutation', invariantName: string, actionMethod: string, actionUrl: string, actionResponseStatus: number, auditWindowMs: number }
```

### 3.6 `soft_delete_consistency`

**Signal:** After `DELETE /api/users/:id` (soft-delete contract), the user is absent from `GET /api/users` (live list) but present in `GET /api/admin/users?includeDeleted=true` (admin/audit view).

**Invariant shape:**
```jsonc
{
  "name": "user-soft-delete-consistency",
  "bugKind": "soft_delete_consistency",
  "appliesTo": { "method": "DELETE", "urlPattern": "^/api/users/[^/]+$" },
  "extract": { "userId": { "from": "actionUrl", "regex": "/api/users/([^/]+)" } },
  "after": {
    "queries": [
      {
        "name": "absent-from-live",
        "query": { "kind": "http", "method": "GET", "url": "/api/users" },
        "parse": "json",
        "expect": { "op": "notContains", "jsonPath": "data[*].id", "value": "{{userId}}" }
      },
      {
        "name": "present-in-admin",
        "query": { "kind": "http", "method": "GET", "url": "/api/admin/users?includeDeleted=true" },
        "parse": "json",
        "expect": { "op": "contains", "jsonPath": "data[*].id", "value": "{{userId}}" }
      }
    ]
  }
}
```

**Edge cases:**
- The two-query pattern is the first time `after.queries[]` (plural) appears. v0.42 supports it: any failed sub-query → fire the bug (extra payload reports which sub-query failed).
- Hard-delete APIs (no soft-delete): the second sub-query returns the user absent → invariant fires `soft_delete_consistency` with `extra.failureMode: 'hard_delete_detected'`. That's the user's contract violation, not ours.
- Pagination — if `/api/users` returns 25 of 1000, the user might be on page 5 and we falsely think "absent". The invariant requires the user to scope queries to find-by-id (`/api/users?id={{userId}}`) or accept the pagination noise. v0.42 documents this; v0.43 may add a `paginate: 'all'` automatic walk.

**`extra`:**
```ts
{ kind: 'soft_delete_consistency', invariantName: string, userId: string, failureMode: 'still_in_live_list' | 'absent_from_admin_view' | 'hard_delete_detected', subQueryName: string }
```

---

## 4. Invariant DSL

### 4.1 Top-level shape (`packages/cli/src/types.ts`)

```ts
export type DataIntegrityInvariantBugKind =
  | 'data_integrity_orphan'
  | 'money_math_precision'
  | 'cache_staleness'
  | 'idempotency_key_violation'
  | 'audit_log_missing_for_mutation'
  | 'soft_delete_consistency';

export type AppliesToFilter = {
  method?: string | string[];                  // 'POST' or ['POST','PATCH']
  urlPattern?: string;                         // regex, anchored as authored
  palette?: PaletteVariant | PaletteVariant[];
  actionIds?: string[];                        // exact match override
};

export type ExtractClause = {
  // Where to read from
  from: 'actionUrl' | 'actionRequestBody' | 'actionResponseBody' | 'actionRequestHeaders' | 'beforeSnapshot' | 'literal';
  // How to extract
  regex?: string;                              // capture group 1
  jsonPath?: string;                           // dotted path; supports `[N]` and `[*]`
  literal?: string | number;                   // when from === 'literal'
};

export type ExpectationOp =
  | 'equals' | 'notEquals'
  | 'lengthEquals' | 'lengthGte' | 'lengthLte'
  | 'numericEquals'                            // requires `tolerance`
  | 'contains' | 'notContains'
  | 'matches';                                 // regex

export type Expectation = {
  op: ExpectationOp;
  jsonPath?: string;                           // path into parsed query result
  value: unknown;                              // template-resolved against snapshots
  tolerance?: number;                          // for numericEquals
};

export type InvariantQuery = {
  query: SeedHook;                             // reuse v0.14 SeedHook shape (kind: 'http' | 'shell')
  parse: 'json' | 'text' | 'jsonl' | 'integer';
  store?: Record<string, string>;              // jsonPath -> snapshot key
  expect?: Expectation;
  retry?: { count: number; delayMs: number };
  timeoutMs?: number;                          // default 30000
  name?: string;                               // optional, for multi-query after.queries[]
};

export type InvariantPhase = InvariantQuery | { queries: InvariantQuery[] };

export type DataIntegrityInvariant = {
  name: string;
  bugKind: DataIntegrityInvariantBugKind;
  description?: string;
  appliesTo: AppliesToFilter;
  extract?: Record<string, ExtractClause>;     // bound to `{{key}}` templates
  injectInputs?: { field: string; values: unknown[] }[]; // money_math_precision only in v0.42
  before?: InvariantPhase;
  replay?: { withSameIdempotencyKey: boolean; expectSameResponseShape: boolean };
  after?: InvariantPhase;                      // required (the assertion lives here)
  continueOnError?: boolean;                   // default false: query failures emit surface_call_failed
};

export type DataIntegrityConfig = {
  invariants: DataIntegrityInvariant[];
  enabled?: boolean;                           // default true; --no-data-integrity flag flips to false
};

// Add to BugHunterConfig:
export type BugHunterConfig = {
  // ... existing fields ...
  dataIntegrity?: DataIntegrityConfig;
};
```

### 4.2 Template resolution

`{{key}}` placeholders resolve against, in priority order: (1) the invariant's `extract` map, (2) `before.store` snapshot keys (prefix: `before.`), (3) the action's runtime context (`currentUserId`, `responseId`, `sentAmount`, `actionUrl`, `actionResponseStatus`). One pass; no nested templates. Arithmetic in templates (`{{before.totalCount + 1}}`) is supported via a tiny safe-eval (`+`, `-`, `*`, `/` on numbers only — no function calls, no variable references except snapshot keys). If the parser sees anything it can't classify, it throws `invariant_template_invalid` and the invariant logs `surface_call_failed` for that action.

### 4.3 Zod schema (`packages/cli/src/config.ts`)

`dataIntegritySchema` is a discriminated structure: each invariant carries `bugKind`, `appliesTo`, etc. all enforced. A `superRefine` cross-checks: `bugKind: 'idempotency_key_violation'` requires `replay`; `bugKind: 'money_math_precision'` requires `injectInputs`; the rest require `after`.

### 4.4 Evaluation contract (`packages/cli/src/dataIntegrity/evaluator.ts`, new file)

```ts
export type InvariantEvaluation = {
  invariantName: string;
  bugKind: DataIntegrityInvariantBugKind;
  actionId: string;
  durationMs: number;
  ok: boolean;                                  // true: passed (or skipped); false: violated
  outcome: 'passed' | 'violated' | 'skipped' | 'query_failed';
  reason?: string;                              // when not ok
  before?: Record<string, unknown>;             // snapshot store
  after?: Record<string, unknown>;
  detectionEmitted?: boolean;                   // true when it produced a BugDetection
};

export async function evaluateInvariantsForAction(
  invariants: DataIntegrityInvariant[],
  action: Action,
  actionResult: ActionResult,
  ctx: { projectDir: string; appBaseUrl: string; role?: string; runId: string }
): Promise<InvariantEvaluation[]>;
```

Internally calls `runSeedHook(invariant.before.query, ...)`, then re-runs the action's mutation (only when `replay` is set), then `runSeedHook(invariant.after.query, ...)`, then evaluates `expectation` against the parsed result, emits a `BugDetection` if violated.

### 4.5 BugDetection extension

Add a discriminated `extra` for each new BugKind, all under one umbrella `DataIntegrityExtra` discriminated union. Reuse the existing `BugDetection.extra: unknown` slot — at the type-narrowing layer only, downstream code matches on `bug.kind` to pull out typed `extra`. (Pattern already used by v0.6 perf and v0.16 pen-test extras.)

---

## 5. Integration with `seedHooks` (lifecycle)

### 5.1 New lifecycle point: `afterEach`

`SeedHookExecution.lifecyclePoint` gains one literal: `'afterEach'`. Add `'afterEach'` to v0.14's union:

```ts
lifecyclePoint: 'beforeRun' | 'afterLogin' | 'perRole' | 'beforeExecute' | 'afterEach' | 'cleanup';
```

`SeedHooksConfig` does NOT gain an `afterEach: SeedHook[]` field. Instead, `afterEach` is the implicit lifecycle point at which `dataIntegrity.invariants` evaluate. The naming is shared so future user-authored after-each hooks (v0.43) can plug into the same point without a new lifecycle slot.

### 5.2 Wiring in `phases/execute.ts`

The execute loop dispatches each action via `runAction(action, ctx)`. After `runAction` returns and BEFORE the next action is dequeued:

```ts
for (const action of plan.actions) {
  const actionResult = await runAction(action, ctx);
  recordResult(actionResult);

  // v0.42: data-integrity invariants on mutating actions only
  if (action.sideEffectClass === 'mutating' && resolved.dataIntegrity?.enabled !== false) {
    const matching = filterInvariants(resolved.dataIntegrity?.invariants ?? [], action);
    if (matching.length > 0) {
      const evaluations = await evaluateInvariantsForAction(matching, action, actionResult, {
        projectDir, appBaseUrl, role: ctx.role, runId
      });
      ctx.dataIntegrityEvaluations.push(...evaluations);
      for (const e of evaluations) {
        if (e.outcome === 'violated') {
          emitBugDetection(buildDataIntegrityDetection(e, action, actionResult));
        } else if (e.outcome === 'query_failed' && !e.continueOnError) {
          emitBugDetection({ kind: 'surface_call_failed', /* attribution */ });
        }
      }
    }
  }
}
```

Note: the invariant phase order around the action is `[before snapshot] → action runs → [replay, optional] → [after snapshot] → [expectation evaluation] → next action`. The `before` snapshot ALSO needs to be captured BEFORE `runAction` if the invariant declares `before`. The cleanest approach: move the matching-and-snapshotting step to PRE-action, the assertion step to POST-action, with state stored in `ctx.pendingInvariantSnapshots`.

```ts
// Pre-action
const pending = await snapshotInvariantsBefore(matching, action, ctx);
const actionResult = await runAction(action, ctx);
const evaluations = await evaluateInvariantsAfter(pending, action, actionResult, ctx);
```

This is the correct shape; the simplified pseudocode above is approximate.

### 5.3 Telemetry

- Per-evaluation row appended to `runs/<runId>/data-integrity.jsonl` (one JSON per line, same JSONL pattern as `bugs.jsonl`).
- Aggregate in `summary.json.dataIntegrity`:
  ```ts
  {
    enabled: boolean;
    invariantsConfigured: number;
    actionsEvaluated: number;
    evaluations: { passed: number; violated: number; skipped: number; queryFailed: number };
    violations: Array<{ invariantName: string; bugKind: DataIntegrityInvariantBugKind; actionId: string }>;
    durationMsTotal: number;
  }
  ```
- Per-evaluation log line at info: `data_integrity: invariant evaluated`, with `{ invariantName, actionId, outcome, durationMs }`.

### 5.4 Budget accounting

Each invariant `query` counts against the global `--budget` budget the same way as a `surface_call`. Invariants that are slow (DB-walks > 1s) eat budget visibly; the user can see this in `summary.json.dataIntegrity.durationMsTotal` and trim their invariants.

---

## 6. CLI

### 6.1 Flags

| Flag | Default | Behavior |
|---|---|---|
| `--no-data-integrity` | invariants run if configured | Disable evaluation; invariants still parse-validated for config-correctness. |
| `--data-integrity-only <invariantName>` | all match | Only run the named invariant(s); pass multiple times for multiple. |
| `--data-integrity-explain` | off | Emit a per-action summary table of which invariants matched and their outcomes; written to `runs/<runId>/data-integrity-explain.txt`. |
| `--data-integrity-dry-run` | off | Parse and match invariants but do not execute queries; useful for config validation. |

### 6.2 Sub-command: `bughunter dataIntegrity check`

Standalone validator: parses config, checks `appliesTo` against the project's known route map (if `routes.json` exists), warns on invariants with no possible matching action. Prints a table:

```
INVARIANT                            BUGKIND                           MATCHES   STATUS
no-orphan-issues-after-project-del   data_integrity_orphan             3 routes  ok
audit-log-on-mutation                audit_log_missing_for_mutation    11 routes ok
payments-idempotency                 idempotency_key_violation         0 routes  WARN: no matching route
```

### 6.3 `bughunter detectors --kind data_integrity_orphan`

Per the §3.9 single-detector promise. Returns:
- Description
- Inputs required (e.g. `appliesTo.method`, `appliesTo.urlPattern`, downstream FK target)
- A minimal example invariant
- Telemetry path: `summary.json.dataIntegrity.violations[]`

---

## 7. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| Six new BugKind values present in the enum and exported. | `grep -c data_integrity_orphan packages/cli/src/types.ts` ≥ 1 |
| Zod schema validates the §4 DSL example configs round-trip. | `npm test -- dataIntegrity/config.test` |
| `evaluator.ts` unit tests cover all six BugKinds (one happy + one violated per kind). | `npm test -- dataIntegrity/evaluator.test` |
| Template resolution unit tests: literal, snapshot, arithmetic, missing-key error. | `npm test -- dataIntegrity/template.test` |
| Filter unit tests: `appliesTo.method` (string + array), `urlPattern`, `actionIds`, palette. | `npm test -- dataIntegrity/filter.test` |
| `phases/execute.ts` integration test: a mock mutating action runs, an invariant evaluates, a violation produces a `BugDetection` in `bugs.jsonl`. | `npm test -- phases/execute.dataIntegrity.test` |
| `summary.json.dataIntegrity` channel populated with correct counts on a sample run. | `jq '.dataIntegrity' summary.json` |
| `--no-data-integrity` flag disables evaluation; no `data-integrity.jsonl` produced. | manual run |
| `bughunter dataIntegrity check` warns on misconfigured invariants. | manual on a fixture config |
| `npx tsc --noEmit` clean. | `tsc` |
| `npx eslint . --max-warnings 0` clean. | `eslint` |
| Aspectv3 smoke with three configured invariants reports `summary.json.dataIntegrity.actionsEvaluated >= 5` and `.evaluations.queryFailed === 0`. | manual smoke + jq |
| No regression on v0.14 `seedHookExecutions` shape. | `jq '.seedHookExecutions' summary.json` against pre-v0.42 baseline |

---

## 8. Files

### 8.1 New files

| Path | Purpose |
|---|---|
| `packages/cli/src/dataIntegrity/types.ts` | All v0.42-specific types (invariant DSL, evaluation result, extras). May be inlined into `cli/src/types.ts` if cleaner — author's call, but ONE source of truth. |
| `packages/cli/src/dataIntegrity/config.ts` | Zod schemas for `DataIntegrityConfig` and re-export from `cli/src/config.ts`. |
| `packages/cli/src/dataIntegrity/filter.ts` | `filterInvariants(invariants, action)` — pure function. |
| `packages/cli/src/dataIntegrity/template.ts` | `resolveTemplate(template, context)` — pure function with the safe-eval arithmetic. |
| `packages/cli/src/dataIntegrity/evaluator.ts` | `evaluateInvariantsForAction`, `snapshotInvariantsBefore`, `evaluateInvariantsAfter`. Calls `seed/runner.ts`. |
| `packages/cli/src/dataIntegrity/buildDetection.ts` | Per-BugKind detection-builder (one switch over `bugKind`). |
| `packages/cli/src/dataIntegrity/__tests__/*.test.ts` | Unit tests, co-located. |
| `packages/cli/src/cli/data-integrity-check.ts` | The `bughunter dataIntegrity check` sub-command. |
| `tests/integration/data-integrity.test.ts` | Integration test with a tiny test HTTP server (mirror v0.14's `seed-hooks.test.ts`). |

### 8.2 Modified files

| Path | Change |
|---|---|
| `packages/cli/src/types.ts` | Add six BugKind entries; add `DataIntegrityConfig` to `BugHunterConfig`; add `'afterEach'` to `lifecyclePoint` union. |
| `packages/cli/src/config.ts` | Wire `dataIntegritySchema` into `BugHunterConfigSchema`. |
| `packages/cli/src/phases/execute.ts` | Add pre/post invariant hooks per §5.2. Touch ONLY the action-loop boundary; do NOT touch action dispatch. |
| `packages/cli/src/phases/emit.ts` | Add `dataIntegrity` channel to `summary.json`. |
| `packages/cli/src/store/filesystem.ts` | Add `runPaths().dataIntegrityJsonl` accessor. |
| `packages/cli/src/cli/main.ts` | Register the four CLI flags; wire `dataIntegrity check` sub-command. |
| `packages/cli/src/seed/runner.ts` | NO CHANGES. Re-used as-is. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §3.7 | Add a back-link footnote: "Implemented in v0.42." |

### 8.3 DO NOT create

- A second HTTP/shell runner.
- A new top-level `dataIntegrity/` directory at the repo root (lives under `packages/cli/src`).
- A new types file in `packages/cli/src/types/` — extend `types.ts`.
- An npm dep for JSONPath, regex parsing, or arithmetic.

---

## 9. Definition of Done

- All six BugKinds enumerated, typed, schema'd, tested.
- Invariants evaluated against a mutating action in execute, violations land in `bugs.jsonl` with cluster + dedupe still working.
- `summary.json.dataIntegrity` populated per §5.3.
- `--no-data-integrity`, `--data-integrity-only`, `--data-integrity-explain`, `--data-integrity-dry-run` flags wired.
- `bughunter dataIntegrity check` and `bughunter detectors --kind data_integrity_*` working.
- Aspectv3 smoke with three configured invariants passes the §1 acceptance target.
- Zero new runtime deps; reuse of v0.14 `seed/runner.ts` confirmed by import graph.
- `tsc --noEmit` and `eslint --max-warnings 0` clean.
- `seedHookExecutions` shape on `summary.json` unchanged for users not configuring invariants (back-compat).
- `BugDetection.extra` discriminated union compiles without `as` casts at any call site.

---

## 10. Open questions

1. **Should `afterEach` invariants run in their own session/cookie jar to avoid bleeding state into the action sequence?** Spec says NO — same session as the action, because audit-log endpoints are typically gated to the same role. But this means a query that returns thousands of rows pollutes the session's HTTP keepalive cache. If real perf hits surface, add an `isolatedSession: true` flag in v0.43.
2. **Is `injectInputs` the right shape, or should `money_math_precision` be a separate `--money-fuzz` mode rather than an invariant attribute?** It blurs the line between passive observers and active fuzzers. Keeping it on the invariant for now (one config block, one mental model). If detector-purity matters more than UX, split in v0.43.
3. **Should template arithmetic support comparison operators (`{{ before.count == after.count }}`)?** Probably yes for cleanliness, but a regex in `expect` is enough today. Hold v0.42 minimal.
4. **Should query failures be auto-retried by default, or always require explicit `retry`?** v0.42 says explicit. The default budget cost of one extra retry per invariant per action is high, and most APIs are read-after-write consistent.
5. **What's the right tolerance for `numericEquals` on money?** v0.42 ships with NO default — the user MUST set it. Saves us from accidentally being lenient on a strict-decimal API and hiding real bugs.
6. **Should `audit_log_missing_for_mutation` cover SAFE actions too (read access to PII rows)?** Yes long-term, but that's a different signal: read-audit, not write-audit. v0.42 limits to mutating; expand in v0.45.
7. **Should the invariant evaluator participate in the auto-fix coordination loop (§5.4 of the exhaustive spec)?** Not yet — auto-fix needs deterministic mode (§6.1), which is Phase C, not E. Listing as future hook only.
8. **Should `dataIntegrity.invariants` be loadable from a separate file (`bughunter.invariants.json`) for reuse across projects?** Likely yes, but a project-specific config is simpler today. Add an `invariantsFile` indirection in v0.43 once two projects share the same set.
9. **What happens to invariants when execute aborts on `max_infra_failures`?** Pending invariants do not run; their snapshots are dropped. Document in the runbook; do not try to flush.
