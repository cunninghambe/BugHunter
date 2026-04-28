# SPEC — v0.15 "Vision consistency: N-of-M agreement"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Sibling spec:** `SPEC_V14_SEED_DATA_HOOKS.md` · **Predecessor:** v0.13 vision-baseline auth survival.

This spec is the implementation contract for vision-result consistency. The same Aspectv3 target, vision-baseline screenshots from a stable post-login DOM, ran through Sonnet 4.6 produced **14 anomalies on one run and 0 on the next**. The screenshots are byte-different (different captures of the same SPA at different timing), but the underlying UI state is the same. Sonnet's prose-judgment classifier is stochastic on borderline cases; minor anomalies appear and disappear between runs. v0.15 stabilizes the output by running each unique screenshot through the classifier N times and only filing a `visual_anomaly` when M-of-N runs agree on severity AND category.

---

## 1. Objective

Add a `consistencyRuns` config knob to `VisionConfig` (default 2) that runs each *unique* screenshot through the vision classifier N times with `temperature: 0`. Aggregate results per screenshot: only emit a `visual_anomaly` cluster when the SAME finding appears in ≥M-of-N calls. Default M is `Math.ceil(consistencyRuns / 2)` for `agreementMode: 'lenient'` or `consistencyRuns` (unanimous) for `agreementMode: 'strict'`. Default mode is `'strict'`.

**In scope:**
- `VisionConfig.consistencyRuns: number` (default 2, max 5)
- `VisionConfig.agreementMode: 'strict' | 'majority'` (default `'strict'` when `consistencyRuns >= 2`)
- Run vision N times per unique screenshot (not per page; dedup-hash check still applies first)
- Aggregation logic: match anomalies across runs by `category` + lowercased element-substring overlap (Jaccard ≥ 0.5)
- Telemetry: `visionConsistency` block on `summary.json` showing runs/screenshot, agreement rate, dropped-by-disagreement count
- Cost knob: per-run cost is multiplied by `consistencyRuns`. Document the budget impact; respect `costCapUsd` ceiling.

**Out of scope (deferred):**
- Cross-screenshot deduplication of anomalies (e.g., the same "table clip" finding on 6 pages → one cluster) — already handled by `clusterSignature`; nothing changes here
- LLM-as-judge for anomaly matching across runs — v0.16
- Active reasoning prompts ("explain why you saw this") — v0.16
- Confidence scores on individual anomalies — v0.17
- Adaptive N (e.g., re-run only when first call returns ≥1 anomaly) — v0.17

**Acceptance target on Aspectv3:**
With `consistencyRuns: 2, agreementMode: 'strict'`, two consecutive smoke runs produce visual-anomaly counts within **±20% of each other**. The 14-vs-0 flap observed on the v0.13 run pair must NOT recur. If it does, that's a consistency-aggregation bug, not a Sonnet stochasticity issue (which is what we're stabilizing).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `VisionConfig`. Add `consistencyRuns` and `agreementMode` fields. |
| `packages/cli/src/config.ts` | Zod schema for `vision`. Add the two new fields with defaults + bounds (1 ≤ consistencyRuns ≤ 5). |
| `packages/cli/src/classify/vision.ts` | `classifyVisualAnomalies`. The current single-call path. Wrap it with `classifyVisualAnomaliesConsistent` that calls N times and aggregates. **Do not modify the inner `classifyVisualAnomalies` semantics** — keep the single-call function pure for unit-test reuse. |
| `packages/cli/src/classify/vision-budget.ts` | `VisionBudget.tryConsume()`. Each consistency-run consumes a budget unit; the dedup check (`tryConsumeHash`) is a single check before all N runs. |
| `packages/cli/src/phases/discover.ts` | `runVisualBaseline` — line 232. Call site of `classifyVisualAnomalies`. Replace with the new aggregator. Maintain the existing screenshot-hash dedup that runs BEFORE budget consumption. |
| `packages/cli/src/phases/execute.ts` | Line ~670 — the per-occurrence vision call when `missing_state_change` fires. ALSO must be wrapped to use the consistency aggregator. |
| `packages/cli/src/phases/emit.ts` | `TestCounters.vision` block. Add `visionConsistency` sub-block to summary. |

### 2.2 Patterns to follow

- **Pure function for aggregation.** `aggregateConsistencyResults(results: BugDetection[][], mode: 'strict' | 'majority'): BugDetection[]` is fully unit-testable.
- **Same screenshot, multiple calls.** Each call uses `temperature: 0` and identical prompt. Sonnet may still vary on borderline cases (that's why we run N).
- **Budget accounting.** `visionBudget.tryConsume()` called before EACH run. If budget exhausted mid-aggregation, stop and aggregate over the runs we got. Telemetry records the partial state.
- **Discriminated-union returns.** Aggregator returns the merged `BugDetection[]`; per-run results are kept in telemetry only.

### 2.3 DO NOT

- Do **not** modify the existing single-call `classifyVisualAnomalies` semantics. Wrap it.
- Do **not** add a new BugKind. The output is still `visual_anomaly`.
- Do **not** change `clusterSignature`. Cross-page dedup is already handled.
- Do **not** parallelize the N calls per screenshot. Sequential keeps budget accounting deterministic and avoids rate-limit spikes. (If profiling later shows a need, parallelize within a screenshot only.)
- Do **not** silently file lower-confidence findings. If `agreementMode: 'strict'` and only 1-of-2 calls saw the anomaly, drop it AND record the disagreement in telemetry.

---

## 3. Configuration shape

Add to `VisionConfig` in `types.ts`:

```ts
export type VisionConfig = {
  // ... existing fields ...

  /**
   * Number of times to run each unique screenshot through the classifier.
   * Default: 2. Max: 5. Set to 1 to disable consistency checking.
   */
  consistencyRuns?: number;

  /**
   * How to aggregate anomalies across the N consistency runs.
   * - 'strict': all N runs must agree on the anomaly (unanimous).
   * - 'majority': ≥ ceil(N/2) runs must agree.
   * Default: 'strict' when consistencyRuns >= 2; ignored when consistencyRuns === 1.
   */
  agreementMode?: 'strict' | 'majority';
};
```

### 3.1 Zod additions in `config.ts`

```ts
consistencyRuns: z.number().int().min(1).max(5).default(2),
agreementMode: z.enum(['strict', 'majority']).default('strict'),
```

### 3.2 Resolved config defaults

`resolveVisionConfig` returns:

```ts
{
  // ... existing ...
  consistencyRuns: c?.consistencyRuns ?? 2,
  agreementMode: c?.agreementMode ?? 'strict',
}
```

---

## 4. Module surface

### 4.1 New aggregator function in `classify/vision.ts`

```ts
/**
 * Match two anomalies as "the same finding" when they share the same
 * visualCategory and their element references overlap (lowercased Jaccard
 * substring >= 0.5). Severity equality is required only in 'strict' mode.
 */
export function anomalyMatches(
  a: BugDetection,
  b: BugDetection,
  mode: 'strict' | 'majority'
): boolean;

/**
 * Aggregate N runs of vision results into a consistency-filtered list.
 * - 'strict': keep an anomaly only if it appears in ALL N runs.
 * - 'majority': keep if it appears in >= ceil(N/2) runs.
 *
 * Returned BugDetection uses the FIRST occurrence as canonical (description,
 * element, severity, suggestedFix) but reports the agreement count via a new
 * field on the detection's metadata.
 */
export function aggregateConsistencyResults(
  results: BugDetection[][],
  mode: 'strict' | 'majority'
): { kept: BugDetection[]; droppedByDisagreement: number; agreementRate: number };
```

### 4.2 Wrapped classifier

```ts
export type ConsistentClassifyInput = ClassifyVisualInput & {
  consistencyRuns: number;
  agreementMode: 'strict' | 'majority';
};

export type ConsistentClassifyResult = {
  detections: BugDetection[];               // post-aggregation
  perRunDetections: BugDetection[][];       // raw, for telemetry
  callsAttempted: number;                   // <= consistencyRuns
  callsSucceeded: number;
  droppedByDisagreement: number;
  agreementRate: number;                    // 0..1; 1 means all pairs agreed
};

export async function classifyVisualAnomaliesConsistent(
  input: ConsistentClassifyInput
): Promise<ConsistentClassifyResult>;
```

Implementation sketch:

```ts
async function classifyVisualAnomaliesConsistent(input) {
  const perRun: BugDetection[][] = [];
  let succeeded = 0;
  for (let i = 0; i < input.consistencyRuns; i++) {
    if (input.budget && !input.budget.tryConsume()) break;  // budget exhausted
    const dets = await classifyVisualAnomalies(input);
    perRun.push(dets);
    succeeded++;
  }
  const { kept, droppedByDisagreement, agreementRate } = aggregateConsistencyResults(perRun, input.agreementMode);
  return { detections: kept, perRunDetections: perRun, callsAttempted: input.consistencyRuns, callsSucceeded: succeeded, droppedByDisagreement, agreementRate };
}
```

### 4.3 Aggregation algorithm details

**Step 1: build clusters across runs.**
For each anomaly in run 0, search for matches in runs 1..N-1. A match is:
- Same `visualCategory`.
- `agreementMode === 'strict'`: same `visualSeverity`.
- Element substring Jaccard ≥ 0.5 (lowercase, split on whitespace, intersect tokens / union tokens).

Greedy 1-to-1 matching: each run-N anomaly can match at most one run-0 anomaly.

**Step 2: count cluster size.**
A "cluster" is the set of matching anomalies across runs. Cluster size = number of runs where this anomaly appeared.

**Step 3: filter.**
- `'strict'`: keep cluster iff `clusterSize === N` (where N = number of *succeeded* runs, not configured runs — handles partial budget).
- `'majority'`: keep cluster iff `clusterSize >= ceil(N / 2)`.

**Step 4: dedupe within a single run.**
If the same anomaly appears twice in run 0 (Sonnet sometimes does), collapse to one before matching.

**Step 5: choose canonical.**
Use the run-0 occurrence as canonical for `description`, `element`, `suggestedFix`. Use the *most-common* `visualSeverity` across the cluster (ties → max severity, since BugHunter biases toward over-reporting in strict-budget runs).

**Step 6: telemetry per call.**
- `agreementRate`: average per-anomaly cluster-size / N. 1.0 means all anomalies agreed across all runs.
- `droppedByDisagreement`: total anomalies seen across all runs MINUS kept × N.

### 4.4 Discover-phase wiring (`phases/discover.ts:232`)

Replace:
```ts
// Old (line 232 area):
const visualBaselineDetections = await classifyVisualAnomalies({ ... });
```

With (Phase 2 — classify in concurrency-bounded pool, around line 318):
```ts
const consistent = await classifyVisualAnomaliesConsistent({
  ...inputArgs,
  consistencyRuns: visionConfig.consistencyRuns,
  agreementMode: visionConfig.agreementMode,
});
results.push(...consistent.detections.map(detection => ({ page, detection, screenshotPath })));
consistencyTelemetry.aggregate(consistent);
```

Pass `visionConsistencyTelemetry` up to `summary.json` via `discovery.visionBaselineTelemetry`.

### 4.5 Execute-phase wiring (`phases/execute.ts:670`)

The per-occurrence `missing_state_change` vision call at line ~670. Wrap the same way. Telemetry merges into the run-level `vision.consistency` block.

### 4.6 Telemetry on `summary.json`

```ts
vision: {
  // ... existing fields ...
  consistency?: {
    runsPerScreenshot: number;             // resolved consistencyRuns
    agreementMode: 'strict' | 'majority';
    totalCalls: number;                    // sum of callsAttempted across all screenshots
    totalSucceeded: number;
    droppedByDisagreement: number;         // total anomalies dropped because they didn't agree
    agreementRate: number;                 // 0..1 average across all screenshots that had ≥1 anomaly
    screenshotsWithAnomalies: number;
    screenshotsClean: number;              // 0 anomalies in all N runs
  };
};
```

---

## 5. Edge cases

### EC-1. consistencyRuns === 1
Disables consistency checking. Wrapper returns single-call result directly. Telemetry block still emitted with `runsPerScreenshot: 1, agreementMode: 'strict'`.

### EC-2. All N runs return zero anomalies
`screenshotsClean++`. `agreementRate` undefined for this screenshot (treat as 1.0 for the global average — perfect agreement on "nothing wrong").

### EC-3. Budget exhausted after only 1-of-N runs
Aggregate over the 1 run we got. In `'strict'` mode with 1 run, every anomaly trivially passes (cluster size 1 of N=1). Telemetry records `callsAttempted: 1` so this is auditable. Document: when budget is tight, the consistency guarantee weakens. Operators should size `costCapUsd` appropriately.

### EC-4. One run errors (auth, transport, malformed JSON)
That run contributes `[]`. Other runs proceed. If all N error, return `{ detections: [], perRunDetections: [[],...] }` and log a warning.

### EC-5. The two runs return very-similar anomalies but on slightly different elements
e.g., Run 1: `"the trades table"`. Run 2: `"trades table on the right"`. Jaccard on lowercased tokens: `{trades, table} ∩ {trades, table, on, the, right} / {trades, table, on, the, right} = 2/5 = 0.4`. Below 0.5 threshold → no match.

This is deliberate. We err on the side of FALSE NEGATIVES (drop both) rather than false-positives in strict mode. Document the threshold; tune in v0.16 if real-world precision/recall data supports it.

### EC-6. Sonnet returns same anomaly twice in one run
Already deduped at parse time within `classifyVisualAnomalies` (existing behavior). Aggregator sees one anomaly per run.

### EC-7. consistencyRuns > maxCalls remaining
Effective per-screenshot cap = `min(consistencyRuns, remaining-budget)`. Aggregation handles partial.

### EC-8. agreementMode='strict' with consistencyRuns=1
Trivially: every anomaly passes. Equivalent to current behavior.

---

## 6. Test plan

### 6.1 Unit tests for `anomalyMatches` (`classify/vision.test.ts`)

- Same category, same severity, identical element → match (strict + majority)
- Same category, same severity, identical element → match
- Same category, different severity → match (majority), no match (strict)
- Different category, identical element → no match
- Same category, severity, element overlap = 0.6 → match
- Same category, severity, element overlap = 0.4 → no match
- Empty element strings → no match (avoid trivial-overlap false positive)

### 6.2 Unit tests for `aggregateConsistencyResults`

- 2 runs, both contain 1 identical anomaly → kept × 1, agreementRate=1
- 2 runs, run-0 has [A], run-1 has [] → strict drops A, majority drops A (1/2 < ceil(2/2)=1, so 1 is the floor — careful: strict requires N=2, majority requires ≥1; this case strict drops, majority KEEPS)

  *Refinement:* `'majority'` with N=2 requires ≥ ceil(2/2) = 1 → keeps. That's "half or more", not strictly majority. Document the edge: with N=2, majority is equivalent to "appears at least once" which is the existing behavior. Recommend `consistencyRuns: 3` for meaningful majority. Update default heuristic: when `consistencyRuns >= 3` use `majority`; when `consistencyRuns === 2` use `strict`.

- 3 runs, [A,B], [A], [B] → strict drops both (no anomaly in all 3); majority keeps both (each in ≥2)
- 3 runs, [A], [A], [B] → strict drops both; majority keeps A only
- 5 runs, [A]×3, []×2 → majority keeps A (3 ≥ 3); strict drops
- Empty runs (all []) → kept=[], droppedByDisagreement=0, agreementRate=1
- Greedy match: 2 runs, [A1,A2] vs [A1] where A1≈A1 (Jaccard 0.6) and A2≈A1 (Jaccard 0.55) — A1-A1 match (greedy in run order), A2 drops (no remaining match). Strict drops both.

### 6.3 Unit tests for `classifyVisualAnomaliesConsistent`

Mock `classifyVisualAnomalies` to return predetermined sequences. Verify the aggregator is called with the right inputs and the wrapper's telemetry shape is correct.

- 2 successful runs → callsSucceeded=2, callsAttempted=2
- 1 successful + 1 budget-exhausted → callsSucceeded=1, callsAttempted=2
- All errors → empty detections, agreementRate=1 (no anomalies = "agreement on clean")

### 6.4 Integration smoke (manual on Aspectv3)

1. Run smoke with `consistencyRuns: 2, agreementMode: 'strict'`.
2. Run AGAIN with same config.
3. Diff `byKind.visual_anomaly` count between the two runs.
4. Acceptance: |run1 - run2| / max(run1, run2) ≤ 0.20.

If the variance is still high (>20%), the underlying screenshots are too different across runs (e.g., live data is changing, time-of-day-dependent UI). Note in the run summary; this becomes the v0.16 problem (deterministic seed + frozen-clock).

---

## 7. Negative requirements

- Do **not** add a new BugKind.
- Do **not** modify `classifyVisualAnomalies` semantics. Wrap, don't rewrite.
- Do **not** parallelize the N calls per screenshot.
- Do **not** add an LLM-as-judge for matching anomalies. The Jaccard heuristic is deliberate; LLM-judging is v0.16+.
- Do **not** silently relax to `'majority'` when budget is tight in `'strict'` mode. Drop the anomalies and document via telemetry.
- Do **not** change `clusterSignature` for `visual_anomaly`.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `consistencyRuns` + `agreementMode` to `VisionConfig` types | `types.ts` | none |
| 2 | Add Zod schema with bounds + defaults | `config.ts` | 1 |
| 3 | Update `resolveVisionConfig` to expose new fields | `classify/vision.ts` | 1, 2 |
| 4 | Implement `anomalyMatches` pure function + tests | `classify/vision.ts`, `classify/vision.test.ts` | 1 |
| 5 | Implement `aggregateConsistencyResults` pure function + tests | `classify/vision.ts`, `classify/vision.test.ts` | 4 |
| 6 | Implement `classifyVisualAnomaliesConsistent` wrapper + tests | `classify/vision.ts`, `classify/vision.test.ts` | 5 |
| 7 | Wire into `runVisualBaseline` (discover phase) | `phases/discover.ts` | 6 |
| 8 | Wire into per-occurrence vision in `executeUiTestInner` | `phases/execute.ts` | 6 |
| 9 | Add `visionConsistency` telemetry to `summary.json` | `phases/emit.ts`, `types.ts` | 6 |
| 10 | Manual smoke verifying 2 consecutive runs differ by ≤20% | (manual on Aspectv3) | 7-9 |

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All unit tests pass (anomalyMatches: 7+, aggregateConsistencyResults: 8+, wrapper: 4+) | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Two consecutive Aspectv3 smokes produce visual_anomaly counts within ±20% | manual |
| `summary.json.vision.consistency` block emitted with valid shape | `jq` |
| Single-call mode (consistencyRuns=1) preserves prior behavior exactly | regression test |

---

## 10. Risks + escape hatches

- **Risk: 2× cost for marginal stability gain.** Per-call cost is ~$0.005 with Sonnet 4.6. 2x = ~$0.01 per screenshot. On Aspectv3's 19 unique screenshots: $0.19 vs $0.10. Negligible.
- **Risk: 'strict' drops real findings that one run missed.** Document this as a precision/recall trade-off. Operators can switch to `'majority'` with `consistencyRuns: 3` for higher recall.
- **Risk: anomaly matching false positives (Jaccard too lenient).** Threshold 0.5 was picked by intuition; tune in v0.16 with telemetry from real runs.
- **Risk: budget exhaustion mid-aggregation.** Telemetry exposes `callsSucceeded < callsAttempted`; operators see exactly when this happens and can raise `costCapUsd`.
- **Escape hatch:** `consistencyRuns: 1` reverts to v0.13 behavior.

---

## 11. Killer-demo runbook (Aspectv3)

```bash
# 1. Update Aspectv3's .bughunter/config.json vision block:
{
  "vision": {
    "enabled": true,
    "model": "claude-sonnet-4-6",
    "maxCalls": 60,                  # 2x the old 30 to cover consistencyRuns=2
    "costCapUsd": 5.0,
    "consistencyRuns": 2,
    "agreementMode": "strict"
  }
}

# 2. Run smoke twice
cd /root/Aspectv3
ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 100 --budget 2400000 --a11y --a11y-strict --seo
# wait, then re-run

# 3. Compare counts
RUN1=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
RUN2=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -2 | tail -1)
jq '.byKind.visual_anomaly' /root/Aspectv3/.bughunter/runs/$RUN1/summary.json
jq '.byKind.visual_anomaly' /root/Aspectv3/.bughunter/runs/$RUN2/summary.json
jq '.vision.consistency' /root/Aspectv3/.bughunter/runs/$RUN1/summary.json
```

Expected: counts within ±20% of each other; `vision.consistency.agreementRate` ≥ 0.7 on screenshots with anomalies.

---

## 12. Open questions

1. **Strict + N=2 is just "both must agree"; is that too strict for real-world Sonnet noise?** Spec defaults to it because the v0.13 flap (14 → 0) suggests Sonnet's confidence varies wildly even on the same content. Strict + 2 is the cheapest stabilizer. If precision drops too much on real targets, default to `majority + 3`.
2. **Should `agreementMode` apply to severity equality?** Spec says yes in `'strict'`. If a run says "major" and another says "critical" on the same finding, strict drops it. Worth reconsidering — these are usually the same bug, just judged differently. Reviewer may want to relax to "agree on category, take max severity".
3. **Should we expose the per-anomaly agreement count on `BugDetection`?** Spec says NO for v0.15 (keep schema unchanged). Worth re-visiting when downstream consumers want to surface "high-confidence" bugs.
