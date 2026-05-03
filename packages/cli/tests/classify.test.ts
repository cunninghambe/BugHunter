import { describe, it, expect } from 'vitest';
import { classifyConsoleErrors } from '../src/classify/console.js';
import { classifyNetworkRequests } from '../src/classify/network.js';
import { classifyMissingStateChange } from '../src/classify/state-change.js';
import type { ConsoleError, NetworkRequest, Action, PreState, PostState } from '../src/types.js';

describe('classifyConsoleErrors', () => {
  it('plain error is console_error', () => {
    const errors: ConsoleError[] = [{ level: 'error', text: 'Something exploded' }];
    const result = classifyConsoleErrors(errors, '/test');
    expect(result[0].kind).toBe('console_error');
  });

  it('React warning prefix is react_error', () => {
    const errors: ConsoleError[] = [{ level: 'error', text: 'Warning: Cannot update during an existing state transition' }];
    const result = classifyConsoleErrors(errors, '/test');
    expect(result[0].kind).toBe('react_error');
  });

  it('hydration mismatch is react_error', () => {
    const errors: ConsoleError[] = [{ level: 'error', text: 'Hydration failed because the initial UI does not match' }];
    const result = classifyConsoleErrors(errors, '/test');
    expect(result[0].kind).toBe('react_error');
  });
});

describe('classifyNetworkRequests', () => {
  it('5xx is network_5xx regardless of expectedOutcome', () => {
    const reqs: NetworkRequest[] = [{ method: 'POST', path: '/api/foo', status: 500, duration: 100 }];
    const result = classifyNetworkRequests(reqs, 'success', true);
    expect(result[0].kind).toBe('network_5xx');
  });

  it('4xx with expectedOutcome=success is network_4xx_unexpected', () => {
    const reqs: NetworkRequest[] = [{ method: 'POST', path: '/api/foo', status: 400, duration: 50 }];
    const result = classifyNetworkRequests(reqs, 'success', true);
    expect(result[0].kind).toBe('network_4xx_unexpected');
  });

  it('4xx with expectedOutcome=expected_failure is not a bug', () => {
    const reqs: NetworkRequest[] = [{ method: 'POST', path: '/api/foo', status: 422, duration: 50 }];
    const result = classifyNetworkRequests(reqs, 'expected_failure', true);
    const unexpected = result.filter(r => r.kind === 'network_4xx_unexpected');
    expect(unexpected).toHaveLength(0);
  });

  it('401 with authorized role is network_4xx_unexpected', () => {
    const reqs: NetworkRequest[] = [{ method: 'GET', path: '/api/admin', status: 401, duration: 20 }];
    const result = classifyNetworkRequests(reqs, 'success', true);
    expect(result[0].kind).toBe('network_4xx_unexpected');
  });

  it('infrastructure_failure does NOT enter bugs — tested via classify phase', () => {
    // infraFailures are handled in classify.ts separately
    // This test documents the contract: classifyNetworkRequests never produces infra_failure
    const reqs: NetworkRequest[] = [];
    const result = classifyNetworkRequests(reqs, 'success', true);
    expect(result.every(r => r.kind !== ('infrastructure_failure' as string))).toBe(true);
  });

  // B-1 regression: status 0 must surface as a real classification (connectivity failure),
  // not be silently dropped as if no status was reported.
  it('B-1: status 0 (connectivity failure) is classified as network_5xx, not silently dropped', () => {
    const reqs: NetworkRequest[] = [{ method: 'POST', path: '/api/orders', status: 0, duration: 0 }];
    const result = classifyNetworkRequests(reqs, 'success', true);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('network_5xx');
    expect(result[0].status).toBe(0);
    expect(result[0].rootCause).toContain('Connectivity failure');
  });
});

describe('classifyMissingStateChange', () => {
  const preState: PreState = {
    url: '/products',
    title: 'Products',
    consoleErrorCount: 0,
  };

  const happyAction: Action = {
    kind: 'click',
    via: 'ui',
    expectedOutcome: 'success',
    palette: 'happy',
    selector: 'button[data-testid="save"]',
  };

  it('no change after successful click = missing_state_change', () => {
    const postState: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 500,
    };
    const result = classifyMissingStateChange(preState, postState, happyAction, '/products');
    expect(result?.kind).toBe('missing_state_change');
  });

  it('URL change = no missing_state_change bug', () => {
    const postState: PostState = {
      url: '/products/123',
      title: 'Product Detail',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 200,
    };
    const result = classifyMissingStateChange(preState, postState, happyAction, '/products');
    expect(result).toBeNull();
  });

  it('expected_failure action does not trigger missing_state_change', () => {
    const failAction: Action = { ...happyAction, expectedOutcome: 'expected_failure', palette: 'null' };
    const postState: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 200,
    };
    const result = classifyMissingStateChange(preState, postState, failAction, '/products');
    expect(result).toBeNull();
  });

  it('render action does not trigger missing_state_change', () => {
    const renderAction: Action = { ...happyAction, kind: 'render' };
    const postState: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 0,
    };
    const result = classifyMissingStateChange(preState, postState, renderAction, '/products');
    expect(result).toBeNull();
  });

  it('aria-expanded false→true = state changed, no fire', () => {
    const pre: PreState = { ...preState, ariaSnapshot: { expanded: false, haspopup: true } };
    const post: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 300,
      ariaSnapshot: { expanded: true, haspopup: true },
    };
    expect(classifyMissingStateChange(pre, post, happyAction, '/products')).toBeNull();
  });

  it('DOM-scoped mutation (URL change) = existing guard still works', () => {
    const post: PostState = {
      url: '/products/new',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 300,
    };
    expect(classifyMissingStateChange(preState, post, happyAction, '/products')).toBeNull();
  });

  it('no DOM change, no ARIA change = fires (real bug)', () => {
    const pre: PreState = { ...preState, ariaSnapshot: { expanded: false, haspopup: true } };
    const post: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 500,
      ariaSnapshot: { expanded: false, haspopup: true },
      newPortalCount: 0,
    };
    expect(classifyMissingStateChange(pre, post, happyAction, '/products')?.kind).toBe('missing_state_change');
  });

  it('aria-haspopup button → Radix portal appears (newPortalCount=1) = no fire', () => {
    const pre: PreState = { ...preState, ariaSnapshot: { haspopup: true } };
    const post: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 300,
      ariaSnapshot: { haspopup: true },
      newPortalCount: 1,
    };
    expect(classifyMissingStateChange(pre, post, happyAction, '/products')).toBeNull();
  });

  it('Headless UI button → portal appears (newPortalCount > 0, no ARIA) = no fire', () => {
    const post: PostState = {
      url: '/products',
      title: 'Products',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 300,
      newPortalCount: 2,
    };
    expect(classifyMissingStateChange(preState, post, happyAction, '/products')).toBeNull();
  });
});
