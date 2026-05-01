# SPEC — v0.28 "Triage & suppression — surface programmability + audit trail"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.27 (bugIdentity stable across runs — sibling on `spec/v27-cross-run-history`). · **Predecessor:** `SPEC_PATH_TO_EXHAUSTIVE.md` §4.3, §6.5. · **Successor:** v0.29 severity calibration.

Ships the four triage commands (`suppress`, `unsuppress`, `triage`, `explain`), the on-disk suppression file, the append-only audit log, and the cluster-phase filter. Result: every BugHunter user can mute a false-positive cluster with one CLI line, see who muted what when and why, and walk an Ink TUI that writes verdict events to `.bughunter/triage.jsonl`. The grammar lands forward-compatible with v0.29 severity (the `severity:critical` pattern is recognized but matches nothing until v0.29 sets the field on clusters).

---

## 1. Objective

Add four CLI commands and one phase-integration so that BugHunter users can:

| Command | Purpose | Audit-trailed |
|---|---|---|
| `bughunter suppress <pattern> --reason <text> [--expires <date>] [--cluster-id <id>]` | Add a `SuppressionEntry` to `.bughunter/suppressions.json`. | yes — append `suppress` event to `.bughunter/suppressions-audit.log`. |
| `bughunter unsuppress <pattern>` | Remove all matching entries from `.bughunter/suppressions.json`. | yes — append `unsuppress` event to `.bughunter/suppressions-audit.log`. |
| `bughunter triage [--interactive]` | Ink-based TUI that walks the latest run's clusters; emits per-cluster verdict events to `.bughunter/triage.jsonl`; in-flight suppression and explain dispatch via `s` and `e` keys. | yes — `triage.jsonl` IS the audit trail. |
| `bughunter explain <cluster-id> [--no-cache]` | Spawn `claude -p` with the cluster + suspectedFiles inline; cache result at `.bughunter/explanations/<bugIdentity>.md`. | no audit trail (read-only). |

The cluster phase gains a post-mint pre-emit filter that:
- Loads `.bughunter/suppressions.json`
- For each cluster, finds the FIRST matching suppression (precedence: bugIdentity > kind > endpoint > suspectedFile > severity)
- If matched: removes the cluster from the emit set, increments `matchCount`, updates `lastMatchedAt`
- Updates `summary.json` with a `suppressedClusters: number` field and a `suppressedSamples: SuppressedSample[]` array (up to 20 samples, for human-eyeball verification)

**In scope:**
- Four new CLI commands, dispatched from `packages/cli/src/cli/main.ts`.
- New module `packages/cli/src/suppress/` (file format, pattern matcher, audit log writer).
- New module `packages/cli/src/triage/` (Ink TUI components + state model).
- New module `packages/cli/src/explain/` (Claude subprocess wrapper + cache).
- Integration point in `packages/cli/src/cli/run.ts` after `runCluster()` returns and before `runEmit()` is called.
- `RunSummary` schema extension (`suppressedClusters: number`, optional `suppressedSamples`).
- Zod schemas for `Suppressions`, `AuditEvent`, `TriageEvent`.
- USAGE help-string updates in `main.ts`.
- Test coverage: per-command unit tests, suppression-filter unit tests, golden-file fixture for the cluster-phase integration.

**Out of scope (deferred):**
- **Severity field on `BugCluster`** — v0.29. v0.28 ships the `severity:` matcher but it never matches until v0.29 sets the field on every cluster. This is intentional — the v0.28 grammar is forward-compatible.
- **Cross-project suppressions** — v0.30. v0.28 is per-project only.
- **MCP tools (`bughunt_suppress`, `bughunt_unsuppress`, `bughunt_triage`)** — separate spec (v0.28-mcp). They wrap the same core helpers; spec keeps the helpers exported from `packages/cli/src/suppress/index.ts` so v0.28-mcp imports without forking.
- **`bughunter suppress audit`** subcommand for printing the audit log — trivial follow-up; users `cat` the file in v0.28.
- **`bughunter explain` HTML render** — v0.28 emits Markdown; HTML wrapping is a viewer concern.
- **Auto-expire of `expiresAt` suppressions** — v0.28 warns at suppression-load time; v0.29 prunes.
- **TUI write keybindings beyond suppress/explain/quit** — `m` (mark verdict) and `f` (dispatch /bughunt fix) ARE in scope for v0.28; `r` (re-cluster on the fly), `/` (search), `?` (help) are deferred to v0.29.
- **JSON output for `bughunter triage --batch`** — v0.29.

**Acceptance target on a deliberately-noisy fixture:**
With the fixture from `tests/fixtures/v28-suppression/` (5 deliberate clusters: 2 false-positives, 3 real bugs), a v0.28 user can:
1. Run `bughunter suppress kind:image_missing_alt --reason "decorative SVG icons; product accepted" `
2. Re-run BugHunter
3. `summary.json.bugs_filed === 3` (was 5); `summary.json.suppressedClusters === 2`; `bugs.jsonl` has 3 lines (was 5)
4. `cat .bughunter/suppressions-audit.log | wc -l === 1` (one suppress event)
5. `bughunter unsuppress kind:image_missing_alt` removes the entry; next run filed === 5 again; audit log has 2 lines.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `/root/BugHunter/packages/cli/src/types.ts` (lines 197–218 for `BugCluster`, 1106–1184 for `RunSummary`) | Source of truth for cluster + summary shapes. ADD `bugIdentity?: string` and `suppressed?: true` to `BugCluster` only if v0.27 hasn't already; otherwise leave alone. ADD `suppressedClusters: number` and optional `suppressedSamples` to `RunSummary`. |
| `/root/BugHunter/packages/cli/src/phases/cluster.ts` (lines 62–144 for `runCluster`) | Cluster mint happens here. SUPPRESSION FILTER INTEGRATES IN `cli/run.ts` AFTER `runCluster` RETURNS — NOT inside `cluster.ts`. `cluster.ts` stays pure and untouched by v0.28. |
| `/root/BugHunter/packages/cli/src/cli/run.ts` (line 496 — `runCluster` invocation; line ~511 — `runState.clusters = clusters`) | Insertion point: a new helper `applySuppressions(clusters, projectDir)` called between `runCluster` and `runState.clusters = ...`. The unsuppressed clusters become `runState.clusters`; the suppressed list is emitted via summary counters. |
| `/root/BugHunter/packages/cli/src/store/filesystem.ts` | `runPaths` returns one struct. v0.28 adds a sibling `bugHunterPaths(projectDir)` returning the project-level files (`suppressionsFile`, `auditLogFile`, `triageFile`, `explanationsDir`). Same module; reuse `appendJsonl`/`writeJsonFile`/`readJsonFile`/`fileExists`. |
| `/root/BugHunter/packages/cli/src/cluster/signature.ts` (line 9 `clusterSignature`) | bugIdentity for v0.27 is `clusterSignature(detection)`; v0.28 imports the existing function via `cluster.signatureKey`. DO NOT redefine. |
| `/root/BugHunter/packages/cli/src/cli/main.ts` (lines 18–73 USAGE, lines 110–235 dispatch) | Add `suppress`, `unsuppress`, `triage`, `explain` cases to the `switch (command)`. Update USAGE block with their syntax — keep the existing visual style (newline-separated under section headers). |
| `/root/BugHunter/packages/cli/src/cli/list.ts` | Pattern reference for a tiny CLI command (24 lines). Mirror this size for `suppress` / `unsuppress`; `triage` and `explain` are larger. |
| `/root/BugHunter/packages/cli/package.json` | `zod`, `micromatch`, `cuid2` are already present. ADD: `ink` (`^4.4.1`), `react` (`^18.2.0`), `@types/react` (devDep, `^18.2.0`). DO NOT add a glob library — `micromatch` is already there. DO NOT add a Claude SDK — `@anthropic-ai/sdk` is already there but v0.28 uses `claude -p` subprocess (cheaper, no API-key plumbing inside `bughunter`). |
| `/root/BugHunter/packages/cli/src/log.ts` | `log.info` / `log.warn` / `log.error` for telemetry. |

### 2.2 Patterns to follow

- **Discriminated unions for events.** `AuditEvent` is `{ kind: 'suppress'; ... } | { kind: 'unsuppress'; ... }`; `TriageEvent` is `{ kind: 'verdict'; ... } | { kind: 'suppress'; ... } | { kind: 'explain-requested'; ... } | { kind: 'fix-dispatched'; ... }`. Mirror `Action` in `types.ts` lines 104–125.
- **Zod schemas for runtime parse.** Every JSON read from disk passes through Zod before we trust the shape. Mirror `BugHunterConfigSchema` in `packages/cli/src/config.ts`.
- **`appendJsonl` for line-oriented files.** Already in `store/filesystem.ts:54`. The audit log and triage log use this; never use `fs.writeFileSync` against them.
- **CLI dispatch pattern.** Read args via `parseArgs`, validate via type-guards, call into the helper module. Do NOT inline business logic in `main.ts` — keep `main.ts` a dispatcher only. See `forbiddenPathGateCommand` (line 207) for the canonical mid-size case.
- **Subprocess spawning.** Use `child_process.spawn` (NOT `exec`) for `claude -p` — exec buffers all of stdout in memory, which is wasteful for a 5KB Markdown response. Mirror `runShellHook` in `packages/cli/src/seed/run-shell.ts` if a similar helper exists; otherwise a 30-line wrapper.
- **micromatch for glob.** `micromatch.isMatch(target, glob)` — already used by `forbidden-path-gate.ts`. Same options.
- **Path joining.** `path.join` always; never string concatenation with `/`.

### 2.3 DO NOT

- Do **not** modify `phases/cluster.ts`. The suppression filter is a SEPARATE phase between cluster and emit. Cluster mint stays pure.
- Do **not** mutate suppression entries' `id`, `pattern`, `addedBy`, `addedAt`, or `reason` after creation. Only `lastMatchedAt` and `matchCount` are mutable. Use a single `applyMatchUpdate` helper to atomically rewrite the file with the deltas.
- Do **not** delete entries on `unsuppress` without writing the audit event first (write-then-delete; on crash the audit log shows the intent and the next run is consistent).
- Do **not** allow `bughunter suppress <pattern>` without `--reason`. Print `Error: --reason is required` and exit 2 (not 1; 1 is general failure).
- Do **not** write the user's chosen text directly to disk if it contains a newline — Zod refuses, and we exit 2 with `Error: --reason cannot contain newlines (use ; or // for separators)`.
- Do **not** load Ink unless `bughunter triage` is invoked. Lazy-import inside the command handler so `bughunter run` doesn't pay the React startup cost (~50ms cold).
- Do **not** include the explanation Markdown in `bugs.jsonl` or `summary.json` — explanations are a separate read-only artifact, not part of the bug record. Linkable via `cluster.explanationPath` only when present.
- Do **not** invent a new bugIdentity — use `cluster.signatureKey` as the stable handle. v0.27 may rename to `cluster.bugIdentity`; v0.28 must read whichever exists.
- Do **not** parse the user's `--expires` value with `Date(text)` — use Zod's `.datetime()` plus a friendly fallback for `YYYY-MM-DD` only.
- Do **not** swallow errors in the cluster-phase suppression filter. If `suppressions.json` is malformed, log a warning, treat it as empty, and proceed. Never crash a run because of a bad suppressions file.
- Do **not** allow `bughunter suppress` to add a duplicate pattern with the same `(pattern, addedBy)` pair within the same minute — second invocation no-ops with `Already suppressed by <addedBy>` and exits 0.
- Do **not** ship a write-through to `git config --local user.email` — read it; if missing, default `addedBy` to `'unknown'` and `log.warn`.

---

## 3. `.bughunter/suppressions.json` schema

Stored at `<projectDir>/.bughunter/suppressions.json`. Created on first `suppress` invocation; absence is equivalent to `[]`.

```ts
// packages/cli/src/suppress/types.ts
import { z } from 'zod';

export const SuppressionPatternSchema = z.string().regex(
  /^(bugIdentity|kind|endpoint|suspectedFile|severity):[^\s]+$/,
  'pattern must be one of bugIdentity:<value>, kind:<BugKind>, endpoint:<glob>, suspectedFile:<glob>, severity:<critical|major|minor|info>',
);

export const SuppressionEntrySchema = z.object({
  /** Stable cuid for the suppression itself; never reused. Different from the bug's id. */
  id: z.string().min(1),
  /** Typed pattern. See SuppressionPatternSchema. */
  pattern: SuppressionPatternSchema,
  /** Free-text reason; required at suppress-time. No newlines. Max 1000 chars. */
  reason: z.string().min(1).max(1000).regex(/^[^\n\r]+$/, 'reason cannot contain newlines'),
  /** git config user.email at suppress-time; 'unknown' when git is missing/unconfigured. */
  addedBy: z.string().min(1),
  /** ISO 8601 UTC timestamp captured at suppress-time. */
  addedAt: z.string().datetime(),
  /** Optional ISO 8601 UTC timestamp; entries past expiry are warned but still apply (until v0.29 prunes). */
  expiresAt: z.string().datetime().optional(),
  /** Updated on every cluster-phase match. ISO 8601 UTC. */
  lastMatchedAt: z.string().datetime().optional(),
  /** Increments on every cluster-phase match (one per matched cluster, not per occurrence). Default 0. */
  matchCount: z.number().int().nonnegative().optional(),
  /** Optional bug-id from the run that motivated this suppression (audit context). */
  sourceClusterId: z.string().optional(),
});

export const SuppressionsSchema = z.array(SuppressionEntrySchema);
export type SuppressionEntry = z.infer<typeof SuppressionEntrySchema>;
export type Suppressions = z.infer<typeof SuppressionsSchema>;
```

**File invariants:**
- Pretty-printed JSON (2-space indent), one array.
- Always written via `writeJsonFile` (atomic write-then-rename inside the helper — verify or add).
- File handle never held across awaits — read whole file, mutate in memory, write whole file.

---

## 4. `.bughunter/suppressions-audit.log` schema

Append-only line-oriented JSONL. One event per line. NEVER edit, NEVER delete.

```ts
// packages/cli/src/suppress/types.ts (continued)
export const AuditEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('suppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),                 // git user.email at the time
    pattern: SuppressionPatternSchema,
    reason: z.string().min(1).max(1000),
    expiresAt: z.string().datetime().optional(),
    sourceClusterId: z.string().optional(),
    suppressionId: z.string().min(1),         // entry's id, for cross-reference
  }),
  z.object({
    kind: z.literal('unsuppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    pattern: SuppressionPatternSchema,        // the pattern argument the user gave
    removedSuppressionIds: z.array(z.string()).min(1),  // ids removed by this unsuppress
    removedCount: z.number().int().positive(),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
```

Append via `appendJsonl(paths.auditLogFile, event)`. Reading is users' job; v0.29 may add `bughunter suppress audit`.

---

## 5. `.bughunter/triage.jsonl` schema

Append-only line-oriented JSONL written by the TUI on every actionable keystroke. Read by `bughunter run` to inform fix-priority ordering (v0.28 only writes; the read side is opt-in, gated on a separate v0.28b PR — TUI shipping first ensures we have the data).

```ts
// packages/cli/src/triage/types.ts
import { z } from 'zod';

export const ClusterVerdictSchema = z.enum([
  'bug',
  'fix-priority',
  'false-positive',
  'known',
]);
export type ClusterVerdictMark = z.infer<typeof ClusterVerdictSchema>;

export const TriageEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('verdict'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    bugIdentity: z.string().optional(),       // present when v0.27 has shipped
    mark: ClusterVerdictSchema,
    note: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('suppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    pattern: z.string().min(1),               // the constructed pattern string
    reason: z.string().min(1).max(1000),
    suppressionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('explain-requested'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    cacheHit: z.boolean(),
    cost: z.number().nonnegative().optional(),  // USD estimate when miss; 0 on hit
  }),
  z.object({
    kind: z.literal('fix-dispatched'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
  }),
]);
export type TriageEvent = z.infer<typeof TriageEventSchema>;
```

---

## 6. Suppression filter integration

### 6.1 Where exactly

`packages/cli/src/cli/run.ts` line 496–514 currently reads:

```ts
const { clusters } = runCluster({ ... });

runState.clusters = clusters;
runState.clusterCount = clusters.length;
runState.phase = 'analyze';
saveRunState(runState);
```

v0.28 inserts after the destructure and before the assign:

```ts
const { clusters: rawClusters } = runCluster({ ... });

// v0.28 — apply user-defined suppressions before downstream consumers see the clusters.
const { clusters, suppressedSamples, suppressedCount } = applySuppressions({
  clusters: rawClusters,
  projectDir: opts.projectDir,
  runId,
});

runState.clusters = clusters;
runState.clusterCount = clusters.length;
runState.phase = 'analyze';
saveRunState(runState);
```

`applySuppressions` lives in `packages/cli/src/suppress/apply.ts`. The two extra return values flow into `RunSummary`:

```ts
// packages/cli/src/cli/run.ts — final summary build (~line 730)
const summary: RunSummary = {
  ...,
  suppressedClusters: suppressedCount,
  ...(suppressedSamples.length > 0 ? { suppressedSamples } : {}),
};
```

### 6.2 `applySuppressions` contract

```ts
// packages/cli/src/suppress/apply.ts
export type ApplySuppressionsArgs = {
  clusters: BugCluster[];
  projectDir: string;
  runId: string;
};

export type ApplySuppressionsResult = {
  /** Clusters NOT matched by any active suppression. Stable input order. */
  clusters: BugCluster[];
  /** Up to 20 samples (id, kind, matchedPattern, suppressionId). For summary.json eyeball. */
  suppressedSamples: SuppressedSample[];
  /** Count of suppressed clusters in this run. */
  suppressedCount: number;
};

export type SuppressedSample = {
  clusterId: string;
  kind: BugKind;
  bugIdentity?: string;        // cluster.signatureKey
  matchedPattern: string;
  suppressionId: string;
};

export function applySuppressions(args: ApplySuppressionsArgs): ApplySuppressionsResult;
```

**Behavior:**
1. Load `<projectDir>/.bughunter/suppressions.json`. Missing → empty array. Malformed → `log.warn` + empty array (never throw).
2. For each cluster, find the FIRST entry matching by precedence: `bugIdentity` > `kind` > `endpoint` > `suspectedFile` > `severity`. (Within a precedence tier, first match wins by file-order.)
3. If matched: add to `suppressedSamples` (capped at 20), increment that entry's `matchCount`, set `lastMatchedAt = new Date().toISOString()`. NOT in the returned `clusters` array.
4. If not matched: include in returned `clusters`. Order preserved.
5. After loop: write back the (possibly-mutated) suppressions file via `writeJsonFile`. Atomic.
6. Return `{ clusters, suppressedSamples, suppressedCount }`.

### 6.3 Pattern matching grammar

| Pattern prefix | Match target | Match logic |
|---|---|---|
| `bugIdentity:<exact>` | `cluster.signatureKey` (or `cluster.bugIdentity` once v0.27 lands) | Exact string equality. Empty target never matches. |
| `kind:<BugKind>` | `cluster.kind` | Exact equality. Unknown BugKind in pattern → never matches (warn at suppression-load). |
| `endpoint:<glob>` | `cluster.occurrences[0].action.toolId` ?? extracted endpoint from `rootCause` | `micromatch.isMatch(target, glob, { dot: false, contains: false })`. |
| `suspectedFile:<glob>` | each entry in `cluster.suspectedFiles` | `cluster.suspectedFiles.some(f => micromatch.isMatch(f, glob))`. |
| `severity:<level>` | `cluster.severity` (v0.29) | Exact equality. v0.28: `cluster.severity` is undefined; matches NOTHING. Emit `log.warn('severity: pattern present but cluster.severity unset; awaiting v0.29')` once per run. |

Endpoint extraction helper: `extractEndpoint(cluster: BugCluster): string | undefined` — first non-empty of:
1. `cluster.occurrences[0]?.action.toolId`
2. The first capture group of `/tool (\S+) failed/` or `/links to (\S+) which returned/` against `cluster.rootCause`

### 6.4 Expiry handling

At load-time:
- If `expiresAt` is present and `< now`, log `bughunter: suppression <id> for pattern <pattern> expired on <expiresAt>; still applied (auto-prune in v0.29)`.
- Apply normally. v0.28 does NOT auto-remove. v0.29 will.

### 6.5 Edge case: one cluster matches N suppressions

Take the FIRST match by the precedence above. Update only that entry's `matchCount`/`lastMatchedAt`. The other entries remain untouched. Document in the spec; `bughunter unsuppress` of the first-matching pattern reveals the second-matching pattern on the next run, which is intended.

---

## 7. `bughunter suppress`

### 7.1 CLI surface

```
bughunter suppress <pattern> --reason <text> [--expires <iso>] [--cluster-id <id>]
```

| Flag | Type | Required | Notes |
|---|---|---|---|
| `<pattern>` | positional, string | yes | Must match `SuppressionPatternSchema`. |
| `--reason <text>` | string | YES | Min 1 char, max 1000, no newlines. |
| `--expires <iso>` | string | no | ISO 8601 datetime OR `YYYY-MM-DD` (interpreted as midnight UTC). |
| `--cluster-id <id>` | string | no | Audit-only; written into `sourceClusterId`. |

### 7.2 Implementation outline

```ts
// packages/cli/src/cli/suppress.ts
export type SuppressOpts = {
  projectDir: string;
  pattern: string;
  reason: string;
  expires?: string;
  clusterId?: string;
};

export async function suppressCommand(opts: SuppressOpts): Promise<void> {
  // 1. Validate pattern via SuppressionPatternSchema.parse (throw on bad).
  // 2. Validate reason (no newlines, length).
  // 3. Parse expires — accept full ISO 8601 OR YYYY-MM-DD; reject anything else.
  // 4. Read .bughunter/suppressions.json (or []).
  // 5. Capture addedBy via getGitUserEmail() — fallback 'unknown'.
  // 6. Dedup: if an entry exists with same (pattern, addedBy) added within the last 60s, log
  //    "Already suppressed by <addedBy> at <addedAt>" and exit 0 without writing.
  // 7. Mint cuid for entry.id. Construct entry. SuppressionsSchema.parse([...all, new]) — defensive.
  // 8. writeJsonFile suppressions.json.
  // 9. Append to suppressions-audit.log: { kind: 'suppress', ... }.
  // 10. process.stdout.write(`Suppressed ${pattern} (${entry.id}); added to .bughunter/suppressions.json\n`);
}
```

### 7.3 Helpers

```ts
// packages/cli/src/suppress/git.ts
export function getGitUserEmail(projectDir: string): string {
  // child_process.execFileSync('git', ['config', 'user.email'], { cwd: projectDir, encoding: 'utf-8', timeout: 2000 })
  // try/catch -> 'unknown'.
  // .trim() the result; empty -> 'unknown'.
}
```

```ts
// packages/cli/src/suppress/expires.ts
export function parseExpires(input: string): string {
  // Accept: 2026-12-31T00:00:00.000Z (full ISO)
  //         2026-12-31           (date-only, treated as 2026-12-31T00:00:00.000Z)
  // Otherwise throw 'expires must be YYYY-MM-DD or ISO 8601 datetime'.
}
```

### 7.4 Exit codes

- `0` on success or no-op dedup.
- `2` on validation failure (bad pattern, missing reason, bad expires).
- `1` on filesystem failure (permissions, disk full).

---

## 8. `bughunter unsuppress`

### 8.1 CLI surface

```
bughunter unsuppress <pattern>
```

`<pattern>` must match `SuppressionPatternSchema`. The unsuppress matches by EXACT pattern equality — globs in stored entries are stored verbatim and matched verbatim. (We do NOT cross-glob: `bughunter unsuppress endpoint:/api/admin/*` removes only entries whose stored pattern is literally `endpoint:/api/admin/*`, not entries whose pattern is `endpoint:/api/admin/users`.)

### 8.2 Implementation

```ts
export async function unsuppressCommand(opts: UnsuppressOpts): Promise<void> {
  // 1. Validate pattern.
  // 2. Read suppressions.json.
  // 3. Partition: kept (pattern !== arg) / removed (pattern === arg).
  // 4. If removed.length === 0 → exit 0 with "No matching suppressions to remove".
  // 5. Append audit event { kind: 'unsuppress', removedSuppressionIds: removed.map(r => r.id), removedCount }.
  // 6. writeJsonFile suppressions.json with kept[].
  // 7. process.stdout.write(`Removed ${removed.length} suppression(s) for ${pattern}\n`).
}
```

### 8.3 Why write-audit-then-delete

If the process crashes between step 5 and step 6, the audit log records intent and the suppressions file is still consistent (entries still present). On next run, the user sees the audit event and can re-run unsuppress idempotently. The reverse order risks losing audit data if the audit-log write fails after the suppressions file is rewritten.

---

## 9. `bughunter triage`

### 9.1 CLI surface

```
bughunter triage [--interactive] [--run-id <id>]
```

- `--interactive` — opens the Ink TUI. v0.28 default-on (no other mode exists yet); the flag documents intent for v0.29's `--batch`.
- `--run-id <id>` — pin a specific run. Defaults to most recent run (`listRunIds(projectDir).sort().reverse()[0]`).

### 9.2 TUI library — Ink

**Choice: [Ink](https://github.com/vadimdemedes/ink) v4.4.x.**

Justification:
- React component model — deterministic, easy to test (`ink-testing-library`).
- Mature: 25k stars, used by GitHub CLI, prisma, gatsby. v4 is current; v5 is alpha.
- Bundle size: ~250KB minified including React. Acceptable because lazy-imported only on `triage` invocation.
- Supports two-pane layout via `<Box flexDirection="row">` cleanly.
- Keystroke handling via `useInput` hook; deterministic.

Alternatives considered:
- **Raw readline** — split-pane is hand-rolled ANSI; ~600 lines; high defect rate. REJECTED.
- **blessed** — older, jQuery-style API; React-mismatch; some maintenance issues. REJECTED.
- **Bubble Tea (Go)** — wrong runtime. REJECTED.
- **prompts** — single-line prompt only; no list view. REJECTED.

The Ink dependency adds React 18 (peer) + ink-renderer; `package.json` ships it as a `peerDependencies` entry where possible to avoid double-installs in user shells, BUT v0.28 ships them as `dependencies` for simplicity (the user is running `bughunter` as a CLI, not a library). We accept the ~250KB cold-start cost.

### 9.3 TUI layout

```
┌───────────────────────────────┬───────────────────────────────────────────────┐
│ Clusters (12)                 │ Cluster detail                                 │
│ ┌──────────────────────────┐  │                                                │
│ │ > 1. console_error       │  │ ID: cml1234abcd                                │
│ │   2. axe_color_contrast  │  │ Kind: console_error                            │
│ │   3. network_5xx         │  │ Identity: console_error|TypeError…|abcdef     │
│ │   4. xss_reflected       │  │ Size: 7 occurrences                            │
│ │   ...                    │  │ Verdict: (none)                                │
│ │                          │  │ Suspected files:                               │
│ │                          │  │   src/auth/login.tsx                           │
│ │                          │  │   src/api/auth.ts                              │
│ │                          │  │ Root cause:                                    │
│ │                          │  │   TypeError: Cannot read 'token' of undefined  │
│ │                          │  │                                                │
│ └──────────────────────────┘  │                                                │
│ j/k navigate · m mark · s     │                                                │
│ suppress · e explain · f fix  │                                                │
│ q quit                        │                                                │
└───────────────────────────────┴───────────────────────────────────────────────┘
```

### 9.4 Keystroke spec

| Key | Action |
|---|---|
| `j` | move selection down (wraps at end) |
| `k` | move selection up (wraps at top) |
| `g` | jump to first cluster |
| `G` | jump to last cluster |
| `m` | open verdict prompt — modal with 4 choices: `b`/`bug`, `f`/`fix-priority`, `p`/`false-positive`, `k`/`known`; ESC cancels. Append `verdict` event. |
| `s` | open suppress prompt — modal with two fields: `pattern` (pre-filled `bugIdentity:<cluster.signatureKey>`), `reason` (free-text, required). Tab moves between fields. Enter submits. Pattern can be edited to `kind:<X>` etc. On submit: invoke `suppressCommand` core helper + append `triage.jsonl` `suppress` event. The suppression takes effect on the NEXT run (not retroactive in the current view). |
| `e` | invoke `explain` for the selected cluster. Display "Explaining…" footer. On completion, render the cached Markdown in the right pane (replacing detail). `r` returns to detail. Append `explain-requested` event. |
| `f` | dispatch `/bughunt fix this cluster` — for v0.28 this writes a `fix-dispatched` event to `triage.jsonl` and prints a copy-to-clipboard line `claude -p '/bughunt fix <runId> <clusterId>'` to a footer; the actual subprocess fork is v0.29 (`f` records intent, doesn't run). |
| `?` | show keybinding help overlay. |
| `q` or Ctrl-C | quit cleanly; flush triage.jsonl. |

### 9.5 State model

```ts
// packages/cli/src/triage/state.ts
export type TriageState = {
  clusters: BugCluster[];
  selectedIdx: number;
  modalKind: 'none' | 'verdict' | 'suppress' | 'explain-loading' | 'explain-detail' | 'help';
  inputBuffer: string;                 // for suppress reason / pattern editing
  inputField: 'pattern' | 'reason' | null;
  patternDraft: string;
  reasonDraft: string;
  explanationCache: Map<string, string>;  // bugIdentity → markdown
  status: string;                      // footer message
};
```

Single reducer; pure functions; tested via `ink-testing-library`.

### 9.6 Empty-run behavior

If the latest run has 0 clusters: print `No clusters in run <id>; nothing to triage.` and exit 0 without entering Ink.

---

## 10. `bughunter explain`

### 10.1 CLI surface

```
bughunter explain <cluster-id> [--no-cache] [--run-id <id>]
```

- `<cluster-id>` — cluster.id from a run.
- `--no-cache` — skip cache; force a Claude call. Used when source files have changed.
- `--run-id <id>` — pin to a run. Default: search runs newest-first for a matching cluster id.

### 10.2 Cache strategy

Cache key: `cluster.signatureKey` (or `cluster.bugIdentity` once v0.27 ships). Cache file: `<projectDir>/.bughunter/explanations/<cacheKey-sanitized>.md`. Sanitize: replace `[^a-zA-Z0-9_.-]` with `_`, max 200 chars.

Hit: read file, print to stdout, return. No Claude call.
Miss: call Claude, write file, print to stdout.
`--no-cache`: write-through; old file overwritten.

### 10.3 Claude subprocess

Spawn `claude -p` with the prompt on stdin. Capture stdout. No tools, no MCP servers, no streaming.

```ts
// packages/cli/src/explain/claude.ts
import { spawn } from 'node:child_process';

export type ExplainArgs = {
  cluster: BugCluster;
  suspectedFileExcerpts: Array<{ path: string; firstLine: number; lastLine: number; content: string }>;
  /** Hard cap on Claude wall-time, default 60s. */
  timeoutMs?: number;
};

export type ExplainResult = {
  markdown: string;
  /** Estimated USD cost from the model used (claude-sonnet ≈ $3/MTok in, $15/MTok out). */
  costUsd: number;
};

export async function explainViaClaude(args: ExplainArgs): Promise<ExplainResult>;
```

The subprocess command: `claude -p` with stdin = the fully-rendered prompt. Exit code non-zero → throw `ExplainError`. Wall-time exceeded → kill + throw.

### 10.4 Prompt template

```
You are reviewing a bug that BugHunter found in the user's codebase. Output ONLY Markdown — no JSON, no shell, no preamble. Aim for under 400 words. Never speculate beyond the evidence below.

## Cluster
- Kind: <cluster.kind>
- Identity: <cluster.signatureKey>
- Cluster size: <cluster.clusterSize>
- Root cause text: "<cluster.rootCause>"
- Suspected files: <cluster.suspectedFiles.join(', ')>

## Evidence
<for each suspected file with content>
### <path>:<firstLine>-<lastLine>
```
<content>
```
</for>

## Sample occurrence
- Role: <cluster.occurrences[0].role>
- Page: <cluster.occurrences[0].page>
- Action: <cluster.occurrences[0].action.kind> on <cluster.occurrences[0].action.selector ?? 'n/a'>

Now write the explanation in this exact structure:

## What's happening
<2-4 sentences>

## Likely root cause
<2-4 sentences; cite the file:line if you can>

## How to fix
<bullet list of 1-3 concrete steps>

## What to verify after the fix
<bullet list of 1-2 verifications>
```

### 10.5 Excerpting suspectedFiles

Read up to 3 suspectedFiles, each capped at 200 lines; if longer, take the first 100 + last 100 with a `...` separator and an `omitted N lines` line. Skip `node_modules`, `.next`, `dist`, `build`. Skip files larger than 1MB on disk (read first 100 + last 100 only).

### 10.6 Cost cap

Per-explain hard cap: $0.50 (refuse and exit 2 if the rendered prompt is so large that 8K + 4K-output completion would exceed it). Document in --help: `Explain cost cap: $0.50/cluster (~5¢ typical).`

Cumulative cost is NOT tracked across explains in v0.28; v0.29 may add a per-month total in `~/.bughunter/explain-budget.json`.

### 10.7 Output

Print the Markdown to stdout. Return exit 0 on success. Cache file is a side-effect; don't print its path unless `--verbose`.

---

## 11. `bughunter` USAGE help string updates

Add to `main.ts:18-72` USAGE block:

```
Usage:
  bughunter init [...]
  bughunter run [options]
  bughunter replay <occurrenceId>
  bughunter inspect <occurrenceId|clusterId>
  bughunter list
  bughunter status <runId>
  bughunter palette
  bughunter prune
  bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]
  bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]
  bughunter fix-summary <runId>
  bughunter suppress <pattern> --reason <text> [--expires <iso>] [--cluster-id <id>]
  bughunter unsuppress <pattern>
  bughunter triage [--interactive] [--run-id <id>]
  bughunter explain <clusterId> [--no-cache] [--run-id <id>]

Triage & suppression:
  Pattern grammar: bugIdentity:<exact> | kind:<BugKind> | endpoint:<glob> |
                   suspectedFile:<glob> | severity:<critical|major|minor|info>
  Reason is REQUIRED on suppress. Audit trail: .bughunter/suppressions-audit.log.
  Triage state: .bughunter/triage.jsonl. Explain cost cap: $0.50/cluster.
```

---

## 12. Edge cases

### EC-1. `git config user.email` is unset
`getGitUserEmail` returns `'unknown'`. `addedBy` field is `'unknown'`. `log.warn('git user.email unset; suppression authorship logged as "unknown"')`.

### EC-2. `suppressions.json` exists but is malformed JSON
`applySuppressions` logs `bughunter: suppressions.json failed to parse: <error>; treating as empty for this run` and proceeds. Next `bughunter suppress` invocation overwrites cleanly with a valid array (atomically).

### EC-3. `suppressions.json` parses as JSON but fails Zod (e.g., extra unknown field, missing required field)
Same as EC-2 — log warning, treat as empty, proceed. The user's stale entries become invisible until they fix the file.

### EC-4. Pattern collisions — one cluster matches N suppressions
First-match wins by precedence (bugIdentity > kind > endpoint > suspectedFile > severity), then by file order within precedence. Only the first match's `matchCount` is incremented.

### EC-5. Expired suppression
`expiresAt < now` at load time. v0.28: log `bughunter: suppression <id> for pattern <pattern> expired on <expiresAt>; still applied (auto-prune in v0.29)`. Match normally.

### EC-6. `bughunter suppress` of a pattern that no current cluster matches
Allowed. The suppression is dormant until a future run produces a matching cluster. Log `Suppressed ${pattern} (no current matches)`.

### EC-7. `bughunter unsuppress` of a pattern with no entries
Exit 0 with `No matching suppressions to remove`. NO audit event written. (If we wrote one, the audit log would be polluted by retries.)

### EC-8. `bughunter suppress severity:critical` when v0.29 hasn't shipped
Suppression is stored. Cluster phase warns once: `bughunter: severity:* pattern present but cluster.severity unset; awaiting v0.29`. Pattern matches nothing in v0.28. Forward-compatible.

### EC-9. `bughunter suppress` race with concurrent `bughunter run`
Concurrent run's `applySuppressions` reads the file as-of-its-start; mid-run write of `suppressions.json` by `bughunter suppress` is NOT picked up. Acceptable. Both processes write atomically; the suppress is consistent on next run.

### EC-10. Pattern with regex-meta in glob — `endpoint:/api/admin/(users|posts)`
micromatch supports extglob; `(a|b)` is valid. Document in --help. If the user wants literal parens they must escape — `endpoint:/api/admin/\\(users\\)`. Out of scope: alternate match modes.

### EC-11. `triage.jsonl` doesn't exist on first invocation
`appendJsonl` creates with the first event. No special-case needed; `fs.appendFileSync` is idempotent on missing files.

### EC-12. Ink TUI fails to render (no TTY)
Detect `process.stdout.isTTY === true` before calling `render`. If false: print `bughunter triage requires a TTY (--batch mode lands in v0.29)` and exit 2.

### EC-13. `claude` binary not on PATH
`spawn('claude', ['-p'])` errors with ENOENT. Catch and exit 2 with `bughunter explain requires the 'claude' CLI on PATH; install per https://docs.anthropic.com/...`.

### EC-14. Suspected file from cluster doesn't exist on disk
Skip silently. Excerpt for that file is omitted from the prompt with `(file not found on disk)`.

### EC-15. Prompt size exceeds Claude context (8 fileExcerpts × 200 lines × ~80 chars = ~128KB)
At excerpting time, hard-cap the rendered prompt at 100,000 chars (rough proxy for ~25K tokens). If over, truncate file content and append `... (truncated for prompt size)`.

### EC-16. `cluster.suspectedFiles` is empty (e.g., header-probe-only finding)
Skip the Evidence section in the prompt; rely on rootCause only. Output is shorter; quality degrades gracefully.

### EC-17. `--cluster-id` references a cluster that doesn't exist in any run
Allowed. v0.28 doesn't validate; the field is audit-only. v0.29 may add `bughunter suppress audit --validate`.

### EC-18. Multiple `bughunter triage` invocations against the same run
Allowed. Each writes its own events to `triage.jsonl`. Consumers (future `bughunter run` priority logic) deduplicate by `(runId, clusterId, kind)`-latest.

### EC-19. `bughunter explain` on a runId that has no clusters
Print `No cluster <clusterId> found in run <runId>; check 'bughunter list'` and exit 1.

---

## 13. Acceptance criteria

| # | Criterion | Verifier |
|---|---|---|
| AC-1 | All Zod schemas in `packages/cli/src/suppress/types.ts` and `packages/cli/src/triage/types.ts` parse the spec's example fixtures cleanly | `vitest run packages/cli/src/suppress/types.test.ts` |
| AC-2 | `bughunter suppress kind:image_missing_alt --reason "decorative"` writes a valid entry + audit event | unit test against tempdir + `vitest` |
| AC-3 | `bughunter suppress` without `--reason` exits 2 with stderr `Error: --reason is required` | `vitest` snapshot |
| AC-4 | `bughunter suppress` with newline in reason exits 2 | unit test |
| AC-5 | `bughunter unsuppress kind:image_missing_alt` removes all entries with that exact pattern + writes audit event | unit test |
| AC-6 | `applySuppressions` removes a `kind:X` cluster from the returned list and emits one `SuppressedSample` | unit test |
| AC-7 | `applySuppressions` first-match-wins precedence: a cluster matching both `bugIdentity:foo` and `kind:bar` is attributed to the bugIdentity entry | unit test |
| AC-8 | Fixture run: 5 clusters → suppress 2 by kind → re-run → `summary.json.suppressedClusters === 2`, `bugs.jsonl` has 3 lines | golden file in `tests/fixtures/v28-suppression/` |
| AC-9 | `audit-log` after suppress + unsuppress contains exactly 2 lines with kinds `'suppress'` then `'unsuppress'` | unit test |
| AC-10 | Ink TUI renders cluster list + detail; `j` advances selection; `q` exits | `ink-testing-library` test |
| AC-11 | TUI `s` keystroke + filled fields writes a `triage.jsonl` `suppress` event AND a `suppressions.json` entry | integration test |
| AC-12 | `bughunter explain <clusterId>` produces Markdown >100 chars containing all four section headers (`## What's happening`, `## Likely root cause`, `## How to fix`, `## What to verify after the fix`) | manual smoke + length assert |
| AC-13 | `bughunter explain` second call with same clusterId is a cache hit (no Claude subprocess) — verify via mock | unit test |
| AC-14 | `bughunter explain --no-cache` always invokes Claude even when cached | unit test |
| AC-15 | `npx tsc --noEmit` clean across the cli package | `tsc` |
| AC-16 | `npx eslint . --max-warnings 0` clean | `eslint` |
| AC-17 | All existing run/replay/inspect tests still pass — the cluster phase is unaffected when `suppressions.json` is absent | `vitest run` |
| AC-18 | `RunSummary.suppressedClusters` is `0` (not `undefined`) on a run with no suppressions file | unit test |
| AC-19 | `bughunter suppress severity:critical --reason X` succeeds; the entry never matches any cluster in v0.28 | unit test |
| AC-20 | `bughunter triage` on a 0-cluster run prints `No clusters…` and exits 0 without rendering Ink | unit test |

---

## 14. Files to touch / add

### 14.1 New files

| Path | Purpose | Approx lines |
|---|---|---|
| `packages/cli/src/suppress/types.ts` | Zod + TS types: `SuppressionEntrySchema`, `AuditEventSchema`, `SuppressedSample` | 80 |
| `packages/cli/src/suppress/git.ts` | `getGitUserEmail` helper | 30 |
| `packages/cli/src/suppress/expires.ts` | `parseExpires` helper | 30 |
| `packages/cli/src/suppress/match.ts` | `matchPattern(cluster, entry): MatchResult` + `extractEndpoint` | 80 |
| `packages/cli/src/suppress/io.ts` | `loadSuppressions(projectDir)`, `saveSuppressions(projectDir, list)`, `appendAuditEvent(projectDir, event)` | 80 |
| `packages/cli/src/suppress/apply.ts` | `applySuppressions` — the cluster-phase integration | 100 |
| `packages/cli/src/suppress/index.ts` | Re-exports for the cli + future MCP wrapper | 20 |
| `packages/cli/src/suppress/types.test.ts` | Zod parse roundtrips | 80 |
| `packages/cli/src/suppress/match.test.ts` | precedence + glob + severity-no-op | 150 |
| `packages/cli/src/suppress/apply.test.ts` | integration: clusters in → filtered + samples out | 150 |
| `packages/cli/src/cli/suppress.ts` | `suppressCommand` | 80 |
| `packages/cli/src/cli/unsuppress.ts` | `unsuppressCommand` | 60 |
| `packages/cli/src/cli/suppress.test.ts` | covers AC-2 through AC-5, AC-9, AC-19 | 200 |
| `packages/cli/src/triage/types.ts` | Zod + TS types: `TriageEventSchema`, `TriageState` | 80 |
| `packages/cli/src/triage/state.ts` | reducer, pure | 150 |
| `packages/cli/src/triage/state.test.ts` | reducer transitions | 150 |
| `packages/cli/src/triage/components/App.tsx` | top-level Ink layout | 60 |
| `packages/cli/src/triage/components/ClusterList.tsx` | left pane | 60 |
| `packages/cli/src/triage/components/ClusterDetail.tsx` | right pane | 80 |
| `packages/cli/src/triage/components/Modal.tsx` | verdict + suppress + help modals | 100 |
| `packages/cli/src/triage/components/App.test.tsx` | ink-testing-library | 150 |
| `packages/cli/src/triage/index.ts` | export `triageCommand` | 60 |
| `packages/cli/src/cli/triage.ts` | thin wrapper that loads runs + lazy-imports Ink + invokes triage | 60 |
| `packages/cli/src/explain/excerpt.ts` | `excerptSuspectedFiles` helper | 80 |
| `packages/cli/src/explain/prompt.ts` | `renderPrompt(cluster, excerpts): string` | 60 |
| `packages/cli/src/explain/cache.ts` | `read`, `write`, `path` helpers | 50 |
| `packages/cli/src/explain/claude.ts` | `explainViaClaude` subprocess wrapper | 80 |
| `packages/cli/src/explain/index.ts` | re-export `explainCluster` orchestrator | 30 |
| `packages/cli/src/explain/excerpt.test.ts` | excerpt + truncation | 80 |
| `packages/cli/src/explain/prompt.test.ts` | snapshot the prompt for a fixture cluster | 60 |
| `packages/cli/src/explain/cache.test.ts` | hit/miss + sanitize | 60 |
| `packages/cli/src/cli/explain.ts` | `explainCommand` — thin CLI wrapper | 60 |
| `packages/cli/src/cli/explain.test.ts` | covers AC-12, AC-13, AC-14, AC-19 | 150 |
| `tests/fixtures/v28-suppression/before-suppress/bugs.jsonl` | 5-cluster fixture | 100 |
| `tests/fixtures/v28-suppression/expected-after-suppress/summary.json` | golden file | 30 |

### 14.2 Modified files

| Path | Change |
|---|---|
| `packages/cli/src/cli/main.ts` | Add 4 cases to switch; update USAGE |
| `packages/cli/src/cli/run.ts` | Insert `applySuppressions` call between `runCluster` and `runState.clusters = …`; pass `suppressedClusters` + `suppressedSamples` into the `RunSummary` build |
| `packages/cli/src/types.ts` | Add `suppressedClusters: number` and optional `suppressedSamples?: SuppressedSample[]` to `RunSummary` |
| `packages/cli/src/store/filesystem.ts` | Add `bugHunterPaths(projectDir)` returning `{ suppressionsFile, auditLogFile, triageFile, explanationsDir }` |
| `packages/cli/package.json` | Add `ink ^4.4.1`, `react ^18.2.0`; devDep `@types/react ^18.2.0`, `ink-testing-library ^3.0.0` |

### 14.3 Files NOT to touch

- `packages/cli/src/phases/cluster.ts` — pure cluster mint stays pure.
- `packages/cli/src/phases/emit.ts` — emit reads `runState.clusters`, which is already the suppressed-filtered set; no change needed.
- `packages/cli/src/cluster/signature.ts` — bugIdentity uses existing `clusterSignature`; no change.
- Any existing test file — additive only.

---

## 15. Task breakdown (agent-sized)

| # | Task | Files | Test | Deps |
|---|---|---|---|---|
| 1 | Suppression types + io + git/expires helpers | `suppress/types.ts`, `suppress/git.ts`, `suppress/expires.ts`, `suppress/io.ts` + tests | `vitest run suppress/` | none |
| 2 | Pattern matching + endpoint extraction | `suppress/match.ts` + test | `vitest run suppress/match.test.ts` | 1 |
| 3 | `applySuppressions` orchestration + golden fixture | `suppress/apply.ts` + test + fixture | `vitest run suppress/apply.test.ts` | 1, 2 |
| 4 | Wire `applySuppressions` into `cli/run.ts`; update `RunSummary` shape | `cli/run.ts`, `types.ts` | run-existing-tests-still-green | 3 |
| 5 | `bughunter suppress` CLI | `cli/suppress.ts` + test, `cli/main.ts` USAGE + dispatch | `vitest run cli/suppress.test.ts` | 1 |
| 6 | `bughunter unsuppress` CLI | `cli/unsuppress.ts` + test, `cli/main.ts` USAGE + dispatch | `vitest run cli/unsuppress.test.ts` | 1 |
| 7 | Explain excerpt + prompt + cache | `explain/excerpt.ts`, `explain/prompt.ts`, `explain/cache.ts` + tests | `vitest run explain/` | none |
| 8 | Explain Claude subprocess wrapper | `explain/claude.ts` + test (mock spawn) | `vitest run explain/claude.test.ts` | 7 |
| 9 | `bughunter explain` CLI orchestrator | `explain/index.ts`, `cli/explain.ts` + test, `cli/main.ts` USAGE + dispatch | `vitest run cli/explain.test.ts` | 7, 8 |
| 10 | Triage state reducer | `triage/types.ts`, `triage/state.ts` + test | `vitest run triage/state.test.ts` | none |
| 11 | Triage Ink components | `triage/components/**.tsx` + App test | `vitest run triage/components/` | 10 |
| 12 | `bughunter triage` CLI wrapper + lazy Ink import | `triage/index.ts`, `cli/triage.ts`, `cli/main.ts` USAGE + dispatch | `vitest run cli/triage.test.ts` | 10, 11, 5 |
| 13 | Spec parity smoke: full fixture run + diff | `tests/integration/v28-suppress.test.ts` | `vitest run tests/integration/v28-suppress.test.ts` | 4, 5, 6 |

Each task is independently completable in ~30 minutes of human-equivalent effort; tasks 11 and 13 are the largest at ~60 minutes due to TUI testing and integration scope.

---

## 16. Negative requirements

- Do **not** export anything from `phases/cluster.ts` that wasn't already exported. The integration is in `cli/run.ts`.
- Do **not** create a new file in `cluster/`. Suppression matching is its own subsystem.
- Do **not** mutate the cluster object in `applySuppressions` other than reading from it. Suppressed clusters are dropped from the output, never tagged.
- Do **not** add `as any` or `as unknown as X` anywhere in v0.28 code paths. Type errors mean a Zod parse step is missing or a discriminated union is incomplete.
- Do **not** allow function bodies > 40 lines. The Ink components are the easy regression here — split each pane into its own component.
- Do **not** introduce a top-level `triage/` directory that shadows existing semantics. Subdirectory names already used: `analyze`, `auth-flow`, `crawl`, `cluster`, `discovery`, `emit`, `execute`, `phases`, `plan`. `suppress`, `triage`, and `explain` are new and unambiguous.
- Do **not** ship Ink as a pinned-without-range dep. v4 has frequent patch releases; pin to `^4.4.1` for SemVer-minor flexibility.
- Do **not** add any timing/sleep loops in tests (they're flaky); use `vi.useFakeTimers` if a delay is genuinely needed (it shouldn't be).
- Do **not** commit `.bughunter/` test artifacts; respect existing `.gitignore`.

---

## 17. Risks + escape hatches

- **Ink/React bundle weight.** Lazy-import inside the `triage` handler; `run` never pays.
- **micromatch extglob surprise.** Document grammar in `--help`; pin `{ dot: false, contains: false }`.
- **`claude -p` not on PATH.** EC-13 friendly error with install link.
- **Prompt overflow.** EC-15 hard 100K-char cap with truncation note.
- **Audit log unbounded growth.** Append-only; few hundred KB/year is negligible. v0.30 may archive.
- **Escape hatch:** `BUGHUNTER_DISABLE_SUPPRESSIONS=1` env var bypasses `applySuppressions` and runs as if the file were empty.

---

## 18. Killer-demo runbook

```bash
cd /tmp/v28-demo
bughunter run --max-bugs 50
jq '.bugs_filed' .bughunter/runs/$(ls -t .bughunter/runs|head -1)/summary.json
# → e.g. 12

bughunter inspect cml123abc                       # decide it's decorative SVG; false positive
bughunter suppress 'kind:image_missing_alt' \
  --reason 'decorative SVG icons; product accepted; PROD-1234' \
  --cluster-id cml123abc

bughunter run --max-bugs 50
jq '.bugs_filed, .suppressedClusters' .bughunter/runs/$(ls -t .bughunter/runs|head -1)/summary.json
# → 9, 3

cat .bughunter/suppressions.json | jq '.[] | {pattern, addedBy, reason}'
cat .bughunter/suppressions-audit.log | jq -c .

bughunter explain cml456def                       # Markdown to stdout, cached
bughunter triage                                  # Ink TUI: j/k navigate, s suppress, e explain
bughunter unsuppress 'kind:image_missing_alt'     # after fix lands
```

---

## 19. Definition of Done

- [ ] All four CLI commands implemented and passing AC-1 through AC-20.
- [ ] `applySuppressions` integrated in `cli/run.ts` between cluster mint and runState assignment.
- [ ] `RunSummary` carries `suppressedClusters: number` always; `suppressedSamples?: SuppressedSample[]` when > 0.
- [ ] Audit log + suppressions file behave correctly across all edge cases EC-1 through EC-19.
- [ ] Ink TUI renders, navigates, suppresses, and exits cleanly; `m`, `s`, `e`, `f`, `q`, `?` all work.
- [ ] `bughunter explain` produces Markdown matching the four-section structure for the fixture cluster.
- [ ] Caches honor `--no-cache` correctly.
- [ ] All Zod schemas reject the documented invalid inputs.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx eslint . --max-warnings 0` clean.
- [ ] `npx vitest run` clean (existing + new tests).
- [ ] `npm run build` succeeds.
- [ ] USAGE help text updated; `bughunter --help` lists the four new commands.
- [ ] Fixture in `tests/fixtures/v28-suppression/` reproducibly demonstrates suppress → run → unsuppress → run.
- [ ] No new file outside `Files to touch / add` (§14).

---

## 20. Open questions

1. **`summary.json.suppressedSamples` shipped or only the count?** Spec ships samples (capped at 20). Argument for: human-eyeball verification. Argument against: leaks suppressed bug data into dashboards. Lean: include — the user opted in with a reason; consumers should keep humans aware.
2. **TUI `f` (fix dispatch) — actually dispatch or record intent?** Spec records intent + prints a copy-paste command. Real dispatch deferred to v0.29; the architect/coder dispatch already lives in the Claude skill, not in `bughunter` itself.
3. **Should `bughunter run` consume `triage.jsonl` for fix-priority ordering?** v0.28 only writes; v0.28b (separate PR) reads. Keeps v0.28 PR small.
4. **Suppress before or after the analyze (heap-attribution) phase?** Before (current spec) — saves analyze cost on suppressed leaks. Cost: un-suppressing later won't have attribution; user re-runs.
5. **Anthropic SDK vs `claude -p` subprocess for explain?** Subprocess (matches existing auto-fix path; no SDK auth surface). MCP wrapper may revisit.
6. **`bughunter triage --cluster-id <id>` to jump directly?** Out of scope; easy v0.29 follow-up.
7. **Default suppression expiry?** No (per spec). Long-lived "third-party never-flag" entries are common; auto-prune is v0.29.
8. **`severity:critical` warn at suppress-time, not just apply-time?** Polish; revisit if users complain.
9. **Audit log per-user or per-project?** Per-project (suppressions ARE per-project; audit follows). Cross-project audit is v0.30.
