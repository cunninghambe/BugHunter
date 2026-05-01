// Tests for v0.22 nav-transition-runner (§8 acceptance criteria).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  captureInterimState,
  runRefreshTransition,
  runBackTransition,
  runForwardTransition,
  runBackThenForwardTransition,
  runDeepLinkNoAuth,
  runHistoryCorruptTransition,
  runRefreshMidMutation,
} from './nav-transition-runner.js';
import type { TabScope } from '../adapters/browser-mcp.js';

function makeScope(overrides: Partial<TabScope> = {}): TabScope {
  const base: TabScope = {
    tabId: 'tab-1',
    navigate: vi.fn().mockResolvedValue({ url: '/app' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html>snapshot</html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '' }),
    evaluate: vi.fn().mockResolvedValue({ value: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false, reason: 'no_hint_fields' as const }),
    ...overrides,
  };
  return base;
}

// ---- captureInterimState ----

describe('captureInterimState', () => {
  it('returns url and domSignature from evaluate calls', async () => {
    let callCount = 0;
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ value: 'http://localhost/app' });
        return Promise.resolve({ value: 'main content text here' });
      }),
    });
    const interim = await captureInterimState(scope, undefined);
    expect(interim.url).toBe('http://localhost/app');
    expect(interim.domSignature).toHaveLength(20); // truncated sha1
    expect(interim.mutationCompletionSignal).toBe('response-200ish');
  });

  it('captures formSnapshot for submit seed actions', async () => {
    let callCount = 0;
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ value: 'http://localhost/form' });
        if (callCount === 2) return Promise.resolve({ value: 'page text' });
        // formSnapshot call
        return Promise.resolve({ value: { name: 'Alice', email: 'alice@test.com' } });
      }),
    });
    const interim = await captureInterimState(scope, {
      kind: 'submit',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: '#contact-form',
    });
    expect(interim.formSnapshot).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  it('does not capture formSnapshot for click seed actions', async () => {
    let callCount = 0;
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ value: 'http://localhost/app' });
        return Promise.resolve({ value: 'text' });
      }),
    });
    const interim = await captureInterimState(scope, {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: '#btn',
    });
    expect(interim.formSnapshot).toBeUndefined();
  });
});

// ---- runRefreshTransition ----

describe('runRefreshTransition', () => {
  it('calls evaluate with location.reload() and takes a snapshot', async () => {
    const scope = makeScope();
    await runRefreshTransition(scope);
    expect(scope.evaluate).toHaveBeenCalledWith('location.reload()');
    expect(scope.snapshot).toHaveBeenCalled();
  });
});

// ---- runRefreshMidMutation ----

describe('runRefreshMidMutation', () => {
  it('fires reload immediately and returns still-pending signal', async () => {
    let callCount = 0;
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation((script: string) => {
        callCount++;
        if (script === 'window.location.href') return Promise.resolve({ value: 'http://localhost/app' });
        if (script === 'location.reload()') return Promise.resolve({ value: undefined });
        return Promise.resolve({ value: 'text' });
      }),
    });
    const interim = await runRefreshMidMutation(scope, undefined);
    expect(interim.mutationCompletionSignal).toBe('still-pending');
    expect(scope.evaluate).toHaveBeenCalledWith('location.reload()');
  });
});

// ---- runBackTransition ----

describe('runBackTransition', () => {
  it('evaluates history.back() and snapshots', async () => {
    const scope = makeScope();
    await runBackTransition(scope);
    expect(scope.evaluate).toHaveBeenCalledWith('history.back()');
    expect(scope.snapshot).toHaveBeenCalled();
  });
});

// ---- runForwardTransition ----

describe('runForwardTransition', () => {
  it('evaluates history.forward() and snapshots', async () => {
    const scope = makeScope();
    await runForwardTransition(scope);
    expect(scope.evaluate).toHaveBeenCalledWith('history.forward()');
    expect(scope.snapshot).toHaveBeenCalled();
  });
});

// ---- runBackThenForwardTransition ----

describe('runBackThenForwardTransition', () => {
  it('evaluates history.back() then history.forward() in order', async () => {
    const calls: string[] = [];
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation((script: string) => {
        calls.push(script);
        return Promise.resolve({ value: undefined });
      }),
    });
    await runBackThenForwardTransition(scope);
    const backIdx = calls.indexOf('history.back()');
    const fwdIdx = calls.indexOf('history.forward()');
    expect(backIdx).toBeGreaterThanOrEqual(0);
    expect(fwdIdx).toBeGreaterThan(backIdx);
  });
});

// ---- runDeepLinkNoAuth ----

describe('runDeepLinkNoAuth', () => {
  it('navigates to capturedUrl and snapshots', async () => {
    const scope = makeScope();
    await runDeepLinkNoAuth(scope, 'http://localhost/admin/settings');
    expect(scope.navigate).toHaveBeenCalledWith('http://localhost/admin/settings');
    expect(scope.snapshot).toHaveBeenCalled();
  });
});

// ---- runHistoryCorruptTransition ----

describe('runHistoryCorruptTransition', () => {
  it('pushes each state via evaluate and then snapshots', async () => {
    const evaluateCalls: string[] = [];
    const scope = makeScope({
      evaluate: vi.fn().mockImplementation((script: string) => {
        evaluateCalls.push(script);
        return Promise.resolve({ value: undefined });
      }),
    });
    const pushStates = [
      { state: { x: 1 }, url: '/route-a' },
      { state: { x: 2 }, url: '/route-b' },
    ];
    await runHistoryCorruptTransition(scope, pushStates);
    expect(evaluateCalls.some(s => s.includes('/route-a'))).toBe(true);
    expect(evaluateCalls.some(s => s.includes('/route-b'))).toBe(true);
    expect(scope.snapshot).toHaveBeenCalled();
  });

  it('handles empty pushStates without error', async () => {
    const scope = makeScope();
    await expect(runHistoryCorruptTransition(scope, [])).resolves.toBeUndefined();
    expect(scope.snapshot).toHaveBeenCalled();
  });
});
