// Unit tests for classifyMissingStateChange — focused on the v0.53 DOM
// mutation signal that closes the spoonworks "Remove row" FP.

import { describe, it, expect } from 'vitest';
import { classifyMissingStateChange } from './state-change.js';
import type { Action, PreState, PostState } from '../types.js';

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    kind: 'click',
    expectedOutcome: 'success',
    palette: 'happy',
    selector: 'button[aria-label="Remove row"]',
    via: 'ui',
    ...overrides,
  } as Action;
}

function makePre(overrides: Partial<PreState> = {}): PreState {
  return {
    url: '/admin/inventory/recipes/x',
    title: '',
    consoleErrorCount: 0,
    ...overrides,
  };
}

function makePost(overrides: Partial<PostState> = {}): PostState {
  return {
    url: '/admin/inventory/recipes/x',
    title: '',
    consoleErrors: [],
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: 100,
    ...overrides,
  };
}

describe('classifyMissingStateChange — happy paths', () => {
  it('returns null when expectedOutcome is not success (mutator probe)', () => {
    const r = classifyMissingStateChange(
      makePre(),
      makePost(),
      makeAction({ expectedOutcome: 'expected_failure' }),
      '/x',
    );
    expect(r).toBeNull();
  });

  it('returns null when action kind is render', () => {
    expect(classifyMissingStateChange(
      makePre(), makePost(), makeAction({ kind: 'render' }), '/x',
    )).toBeNull();
  });

  it('returns null when URL changed', () => {
    expect(classifyMissingStateChange(
      makePre({ url: '/a' }),
      makePost({ url: '/b' }),
      makeAction(), '/a',
    )).toBeNull();
  });

  it('returns null when network completed', () => {
    expect(classifyMissingStateChange(
      makePre(),
      makePost({ networkRequests: [{ method: 'POST', path: '/api/x', status: 200, duration: 10 }] }),
      makeAction(), '/x',
    )).toBeNull();
  });

  it('returns null when console error fired', () => {
    expect(classifyMissingStateChange(
      makePre(),
      makePost({ consoleErrors: [{ level: 'error', text: 'fail', stack: '' }] }),
      makeAction(), '/x',
    )).toBeNull();
  });
});

describe('classifyMissingStateChange — fires when truly nothing happened', () => {
  it('emits when click had no observable signal at all', () => {
    const r = classifyMissingStateChange(
      makePre(), makePost(), makeAction(), '/admin/x',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('missing_state_change');
    expect(r!.pageRoute).toBe('/admin/x');
    expect(r!.rootCause).toContain('Remove row');
  });
});

describe('classifyMissingStateChange — v0.53 DOM mutation signal', () => {
  it('returns null when domMutationCount > 0 (spoonworks Remove row case)', () => {
    // Remove row click → setRows(p.filter(...)) → React removes row nodes.
    // No URL change, no network, no aria, no portal — but the MutationObserver
    // captures the row's removal via childList mutations.
    const r = classifyMissingStateChange(
      makePre(),
      makePost({ domMutationCount: 3 }),
      makeAction(),
      '/admin/inventory/recipes/x',
    );
    expect(r).toBeNull();
  });

  it('still fires when domMutationCount === 0 (truly inert click)', () => {
    const r = classifyMissingStateChange(
      makePre(),
      makePost({ domMutationCount: 0 }),
      makeAction(),
      '/admin/x',
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('missing_state_change');
  });

  it('still fires when domMutationCount is absent (pre-v0.53 PostState; conservative)', () => {
    // Backward compat: a synthesized occurrence or a stored cluster from
    // before the field existed must not silently change behavior.
    const r = classifyMissingStateChange(
      makePre(),
      makePost(), // no domMutationCount
      makeAction(),
      '/admin/x',
    );
    expect(r).not.toBeNull();
  });

  it('returns null with domMutationCount=1 (single mutation is enough)', () => {
    // A single childList add or remove is a meaningful change.
    expect(classifyMissingStateChange(
      makePre(), makePost({ domMutationCount: 1 }), makeAction(), '/x',
    )).toBeNull();
  });
});
