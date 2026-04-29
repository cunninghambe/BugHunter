# SPEC — v0.8 "Memory leak attribution via heap-snapshot diffing"

**Status:** Draft 1 — ready for `@coder` assignment after v0.6 perf has soaked in production for ≥1 week · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** v0.6 perf (`SPEC_V06_PERFORMANCE.md`, shipped via PR #26 — `memory_leak_suspected` exists as a growth-only signal) · **Successor:** v0.9 (offline behavior + multi-viewport).

This spec **upgrades** the existing `memory_leak_suspected` BugKind from a low-confidence growth-detection signal into a high-confidence attribution finding. v0.6 reports "heap is growing"; v0.8 reports "heap is growing **because** these objects are retained by these closures." The diff is what makes the finding actionable.

---

## 0. Reading guide

| Section | Audience | When to read |
|---|---|---|
| §1 Objective + boundaries | everyone | first |
| §2 Existing code map | `@coder` | before keyboard touch |
| §3 New CDP surface | `@coder` (HeapProfiler subset) | before T1 |
| §4 New module: `analyze/heap-diff.ts` | `@coder` | before T2 |
| §5 New BugKind: `memory_leak_attributed` | `@coder` | before T3 |
| §6 Promotion of existing `memory_leak_suspected` | `@coder` | before T4 |
| §7 Config / CLI surface | `@coder` | before T5 |
| §8 Negative requirements | everyone | before commit |
| §9 Task breakdown | assignee | per task |
| §10 Acceptance + done-when matrix | `@qa` | end of phase |
| §11 Killer-demo runbook | `@architect` | end-of-phase verification |
| §12 Risk + escape hatches | everyone | before commit |

---

## 1. Objective

Add **one new BugKind** (`memory_leak_attributed`) that runs heap-snapshot diffing **only when** the v0.6 `memory_leak_suspected` cluster fires for a run. Snapshot diffing is expensive (~50-200MB heap dump per snapshot, ~5-10s parse time per diff) — running it unconditionally blows the perf budget. The decision to diff is signal-driven: the slope-detector in v0.6 says "something leaked," v0.8 then says "and here's what."

The single kind:

1. `memory_leak_attributed` — heap-snapshot diff between action N and action N+K reveals ≥1 object class that grew by **≥10 instances OR ≥5MB retained** AND whose retainer chain includes a non-DOM, non-singleton root (i.e., not the `window`, not React's root fiber, not the Redux store — these are expected to grow). The finding emits the **constructor name**, **retainer chain** (top 3 frames), and **estimated leak rate** (instances/action).

**Out of scope** (do not implement, even partially):

- Native (C++) leak detection — requires perf_hooks + `--inspect`'d Node, not the browser. v0.9 considers it.
- Cross-tab leak attribution — single-tab only.
- Leak fix suggestions ("you should null this ref") — too speculative; v1.0.
- Heap snapshots of pages without an action sequence — v0.8 only runs if ≥3 actions executed against the page.
- `BigInt`-typed leak attribution — V8 reports them as `BigInt` constructor with no further detail; not enough signal.
- WeakMap/WeakSet leak attribution — by definition not retained; if it grows, it's a logic bug elsewhere; report as `memory_leak_suspected` only.
- Snapshot diffing during the `execute` phase — too expensive on the hot path. Diff runs in a new `analyze` phase between `cluster` and `emit`.

The shape of v0.8: **one new CDP method group** (`HeapProfiler.takeHeapSnapshot` + `HeapProfiler.collectGarbage`), **one new module** (`analyze/heap-diff.ts`), **one new phase** (`phases/analyze.ts` — sized to v0.6 perf's `phases/cluster.ts`), and **one new BugKind** layered on top.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/adapters/cdp-session.ts` | The CDP adapter from v0.6. `subscribe`, `drain`, `sample`. **Extend** with `takeHeapSnapshot` + `collectGarbage`; do not duplicate the session lifecycle. |
| `packages/cli/src/perf/perf-collector.ts` | Where `HeapSample[]` is collected today. Snapshot capture goes here too — gated by `config.perf.heapAttribution === true`. |
| `packages/cli/src/types.ts` | `BugKind` union (`memory_leak_suspected` exists). Add `memory_leak_attributed`. New `HeapSnapshot` + `HeapSnapshotDiff` types. |
| `packages/cli/src/classify/network.ts` | Pattern for classifier that reads PerfArtifacts. Mirror this for heap-diff classifier. |
| `packages/cli/src/cluster/signature.ts` | New cluster-signature case. Pattern: `memory_leak_attributed | <constructor> | <retainerChain[0]>`. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. New kind slots **just above** `memory_leak_suspected`; if both fire on the same run, attributed wins. |
| `packages/cli/src/phases/cluster.ts` | Cluster materialization. New phase `analyze` runs **between** cluster and emit. |
| `packages/cli/src/phases/emit.ts` | Run summary emission. Add `heapAttributionSummary` field similar to v0.6's `perfSummary`. |
| `packages/cli/src/store/filesystem.ts` | `runPaths()`. New artifacts under `runs/<runId>/heap/`. Snapshots are large (50-200MB); store gzipped. |

### 2.2 Patterns to follow

- **Adapter pattern.** CDP HeapProfiler additions go in `cdp-session.ts`. No `playwright-core` import outside that file.
- **Phase boundary.** Heap-diff is a new phase: `analyze`. Phases are: `validate → discover → plan → execute → classify → cluster → analyze → emit → done`. (The `RunPhase` union in `types.ts:549` adds `analyze`.)
- **Snapshot retention.** Snapshots are gzipped to disk under `runs/<runId>/heap/`. Default keep last 3 (the diff window). Older snapshots are dropped after diff to save disk.
- **Re-entrancy.** Diff is deterministic: same two snapshots → same result. Re-run safe.
- **Discriminated-union returns.** Phase function returns `{ ok: true; data: HeapDiffResult } | { ok: false; reason: string }`.

### 2.3 DO NOT

- Do **not** run heap-snapshot capture on every action — gated by the v0.6 `memory_leak_suspected` cluster's existence in the run.
- Do **not** store ungzipped snapshots — they are 50-200MB each.
- Do **not** modify `BrowserMcpAdapter` — extend `cdp-session.ts` instead.
- Do **not** add a new dependency. V8 heap-snapshot format is documented; write the parser inline (~200 lines).
- Do **not** wrap third-party heap-diff tools (`heapdump`, `memwatch-next`, `node-heapdump`) — they target Node, not Chrome via CDP.
- Do **not** report findings on snapshot diffs that show `<10` instance growth AND `<5MB` retained — too noisy.
- Do **not** include `(Map)`, `(Array)`, `(Object)` constructors in retainer chains — too generic to action.

---

## 3. New CDP surface

Extend `packages/cli/src/adapters/cdp-session.ts` with:

```ts
export interface CdpSessionInterface {
  // existing v0.6 surface ...
  takeHeapSnapshot(reportProgress: boolean): Promise<HeapSnapshotRaw>;
  collectGarbage(): Promise<void>;
}

export type HeapSnapshotRaw = {
  capturedAtMs: number;
  /** V8 heap-snapshot JSON; gzipped on disk, parsed in-memory */
  json: string;
};
```

**Behavior of `takeHeapSnapshot`:**
1. Send `HeapProfiler.takeHeapSnapshot` over CDP with `reportProgress: false`.
2. Stream `HeapProfiler.addHeapSnapshotChunk` events into a buffer.
3. Wait for `HeapProfiler.reportHeapSnapshotProgress` final event.
4. Return the concatenated JSON string.

**Behavior of `collectGarbage`:**
1. Send `HeapProfiler.collectGarbage` over CDP.
2. Wait for `Heap.garbageCollected` event (or timeout at 5s).
3. Return.

**Snapshot capture protocol** (in `phases/analyze.ts`):
1. `await cdpSession.collectGarbage()` — force GC so transient allocations don't pollute snapshot.
2. `await cdpSession.takeHeapSnapshot(false)` — capture cleaned snapshot.
3. Gzip + write to `runs/<runId>/heap/snapshot-<actionIdx>.json.gz`.
4. Repeat at action boundaries: indices 0, ⌊N/2⌋, N (start, mid, end of run). Three snapshots → two diffs.

---

## 4. New module: `analyze/heap-diff.ts`

**Public surface:**

```ts
export type HeapSnapshotDiff = {
  beforeIdx: number;
  afterIdx: number;
  capturedAtMsBefore: number;
  capturedAtMsAfter: number;
  /** Sorted by retainedDelta DESC */
  growthByConstructor: HeapDiffEntry[];
};

export type HeapDiffEntry = {
  constructorName: string;
  instanceCountBefore: number;
  instanceCountAfter: number;
  instanceCountDelta: number;
  retainedSizeBefore: number;     // bytes
  retainedSizeAfter: number;
  retainedSizeDelta: number;
  /** Top 3 retainer-chain frames; empty if no chain found */
  retainerChain: string[];
};

export interface HeapDiffInterface {
  diff(beforeRaw: HeapSnapshotRaw, afterRaw: HeapSnapshotRaw): HeapSnapshotDiff;
}

export class V8HeapSnapshotDiff implements HeapDiffInterface { /* ... */ }
```

**Behavior:**
1. Parse both snapshots (V8 heap-snapshot JSON format: `{ snapshot, nodes, edges, strings, ... }`).
2. Group nodes by constructor name (read via `nodes[i].name` index → `strings[]`).
3. Compute per-constructor stats: count, retained size sum.
4. For constructors with `instanceCountDelta ≥ 10` OR `retainedSizeDelta ≥ 5_000_000`, walk the retainer chain (parent edges) up to 3 hops. Skip generic constructors (`(Object)`, `(Array)`, `(Map)`, `(Set)`, `(WeakMap)`, `(WeakSet)`, `(closure)`, `Window`, `Document`).
5. Sort `growthByConstructor` by `retainedSizeDelta DESC`.

**Edge cases:**
- Snapshot JSON malformed → throw `HeapDiffError('parse_failed')`. Caller treats as `infraFailure`.
- Constructors that exist only in the after snapshot (instanceCountBefore=0): include them.
- Constructors that shrunk (negative delta): exclude. We're tracking growth.
- Snapshots captured >5min apart: still diff, but flag in result with `largeTimeGap: true` for context.

**Performance budget:** ≤ 10s per diff for 100MB snapshots.

---

## 5. New BugKind: `memory_leak_attributed`

**Trigger:**
- v0.6 `memory_leak_suspected` cluster exists in the run **AND**
- ≥1 `HeapDiffEntry` in the run satisfies BOTH:
  - `instanceCountDelta ≥ 10` OR `retainedSizeDelta ≥ 5_000_000`
  - `retainerChain.length > 0` AND retainer chain does **not** include `Window`, `Document`, `(Module)`, or React's `FiberRoot`

**One detection per qualifying entry**, **per diff** (so a 3-snapshot run has up to 2 diffs each producing N entries).

**Cluster signature:**
```ts
case 'memory_leak_attributed':
  return `memory_leak_attributed|${detection.heapContext?.constructorName ?? ''}|${detection.heapContext?.retainerChain?.[0] ?? ''}`;
```

**`BugDetection.heapContext`:**
```ts
heapContext?: {
  constructorName: string;
  instanceCountDelta: number;
  retainedSizeDelta: number;
  retainerChain: string[];
  diffWindow: { beforeActionIdx: number; afterActionIdx: number };
  largeTimeGap?: boolean;
};
```

**Confidence:**
- High: constructor not in stdlib (`HTMLDivElement`, `Object`, etc.) AND retainer chain has ≥2 frames.
- Medium: constructor in stdlib OR retainer chain has 1 frame.
- (No "low" — those are filtered out.)

**Done-when:**
- Synthetic fixture (intentional leak: closure-captured array push in event handler) emits exactly 1 finding with the correct constructor name.
- TraiderJo run: best-effort; document actual finding in §11.

---

## 6. Promotion of existing `memory_leak_suspected`

When `memory_leak_attributed` fires on a run, the corresponding `memory_leak_suspected` cluster's `relatedClusters[]` is populated with the attributed cluster ids — and a note added to the suspected cluster's summary: "see `memory_leak_attributed` for retainer attribution."

Both clusters survive — they convey different signals. Suspected = "heap grew." Attributed = "and here's what." Co-existence helps reviewers triage.

---

## 7. Config / CLI surface

```
--enable-heap-attribution      Enable v0.8 heap-snapshot capture + diff. Implies --enable-memory-profile.
--heap-snapshot-frequency=N    Capture snapshot every N actions (default 'auto' = at indices 0, mid, end).
--heap-diff-min-instances=N    Minimum instance delta to flag (default 10).
--heap-diff-min-bytes=N        Minimum retained-size delta to flag, in bytes (default 5000000).
```

`config.ts` additions:

```ts
perf: {
  // existing v0.6 keys ...
  heapAttribution?: boolean;     // default false
  heapSnapshotFrequency?: 'auto' | number;  // default 'auto'
  heapDiffMinInstances?: number; // default 10
  heapDiffMinBytes?: number;     // default 5_000_000
};
```

Defaults:
- `--enable-heap-attribution` is **off by default**. Adds 30-60s runtime + 100-300MB peak memory + 200MB disk.
- Adoption path: users running `--enable-memory-profile` who see `memory_leak_suspected` enable `--enable-heap-attribution` for follow-up runs to attribute the leak.

---

## 8. Negative requirements

- Coder must **not** modify `BrowserMcpAdapter` — extend `cdp-session.ts` instead.
- Coder must **not** add a new runtime dep (`heapsnapshot-parser`, etc.) — write the parser inline.
- Coder must **not** capture snapshots when `memory_leak_suspected` did not fire in the prior run AND `--enable-heap-attribution` was not explicitly passed.
- Coder must **not** retain ungzipped snapshots after diff completes.
- Coder must **not** flag findings whose retainer chain is exclusively generic (`(Object)`, `(Array)`, etc.).
- Coder must **not** include the heap-diff in the `execute` phase — it lives in a new `analyze` phase.

---

## 9. Task breakdown

| # | Task | File(s) | Deps | Owner |
|---|---|---|---|---|
| 1 | Extend `cdp-session.ts` with `takeHeapSnapshot` + `collectGarbage` | `adapters/cdp-session.ts` | none | coder |
| 2 | New module: `analyze/heap-diff.ts` (V8HeapSnapshotDiff) | `analyze/heap-diff.ts` (new) | 1 | coder |
| 3 | Heap-diff parser + retainer-chain walk | `analyze/heap-diff.ts` | 2 | coder |
| 4 | New phase: `phases/analyze.ts` | `phases/analyze.ts` (new) | 1, 2, 3 | coder |
| 5 | Add `memory_leak_attributed` to `BugKind` union + `heapContext` to `BugDetection` | `types.ts` | none | coder |
| 6 | Add cluster signature + KIND_PRIORITY slot | `cluster/signature.ts`, `phases/classify.ts` | 5 | coder |
| 7 | Wire phase ordering: cluster → analyze → emit | `cli/run.ts` | 4, 6 | coder |
| 8 | Promote `memory_leak_suspected` with `relatedClusters[]` | `phases/classify.ts`, `cluster/signature.ts` | 5, 6 | coder |
| 9 | Config + CLI flags | `config.ts`, `cli/main.ts` | 5 | coder |
| 10 | Snapshot gzip storage + retention policy | `store/filesystem.ts`, `phases/analyze.ts` | 1, 4 | coder |
| 11 | Run-summary `heapAttributionSummary` field | `phases/emit.ts`, `cli/run.ts` | 7 | coder |
| 12 | Unit tests: heap-diff parser (8 cases) | `analyze/heap-diff.test.ts` (new) | 3 | coder |
| 13 | Unit tests: phase analyze (6 cases via mock) | `phases/analyze.test.ts` (new) | 4 | coder |
| 14 | Synthetic fixture: `fixtures/heap-leak/` (intentional closure-captured array) | `fixtures/heap-leak/` (new) | none | coder |
| 15 | Integration test: smoke against `fixtures/heap-leak` produces ≥1 `memory_leak_attributed` | `tests/integration/heap-leak.test.ts` | 7, 11, 14 | coder |
| 16 | TraiderJo killer-demo update — `--enable-heap-attribution` runbook | `SPEC_V08_MEMORY_LEAK.md` §11 | 15 | architect |

---

## 10. Acceptance + done-when matrix

| Behavior | Verification |
|---|---|
| `cdpSession.takeHeapSnapshot` returns parseable JSON | unit test |
| `V8HeapSnapshotDiff.diff` correctly identifies +20 instances of class `Foo` | unit test |
| `V8HeapSnapshotDiff.diff` correctly walks retainer chain ≥ 2 frames | unit test |
| Snapshots stored gzipped under `runs/<runId>/heap/` | integration test |
| Snapshots dropped after diff (only last 3 retained) | integration test |
| `analyze` phase runs only when `memory_leak_suspected` fired OR `--enable-heap-attribution` set | integration test |
| Synthetic leak fixture produces ≥1 `memory_leak_attributed` cluster with correct constructor | integration test |
| `memory_leak_suspected` cluster's `relatedClusters[]` includes attributed cluster id | integration test |
| Run summary includes `heapAttributionSummary` when enabled | integration test |
| Non-leaking fixture produces 0 `memory_leak_attributed` clusters | integration test |
| Re-running with same snapshots produces same diff (deterministic) | integration test |
| `--heap-diff-min-instances` and `--heap-diff-min-bytes` thresholds respected | integration test |

**Phase passes when:**
- All 16 tasks complete with green tests.
- `npx tsc --noEmit` clean, `npx eslint . --max-warnings 0` clean.
- Synthetic fixture produces 1 `memory_leak_attributed` cluster.
- Non-leak fixture produces 0 `memory_leak_attributed` clusters (no false positives).
- v0.6 perf integration tests still pass (regression gate).

---

## 11. Killer-demo runbook (TraiderJo)

```bash
cd /tmp/TraiderJo
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --enable-memory-profile --enable-heap-attribution \
  --max-bugs 50 --budget 1800000
```

Expected output:
- If TraiderJo has a real leak (e.g., closure-captured trade array): 1× `memory_leak_attributed` with `constructorName: 'Trade'` (or similar) + retainer chain showing the offending closure.
- If TraiderJo has no leak: `memory_leak_suspected` does not fire → analyze phase exits early → 0 `memory_leak_attributed` findings. Negative result is also acceptable for the demo (proves no false positives).

Document actual outputs in v0.8 release notes.

---

## 12. Risk + escape hatches

- **Risk: snapshot capture OOMs the test browser.** Snapshots are 50-200MB. Mitigation: capture only on configured boundaries (3 per run by default), gzip immediately, drop ungzipped buffer.
- **Risk: heap-diff parser crashes on malformed snapshots.** Mitigation: try/catch around parse; emit `infraFailure` not `memory_leak_attributed`; continue run.
- **Risk: false positives from legitimate caches.** Mitigation: 5MB retained-size threshold; users can raise via `--heap-diff-min-bytes`. Document cache-allowlist file in v0.9 if signal-to-noise becomes a problem in production.
- **Risk: snapshot capture interferes with action timing.** Snapshots take ~3-5s. Mitigation: capture happens between actions, not during. Action sequence is restored by re-issuing the focus state (no state mutation during snapshot).
- **Escape hatch:** `--no-heap-attribution` disables the entire v0.8 path, even if `memory_leak_suspected` fires. For users who only want the v0.6 growth-detection signal.
