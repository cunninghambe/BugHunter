# SPEC — retest must support static-detector clusters via re-run, not replay

**Status:** Draft 1 — ready for `@coder` · **Author:** `@architect` (Opus) · **Date:** 2026-04-30 · **Sibling specs:** `SPEC_RETEST_FIX_RELATIVE_URL.md`, `SPEC_PLAN_FIX_HTTP_METHOD_FILTER.md`

The retest tool assumes every cluster occurrence has a recorded action-log it can replay. Static-page detectors (SEO baseline, a11y baseline, static analysis) emit `BugDetection`s without a `TestCase` — they're synthesized from filesystem walks or DOM-crawl screenshots, not from executed test sequences. When retest tries to replay, it finds no action-log and returns `passed: false, error: 'Action log not found: ...'`.

Surfaced during OpeningBell autofix:
- Cluster `ec9cx4wn60titp1vk9d5ysjs` (`seo_h1_missing_or_multiple`) → 1 occurrence, retest verdict `not_fixed` because action-log was missing.
- Cluster `ng5f2ip9wqfge1ot4nf8jwis` (`seo_title_duplicate_across_routes`) → same.

Both fixes were logically correct (verified by the next full BugHunter smoke), but retest mis-reported them as failures.

---

## 1. Objective

Add a `replayKind` field to clusters that classifies how retest should validate the fix:

| `replayKind` | Verification path |
|---|---|
| `'action_log'` (default) | Existing path: read `.bughunter/runs/<runId>/action-logs/<occurrenceId>.json`, replay each step. |
| `'static_rerun'` | Re-execute the static detector that produced the original cluster against the fix branch. Pass = the same finding does not recur. |
| `'unrunable'` | The cluster references state we can't reproduce locally (e.g., a vulnerable_dependency_high cluster from npm-audit). Retest returns `verdict: 'cannot_retest'` instead of pretending to validate. |

The cluster-emission code (in `phases/cluster.ts` or wherever clusters are minted) tags each cluster's `replayKind` based on the detection's source phase. Retest dispatches on it.

**In scope:**
- `BugCluster.replayKind` field (new, optional for backward compat with existing JSONL artifacts).
- Cluster-minting code tags `replayKind` correctly per source phase (execute → `action_log`; SEO/a11y baseline → `static_rerun`; vulnerable_dependency_high / hardcoded_credentials_in_source / swallowed_error_empty_catch → `static_rerun` (re-run static analysis); unrecoverable cases → `unrunable`).
- `ops/retest.ts` dispatches on `replayKind`.
- New retest verdicts: `verified_fixed_static`, `cannot_retest`.
- A small static-detector-rerun harness that knows how to invoke each static detector against a given branch's working tree.

**Out of scope:**
- Refactoring the static detectors themselves — they already accept project-dir-as-input arguments; we just call them again post-fix.
- Adding new BugKinds.
- Changing the retest CLI signature.
- Bug 1 (relative URL) and bug 3 (planner method filter) — separate specs.

**Acceptance:**
- Re-run the ec9cx + ng5f2 retests on OpeningBell with this fix: both produce `verdict: 'verified_fixed_static'` (or `not_fixed_static` if the rerun still finds the cluster).
- Existing action-log retest path is unchanged.
- vulnerable_dependency_high clusters return `cannot_retest` cleanly instead of "Action log not found".

---

## 2. Existing code map

### 2.1 Files to read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugCluster`. Add `replayKind?: 'action_log' \| 'static_rerun' \| 'unrunable'`. Default behavior when absent: `action_log` (preserves old artifacts). |
| `packages/cli/src/phases/cluster.ts` | Where clusters are minted. Each cluster's source kind tells us which `replayKind` to assign. |
| `packages/cli/src/ops/retest.ts` | The dispatcher. Add the switch on `replayKind`. |
| `packages/cli/src/repro/replay.ts` | Existing action-log replay path (untouched). |
| `packages/cli/src/classify/seo.ts` | SEO detector functions. We need to call these again with the post-fix project. |
| `packages/cli/src/classify/a11y-baseline.ts` | A11y baseline detector. Same. |
| `packages/cli/src/static/runner.ts` | Static analysis runner (gitleaks, npm-audit, semgrep). Re-runnable; this is the path for vulnerable_dependency_high etc. |
| `packages/cli/src/types.ts` (retest result type) | `RetestResult`. Add `'verified_fixed_static' \| 'not_fixed_static' \| 'cannot_retest'` to the verdict union. |

### 2.2 Patterns to follow

- **Dispatch on a discriminated tag.** `switch (cluster.replayKind ?? 'action_log')` covers the default for old artifacts.
- **Reuse, don't duplicate.** Static detectors are already pure functions over project state. The rerun path just re-invokes them and checks if the cluster's signature recurs.
- **Cluster-signature equality.** A cluster is "still present" iff a freshly-emitted `BugDetection` would produce the same `clusterSignature`. Use the existing `clusterSignature(detection)` helper.

### 2.3 DO NOT

- Do NOT remove or change the existing action-log replay path.
- Do NOT introduce a new artifact type — re-runs are ephemeral.
- Do NOT block on heavy static-analysis tools that may not be installed (gitleaks, semgrep). For unrecoverable tool absence, fall through to `cannot_retest`.

---

## 3. Implementation

### 3.1 `BugCluster.replayKind` + `ReplayKind`

Add to `types.ts`:

```ts
export type ReplayKind = 'action_log' | 'static_rerun' | 'unrunable';

export type BugCluster = {
  // ... existing fields ...
  replayKind?: ReplayKind;
};
```

### 3.2 Tag at cluster mint time

In `phases/cluster.ts` (or the central cluster-minting code path), pick `replayKind` based on the cluster's `kind`:

| BugKind family | replayKind |
|---|---|
| `console_error`, `react_error`, `hydration_mismatch`, `network_5xx`, `network_4xx_unexpected`, `404_for_linked_route`, `missing_state_change`, `unhandled_exception`, `accessibility_critical` (delta), `dom_error_text`, `surface_call_failed`, `xss_reflected`, `xss_dom`, `interactive_element_missing_accessible_name`, `idor_*`, `csrf_missing_on_mutating_route`, `race_double_submit`, `optimistic_update_divergence`, `auth_session_fixation`, `password_reset_token_reuse`, `no_rate_limit_on_login`, `auth_bypass_via_unauthed_route`, all v0.16 pen-testing kinds, all `xss_*`, `focus_lost_after_action` (per-action), `keyboard_trap` (per-action), `image_missing_alt` (per-action via axe delta) | `action_log` |
| `axe_color_contrast_strong` (baseline), `image_missing_alt` (baseline if from a11y baseline), `form_input_unlabeled`, `seo_title_missing`, `seo_title_duplicate_across_routes`, `seo_meta_description_missing`, `seo_canonical_missing`, `seo_h1_missing_or_multiple`, `seo_robots_blocking_crawl`, `visual_anomaly` (vision baseline), `slow_lcp`, `slow_inp`, `high_cls`, `unbounded_list_render`, `n_plus_one_api_calls`, `request_dedup_missing`, `request_cancellation_missing`, `main_thread_blocked`, `oversized_bundle`, `excessive_re_renders`, `memory_leak_suspected`, `memory_leak_attributed` | `static_rerun` |
| `vulnerable_dependency_high`, `hardcoded_credentials_in_source`, `swallowed_error_empty_catch`, `missing_csp_header`, `permissive_cors`, `cookie_security_flags`, `open_redirect`, `sensitive_data_in_url`, `stack_trace_leak_in_response`, `hallucinated_route` | `static_rerun` (re-run static analysis or header-probe) |

If you can't unambiguously map a kind, default to `action_log` and log a warning so we can audit which detections are unaccounted for.

Implementation: a `replayKindForBugKind(kind: BugKind): ReplayKind` lookup helper near the top of `phases/cluster.ts`. The map is data; keep it tabular.

### 3.3 `ops/retest.ts` dispatch

Pseudo-code:

```ts
export async function retest(runId: string, clusterId: string, opts): Promise<RetestResult> {
  const cluster = loadCluster(runId, clusterId);
  const kind = cluster.replayKind ?? 'action_log';

  switch (kind) {
    case 'action_log':
      return retestViaActionLogReplay(cluster, opts); // existing path
    case 'static_rerun':
      return retestViaStaticRerun(cluster, opts); // new path
    case 'unrunable':
      return { verdict: 'cannot_retest', detail: 'cluster type does not support automated retest' };
  }
}
```

### 3.4 `retestViaStaticRerun`

The new path:

1. Identify the static detector to re-run from `cluster.kind`. A small lookup table in retest.ts:

   ```ts
   const STATIC_RERUNNERS: Record<string, (projectDir: string, runId: string) => Promise<BugDetection[]>> = {
     'seo_title_missing': () => runSeoCorpus(...),
     'seo_title_duplicate_across_routes': () => runSeoCorpus(...),
     'seo_h1_missing_or_multiple': () => runSeoCorpus(...),
     'axe_color_contrast_strong': () => runA11yBaseline(...),
     'image_missing_alt': () => runA11yBaseline(...),
     'visual_anomaly': () => runVisionBaseline(...),
     'vulnerable_dependency_high': () => runStaticAnalysis(['npm-audit'], ...),
     'hardcoded_credentials_in_source': () => runStaticAnalysis(['gitleaks'], ...),
     // ...
   };
   ```

2. Check out the fix branch into the project's working tree (the autofix orchestrator already does this).

3. Call the rerunner. It returns a fresh `BugDetection[]` for the post-fix state.

4. For each occurrence in the original cluster, check whether ANY freshly-emitted detection has the same `clusterSignature` as that occurrence. If yes, the bug is still present for that occurrence (`passed: false`). If no, the bug is resolved (`passed: true`).

5. Aggregate per-occurrence pass/fail into the standard `RetestResult` shape with verdict `verified_fixed_static` or `not_fixed_static` (or `partially_fixed_static`).

If the rerunner can't run (tool missing, build fails, etc.), return `cannot_retest` with `detail: <reason>`.

### 3.5 Verdict union extension

In `types.ts`:

```ts
export type RetestVerdict =
  | 'verified_fixed'
  | 'not_fixed'
  | 'partially_verified'
  | 'verified_fixed_static'      // NEW
  | 'not_fixed_static'           // NEW
  | 'partially_verified_static'  // NEW
  | 'cannot_retest';              // NEW
```

The existing `_static`-less verdicts continue to be emitted by the action-log path. The new ones are emitted by the static-rerun path. Downstream consumers (`fix-summary.ts`) treat the `_static` variants the same as the non-static ones for counting purposes; just preserve them in the JSON output for diagnostic clarity.

---

## 4. Edge cases

### EC-1. Old artifact's cluster has no `replayKind` field
Default to `action_log`. Existing behavior preserved. Operators can re-emit with the new field by re-running the run, but they don't have to.

### EC-2. Static rerunner crashes (e.g., npm audit non-zero exit)
Catch + return `cannot_retest` with `detail: 'static rerunner crashed: <message>'`.

### EC-3. Re-run produces MORE findings than the original
That's fine — only the original cluster's signature equality matters. Extra findings are not "this fix didn't work."

### EC-4. Re-run produces NEW findings of the same kind but different signature
The original cluster's bug is fixed (the specific signature is gone). New findings of the same kind are out-of-scope for this retest call — they'll surface in the next full smoke.

### EC-5. `vulnerable_dependency_high` rerunner needs `npm install` first
The fix branch should already have package.json + lock changes — but those are forbidden-path, so the autofix loop never produces such fixes. So in practice, vulnerable_dep clusters → architect_refused → never reach retest. Document.

### EC-6. `visual_anomaly` rerun is expensive (vision API calls)
Vision baseline calls Sonnet ~$0.005 per screenshot. For a single-cluster retest that's ~$0.01. Acceptable.

### EC-7. `seo_*` rerun needs the dev server running
Document: retest assumes the dev server at `appBaseUrl` is up. If not, `cannot_retest` with appropriate message.

---

## 5. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| New unit tests for `replayKindForBugKind` mapping | `npm test` |
| New unit tests for `retestViaStaticRerun` (mocked rerunner) | `npm test` |
| Existing tests pass | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Re-run ec9cx retest on OpeningBell run y3ign6ly1zaxnr4a51ard50d → verdict is `verified_fixed_static`, NOT "Action log not found" | manual: `bughunter retest <run> ec9cx --base main --branch <branch>` |

---

## 6. Files to touch

- `packages/cli/src/types.ts` (add `ReplayKind`, extend `RetestVerdict`, add `BugCluster.replayKind`)
- `packages/cli/src/phases/cluster.ts` (tag clusters with `replayKind` at mint time)
- `packages/cli/src/ops/retest.ts` (add `static_rerun` + `unrunable` dispatch + new helper `retestViaStaticRerun`)
- `packages/cli/src/ops/retest.test.ts` (new tests for both new paths)
- `packages/cli/src/phases/cluster.test.ts` (new test for `replayKindForBugKind` map)

5 files, ≤300 lines of net change.

---

## 7. Negative requirements

- Do NOT remove the action-log replay path.
- Do NOT block on tools that may not be installed — fall through to `cannot_retest`.
- Do NOT add a new artifact directory.
- Do NOT auto-run the rerunner during a normal run; it's only invoked from the retest CLI.

---

## 8. Risks

- **Risk: rerunner has side effects** (e.g., visual_anomaly takes screenshots — those overwrite live screenshots). Mitigated: rerunner writes to a `/tmp/<runId>-retest-<clusterId>/` dir, not the original run dir.
- **Risk: kind-to-rerunner map drifts as new BugKinds land.** Mitigated: default `action_log` + log warning. Audit the warnings periodically; add to the static-rerun list when needed.
- **Risk: `cluster.kind`-based dispatch is ambiguous when one kind is emitted by multiple sources** (e.g., `image_missing_alt` from baseline AND from delta). Mitigated: cluster mint time has access to the source phase; use that to disambiguate when minting `replayKind`, not `cluster.kind` later.

---

## 9. Killer-demo

Re-run the t1aakl + ec9cx + ng5f2 retests against OpeningBell run `y3ign6ly1zaxnr4a51ard50d` with the merged fix branches:
- t1aakl (focus_lost_after_action) → bug 1 fixes the action-log relative URL → verified_fixed (real verdict)
- ec9cx (seo_h1) → this spec applies → verified_fixed_static (the seo detector confirms 1 h1 on /)
- ng5f2 (seo_title_dup) → this spec applies → verified_fixed_static (titles are now distinct)
- alv5wd (vulnerable_dependency_high) → cannot_retest (no autofix path)
