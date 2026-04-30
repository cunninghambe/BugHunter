// Unit tests for v0.19 race-condition detectors.
// Uses synthetic observations — no browser, no IO.

import { describe, it, expect } from 'vitest';
import {
  detectDoubleSubmit,
  detectClickThenNavigate,
  detectOptimisticRevert,
  detectInterleavedMutations,
  detectCrossTab,
} from './race-detectors.js';
import type {
  DoubleSubmitPlan,
  ClickThenNavigatePlan,
  OptimisticRevertPlan,
  InterleavedMutationsPlan,
  CrossTabPlan,
} from './race-detectors.js';
import type { RaceObservation } from '../types.js';

// ---- helpers ----

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

// ---- detectDoubleSubmit ----

describe('detectDoubleSubmit', () => {
  const plan: DoubleSubmitPlan = {
    variant: { kind: 'double_submit', gapMs: 50 },
    toolId: 'create-post',
    toolPath: '/api/posts',
    raceNonce: 'abc123',
  };

  it('returns a detection when two 2xx responses and final state', () => {
    const observations = [
      obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 200 }),
      obs({ offsetMs: 50, targetSelectorState: 'pre', responseStatus: 200 }),
      obs({ offsetMs: 1000, targetSelectorState: 'final' }),
    ];
    const result = detectDoubleSubmit(plan, observations);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_double_submit');
    expect(result?.raceContext?.variantKind).toBe('double_submit');
  });

  it('returns null when only one 2xx response', () => {
    const observations = [
      obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 200 }),
      obs({ offsetMs: 1000, targetSelectorState: 'final' }),
    ];
    expect(detectDoubleSubmit(plan, observations)).toBeNull();
  });

  it('returns null when final state is not "final"', () => {
    const observations = [
      obs({ offsetMs: 0, responseStatus: 200 }),
      obs({ offsetMs: 50, responseStatus: 200 }),
      obs({ offsetMs: 1000, targetSelectorState: 'pre' }),
    ];
    expect(detectDoubleSubmit(plan, observations)).toBeNull();
  });

  it('returns null with empty observations', () => {
    expect(detectDoubleSubmit(plan, [])).toBeNull();
  });
});

// ---- detectClickThenNavigate ----

describe('detectClickThenNavigate', () => {
  const plan: ClickThenNavigatePlan = {
    variant: { kind: 'click_then_navigate', targetRoute: '/dashboard', preFireDelayMs: 0 },
    toolId: 'update-post',
    toolPath: '/api/posts/1',
    pageRoute: '/posts/edit',
  };

  it('detects stale post-navigation (pre state, no error, no toast)', () => {
    const observations = [
      obs({ offsetMs: 0, targetSelectorState: 'pre' }),
      obs({ offsetMs: 2000, targetSelectorState: 'pre', consoleErrorCount: 0, toastVisible: false }),
    ];
    const result = detectClickThenNavigate(plan, observations);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_click_navigate');
    expect(result?.raceContext?.proof).toBe('stale_post_navigation');
  });

  it('detects silent post-unmount failure', () => {
    const observations = [
      obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 400 }),
      obs({ offsetMs: 2000, targetSelectorState: 'errored', consoleErrorCount: 0, toastVisible: false }),
    ];
    // post-nav state is 'errored' so stale branch won't fire; but failed request with no user feedback
    // Note: targetSelectorState='errored' means did NOT revert — but the branch checks 'pre' specifically
    // So this tests the second branch: failed request + no console error + no toast
    const result = detectClickThenNavigate(plan, observations);
    // errored != pre so branch 1 doesn't fire; branch 2: failedRequest exists, no error, no toast
    expect(result).not.toBeNull();
    expect(result?.raceContext?.proof).toBe('silent_post_unmount_failure');
  });

  it('returns null when a console error surfaced the failure', () => {
    const observations = [
      obs({ offsetMs: 0, responseStatus: 400 }),
      obs({ offsetMs: 2000, targetSelectorState: 'pre', consoleErrorCount: 1 }),
    ];
    expect(detectClickThenNavigate(plan, observations)).toBeNull();
  });

  it('returns null when a toast surfaced the failure', () => {
    const observations = [
      obs({ offsetMs: 0, responseStatus: 400 }),
      obs({ offsetMs: 2000, targetSelectorState: 'pre', toastVisible: true }),
    ];
    expect(detectClickThenNavigate(plan, observations)).toBeNull();
  });

  it('returns null when the mutation succeeded (final state with no failure)', () => {
    const observations = [
      obs({ offsetMs: 0, responseStatus: 200 }),
      obs({ offsetMs: 2000, targetSelectorState: 'final' }),
    ];
    expect(detectClickThenNavigate(plan, observations)).toBeNull();
  });
});

// ---- detectOptimisticRevert ----

describe('detectOptimisticRevert', () => {
  const plan: OptimisticRevertPlan = {
    variant: { kind: 'optimistic_revert', forcedStatus: 500, forcedBody: '{"error":"forced"}' },
    toolId: 'like-post',
    toolPath: '/api/posts/1/like',
    pageRoute: '/posts/1',
  };

  it('detects missing revert when optimistic state persists at 5000ms', () => {
    const observations = [
      obs({ offsetMs: 300, targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 5000, targetSelectorState: 'optimistic', consoleErrorCount: 0, toastVisible: false }),
    ];
    const result = detectOptimisticRevert(plan, observations);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_optimistic_revert');
    expect(result?.raceContext?.proof).toBe('no_revert_after_failure');
  });

  it('returns null when the UI reverted to "reverted" state', () => {
    const observations = [
      obs({ offsetMs: 300, targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 5000, targetSelectorState: 'reverted' }),
    ];
    expect(detectOptimisticRevert(plan, observations)).toBeNull();
  });

  it('returns null when a toast appeared (failure surfaced)', () => {
    const observations = [
      obs({ offsetMs: 300, targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 5000, targetSelectorState: 'optimistic', toastVisible: true }),
    ];
    expect(detectOptimisticRevert(plan, observations)).toBeNull();
  });

  it('returns null when no optimistic state was shown', () => {
    const observations = [
      obs({ offsetMs: 300, targetSelectorState: 'pre' }),
      obs({ offsetMs: 5000, targetSelectorState: 'pre' }),
    ];
    expect(detectOptimisticRevert(plan, observations)).toBeNull();
  });

  it('returns null with fewer than 2 observations (missing either slot)', () => {
    expect(detectOptimisticRevert(plan, [])).toBeNull();
  });
});

// ---- detectInterleavedMutations ----

describe('detectInterleavedMutations', () => {
  const plan: InterleavedMutationsPlan = {
    variant: { kind: 'interleaved_mutations', siblingActionId: 'patch-post', gapMs: 0, consensusRuns: 3 },
    toolId: 'update-post',
    toolPath: '/api/posts/1',
    siblingToolId: 'patch-post',
    pageRoute: '/posts/edit',
  };

  it('detects bug when ≥2 runs diverge', () => {
    const runObs = [
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' })],
    ];
    const result = detectInterleavedMutations(plan, runObs);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_interleaved_mutations');
    expect(result?.raceContext?.flaky).toBeFalsy();
  });

  it('marks as flaky when exactly 1 run diverges', () => {
    const runObs = [
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' })],
    ];
    const result = detectInterleavedMutations(plan, runObs);
    expect(result).not.toBeNull();
    expect(result?.raceContext?.flaky).toBe(true);
  });

  it('returns null when all runs have the same final state', () => {
    const runObs = [
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
    ];
    expect(detectInterleavedMutations(plan, runObs)).toBeNull();
  });

  it('returns null when any run returned a 409 conflict', () => {
    const runObs = [
      [obs({ offsetMs: 500, responseStatus: 409 }), obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' })],
      [obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' })],
    ];
    expect(detectInterleavedMutations(plan, runObs)).toBeNull();
  });
});

// ---- detectCrossTab ----

describe('detectCrossTab', () => {
  const plan: CrossTabPlan = {
    variant: { kind: 'cross_tab', settleMs: 5000 },
    toolId: 'update-counter',
    toolPath: '/api/counter',
    pageRoute: '/counter',
  };

  it('detects divergence when tabs have different final hashes', () => {
    const tab1Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-tab1', targetSelectorState: 'final' })];
    const tab2Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-tab2', targetSelectorState: 'final' })];
    const result = detectCrossTab(plan, tab1Obs, tab2Obs);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_cross_tab');
    expect(result?.raceContext?.proof).toBe('cross_tab_no_reconcile');
  });

  it('returns null when both tabs have same final hash', () => {
    const tab1Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' })];
    const tab2Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' })];
    expect(detectCrossTab(plan, tab1Obs, tab2Obs)).toBeNull();
  });

  it('returns null when either tab has errored state', () => {
    const tab1Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-A', targetSelectorState: 'errored' })];
    const tab2Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-B', targetSelectorState: 'final' })];
    expect(detectCrossTab(plan, tab1Obs, tab2Obs)).toBeNull();
  });

  it('returns null when either tab has empty hash', () => {
    const tab1Obs = [obs({ offsetMs: 5000, targetSelectorHash: '', targetSelectorState: 'final' })];
    const tab2Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-B', targetSelectorState: 'final' })];
    expect(detectCrossTab(plan, tab1Obs, tab2Obs)).toBeNull();
  });

  it('returns null when either tab has no observations', () => {
    const tab1Obs: RaceObservation[] = [];
    const tab2Obs = [obs({ offsetMs: 5000, targetSelectorHash: 'hash-B', targetSelectorState: 'final' })];
    expect(detectCrossTab(plan, tab1Obs, tab2Obs)).toBeNull();
  });
});
