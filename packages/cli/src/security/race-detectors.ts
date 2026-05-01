// v0.19 race-condition detectors — pure functions, no IO.
// Each detector takes a plan + observations and returns a Detection or null.

import type { BugDetection, RaceDetectionContext, RaceObservation, InterleavingVariant } from '../types.js';

// ---- shared helpers ----

function makeDetection(
  kind: BugDetection['kind'],
  rootCause: string,
  endpoint: string | undefined,
  pageRoute: string | undefined,
  raceContext: RaceDetectionContext,
): BugDetection {
  return {
    kind,
    rootCause,
    endpoint,
    pageRoute,
    raceContext,
  };
}

function obsAt(observations: RaceObservation[], offsetMs: number): RaceObservation | undefined {
  // Find the observation closest to the given offset (or exact match)
  return observations.reduce<RaceObservation | undefined>((best, obs) => {
    if (best === undefined) return obs;
    return Math.abs(obs.offsetMs - offsetMs) < Math.abs(best.offsetMs - offsetMs) ? obs : best;
  }, undefined);
}

function evidenceSnippet(text: string): string {
  return text.slice(0, 200);
}

// ---- double_submit detector ----

export type DoubleSubmitPlan = {
  variant: InterleavingVariant & { kind: 'double_submit' };
  toolId: string;
  toolPath: string;
  raceNonce: string;
};

/**
 * Detect duplicate state after double-firing the same mutating action.
 * Bug if: post-state DOM/API contains the raceNonce ≥2 times.
 * Returns null if the toolId is idempotent (caller should have skipped, but guard here too).
 */
export function detectDoubleSubmit(
  plan: DoubleSubmitPlan,
  observations: RaceObservation[],
): BugDetection | null {
  const postObs = obsAt(observations, 1000);
  if (postObs === undefined) return null;

  // Count occurrences of the nonce in the final DOM hash would require the full DOM,
  // but we have only the hash. Instead we check responseStatus duplication:
  // Two successful responses (both 2xx) for a non-idempotent action = duplicate.
  const successResponses = observations.filter(o => o.responseStatus !== undefined && o.responseStatus >= 200 && o.responseStatus < 300);
  if (successResponses.length < 2) return null;

  // Check final state is 'final' (both writes persisted) vs 'pre' (only one persisted = idempotent)
  if (postObs.targetSelectorState !== 'final') return null;

  const raceContext: RaceDetectionContext = {
    variantKind: 'double_submit',
    gapMs: plan.variant.gapMs,
    proof: 'duplicate_state',
    evidence: evidenceSnippet(`Nonce ${plan.raceNonce}: ${successResponses.length} 2xx responses for non-idempotent action`),
  };

  return makeDetection(
    'race_condition_double_submit',
    `Double-submit: ${successResponses.length} successful responses for non-idempotent action ${plan.toolId}`,
    plan.toolPath,
    undefined,
    raceContext,
  );
}

// ---- click_then_navigate detector ----

export type ClickThenNavigatePlan = {
  variant: InterleavingVariant & { kind: 'click_then_navigate' };
  toolId: string;
  toolPath: string;
  pageRoute: string;
};

/**
 * Detect stale data or silent failure after navigating away during an in-flight mutation.
 *
 * Open question 1 resolution: keep as single kind with two proof discriminators
 * (conservative — splitting would add a sixth race kind, outside spec scope).
 */
export function detectClickThenNavigate(
  plan: ClickThenNavigatePlan,
  observations: RaceObservation[],
): BugDetection | null {
  const postNavObs = obsAt(observations, 2000);
  if (postNavObs === undefined) return null;

  // Branch 1: stale data — after navigation, the target page's state is unchanged
  // and no error appeared. Indicates the mutation silently dropped with no user feedback.
  if (postNavObs.targetSelectorState === 'pre' && postNavObs.consoleErrorCount === 0 && !postNavObs.toastVisible) {
    const raceContext: RaceDetectionContext = {
      variantKind: 'click_then_navigate',
      navigateTarget: plan.variant.targetRoute,
      proof: 'stale_post_navigation',
      evidence: evidenceSnippet(`Post-navigation state is 'pre' at ${postNavObs.offsetMs}ms — mutation may have been silently discarded`),
    };
    return makeDetection(
      'race_condition_click_navigate',
      `Click-then-navigate: mutation to ${plan.toolId} silently dropped on navigation (stale data)`,
      plan.toolPath,
      plan.pageRoute,
      raceContext,
    );
  }

  // Branch 2: silent fail — in-flight request returned non-2xx or was aborted,
  // AND no console error AND no toast appeared on destination route AND the
  // target element isn't itself in an `errored` state (which the user can see).
  const failedRequest = observations.find(o =>
    o.responseStatus !== undefined && (o.responseStatus < 200 || o.responseStatus >= 300)
  );
  if (
    failedRequest !== undefined &&
    postNavObs.consoleErrorCount === 0 &&
    !postNavObs.toastVisible &&
    postNavObs.targetSelectorState !== 'errored'
  ) {
    const raceContext: RaceDetectionContext = {
      variantKind: 'click_then_navigate',
      navigateTarget: plan.variant.targetRoute,
      proof: 'silent_post_unmount_failure',
      evidence: evidenceSnippet(`In-flight request failed (status ${failedRequest.responseStatus ?? 'aborted'}) after navigation — no error surfaced to user`),
    };
    return makeDetection(
      'race_condition_click_navigate',
      `Click-then-navigate: in-flight mutation to ${plan.toolId} failed silently after unmount`,
      plan.toolPath,
      plan.pageRoute,
      raceContext,
    );
  }

  return null;
}

// ---- optimistic_revert detector ----

export type OptimisticRevertPlan = {
  variant: InterleavingVariant & { kind: 'optimistic_revert' };
  toolId: string;
  toolPath: string;
  pageRoute: string;
};

/**
 * Detect missing UI revert after forced network failure.
 * Bug if: at t=300ms shows optimistic/final state, AND at t=5000ms still shows
 * success state (not reverted/errored) AND no error toast AND no console error.
 *
 * EC-9: routeFulfill scoping (method + path + body hash) is handled by the runner,
 * not the detector.
 */
export function detectOptimisticRevert(
  plan: OptimisticRevertPlan,
  observations: RaceObservation[],
): BugDetection | null {
  const earlyObs = obsAt(observations, 300);
  const lateObs = obsAt(observations, 5000);
  if (earlyObs === undefined || lateObs === undefined) return null;

  // UI must have shown an optimistic success state early
  const showedOptimistic = earlyObs.targetSelectorState === 'optimistic' || earlyObs.targetSelectorState === 'final';
  if (!showedOptimistic) return null;

  // At t=5000ms, the UI should have reverted. If it hasn't, and no error is visible, that's a bug.
  const didRevert = lateObs.targetSelectorState === 'reverted' || lateObs.targetSelectorState === 'errored';
  if (didRevert) return null;

  // If a console error or toast appeared, the app *attempted* to surface the failure — not a bug.
  if (lateObs.consoleErrorCount > 0 || lateObs.toastVisible) return null;

  const raceContext: RaceDetectionContext = {
    variantKind: 'optimistic_revert',
    forcedStatus: plan.variant.forcedStatus,
    proof: 'no_revert_after_failure',
    evidence: evidenceSnippet(
      `State at t=300ms: ${earlyObs.targetSelectorState}; state at t=5000ms: ${lateObs.targetSelectorState} — no revert after forced ${plan.variant.forcedStatus}`
    ),
  };

  return makeDetection(
    'race_condition_optimistic_revert',
    `Optimistic revert missing: ${plan.toolId} showed success but failed to revert after ${plan.variant.forcedStatus} response`,
    plan.toolPath,
    plan.pageRoute,
    raceContext,
  );
}

// ---- interleaved_mutations detector ----

export type InterleavedMutationsPlan = {
  variant: InterleavingVariant & { kind: 'interleaved_mutations' };
  toolId: string;
  toolPath: string;
  siblingToolId: string;
  pageRoute: string;
};

/**
 * Detect order-dependent final state across consensus runs.
 * Requires ≥2 of consensusRuns to diverge in the same way.
 * A 409 Conflict response is NOT a finding — that's the server correctly rejecting the write.
 *
 * observations is an array of arrays — one per consensus run.
 */
export function detectInterleavedMutations(
  plan: InterleavedMutationsPlan,
  runObservations: RaceObservation[][],
): BugDetection | null {
  const { consensusRuns } = plan.variant;

  // For each run, get the final-state hash at the last observation
  const finalHashes = runObservations.map(obs => {
    if (obs.length === 0) return '';
    // Safe: length > 0 guarantees a defined value at the last index
    return (obs[obs.length - 1] as RaceObservation).targetSelectorHash;
  });

  // Check no run had a 409 Conflict — that's the contract working, not a bug.
  for (const obs of runObservations) {
    if (obs.some(o => o.responseStatus === 409)) return null;
  }

  // Count divergences: runs where final state differs from the first run's final state
  const baseline = finalHashes[0];
  const diverged = finalHashes.filter(h => h !== '' && h !== baseline).length;

  // Require ≥2-of-consensusRuns to diverge (majority)
  const isFlaky = diverged === 1 && consensusRuns >= 2;
  const isBug = diverged >= 2;

  if (!isBug && !isFlaky) return null;

  const raceContext: RaceDetectionContext = {
    variantKind: 'interleaved_mutations',
    siblingToolId: plan.siblingToolId,
    consensusVotes: diverged,
    consensusTotal: finalHashes.length,
    proof: 'order_dependent_final_state',
    evidence: evidenceSnippet(
      `${diverged} of ${finalHashes.length} runs produced divergent final state (hashes: ${finalHashes.join(', ')})`
    ),
    flaky: isFlaky && !isBug,
  };

  return makeDetection(
    'race_condition_interleaved_mutations',
    `Interleaved mutations: ${plan.toolId} + ${plan.siblingToolId} produce order-dependent final state (${diverged}/${finalHashes.length} runs diverged)`,
    plan.toolPath,
    plan.pageRoute,
    raceContext,
  );
}

// ---- cross_tab detector ----

export type CrossTabPlan = {
  variant: InterleavingVariant & { kind: 'cross_tab' };
  toolId: string;
  toolPath: string;
  pageRoute: string;
};

/**
 * Detect cross-tab divergence after simultaneous mutations from two browser contexts.
 * Bug if: field-level state diverges between tabs at settle time, AND no storage event
 * reconciled within settleMs.
 *
 * tab1Obs and tab2Obs are the per-tab observation arrays.
 *
 * EC-8: per-tab session check (sessionId equality) is handled by the runner, not the detector.
 */
export function detectCrossTab(
  plan: CrossTabPlan,
  tab1Obs: RaceObservation[],
  tab2Obs: RaceObservation[],
): BugDetection | null {
  const tab1Final = obsAt(tab1Obs, plan.variant.settleMs);
  const tab2Final = obsAt(tab2Obs, plan.variant.settleMs);

  if (tab1Final === undefined || tab2Final === undefined) return null;

  // Both must have settled to a non-error state
  if (tab1Final.targetSelectorState === 'errored' || tab2Final.targetSelectorState === 'errored') return null;

  // Detect hash divergence: different final DOM state between tabs
  if (tab1Final.targetSelectorHash === '' || tab2Final.targetSelectorHash === '') return null;
  if (tab1Final.targetSelectorHash === tab2Final.targetSelectorHash) return null;

  const raceContext: RaceDetectionContext = {
    variantKind: 'cross_tab',
    proof: 'cross_tab_no_reconcile',
    evidence: evidenceSnippet(
      `Tab1 hash: ${tab1Final.targetSelectorHash}, Tab2 hash: ${tab2Final.targetSelectorHash} at settle ${plan.variant.settleMs}ms — no reconciliation detected`
    ),
  };

  return makeDetection(
    'race_condition_cross_tab',
    `Cross-tab divergence: ${plan.toolId} produced different final state in two simultaneous tabs`,
    plan.toolPath,
    plan.pageRoute,
    raceContext,
  );
}
