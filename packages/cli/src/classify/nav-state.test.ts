// Tests for v0.22 nav-state classifier (§8 acceptance criteria).

import { describe, it, expect } from 'vitest';
import { classifyNavTransition, classifyBackAfterFormFill } from './nav-state.js';
import type { PreState, PostState, InterimState, NavTransition } from '../types.js';

function makePreState(overrides: Partial<PreState> = {}): PreState {
  return { url: '/app', title: '', consoleErrorCount: 0, ...overrides };
}

function makeInterim(overrides: Partial<InterimState> = {}): InterimState {
  return {
    url: '/app',
    domSignature: 'sig-after-seed',
    inFlightRequests: [],
    mutationCompletionSignal: 'response-200ish',
    ...overrides,
  };
}

function makePostState(overrides: Partial<PostState> = {}): PostState {
  return {
    url: '/app',
    title: '',
    consoleErrors: [],
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: 0,
    ...overrides,
  };
}

// ---- refresh ----

describe('classifyNavTransition — refresh', () => {
  const transition: NavTransition = { kind: 'refresh' };

  it('emits nav_refresh_double_mutation when still-pending and matching request appears in post', () => {
    const interim = makeInterim({
      mutationCompletionSignal: 'still-pending',
      inFlightRequests: [{ method: 'POST', path: '/api/orders', startedAtMs: 0 }],
    });
    const post = makePostState({
      networkRequests: [{ method: 'POST', path: '/api/orders', status: 201, duration: 100 }],
    });
    const result = classifyNavTransition({
      pre: makePreState(), interim, post, transition, pageRoute: '/orders',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_refresh_double_mutation');
    expect(result[0].navStateContext?.transitionKind).toBe('refresh');
    expect(result[0].navStateContext?.endpoint).toContain('POST');
  });

  it('emits nav_state_corruption when post DOM matches pre but interim differs', () => {
    const pre = makePreState();
    const interim = makeInterim({ domSignature: 'sig-mutated' });
    const post = makePostState({ domSignature: pre.consoleErrorCount.toString() } as never);
    // Custom: make post domSignature match pre
    const postCustom = makePostState() as PostState & { domSignature: string };
    postCustom.domSignature = 'sig-original';
    const preCustom = makePreState();
    const interimCustom = makeInterim({ domSignature: 'sig-mutated' });
    const inputPost = { ...postCustom };

    const result = classifyNavTransition({
      pre: { ...preCustom, domSignature: 'sig-original' } as never,
      interim: interimCustom,
      post: inputPost,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_state_corruption');
  });

  it('returns empty when mutation completed and no double request', () => {
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim({ mutationCompletionSignal: 'response-200ish' }),
      post: makePostState(),
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });
});

// ---- back ----

describe('classifyNavTransition — back', () => {
  const transition: NavTransition = { kind: 'back' };

  it('emits nav_resubmit_on_back when in-flight write request appears in post', () => {
    const interim = makeInterim({
      inFlightRequests: [{ method: 'DELETE', path: '/api/items/5', startedAtMs: 0 }],
    });
    const post = makePostState({
      networkRequests: [{ method: 'DELETE', path: '/api/items/5', status: 200, duration: 50 }],
    });
    const result = classifyNavTransition({
      pre: makePreState(), interim, post, transition, pageRoute: '/items',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_resubmit_on_back');
    expect(result[0].navStateContext?.endpoint).toContain('DELETE');
  });

  it('emits nav_state_corruption when post is a third DOM state', () => {
    const pre = makePreState();
    const interim = makeInterim({ url: pre.url });
    const post = makePostState({ url: pre.url });
    // inject domSignatures via cast since PostState doesn't have domSignature in base type
    const result = classifyNavTransition({
      pre: { ...pre, domSignature: 'sig-a' } as never,
      interim: { ...interim, domSignature: 'sig-b' },
      post: { ...post, domSignature: 'sig-c' } as never,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_state_corruption');
  });

  it('downgrades to empty when interim domSignature has modal marker', () => {
    const pre = makePreState();
    const post = makePostState({ url: pre.url });
    const result = classifyNavTransition({
      pre: { ...pre, domSignature: 'sig-a' } as never,
      interim: makeInterim({ domSignature: 'modal:dialog-open' }),
      post: { ...post, domSignature: 'sig-c' } as never,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when no resubmit and DOM states match', () => {
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post: makePostState(),
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });
});

// ---- back_then_forward ----

describe('classifyNavTransition — back_then_forward', () => {
  const transition: NavTransition = { kind: 'back_then_forward' };

  it('emits nav_state_corruption when same URL but DOM diverges', () => {
    const interim = makeInterim({ url: '/app' });
    const post = makePostState({ url: '/app' });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: { ...interim, domSignature: 'sig-before-fwd' },
      post: { ...post, domSignature: 'sig-after-fwd' } as never,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_state_corruption');
    expect(result[0].navStateContext?.transitionKind).toBe('back_then_forward');
  });

  it('returns empty when URL differs (expected — back changed route)', () => {
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim({ url: '/app' }),
      post: makePostState({ url: '/other' }),
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when aria-live marker present (§7.8 false-positive guard)', () => {
    const interim = makeInterim({ url: '/app', domSignature: 'arialive:count=3' });
    const post = makePostState({ url: '/app' });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim,
      post: { ...post, domSignature: 'arialive:count=4' } as never,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when DOM signatures match', () => {
    const sig = 'sig-consistent';
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim({ url: '/app', domSignature: sig }),
      post: { ...makePostState({ url: '/app' }), domSignature: sig } as never,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });
});

// ---- deep_link_no_auth ----

describe('classifyNavTransition — deep_link_no_auth', () => {
  it('emits nav_state_corruption when URL unchanged and no auth modal', () => {
    const capturedUrl = '/admin/settings';
    const transition: NavTransition = { kind: 'deep_link_no_auth', capturedUrl };
    const post = makePostState({ url: capturedUrl });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post: { ...post, domSignature: 'rendered-admin-content' } as never,
      transition,
      pageRoute: '/admin/settings',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_state_corruption');
  });

  it('returns empty when URL redirected away (login redirect)', () => {
    const capturedUrl = '/admin/settings';
    const transition: NavTransition = { kind: 'deep_link_no_auth', capturedUrl };
    const post = makePostState({ url: '/login' });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post,
      transition,
      pageRoute: '/admin/settings',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when auth modal marker detected', () => {
    const capturedUrl = '/dashboard';
    const transition: NavTransition = { kind: 'deep_link_no_auth', capturedUrl };
    const post = makePostState({ url: capturedUrl });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post: { ...post, domSignature: 'auth:modal-shown' } as never,
      transition,
      pageRoute: '/dashboard',
    });
    expect(result).toHaveLength(0);
  });
});

// ---- history_corrupt ----

describe('classifyNavTransition — history_corrupt', () => {
  it('emits nav_state_corruption when post URL does not match last pushState URL', () => {
    const transition: NavTransition = {
      kind: 'history_corrupt',
      pushStates: [
        { state: {}, url: '/route-a' },
        { state: {}, url: '/route-b' },
      ],
    };
    const post = makePostState({ url: '/route-a' }); // stuck on first, not last
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_state_corruption');
  });

  it('returns empty when post URL matches last pushState URL', () => {
    const transition: NavTransition = {
      kind: 'history_corrupt',
      pushStates: [{ state: {}, url: '/route-b' }],
    };
    const post = makePostState({ url: '/route-b' });
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post,
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when pushStates is empty', () => {
    const transition: NavTransition = { kind: 'history_corrupt', pushStates: [] };
    const result = classifyNavTransition({
      pre: makePreState(),
      interim: makeInterim(),
      post: makePostState(),
      transition,
      pageRoute: '/app',
    });
    expect(result).toHaveLength(0);
  });
});

// ---- back-after-form-fill ----

describe('classifyBackAfterFormFill', () => {
  it('emits nav_form_state_lost when post form is empty', () => {
    const interim = makeInterim({
      url: '/form',
      formSnapshot: { name: 'Alice', email: 'alice@test.com' },
    });
    const post = makePostState({ url: '/form' });
    (post as never as Record<string, unknown>).formSnapshot = {};
    const result = classifyBackAfterFormFill({
      pre: makePreState({ url: '/form' }),
      interim,
      post,
      pageRoute: '/form',
      formSignature: 'hash-abc',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_form_state_lost');
    expect(result[0].navStateContext?.formSignature).toBe('hash-abc');
  });

  it('emits nav_form_state_stale when a field value changed from what was filled', () => {
    const interim = makeInterim({
      url: '/form',
      formSnapshot: { name: 'Alice' },
    });
    const post = makePostState({ url: '/form' });
    (post as never as Record<string, unknown>).formSnapshot = { name: '' };
    const result = classifyBackAfterFormFill({
      pre: makePreState({ url: '/form' }),
      interim,
      post,
      pageRoute: '/form',
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('nav_form_state_stale');
    expect(result[0].navStateContext?.staleField).toBe('name');
  });

  it('returns empty when formSnapshot absent (no fill happened)', () => {
    const result = classifyBackAfterFormFill({
      pre: makePreState(),
      interim: makeInterim(),
      post: makePostState(),
      pageRoute: '/form',
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty when all field values preserved', () => {
    const interim = makeInterim({ formSnapshot: { name: 'Bob' } });
    const post = makePostState();
    (post as never as Record<string, unknown>).formSnapshot = { name: 'Bob' };
    const result = classifyBackAfterFormFill({
      pre: makePreState(),
      interim,
      post,
      pageRoute: '/form',
    });
    expect(result).toHaveLength(0);
  });
});
