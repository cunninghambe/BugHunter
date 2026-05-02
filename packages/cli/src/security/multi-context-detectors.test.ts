// Unit tests for v0.40 multi-context detectors.
// Uses synthetic observations and snapshot captures — no browser, no IO.

import { describe, it, expect } from 'vitest';
import {
  detectMultiContextStateDivergence,
  detectVisibilityChangeStateLoss,
  detectMultiUserInconsistentSnapshot,
} from './multi-context-detectors.js';
import type {
  StateDivergencePlan,
  LifecycleStateLossPlan,
  InconsistentSnapshotPlan,
} from './multi-context-detectors.js';
import type { RaceObservation, SnapshotCapture } from '../types.js';

// ---- observation helpers ----

function obs(opts: Partial<RaceObservation> & { offsetMs: number }): RaceObservation {
  return {
    offsetMs: opts.offsetMs,
    url: opts.url ?? 'http://localhost/',
    targetSelectorState: opts.targetSelectorState ?? 'pre',
    targetSelectorHash: opts.targetSelectorHash ?? '',
    consoleErrorCount: opts.consoleErrorCount ?? 0,
    toastVisible: opts.toastVisible ?? false,
    responseStatus: opts.responseStatus,
  };
}

function snap(opts: Partial<SnapshotCapture> & { offsetMs: number }): SnapshotCapture {
  return {
    offsetMs: opts.offsetMs,
    responseStatus: opts.responseStatus ?? 200,
    responseBody: opts.responseBody ?? null,
    headers: opts.headers ?? {},
  };
}

// ---- detectMultiContextStateDivergence ----

describe('detectMultiContextStateDivergence', () => {
  const basePlan: StateDivergencePlan = {
    variant: { kind: 'state_divergence', n: 3, gapMs: 0, settleMs: 5000 },
    toolId: 'update-item',
    toolPath: '/api/items/1',
    pageRoute: '/items',
  };

  it('returns null when all contexts produce identical final hash', () => {
    // Given: 3 contexts all settle to the same selector hash
    const observationsByContext = [
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
    ];
    // When
    const result = detectMultiContextStateDivergence(basePlan, observationsByContext);
    // Then: no bug emitted
    expect(result).toBeNull();
  });

  it('returns detection when contexts diverge at settle time', () => {
    // Given: 3 contexts settle to different hashes (cross-tab state divergence)
    const observationsByContext = [
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'ddeeff' })],
      [obs({ offsetMs: 0 }), obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
    ];
    // When
    const result = detectMultiContextStateDivergence(basePlan, observationsByContext);
    // Then: bug emitted with correct kind and variant context
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('multi_context_state_divergence');
    expect(result!.multiContextContext?.variantKind).toBe('state_divergence');
    expect(result!.multiContextContext?.proof).toBe('n_way_no_reconcile');
    expect(result!.multiContextContext?.n).toBe(3);
  });

  it('returns null when observations array is empty', () => {
    // Given: no contexts (malformed input)
    expect(detectMultiContextStateDivergence(basePlan, [])).toBeNull();
  });

  it('returns null when any context has no observations at all', () => {
    // Given: one context has zero observations — cannot determine final state
    const observationsByContext = [
      [obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
      [], // context 2 has no data
      [obs({ offsetMs: 5000, targetSelectorHash: 'ddeeff' })],
    ];
    expect(detectMultiContextStateDivergence(basePlan, observationsByContext)).toBeNull();
  });

  it('embeds endpoint from toolPath in detection', () => {
    // Given: diverging contexts
    const observationsByContext = [
      [obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
      [obs({ offsetMs: 5000, targetSelectorHash: 'ddeeff' })],
      [obs({ offsetMs: 5000, targetSelectorHash: 'aabbcc' })],
    ];
    const result = detectMultiContextStateDivergence(basePlan, observationsByContext);
    expect(result).not.toBeNull();
    expect(result!.endpoint).toBe('/api/items/1');
  });
});

// ---- detectVisibilityChangeStateLoss ----

describe('detectVisibilityChangeStateLoss', () => {
  const basePlan: LifecycleStateLossPlan = {
    variant: {
      kind: 'lifecycle_state_loss',
      lifecycleEvent: 'visibilitychange',
      midActionDelayMs: 100,
      settleMs: 5000,
    },
    toolId: 'save-settings',
    toolPath: '/api/settings',
    pageRoute: '/settings',
  };

  it('returns null when final state is stable after lifecycle event (no regression)', () => {
    // Given: optimistic at 100ms, same state at final — no revert
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 100, targetSelectorHash: 'new_hash', targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 300, targetSelectorHash: 'new_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'new_hash' }),
    ];
    expect(detectVisibilityChangeStateLoss(basePlan, observations)).toBeNull();
  });

  it('detects state_lost_post_lifecycle when optimistic then reverted with no toast', () => {
    // Given: optimistic at 100ms; after visibilitychange, state returns to pre — silent drop
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 100, targetSelectorHash: 'optimistic_hash', targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 300, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'pre_hash', toastVisible: false }),
    ];
    // When
    const result = detectVisibilityChangeStateLoss(basePlan, observations);
    // Then
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('visibility_change_state_loss');
    expect(result!.multiContextContext?.proof).toBe('state_lost_post_lifecycle');
    expect(result!.multiContextContext?.lifecycleEvent).toBe('visibilitychange');
  });

  it('does not detect state loss when a toast is visible (failure was surfaced)', () => {
    // Given: state reverted but a toast appeared — app handled it correctly
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 100, targetSelectorHash: 'optimistic_hash', targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 300, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'pre_hash', toastVisible: true }),
    ];
    expect(detectVisibilityChangeStateLoss(basePlan, observations)).toBeNull();
  });

  it('detects silent_failure_post_lifecycle when 4xx response with no toast and no console errors', () => {
    // Given: 400 response captured, but no error surface shown
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 100, targetSelectorHash: 'pre_hash', responseStatus: 400, toastVisible: false, consoleErrorCount: 0 }),
      obs({ offsetMs: 300, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'pre_hash', toastVisible: false, consoleErrorCount: 0 }),
    ];
    const result = detectVisibilityChangeStateLoss(basePlan, observations);
    expect(result).not.toBeNull();
    expect(result!.multiContextContext?.proof).toBe('silent_failure_post_lifecycle');
  });

  it('returns null when lifecycle fired after response arrived and state is consistent', () => {
    // Given: successful mutation settled before lifecycle — no regression
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash', targetSelectorState: 'pre' }),
      obs({ offsetMs: 100, targetSelectorHash: 'new_hash', targetSelectorState: 'final' }),
      obs({ offsetMs: 300, targetSelectorHash: 'new_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'new_hash' }),
    ];
    expect(detectVisibilityChangeStateLoss(basePlan, observations)).toBeNull();
  });

  it('returns null when observations are missing required slots', () => {
    // Given: only 1 observation — cannot evaluate pre/optimistic/final
    const observations = [obs({ offsetMs: 5100, targetSelectorHash: 'x' })];
    // obsAt will pick the same observation for all slots, all hashes equal → null
    expect(detectVisibilityChangeStateLoss(basePlan, observations)).toBeNull();
  });

  it('works for pagehide lifecycle event with same detection logic', () => {
    // Given: pagehide event triggers state loss pattern
    const pagehidePlan: LifecycleStateLossPlan = {
      ...basePlan,
      variant: { ...basePlan.variant, lifecycleEvent: 'pagehide' },
    };
    const observations = [
      obs({ offsetMs: 0, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 100, targetSelectorHash: 'optimistic_hash', targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 300, targetSelectorHash: 'pre_hash' }),
      obs({ offsetMs: 5100, targetSelectorHash: 'pre_hash', toastVisible: false }),
    ];
    const result = detectVisibilityChangeStateLoss(pagehidePlan, observations);
    expect(result).not.toBeNull();
    expect(result!.multiContextContext?.lifecycleEvent).toBe('pagehide');
  });
});

// ---- detectMultiUserInconsistentSnapshot ----

describe('detectMultiUserInconsistentSnapshot', () => {
  const basePlan: InconsistentSnapshotPlan = {
    variant: {
      kind: 'inconsistent_snapshot',
      readerEndpoint: '/api/items/1',
      resourceId: '1',
      writerSettleMs: 2000,
    },
    writerToolId: 'update-item',
    toolPath: '/api/items/1',
    pageRoute: '/items',
  };

  const writerObs = [obs({ offsetMs: 0 }), obs({ offsetMs: 2000 })];

  it('returns null when pre equals post (writer produced no observable change)', () => {
    // Given: writer wrote but content is identical pre/post
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Alice', count: 5 } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Alice', count: 5 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('returns null when mid equals pre (write not yet applied at read time)', () => {
    // Given: consistent read — reader sees old state mid-write (not yet committed)
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Alice', count: 5 } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('returns null when mid equals post (write applied atomically before reader hit)', () => {
    // Given: atomic write — reader sees full post state
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 10 } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('detects torn_read when mid has partial subset of changed fields', () => {
    // Given: writer changes both `name` and `count`; reader mid sees only `name` changed
    // — classic torn read (partial write visible)
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 5 } }),  // only name updated
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }), // both updated
    };
    const result = detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('multi_user_inconsistent_snapshot');
    expect(result!.multiContextContext?.proof).toBe('torn_read');
    expect(result!.multiContextContext?.readerEndpoint).toBe('/api/items/1');
  });

  it('returns null when mid has ETag header (app signals snapshot-aware semantics)', () => {
    // Given: torn-read pattern BUT reader returns ETag — app intentionally versions responses
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 5 }, headers: { etag: '"abc123"' } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('returns null when x-snapshot-version header is present', () => {
    // Given: custom version header — same intent as ETag
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 5 }, headers: { xSnapshotVersion: '2' } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('returns null when reader gets non-2xx on any capture', () => {
    // Given: pre succeeds but mid returns 503 — reader transient failure, not a torn read
    const captures = {
      pre: snap({ offsetMs: 0, responseStatus: 200, responseBody: { name: 'Alice', count: 5 } }),
      mid: snap({ offsetMs: 1000, responseStatus: 503, responseBody: null }),
      post: snap({ offsetMs: 2000, responseStatus: 200, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('returns null when reader body is null (non-JSON or empty response)', () => {
    // Given: reader cannot parse body — insufficient data to compare
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: null }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 5 } }),
      post: snap({ offsetMs: 2000, responseBody: { name: 'Bob', count: 10 } }),
    };
    expect(detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures)).toBeNull();
  });

  it('detects inconsistent_field_overlay when mid has fields outside pre→post delta', () => {
    // Given: writer changes `count`; reader mid sees `name` changed (impossible — unrelated write visible)
    const captures = {
      pre: snap({ offsetMs: 0, responseBody: { name: 'Alice', count: 5, status: 'active' } }),
      mid: snap({ offsetMs: 1000, responseBody: { name: 'Bob', count: 5, status: 'active' } }), // name changed but writer didn't touch name
      post: snap({ offsetMs: 2000, responseBody: { name: 'Alice', count: 10, status: 'active' } }), // only count changed
    };
    const result = detectMultiUserInconsistentSnapshot(basePlan, writerObs, captures);
    expect(result).not.toBeNull();
    expect(result!.multiContextContext?.proof).toBe('inconsistent_field_overlay');
  });
});
