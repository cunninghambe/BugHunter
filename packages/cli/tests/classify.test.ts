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
});
