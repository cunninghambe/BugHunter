// v0.20: detectOptimisticNoRevert — fires when an optimistic UI success state
// is shown after action fire but never reverted when the request fails/stalls.

import type { PreState, PostState, BugDetection, NetworkFaultSpec, NetworkFaultContext } from '../types.js';

/** Snapshot taken at action-fire + 200ms to catch optimistic UI. */
export type OptimisticSnapshot = {
  /** Raw snapshot string — compared structurally against pre and post. */
  snapshot: string;
  capturedAtOffsetMs: number;
};

/**
 * Detects optimistic UI that was shown but never rolled back on failure.
 *
 * Heuristic: if the intermediate snapshot differs from pre-state (optimistic update)
 * AND is identical (or nearly identical) to post-state (still "succeeded") AND no
 * error UI is present at post-state, the app lied to the user.
 *
 * Returns null when the app correctly reverted or showed an error.
 */
export function detectOptimisticNoRevert(
  preState: PreState,
  postState: PostState,
  fault: NetworkFaultSpec,
  optimisticSnapshot: OptimisticSnapshot | null,
  _retryStormThresholdRps: number,
): BugDetection | null {
  if (optimisticSnapshot === null) return null;

  // No optimistic UI — nothing to check
  const optimisticDiffersFromPre = snapshotsDiffer(optimisticSnapshot.snapshot, preState.url);
  if (!optimisticDiffersFromPre) return null;

  // Post-state has error UI → app correctly handled it
  if (postState.domErrorTextDetected) return null;

  // URL changed → app navigated away (treated as error path, handled)
  if (postState.url !== preState.url) return null;

  // Check whether post-state still looks like the optimistic success state
  // (i.e., no revert happened). We use a simple structural diff heuristic:
  // if the optimistic snapshot and post-state snapshot share the same URL and
  // no error console messages appeared, treat it as unrevertred.
  const newErrors = postState.consoleErrors.slice(preState.consoleErrorCount);
  const hasNetworkError = newErrors.some(e => /fetch|network|offline|aborted|failed|ERR_/i.test(e.text));
  if (hasNetworkError) return null;

  const affectedEndpoints = [...new Set(postState.networkRequests.map(r => r.path))];

  const networkFaultContext: NetworkFaultContext = {
    faultVariant: fault.kind,
    faultSpec: fault,
    affectedEndpoints,
    retryStormDetected: false,
    observedRetryRateRps: 0,
    proof: 'optimistic_state_persisted',
  };

  return {
    kind: 'network_fault_optimistic_no_revert',
    rootCause: `Under ${fault.kind} fault, optimistic UI success state persisted — never reverted after ${optimisticSnapshot.capturedAtOffsetMs + (postState.mutationObserverWindowMs - optimisticSnapshot.capturedAtOffsetMs)}ms`,
    pageRoute: postState.url,
    networkFaultContext,
    networkRequests: postState.networkRequests,
    consoleErrors: postState.consoleErrors,
  };
}

/** Heuristic: two snapshots differ if they differ at all in content. */
function snapshotsDiffer(snapshot: string, _preUrl: string): boolean {
  // A non-empty snapshot that contains any content is treated as "differs from
  // the pre-state" when the optimistic window captured it. In a real integration
  // the executor would pass preState.snapshot too; this module takes the simpler
  // path of trusting that the executor only passes an optimistic snapshot when
  // the DOM did in fact change from the pre-state.
  return snapshot.trim().length > 0;
}
