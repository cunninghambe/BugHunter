# SPEC — v0.27 "Cross-run history & regression tracking"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** `SPEC_PATH_TO_EXHAUSTIVE.md` Phase D (§ 4.2, § 6.6, § 7) · **Sibling:** v0.26 `bughunter detectors --last-fired` (provides per-kind last-fired query that this spec backs with the same `history.db`).

This spec implements the **cross-time** axis from the path-to-exhaustive roadmap. Today, every BugHunter run is a silo: the same root-cause bug gets a fresh `cuid` cluster id every run; there is no way to ask "did the bug we fixed last week regress" or "how long has this cluster been open." V27 fixes that by minting a stable `bugIdentity` at cluster time, persisting it to a SQLite history database alongside the existing per-run filesystem layout, and adding four cross-run commands (`diff`, `history`, `ingest`, `aging`) plus a `crossRun` field on `summary.json`.

The implementation is bounded: ~600 lines of code, one new dep (`better-sqlite3`), no schema migrations to existing artifacts, no changes to the cluster algorithm — `clusterSignature` already produces the stable input we need. The hard work is at the seam between phases (`cluster.ts` mints the identity), at the end-of-run hook (`emit.ts` writes the row), and at four new CLI commands.

---

## 1. Objective

Add cross-run regression tracking so that a long-lived BugHunter project can answer:

| Question | Answered by |
|---|---|
| Which clusters in this run are new vs. carried-over vs. regressed? | `bughunter diff <old> <new>` and `summary.json.crossRun` |
| How long has cluster X been open? | `bughunter history --bug-identity <id>` |
| Which clusters have lingered ≥N runs without a fix? | `bughunter aging --threshold <days>` |
| Did the bug fixed in run B come back in run D? | `crossRun.regressed` count + `bughunter diff` regressed bucket |
| Can I import bugs.jsonl from a teammate's run? | `bughunter ingest <path>` |

**In scope (V27):**
- Stable `bugIdentity` derived from `(projectName, clusterSignature)`, minted at cluster time, stored on every `BugCluster`.
- SQLite history DB at `.bughunter/history.db` with two tables (`runs`, `clusters`) and three indexes.
- Write-hook in `phases/emit.ts`: every successful run inserts one `runs` row and N `clusters` rows.
- Four new CLI subcommands: `diff`, `history`, `ingest`, `aging`.
- New `crossRun?` field on `RunSummary` populated at emit time by comparing this run to the previous run for the same `projectName`.
- One-shot `bughunter prune --rebuild-identity` flag for legacy runs whose clusters have no `bugIdentity` recorded.

**Out of scope (deferred):**
- Full SARIF emission detail — V27 emits a placeholder shape; V29 wires SARIF to `bughunter export --format sarif`.
- `bughunter bisect` — separate spec; v0.7.
- Linear / Jira / GitHub Issues sync (V29).
- Cross-project coordination (`bughunter projects scan`, `~/.bughunter/projects.json`).
- Severity calibration field (depends on V25; this spec consumes severity if present, but does not introduce the field itself).
- Migrating `BugKind`-level `last-fired` queries — V26 owns the surface; V27 only owns the storage.
- Daemonized history.db service. The DB is a single SQLite file, opened per-process, written synchronously, closed at end of run.
- Triage / suppression history tables — separate spec; this DB schema reserves no space for them.

**Acceptance target on the demo fixture (`fixtures/cross-run-demo/`):**
After three successive `bughunter run` invocations against the fixture (run-A introduces bug-X, run-B fixes bug-X, run-C re-introduces bug-X):
1. `bughunter diff <runA> <runB>` reports `gone: 1`, `new: 0`, `persistent: 0`, `regressed: 0` for bug-X's identity.
2. `bughunter diff <runB> <runC>` reports `regressed: 1`, `new: 0` for the same identity (because run-B's verdict was `verified_fixed`).
3. `bughunter history --bug-identity <X-id>` lists all three runs with the correct first-seen / last-seen.
4. `summary.json.crossRun.regressed` for run-C equals 1.
5. `bughunter ingest /tmp/foreign-bugs.jsonl --run-id <synth>` inserts rows; `bughunter history` then reflects them.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts:197-218` | `BugCluster` definition. **ADD** `bugIdentity?: string` field; do not create a new type. Note `signatureKey` already exists at `:217` — that is the input to `bugIdentity`. |
| `packages/cli/src/types.ts:1104-1180` | `RunSummary`. **ADD** `crossRun?` field. |
| `packages/cli/src/cluster/signature.ts:9-235` | `clusterSignature(detection)` — the stable signature used as both `signatureKey` and the `bugIdentity` input. **DO NOT MODIFY.** Read to understand: every BugKind has a deterministic case branch. The signature is the contract. |
| `packages/cli/src/phases/cluster.ts:62-144` | `runCluster()` mints clusters. **MODIFY** to assign `bugIdentity` at the same site where `signatureKey` is set (line ~95). Needs `projectName` passed in via `ClusterOptions`. |
| `packages/cli/src/phases/emit.ts:36-130` | `runEmit()` writes `bugs.jsonl` and `summary.json`. **MODIFY** to (a) compute `crossRun` by querying `history.db`, (b) write rows to `history.db` at the end. |
| `packages/cli/src/store/filesystem.ts:1-92` | Run-paths helpers. **ADD** `historyDbPath(projectDir)` returning `<projectDir>/.bughunter/history.db`. Do **not** add new run-level paths — the DB is project-level, not run-level. |
| `packages/cli/src/store/run-state.ts:1-42` | `RunState` persistence pattern. New `history.ts` module mirrors this style: pure functions, no global state, sync I/O. |
| `packages/cli/src/cli/list.ts:1-25` | The minimal CLI command pattern. New `diff.ts`, `history.ts`, `ingest.ts`, `aging.ts` follow the same shape: a single exported function, `process.stdout.write`, no global imports. |
| `packages/cli/src/cli/main.ts:79-220` | CLI dispatch. **ADD** four new `case` branches; **ADD** four new imports; **EXTEND** `USAGE` text. |
| `packages/cli/src/cli/prune.ts:1-14` | `prune` command pattern. **EXTEND** `prune` to accept `--rebuild-identity`. |
| `packages/cli/src/cli/run.ts:587` | `runEmit` call site — verify `projectName` is available in scope (it is, via `runState.config.projectName`). |
| `packages/cli/package.json` | **ADD** `better-sqlite3` to `dependencies`. |

### 2.2 Patterns to follow

- **Sync-only I/O.** The CLI is single-process, single-run, blocking. `better-sqlite3` is sync by design — don't reach for `sqlite` (async wrapper) or `sql.js` (WASM, slow).
- **Prepared statements.** Always `db.prepare(sql)` once at module init or function entry; `.run(params)` / `.all(params)` / `.get(params)` with bound params. **Never** `db.exec(template-literal-with-userdata)` — SQL injection.
- **Schema migration via `user_version`.** SQLite's `PRAGMA user_version` is a single integer set per DB. The history module inspects it on open and runs the next-version migration block when it lags. V27 ships `user_version = 1`.
- **One DB connection per CLI invocation.** Open at command start, close at command end. Do not pass the connection across module boundaries; pass `historyDbPath` and re-open in each helper. SQLite handles concurrent readers; concurrent writers serialize on the file lock.
- **Discriminated unions for diff buckets.** `DiffEntry` is a typed union: `{ bucket: 'new'|'persistent'|'gone'|'regressed', bugIdentity: string, ... }`. Drives table/json/sarif formatting via exhaustive switch.
- **CLI output style.** Tables go to stdout via `process.stdout.write` with column-aligned strings (no `cli-table` dep). JSON is `JSON.stringify(result, null, 2)`. SARIF is a placeholder JSON shape — TODO comment in code referencing V29.
- **No persistence ambiguity.** If `history.db` does not exist, the four read-side commands behave as if no history exists (empty results, exit 0 with informational message). The write-side happens at run-end and creates the DB on demand.

### 2.3 DO NOT

- Do **not** create new types for `BugCluster` or `RunSummary` — extend the existing types in `types.ts`.
- Do **not** modify `clusterSignature()`. The signature is the source of truth for `bugIdentity`. If it changes, that's a major version bump and a separate spec; the rebuild-identity prune flag is the migration path.
- Do **not** auto-migrate legacy runs. Old runs (`bugs.jsonl` written before V27) have no `bugIdentity` field. They sit in the filesystem unchanged. Only `bughunter prune --rebuild-identity` (opt-in) backfills them.
- Do **not** ship `better-sqlite3@*` — pin exact version.
- Do **not** add async wrappers around `better-sqlite3`. The lib is intentionally synchronous; that is the correct shape for a CLI.
- Do **not** open multiple DB connections in the same process. One `Database(path)` per command.
- Do **not** vacuum or compact the DB inside `bughunter run`. Vacuuming is opt-in via `bughunter prune --vacuum-history` (deferred to V28 — V27 just notes the open question).
- Do **not** swallow SQLite errors. Throw with the SQL + bind values redacted (params may contain bug content, but column names + error code are safe).
- Do **not** `JSON.parse` user-supplied JSONL line-by-line without Zod validation in `ingest`.
- Do **not** introduce a new run-state field for `bugIdentity`. It lives on `BugCluster`, period.

---

## 3. `bugIdentity` specification

### 3.1 Algorithm

```ts
import { createHash } from 'node:crypto';

export function computeBugIdentity(projectName: string, clusterSignature: string): string {
  return createHash('sha256')
    .update(projectName)
    .update(' ') // null byte separator: prevents projectName collisions like "fooBAR" vs "foo|BAR"
    .update(clusterSignature)
    .digest('hex')
    .slice(0, 16);
}
```

- **Input 1:** `projectName` from `BugHunterConfig.projectName` (`packages/cli/src/types.ts:956`). Required, non-empty (validated at config load).
- **Input 2:** the `clusterSignature` string already minted by `cluster/signature.ts:9` and stored as `BugCluster.signatureKey` (`types.ts:217`).
- **Output:** 16 lowercase hex chars (64 bits). Collision probability for 100k clusters across all BugHunter projects worldwide: ~3×10⁻¹⁰. Acceptable.
- **Stability:** any time the same `projectName` and the same `signatureKey` recur in any run, the same identity is produced. Project rename = new identity. Signature-algorithm change = new identity.

### 3.2 Where it is minted

In `phases/cluster.ts:80-96`, at the `clusterMap.set(sig, ...)` call site, alongside `signatureKey: sig`:

```ts
clusterMap.set(sig, {
  id: createId(),               // unchanged — per-run cuid for in-run cross-references
  runId,
  bugIdentity: computeBugIdentity(opts.projectName, sig),   // NEW
  // ...other fields unchanged
  signatureKey: sig,
});
```

`opts.projectName` is added to `ClusterOptions`. Run.ts:587 already has it via `runState.config.projectName` — pass it in.

### 3.3 Stability guarantees

- **Refactors that don't change behavior should NOT change identity.** Because `clusterSignature` is symptom-shaped (error-message-normalized + stack-fingerprint, or endpoint+status+body-shape, etc.), pure refactors typically preserve it. A renamed function preserves the stack fingerprint at the call site that triggers the bug; the message stays the same; the identity stays the same.
- **Refactors that DO change behavior MAY change identity.** A change to a normalized error message format, an endpoint-rename in the API tree, or a route-change in the SPA can produce a new identity. This is correct: the underlying bug instance is now in a different shape, and treating it as a new clue is honest.
- **Major version bumps to `cluster/signature.ts`** invalidate identity. The maintainer is responsible for documenting these in the changelog and offering `bughunter prune --rebuild-identity` to consumers. V27 ships with signature.ts at version 1 (per the file header — there is no version field today; V27 introduces a SIGNATURE_ALGO_VERSION = 1 constant in `cluster/signature.ts`, written into `runs.bughunter_version` only when needed).

### 3.4 Migration policy

- **Brand-new projects:** every cluster gets `bugIdentity` from day one. Trivial.
- **Existing projects upgrading to V27:** the next `bughunter run` mints `bugIdentity` for newly-minted clusters. Old runs sitting in `.bughunter/runs/<id>/bugs.jsonl` are not retroactively rewritten. They simply have no `bugIdentity` field; the read-side commands treat their clusters as identity-less and exclude them from `diff` / `history` / `aging` computations.
- **Opt-in backfill:** `bughunter prune --rebuild-identity` walks every run's `bugs.jsonl`, recomputes `bugIdentity` from `clusterSignature` (stored as `signatureKey` on every cluster), rewrites `bugs.jsonl` in-place (one shot, atomic via temp-file + rename), and re-populates `history.db`. Idempotent.
- **Fallback when `signatureKey` is missing on legacy clusters:** older clusters before `signatureKey` was added (pre-v0.16) cannot be rebuilt automatically. The prune command logs them and skips. Document.

---

## 4. History database specification

### 4.1 Location

`<projectDir>/.bughunter/history.db` — a SQLite file, project-scoped, sibling to `.bughunter/runs/`. **Not** committed to git (already covered by the standard `.bughunter/` ignore pattern; document the recommendation in `README.md` if not already).

### 4.2 Schema (`user_version = 1`)

```sql
-- Per-run summary; one row per `bughunter run` that completed (or partial-emitted).
CREATE TABLE runs (
  run_id              TEXT PRIMARY KEY,
  project_name        TEXT NOT NULL,
  started_at          TEXT NOT NULL,            -- ISO 8601 from RunState.startedAt
  ended_at            TEXT,                     -- NULL if partial; ISO 8601 otherwise
  total_clusters      INTEGER NOT NULL,
  config_hash         TEXT NOT NULL,            -- sha256(JSON.stringify(config)).slice(0,16)
  bughunter_version   TEXT NOT NULL             -- read from packages/cli/package.json
);

-- One row per (cluster, run) pair. The same `bug_identity` recurs across runs.
CREATE TABLE clusters (
  bug_identity        TEXT NOT NULL,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  cluster_id          TEXT NOT NULL,            -- the per-run cuid; for human cross-ref
  kind                TEXT NOT NULL,            -- BugKind
  cluster_size        INTEGER NOT NULL,
  root_cause          TEXT NOT NULL,            -- truncated to 4096 chars on insert
  verdict             TEXT,                     -- ClusterVerdict | NULL
  PRIMARY KEY (bug_identity, run_id)
);

CREATE INDEX clusters_by_run        ON clusters(run_id);
CREATE INDEX clusters_by_identity   ON clusters(bug_identity);
CREATE INDEX runs_by_project_started ON runs(project_name, started_at DESC);

-- Schema version stamp.
PRAGMA user_version = 1;
```

**Notes:**
- `ON DELETE CASCADE` on `clusters.run_id` enables `bughunter prune --keep <n>` to delete a run row and have its clusters rows go with it. (Prune integration is V28; V27 just installs the cascade.)
- `bug_identity` is **not** unique on its own — the whole point is that it recurs across runs.
- `root_cause` is truncated to 4096 chars at insert time. Real root causes are usually <500 chars; the cap prevents pathological detection records (e.g. a hydration-mismatch with a 200KB DOM diff) from bloating the DB.
- `runs_by_project_started` powers the "find the previous run for this project" query in `crossRun` computation.

### 4.3 `better-sqlite3` initialization pattern

`packages/cli/src/store/history.ts` (new file):

```ts
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugCluster, RunState, ClusterVerdict } from '../types.js';

export type HistoryDb = Database.Database;

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_clusters INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  bughunter_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
  bug_identity TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cluster_size INTEGER NOT NULL,
  root_cause TEXT NOT NULL,
  verdict TEXT,
  PRIMARY KEY (bug_identity, run_id)
);
CREATE INDEX IF NOT EXISTS clusters_by_run ON clusters(run_id);
CREATE INDEX IF NOT EXISTS clusters_by_identity ON clusters(bug_identity);
CREATE INDEX IF NOT EXISTS runs_by_project_started ON runs(project_name, started_at DESC);
`;

export function historyDbPath(projectDir: string): string {
  return path.join(projectDir, '.bughunter', 'history.db');
}

export function openHistoryDb(projectDir: string): HistoryDb {
  fs.mkdirSync(path.dirname(historyDbPath(projectDir)), { recursive: true });
  const db = new Database(historyDbPath(projectDir));
  db.pragma('journal_mode = WAL');         // crash-safe; concurrent readers
  db.pragma('foreign_keys = ON');           // ON DELETE CASCADE works
  migrate(db);
  return db;
}

function migrate(db: HistoryDb): void {
  const current = (db.pragma('user_version', { simple: true }) as number);
  if (current >= SCHEMA_VERSION) return;
  if (current === 0) {
    db.exec(SCHEMA_V1);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else {
    // Future schema bumps add `if (current < N) { ...migrationN; }` blocks here.
    throw new Error(`history.db user_version=${current} is newer than this BugHunter (${SCHEMA_VERSION}). Upgrade BugHunter or delete history.db.`);
  }
}
```

### 4.4 Write hook (called from `phases/emit.ts`)

```ts
export function writeRunToHistory(
  db: HistoryDb,
  runState: RunState,
  clusters: BugCluster[],
  bughunterVersion: string,
): void {
  const insertRun = db.prepare(
    `INSERT OR REPLACE INTO runs (run_id, project_name, started_at, ended_at, total_clusters, config_hash, bughunter_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCluster = db.prepare(
    `INSERT OR REPLACE INTO clusters (bug_identity, run_id, cluster_id, kind, cluster_size, root_cause, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    insertRun.run(
      runState.runId,
      runState.config.projectName,
      runState.startedAt,
      new Date().toISOString(),
      clusters.length,
      configHash(runState.config),
      bughunterVersion,
    );
    for (const c of clusters) {
      if (c.bugIdentity === undefined || c.bugIdentity === '') continue;  // legacy / mis-minted; skip
      insertCluster.run(
        c.bugIdentity,
        runState.runId,
        c.id,
        c.kind,
        c.clusterSize,
        c.rootCause.slice(0, 4096),
        c.verdict ?? null,
      );
    }
  });
  tx();
}
```

`configHash(config)` is `sha256(JSON.stringify(stripVolatile(config))).slice(0,16)`. `stripVolatile` removes fields like `apiKey` and `extraHeaders.Authorization` so two runs with the same logical config but different rotated keys get the same hash.

### 4.5 Read patterns (for diff / history / aging)

```ts
// All clusters in a run.
export function clustersForRun(db: HistoryDb, runId: string): ClusterRow[] {
  return db.prepare(`SELECT * FROM clusters WHERE run_id = ?`).all(runId) as ClusterRow[];
}

// All runs containing this bugIdentity, oldest first.
export function runsForIdentity(db: HistoryDb, bugIdentity: string): Array<RunRow & { verdict: ClusterVerdict | null }> {
  return db.prepare(
    `SELECT r.*, c.verdict
     FROM runs r INNER JOIN clusters c ON c.run_id = r.run_id
     WHERE c.bug_identity = ?
     ORDER BY r.started_at ASC`,
  ).all(bugIdentity) as Array<RunRow & { verdict: ClusterVerdict | null }>;
}

// Previous run for this project (for crossRun computation).
export function previousRunForProject(db: HistoryDb, projectName: string, excludingRunId: string): RunRow | undefined {
  return db.prepare(
    `SELECT * FROM runs
     WHERE project_name = ? AND run_id != ?
     ORDER BY started_at DESC LIMIT 1`,
  ).get(projectName, excludingRunId) as RunRow | undefined;
}

// Aging: bugIdentity that has appeared in ≥minRuns runs across ≥minDays days, never verified_fixed.
export function agingClusters(db: HistoryDb, projectName: string, minDays: number): AgingRow[] {
  return db.prepare(
    `SELECT
       c.bug_identity,
       c.kind,
       MIN(r.started_at) AS first_seen,
       MAX(r.started_at) AS last_seen,
       COUNT(DISTINCT c.run_id) AS run_count
     FROM clusters c
     INNER JOIN runs r ON r.run_id = c.run_id
     WHERE r.project_name = ?
       AND c.bug_identity NOT IN (
         SELECT bug_identity FROM clusters WHERE verdict = 'verified_fixed'
       )
     GROUP BY c.bug_identity, c.kind
     HAVING (julianday(MAX(r.started_at)) - julianday(MIN(r.started_at))) >= ?`,
  ).all(projectName, minDays) as AgingRow[];
}
```

---

## 5. Per-command specification

### 5.1 `bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind|severity>]`

**Signature:**
```ts
export function diffCommand(projectDir: string, opts: {
  runIdOld: string;
  runIdNew: string;
  format?: 'table' | 'json' | 'sarif';   // default 'table'
  filter?: { kind?: BugKind; severity?: Severity };
}): void;
```

**Algorithm:**
1. Open `history.db`. If absent → print "no history; run completed against fresh DB" and exit 0.
2. Validate both `runId`s exist; error with usage if not.
3. Load both runs' clusters into `Map<bugIdentity, ClusterRow>`.
4. Compute four buckets:
   - **new:** identity in `new` but not in `old`.
   - **persistent:** identity in both, neither verdict was `verified_fixed` in `old`.
   - **gone:** identity in `old` but not in `new`.
   - **regressed:** identity in both, AND `old.verdict === 'verified_fixed'` (so it had been confirmed gone, but is back).
5. Apply filter if set: by kind (exact match) or by severity (requires V25 severity field — if absent, log warning and ignore).
6. Render per `format`:
   - `table`: 4 sections, one per bucket, columns `bug_identity | kind | cluster_size | root_cause(truncated)`.
   - `json`: `{ runIdOld, runIdNew, buckets: { new: [...], persistent: [...], gone: [...], regressed: [...] }, generatedAt }`.
   - `sarif`: emit a minimal SARIF 2.1.0 JSON shape with `runs[0].results = [...]` populated from new + regressed buckets only. **Placeholder:** the result shape is correct enough to import into a SARIF viewer, but full taxonomy mapping (CWE, severity → SARIF level) is V29. Add a `// TODO(V29): taxonomy mapping` comment.
7. Exit code: `0` if no `regressed` and no `new` (with `--ci` flag, deferred); otherwise `0` for V27 (CI gating is V29).

**Filter syntax:**
- `--filter kind=xss_reflected` → only that kind.
- `--filter severity=critical` (deferred until V25 ships severity).
- For V27 acceptance, only `kind=` is required to work.

### 5.2 `bughunter history [--kind <bugkind>] [--limit <n>] [--bug-identity <id>]`

**Signature:**
```ts
export function historyCommand(projectDir: string, opts: {
  kind?: BugKind;
  limit?: number;          // default 30
  bugIdentity?: string;
}): void;
```

**Three modes:**
1. **No filter:** print summary stats — total runs, total unique bug identities, top 5 most frequent kinds, oldest open identity. One screen of output.
2. **`--kind <k>`:** list (run_id, started_at, cluster_size, verdict) for runs where this kind appeared. Limit applies. Newest first.
3. **`--bug-identity <id>`:** full life-cycle for one identity:
   - `firstSeen`: earliest started_at.
   - `lastSeen`: latest started_at.
   - `runs`: array of (runId, startedAt, clusterSize, verdict) — oldest first.
   - `fixAttempts`: count of runs where verdict ∈ {`verified_fixed`, `verified_fixed_by_removal`, `partially_verified`}.
   - `regressions`: count of transitions where `verified_fixed` → next-run-still-present.

Output format always JSON if `--format json`, else table. Table is the default.

### 5.3 `bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]`

**Signature:**
```ts
export function ingestCommand(projectDir: string, opts: {
  filePath: string;
  runId?: string;          // synthesized from filename hash if absent
  projectName?: string;    // pulled from BugCluster.runId match if absent; required for orphans
}): Promise<void>;
```

**Algorithm:**
1. Validate path exists and is readable.
2. Parse line-by-line. Each line → Zod-validate against `BugClusterSchema` (define the schema in `types/zod.ts` if not already; otherwise extend). Reject the import on first parse failure with line number.
3. Determine `runId`: use `--run-id` if provided; otherwise derive from filename + sha256 of file content prefix.
4. Determine `projectName`: use `--project-name` if provided; otherwise inspect `BugCluster.runId` patterns (legacy runs may carry it as a prefix); otherwise fail with "must supply --project-name."
5. Compute `bugIdentity` for each cluster from `(projectName, signatureKey)`. If `signatureKey` absent on a cluster, skip with warning.
6. Open `history.db`, insert one `runs` row + N `clusters` rows in a single transaction. Use `INSERT OR REPLACE` so re-ingest is idempotent on `runId`.
7. Print summary: `Ingested N clusters from M runs.`

**Backward compatibility:** ingest must accept `bugs.jsonl` from V26 and earlier (no `bugIdentity` field on disk). It computes the identity at ingest time.

**Forward compatibility:** if `bugs.jsonl` carries newer fields than the local `BugCluster` Zod schema, the extra fields are ignored, not rejected. Use Zod's `.passthrough()` on the cluster schema for ingest-only.

### 5.4 `bughunter aging [--threshold <days>] [--min-runs <n>]`

**Signature:**
```ts
export function agingCommand(projectDir: string, opts: {
  thresholdDays?: number;  // default 7
  minRuns?: number;        // default 3
}): void;
```

**Algorithm:**
1. Use `agingClusters(db, projectName, thresholdDays)` query (§ 4.5) — adapt to also enforce `minRuns`.
2. Filter out any identity whose latest verdict is `verified_fixed` or `verified_fixed_by_removal`.
3. Render table: `bug_identity | kind | first_seen | last_seen | days_open | run_count`.
4. Exit `0`. (CI gating deferred.)

`projectName` is read from `<projectDir>/.bughunter/config.json` via existing config loader.

### 5.5 `bughunter prune --rebuild-identity`

Extension to existing `prune` command (`packages/cli/src/cli/prune.ts`). When the flag is set:

1. Walk every directory in `.bughunter/runs/`.
2. For each `bugs.jsonl`, read it, line-by-line parse to `BugCluster`.
3. If `signatureKey` is present and `bugIdentity` is absent (or `--force` is set), compute `bugIdentity = computeBugIdentity(projectName, signatureKey)`.
4. Write back to a temp file, then `fs.renameSync` over the original (atomic).
5. After all runs are rewritten, drop and re-create `history.db` from scratch by reading every run's `bugs.jsonl` and `state.json`.

Idempotent. Logs progress per-run. Refuses to run if any active `bughunter run` is detected (lock file at `.bughunter/runs/.lock`; defer the lock implementation to V28 — for V27, document the risk and instruct users to ensure no concurrent runs).

---

## 6. `summary.json` `crossRun` field

### 6.1 Shape

Add to `RunSummary` (`types.ts:1104-1180`):

```ts
export type CrossRunSummary = {
  /** Previous run id used for comparison; null when this is the first run for the project. */
  previousRunId: string | null;
  newBugs: number;
  persistent: number;
  goneSinceLast: number;
  regressed: number;
};

export type RunSummary = {
  // ...all existing fields...
  /** v0.27 cross-run delta vs. previous run for the same projectName. Absent when history.db is empty. */
  crossRun?: CrossRunSummary;
};
```

### 6.2 Population

Inside `phases/emit.ts:runEmit`, **before** calling `writeJsonFile(paths.summaryFile, summary)`:

```ts
const db = openHistoryDb(runState.projectDir);
try {
  const prev = previousRunForProject(db, runState.config.projectName, runState.runId);
  let crossRun: CrossRunSummary | undefined = undefined;
  if (prev !== undefined) {
    const prevClusters = clustersForRun(db, prev.run_id);
    const prevByIdentity = new Map(prevClusters.map(c => [c.bug_identity, c]));
    const currIdentities = new Set(clusters.filter(c => c.bugIdentity !== undefined).map(c => c.bugIdentity!));

    let newBugs = 0, persistent = 0, regressed = 0;
    for (const c of clusters) {
      if (c.bugIdentity === undefined) continue;
      const prior = prevByIdentity.get(c.bugIdentity);
      if (prior === undefined) newBugs++;
      else if (prior.verdict === 'verified_fixed') regressed++;
      else persistent++;
    }
    let goneSinceLast = 0;
    for (const pc of prevClusters) {
      if (!currIdentities.has(pc.bug_identity)) goneSinceLast++;
    }
    crossRun = { previousRunId: prev.run_id, newBugs, persistent, goneSinceLast, regressed };
  }
  // ...append crossRun to summary if defined
  writeRunToHistory(db, runState, clusters, BUGHUNTER_VERSION);
} finally {
  db.close();
}
```

### 6.3 First-run handling

If `previousRunForProject` returns undefined, `crossRun` is omitted from `summary.json` entirely. Consumers must handle absence (typed as optional). Add a `discovery.first-run-for-project` console message at emit time to make this visible.

---

## 7. CLI / config

### 7.1 New CLI flags

| Command | Flag | Type | Default |
|---|---|---|---|
| `diff` | `--format <t>` | `'table'\|'json'\|'sarif'` | `'table'` |
| `diff` | `--filter <kv>` | `kind=...` or `severity=...` | unset |
| `history` | `--kind <k>` | BugKind | unset |
| `history` | `--limit <n>` | int | 30 |
| `history` | `--bug-identity <id>` | 16-char hex | unset |
| `history` | `--format <t>` | `'table'\|'json'` | `'table'` |
| `ingest` | `--run-id <id>` | string | derived |
| `ingest` | `--project-name <n>` | string | derived |
| `aging` | `--threshold <days>` | int | 7 |
| `aging` | `--min-runs <n>` | int | 3 |
| `prune` | `--rebuild-identity` | bool | false |
| `prune` | `--force` | bool | false |

### 7.2 Config additions

None. The history DB is implicitly enabled. Future config field `historyEnabled?: boolean` (default true) is reserved but not implemented in V27.

### 7.3 `USAGE` text

Append to the `USAGE` constant in `main.ts`:

```
  bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind=k|severity=s>]
  bughunter history [--kind <bugkind>] [--bug-identity <id>] [--limit <n>] [--format table|json]
  bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]
  bughunter aging [--threshold <days>] [--min-runs <n>]
  bughunter prune [--rebuild-identity] [--force]
```

---

## 8. Edge cases

### EC-1. First run of a project (history.db doesn't exist yet)
Open creates it with empty schema; `previousRunForProject` returns undefined; `crossRun` omitted from summary.json; `bughunter diff` errors with "runId not found." Acceptable.

### EC-2. Two runs with identical signatures but different `runId` minted within the same millisecond
`startedAt` collides at second-precision but ISO with milliseconds disambiguates. `runs.run_id` is PRIMARY KEY → the second `INSERT` would error if it weren't `INSERT OR REPLACE`. Use `INSERT OR REPLACE` (handles legitimate re-emit-after-resume too).

### EC-3. Cluster missing `signatureKey` (pre-v0.16 legacy)
`writeRunToHistory` skips the cluster with a debug log. `prune --rebuild-identity` skips with a warning. Documented in § 3.4.

### EC-4. `bughunter version` upgrade where signature.ts has changed materially
`bughunter_version` column lets users see the version delta. The diff between `runs.bughunter_version` of two adjacent runs is informational only — V27 does not auto-detect signature-algo bumps.

### EC-5. history.db corruption (e.g. partial write on power loss)
`better-sqlite3` defaults to journal mode `WAL` (set explicitly in § 4.3). Recovery: `bughunter prune --rebuild-identity` regenerates the DB from the source-of-truth `bugs.jsonl` files.

### EC-6. `bughunter ingest` of a malicious bugs.jsonl
Zod validation catches type-mismatched payloads. `root_cause` is truncated to 4096 chars. `cluster_size` is bound to the SQL parameter — no SQL injection. SQLite handles arbitrary string content safely.

### EC-7. Two projects with the same `projectName` in different directories
They share an identity space. **Documented behavior:** `projectName` is the cross-run identity namespace; users with two unrelated projects must give them distinct names. The Zod config validator already rejects empty `projectName`. Add a doc note: "do not reuse projectName across unrelated codebases — bug identities will collide."

### EC-8. `crossRun` regressed but verdict was set in a non-adjacent prior run
**Decision:** only adjacent runs are compared. If verdict was `verified_fixed` two runs ago but `not_fixed` last run, the current run reports the bug as `persistent` (not `regressed`) because the immediate predecessor had it open. A future spec could trace the verdict history; V27 does immediate-neighbor only. Keep the algorithm simple and predictable.

### EC-9. `verdict` is set on the cluster after retest, not at emit time
The retest pipeline (`packages/cli/src/cli/retest-cmd.ts`) updates `BugCluster.verdict` and rewrites `bugs.jsonl`. **It must also update `history.db`** — add a `updateClusterVerdict(db, runId, bugIdentity, verdict)` helper called from retest.

### EC-10. Schema bump (V28+) lands and the user runs old V27 binary
The migrate function throws when `user_version > SCHEMA_VERSION`. Error message instructs upgrading or wiping the DB. Log the file path.

### EC-11. Concurrent `bughunter run` on the same project
SQLite WAL handles concurrent writes by serializing on the file lock; `BUSY_TIMEOUT` set to 5000ms via `db.pragma('busy_timeout = 5000')`. Two concurrent runs produce two `runs` rows; their cluster rows interleave correctly.

### EC-12. `projectName` was changed between two runs (user-renamed project)
Two distinct identity spaces. The diff between the two runs shows everything in `gone` for the old name and everything in `new` for the new name. Acceptable; user error has a clear signal.

---

## 9. Acceptance criteria

| ID | Criterion | Verifier |
|---|---|---|
| AC-1 | `BugCluster.bugIdentity` is a 16-char hex string for every cluster minted with V27 | unit test on `runCluster` |
| AC-2 | Two runs of the same fixture produce identical `bugIdentity` for the same root-cause cluster | integration test in `phases/cluster.test.ts` |
| AC-3 | `history.db` is created at `<projectDir>/.bughunter/history.db` after first `bughunter run` | filesystem assertion in run integration test |
| AC-4 | `history.db` schema matches § 4.2 exactly | `PRAGMA table_info` snapshot test |
| AC-5 | `bughunter diff <A> <B>` correctly buckets new/persistent/gone/regressed against the demo fixture | e2e test in `cli/diff.test.ts` |
| AC-6 | `bughunter history --bug-identity <id>` returns the correct lifecycle for the demo fixture | e2e test in `cli/history.test.ts` |
| AC-7 | `bughunter ingest` round-trips: dump, ingest, query → identical row count and identities | e2e test in `cli/ingest.test.ts` |
| AC-8 | `bughunter aging --threshold 7` lists clusters open ≥7 days, never `verified_fixed` | e2e test in `cli/aging.test.ts` |
| AC-9 | `summary.json.crossRun` populated correctly across the 3-run fixture sequence | snapshot of `summary.json` |
| AC-10 | First run of a project produces `summary.json` without `crossRun` field | snapshot |
| AC-11 | `bughunter prune --rebuild-identity` backfills `bugIdentity` on legacy `bugs.jsonl` files | unit test |
| AC-12 | `npx tsc --noEmit` clean across `packages/cli` | tsc |
| AC-13 | `npx eslint . --max-warnings 0` clean | eslint |
| AC-14 | All existing tests still pass | `npm test` |

---

## 10. Files to touch / add

### 10.1 New files

| Path | Purpose |
|---|---|
| `packages/cli/src/store/history.ts` | `openHistoryDb`, `historyDbPath`, `migrate`, `writeRunToHistory`, `clustersForRun`, `runsForIdentity`, `previousRunForProject`, `agingClusters`, `updateClusterVerdict`. ~200 lines. |
| `packages/cli/src/store/history.test.ts` | Unit tests against an in-memory `Database(':memory:')`. ~150 lines. |
| `packages/cli/src/cluster/bug-identity.ts` | `computeBugIdentity(projectName, signatureKey)`. ~10 lines. |
| `packages/cli/src/cluster/bug-identity.test.ts` | Stability tests. ~30 lines. |
| `packages/cli/src/cli/diff.ts` | `diffCommand`. ~120 lines. |
| `packages/cli/src/cli/diff.test.ts` | ~80 lines. |
| `packages/cli/src/cli/history.ts` | `historyCommand`. ~100 lines. |
| `packages/cli/src/cli/history.test.ts` | ~60 lines. |
| `packages/cli/src/cli/ingest.ts` | `ingestCommand`. ~100 lines. |
| `packages/cli/src/cli/ingest.test.ts` | ~60 lines. |
| `packages/cli/src/cli/aging.ts` | `agingCommand`. ~80 lines. |
| `packages/cli/src/cli/aging.test.ts` | ~60 lines. |
| `packages/cli/src/cli/diff-format-sarif.ts` | Placeholder SARIF formatter. ~40 lines. Marked TODO(V29). |
| `fixtures/cross-run-demo/` | Three pre-baked `bugs.jsonl` files emulating new/fixed/regressed lifecycle for e2e tests. |

### 10.2 Modified files

| Path | Change |
|---|---|
| `packages/cli/src/types.ts` | Add `bugIdentity?: string` on `BugCluster`. Add `CrossRunSummary` type and `crossRun?` field on `RunSummary`. |
| `packages/cli/src/phases/cluster.ts` | Add `projectName: string` to `ClusterOptions`. Mint `bugIdentity` at line ~95. |
| `packages/cli/src/phases/cluster.test.ts` | New test for `bugIdentity` minting. |
| `packages/cli/src/phases/emit.ts` | Add history-DB write hook + `crossRun` computation around the existing `writeJsonFile(summary)` call. |
| `packages/cli/src/cli/run.ts` | Pass `projectName` into `runCluster` (line ~`runCluster({...})` site). |
| `packages/cli/src/cli/main.ts` | Imports + four new `case` branches + USAGE update. |
| `packages/cli/src/cli/prune.ts` | `--rebuild-identity` and `--force` flags. |
| `packages/cli/src/store/filesystem.ts` | Re-export `historyDbPath` from `history.ts` for symmetry (optional). |
| `packages/cli/src/cli/retest-cmd.ts` | After verdict update on disk, also call `updateClusterVerdict(db, ...)`. |
| `packages/cli/package.json` | Add `"better-sqlite3": "11.3.0"` to `dependencies`. (Pin exact.) |
| `packages/cli/package.json` | Add `"@types/better-sqlite3": "7.6.11"` to `devDependencies`. |

---

## 11. Negative requirements

- Do **not** introduce a per-run history-db file; one project-scoped DB.
- Do **not** make any of the new CLI commands fail if `history.db` is empty/absent — they must handle "first run" cleanly.
- Do **not** delete or rewrite any cluster's `id` (cuid). The cuid stays as the per-run handle.
- Do **not** include `verdict` history (an array) on a cluster — verdict is single-valued per (run, cluster) and lives in the `clusters` table.
- Do **not** ship a new CLI namespace (e.g. `bughunter history list`); flat commands only, matching the existing CLI shape.
- Do **not** add an MCP-tool surface for history queries in this spec — that's V28 (mirrors `SPEC_PATH_TO_EXHAUSTIVE.md` § 5.1's `bughunt_history`).
- Do **not** retain runs beyond `bughunter prune` policy — when `prune --keep N` runs (V28), the DB must cascade-delete dropped runs' clusters. V27 only sets up the cascade; the prune integration is V28.

---

## 12. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `bugIdentity?` field to `BugCluster`; add `CrossRunSummary` + `crossRun?` to `RunSummary` | `types.ts` | none |
| 2 | Implement `computeBugIdentity` + tests | `cluster/bug-identity.ts`, `cluster/bug-identity.test.ts` | 1 |
| 3 | Wire identity minting in `runCluster`; thread `projectName` through `ClusterOptions` | `phases/cluster.ts`, `phases/cluster.test.ts`, `cli/run.ts` | 2 |
| 4 | Add `better-sqlite3` dep; implement `history.ts` (open, migrate, helpers) + tests | `store/history.ts`, `store/history.test.ts`, `package.json` | 1 |
| 5 | Wire write-hook + `crossRun` computation in `runEmit` | `phases/emit.ts` | 3, 4 |
| 6 | Implement `bughunter diff` (table + json; sarif placeholder) | `cli/diff.ts`, `cli/diff-format-sarif.ts`, `cli/diff.test.ts` | 4 |
| 7 | Implement `bughunter history` | `cli/history.ts`, `cli/history.test.ts` | 4 |
| 8 | Implement `bughunter ingest` (with Zod validation) | `cli/ingest.ts`, `cli/ingest.test.ts` | 4 |
| 9 | Implement `bughunter aging` | `cli/aging.ts`, `cli/aging.test.ts` | 4 |
| 10 | Wire all four into `main.ts` USAGE + dispatch | `cli/main.ts` | 6, 7, 8, 9 |
| 11 | Extend `prune` with `--rebuild-identity` | `cli/prune.ts` | 4 |
| 12 | Wire `updateClusterVerdict` into retest-cmd | `cli/retest-cmd.ts` | 4 |
| 13 | Build `fixtures/cross-run-demo/` and end-to-end acceptance test | `fixtures/cross-run-demo/`, `cli/diff.test.ts` | 6, 7 |
| 14 | Run full verification: tsc, eslint, vitest | (all) | 1-13 |

Each task is bounded; tasks 6-9 can run in parallel after 4. Total: ~600 LOC + ~440 LOC tests.

---

## 13. Definition of Done

- All 14 acceptance criteria pass.
- `bughunter diff`, `bughunter history`, `bughunter ingest`, `bughunter aging` all reachable from CLI with documented usage in `--help`.
- The 3-run demo fixture demonstrates the regression detection path end-to-end.
- `summary.json.crossRun` shape matches the spec for runs ≥ 2.
- `history.db` schema verified by snapshot test against `PRAGMA table_info`.
- `npx tsc --noEmit` and `eslint --max-warnings 0` clean.
- All previous tests still pass.
- `better-sqlite3` is the only new dep and is pinned exactly.
- `README.md` (or a section thereof) documents the four new commands and the DB location. (One short section is sufficient.)

---

## 14. Risks + escape hatches

- **Risk: `better-sqlite3` build issues on user machines (it's a native module).** Mitigation: it's the same dep used by Prisma/Drizzle/Knex; prebuilt binaries cover macOS x64/arm64 + Linux x64/arm64 + Windows x64. Document Node 20 requirement (already enforced by `engines.node`).
- **Risk: signature-algo change between V26 and V27 invalidates identities.** Mitigation: V27 freezes the algo; introduce `SIGNATURE_ALGO_VERSION = 1` constant; future bumps require an explicit `--rebuild-identity` step documented in the changelog.
- **Risk: bench DB grows unboundedly.** Mitigation: `bughunter prune --keep <n>` (V28) cascades. V27 documents the open question; suggests vacuuming as future work.
- **Risk: `crossRun` adjacency rule (§ EC-8) misleads users in CI where many runs happen per day.** Mitigation: `bughunter history --bug-identity <id>` always shows the full timeline, so the truthful state is one query away. The single-number `regressed` count in `summary.json` is intentionally conservative.
- **Escape hatch:** the entire feature degrades to a no-op if `history.db` is corrupt and unrebuildable — `runEmit` opens it inside a try/catch, logs a warning on failure, and proceeds without the crossRun field. The on-disk `bugs.jsonl` is the canonical record; history.db is a secondary index.

---

## 15. Open questions

1. **better-sqlite3 version.** The latest stable on 2026-04-30 is 11.3.0; pin to that. Is there a workspace-wide rule that prefers newer or older? Defer to repo maintainer; default 11.3.0 unless told otherwise.
2. **Vacuuming policy.** SQLite VACUUM rewrites the file. After many `prune --keep` cycles, DB pages can be sparse. V27 proposes deferring `bughunter prune --vacuum-history` to V28. Acceptable?
3. **Retention beyond 30 runs.** `prune --keep` defaults to 30 in `SPEC_PATH_TO_EXHAUSTIVE.md` § 7.2 but isn't yet implemented. V27 leaves history.db unbounded. When V28 lands `prune --keep`, the cascade in this spec's schema makes it a single SQL `DELETE FROM runs WHERE run_id NOT IN (...)`.
4. **`bugIdentity` truncation length.** 16 hex chars = 64 bits. Sufficient for ~10⁹ unique identities at 50% collision probability per birthday paradox — overkill for a single project, fine for cross-project ingest. 12 chars (48 bits) would be tighter but riskier; 24 (96 bits) is overkill. 16 stays. Confirm.
5. **Ingest: should we accept `bugs.jsonl` from a different `bughunter_version` than the local one?** Spec says yes (Zod `.passthrough()`); flag a warning if the version diverges by ≥ 1 minor. Confirm acceptable.
6. **`crossRun` adjacency vs. project-history-aware.** Adjacent-only is simple and correct for "did this regress vs last run." Full-history (e.g., `regressed = bugIdentity ever-fixed in any prior run, present now, not currently `verified_fixed`) is more powerful but harder to reason about. V27 ships adjacent; document the alternative for V28+.
7. **`bughunter detectors --last-fired` (V26 dep) — what does it query?** V26 should query `history.db` directly via the same `clustersForRun` / `runsForIdentity` helpers exported from `store/history.ts`. Agreed split: V27 owns the storage; V26 owns the surface. Confirm with V26 author.
8. **SARIF placeholder shape — minimal viable?** `{ version: '2.1.0', $schema: 'https://...', runs: [{ tool: { driver: { name: 'BugHunter', rules: [] } }, results: [...] }] }`. Sufficient for SARIF-aware tools to parse; full taxonomy in V29. Acceptable as placeholder?

---

End of spec.
