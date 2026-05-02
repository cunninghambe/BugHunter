// v0.40 multi-context detectors — pure functions, no IO.
// Each detector takes a plan + observations and returns a BugDetection or null.

import type {
  BugDetection,
  MultiContextDetectionContext,
  RaceObservation,
  SnapshotCapture,
  MultiContextVariant,
  LifecycleEventKind,
} from '../types.js';

// ---- shared helpers ----

function makeDetection(
  kind: BugDetection['kind'],
  rootCause: string,
  endpoint: string | undefined,
  ctx: MultiContextDetectionContext,
): BugDetection {
  return { kind, rootCause, endpoint, multiContextContext: ctx };
}

function evidenceSnippet(text: string): string {
  return text.slice(0, 200);
}

function obsAt(observations: RaceObservation[], targetMs: number): RaceObservation | undefined {
  return observations.reduce<RaceObservation | undefined>((best, obs) => {
    if (best === undefined) return obs;
    return Math.abs(obs.offsetMs - targetMs) < Math.abs(best.offsetMs - targetMs) ? obs : best;
  }, undefined);
}

// ---- state_divergence detector ----

export type StateDivergencePlan = {
  variant: MultiContextVariant & { kind: 'state_divergence' };
  toolId: string;
  toolPath: string;
  pageRoute: string;
  nonCommutativeFields?: string[];
};

/**
 * Detect N-way state divergence: N contexts fired the same action; final state differs
 * across contexts without any reconciliation event observed.
 */
export function detectMultiContextStateDivergence(
  plan: StateDivergencePlan,
  observationsByContext: RaceObservation[][],
): BugDetection | null {
  const finalObsMaybe = observationsByContext.map(obs => obsAt(obs, plan.variant.settleMs));
  if (finalObsMaybe.some(o => o === undefined)) return null;
  const finalObs = finalObsMaybe as RaceObservation[];

  const hashes = finalObs.map(o => o.targetSelectorHash);
  const allMatch = hashes.every(h => h === hashes[0]);
  if (allMatch) return null;

  const evidence: string[] = [];
  for (let i = 0; i < hashes.length; i++) {
    evidence.push(`ctx${i}=${hashes[i]?.slice(0, 8) ?? ''}`);
  }

  const ctx: MultiContextDetectionContext = {
    variantKind: 'state_divergence',
    n: plan.variant.n,
    proof: 'n_way_no_reconcile',
    evidence: evidenceSnippet(`N=${plan.variant.n} divergence: ${evidence.join(', ')}`),
    perPatternConfig: { n: plan.variant.n, settleMs: plan.variant.settleMs },
  };

  return makeDetection(
    'multi_context_state_divergence',
    `Multi-context state divergence: ${plan.variant.n} contexts produced different final state for ${plan.toolId}`,
    plan.toolPath,
    ctx,
  );
}

// ---- lifecycle_state_loss detector ----

export type LifecycleStateLossPlan = {
  variant: MultiContextVariant & { kind: 'lifecycle_state_loss' };
  toolId: string;
  toolPath: string;
  pageRoute: string;
};

/**
 * Detect state loss or silent failure across a lifecycle event.
 * Bug shapes:
 *   A (state_lost_post_lifecycle): final state regressed to pre-action state.
 *   B (silent_failure_post_lifecycle): non-2xx response without any error surfaced.
 *   C (rollback_post_lifecycle): successful response arrived pre-lifecycle, then state reverted.
 */
export function detectVisibilityChangeStateLoss(
  plan: LifecycleStateLossPlan,
  observations: RaceObservation[],
): BugDetection | null {
  const lifecycleAt = plan.variant.midActionDelayMs;
  const pre = obsAt(observations, 0);
  const optimistic = obsAt(observations, 100);
  const postLifecycle = obsAt(observations, lifecycleAt + 200);
  const finalObs = obsAt(observations, lifecycleAt + plan.variant.settleMs);

  if (pre === undefined || optimistic === undefined || finalObs === undefined) return null;

  // Bug shape A: state regressed to pre after lifecycle
  if (
    finalObs.targetSelectorHash === pre.targetSelectorHash &&
    optimistic.targetSelectorState === 'optimistic' &&
    finalObs.toastVisible === false
  ) {
    const ctx: MultiContextDetectionContext = {
      variantKind: 'lifecycle_state_loss',
      lifecycleEvent: plan.variant.lifecycleEvent,
      proof: 'state_lost_post_lifecycle',
      evidence: evidenceSnippet(
        `pre=${pre.targetSelectorHash.slice(0, 8)} optimistic=${optimistic.targetSelectorState} final=${finalObs.targetSelectorHash.slice(0, 8)}`,
      ),
    };
    return makeDetection(
      'visibility_change_state_loss',
      `State lost after ${plan.variant.lifecycleEvent} lifecycle event on ${plan.toolId}`,
      plan.toolPath,
      ctx,
    );
  }

  // Bug shape B: silent failure — non-2xx network response, no error visible
  const hasNetworkFailure = observations.some(o => o.responseStatus !== undefined && o.responseStatus >= 400);
  if (hasNetworkFailure && finalObs.toastVisible === false && finalObs.consoleErrorCount === 0) {
    const ctx: MultiContextDetectionContext = {
      variantKind: 'lifecycle_state_loss',
      lifecycleEvent: plan.variant.lifecycleEvent,
      proof: 'silent_failure_post_lifecycle',
      evidence: evidenceSnippet(
        `Non-2xx response after ${plan.variant.lifecycleEvent}; no error toast or console error visible`,
      ),
    };
    return makeDetection(
      'visibility_change_state_loss',
      `Silent failure after ${plan.variant.lifecycleEvent} lifecycle event on ${plan.toolId}`,
      plan.toolPath,
      ctx,
    );
  }

  // Bug shape C: success arrived before lifecycle event, but state reverted after
  if (
    optimistic.targetSelectorState === 'final' &&
    postLifecycle !== undefined &&
    finalObs.targetSelectorHash === pre.targetSelectorHash
  ) {
    const ctx: MultiContextDetectionContext = {
      variantKind: 'lifecycle_state_loss',
      lifecycleEvent: plan.variant.lifecycleEvent,
      proof: 'rollback_post_lifecycle',
      evidence: evidenceSnippet(
        `Response arrived (state=final at 100ms) but reverted to pre-state after ${plan.variant.lifecycleEvent}`,
      ),
    };
    return makeDetection(
      'visibility_change_state_loss',
      `Rollback after ${plan.variant.lifecycleEvent} event despite successful response on ${plan.toolId}`,
      plan.toolPath,
      ctx,
    );
  }

  return null;
}

// ---- inconsistent_snapshot detector ----

export type InconsistentSnapshotPlan = {
  variant: MultiContextVariant & { kind: 'inconsistent_snapshot' };
  writerToolId: string;
  toolPath: string;
  pageRoute: string;
};

/**
 * Detect torn reads: roleB reads a resource mid-mutation by roleA and sees a partial state.
 * Torn = mid is neither pre nor post, with no snapshot-versioning header.
 */
export function detectMultiUserInconsistentSnapshot(
  plan: InconsistentSnapshotPlan,
  _writerObservations: RaceObservation[],
  readerCaptures: { pre: SnapshotCapture; mid: SnapshotCapture; post: SnapshotCapture },
): BugDetection | null {
  const { pre, mid, post } = readerCaptures;

  if (pre.responseStatus >= 400 || mid.responseStatus >= 400 || post.responseStatus >= 400) return null;
  if (mid.responseStatus === 401 || mid.responseStatus === 403) return null;

  const preBody = pre.responseBody as Record<string, unknown> | null;
  const midBody = mid.responseBody as Record<string, unknown> | null;
  const postBody = post.responseBody as Record<string, unknown> | null;

  if (preBody === null || midBody === null || postBody === null) return null;

  const changedPreToPost = getChangedKeys(preBody, postBody);
  if (changedPreToPost.length === 0) return null; // writer noop

  const changedPreToMid = getChangedKeys(preBody, midBody);

  // If mid equals pre: not yet applied — consistent
  if (changedPreToMid.length === 0) return null;

  // If mid equals post: applied atomically — consistent
  if (sameFields(changedPreToMid, changedPreToPost) && fieldsMatch(midBody, postBody, changedPreToPost)) return null;

  // Snapshot-version headers present → app signals intentional snapshot-aware semantics
  if (mid.headers.etag !== undefined || mid.headers.xSnapshotVersion !== undefined || mid.headers.lastModified !== undefined) return null;

  // Torn read: mid is a strict subset of post's changes
  const isSubset = changedPreToMid.every(k => changedPreToPost.includes(k));
  if (isSubset) {
    const ctx: MultiContextDetectionContext = {
      variantKind: 'inconsistent_snapshot',
      readerEndpoint: plan.variant.readerEndpoint,
      proof: 'torn_read',
      evidence: evidenceSnippet(
        `pre→mid changed [${changedPreToMid.join(',')}], pre→post changed [${changedPreToPost.join(',')}]`,
      ),
    };
    return makeDetection(
      'multi_user_inconsistent_snapshot',
      `Torn read on ${plan.variant.readerEndpoint}: mid-mutation snapshot shows partial state from ${plan.writerToolId}`,
      plan.writerToolId,
      ctx,
    );
  }

  // Impossible state: mid has changes outside of pre→post delta
  const overlaps = changedPreToMid.filter(k => !changedPreToPost.includes(k));
  if (overlaps.length > 0) {
    const ctx: MultiContextDetectionContext = {
      variantKind: 'inconsistent_snapshot',
      readerEndpoint: plan.variant.readerEndpoint,
      proof: 'inconsistent_field_overlay',
      evidence: evidenceSnippet(
        `mid has unexpected fields [${overlaps.join(',')}] not in pre→post delta [${changedPreToPost.join(',')}]`,
      ),
    };
    return makeDetection(
      'multi_user_inconsistent_snapshot',
      `Inconsistent field overlay on ${plan.variant.readerEndpoint}: impossible mid-state from ${plan.writerToolId}`,
      plan.writerToolId,
      ctx,
    );
  }

  return null;
}

// ---- helpers ----

function getChangedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Array.from(keys).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function sameFields(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(k => setA.has(k));
}

function fieldsMatch(a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export type { LifecycleEventKind };
