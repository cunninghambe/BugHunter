import { describe, it, expect } from 'vitest';
import { detectNetworkFaultUnhandled } from './network-fault-unhandled.js';
import type { PreState, PostState, NetworkFaultSpec } from '../types.js';

function makePreState(overrides?: Partial<PreState>): PreState {
  return {
    url: 'http://localhost:3000/todos',
    title: 'Todos',
    consoleErrorCount: 0,
    ...overrides,
  };
}

function makePostState(overrides?: Partial<PostState>): PostState {
  return {
    url: 'http://localhost:3000/todos',
    title: 'Todos',
    consoleErrors: [],
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: 5000,
    ...overrides,
  };
}

const OFFLINE_FAULT: NetworkFaultSpec = { kind: 'offline' };
const SERVER_5XX_FAULT: NetworkFaultSpec = { kind: 'server_5xx', status: 500 };
const HIGH_LATENCY_FAULT: NetworkFaultSpec = { kind: 'high_latency', latencyMs: 5000 };

describe('detectNetworkFaultUnhandled', () => {
  it('returns null when fault is high_latency (not an error-handling fault)', () => {
    const result = detectNetworkFaultUnhandled(makePreState(), makePostState(), HIGH_LATENCY_FAULT, 10, 30000);
    expect(result).toBeNull();
  });

  it('returns null when domErrorTextDetected is true (app handled error)', () => {
    const result = detectNetworkFaultUnhandled(
      makePreState(),
      makePostState({ domErrorTextDetected: true }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result).toBeNull();
  });

  it('returns null when URL changed (app navigated to error route)', () => {
    const result = detectNetworkFaultUnhandled(
      makePreState({ url: 'http://localhost:3000/todos' }),
      makePostState({ url: 'http://localhost:3000/error' }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result).toBeNull();
  });

  it('returns null when network console error is present', () => {
    const result = detectNetworkFaultUnhandled(
      makePreState({ consoleErrorCount: 0 }),
      makePostState({
        consoleErrors: [{ level: 'error', text: 'fetch failed: network error' }],
      }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result).toBeNull();
  });

  it('fires when no error UI, no URL change, no network console errors under offline', () => {
    const result = detectNetworkFaultUnhandled(makePreState(), makePostState(), OFFLINE_FAULT, 10, 30000);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('network_fault_unhandled');
    expect(result?.networkFaultContext?.proof).toBe('no_error_ui_no_rollback');
    expect(result?.networkFaultContext?.faultVariant).toBe('offline');
  });

  it('fires under server_5xx fault with no error UI', () => {
    const result = detectNetworkFaultUnhandled(makePreState(), makePostState(), SERVER_5XX_FAULT, 10, 30000);
    expect(result).not.toBeNull();
    expect(result?.networkFaultContext?.faultVariant).toBe('server_5xx');
  });

  it('detects retry storm when same-endpoint request rate exceeds threshold', () => {
    const requests = Array.from({ length: 100 }, () => ({
      method: 'POST',
      path: '/api/todos',
      status: 500,
      duration: 10,
    }));
    const result = detectNetworkFaultUnhandled(
      makePreState(),
      makePostState({ networkRequests: requests, mutationObserverWindowMs: 5000 }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result?.networkFaultContext?.retryStormDetected).toBe(true);
    expect(result?.networkFaultContext?.observedRetryRateRps).toBeGreaterThan(10);
  });

  it('does not detect retry storm when rate is below threshold', () => {
    const requests = [
      { method: 'POST', path: '/api/todos', status: 500, duration: 10 },
      { method: 'POST', path: '/api/todos', status: 500, duration: 10 },
    ];
    const result = detectNetworkFaultUnhandled(
      makePreState(),
      makePostState({ networkRequests: requests, mutationObserverWindowMs: 5000 }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result?.networkFaultContext?.retryStormDetected).toBe(false);
  });

  it('excludes dev-server paths from affectedEndpoints (#149 follow-up)', () => {
    const requests = [
      { method: 'GET', path: '/@vite/client', status: 200, duration: 5 },
      { method: 'GET', path: '/__vite_ping', status: 200, duration: 5 },
      { method: 'POST', path: '/api/todos', status: 500, duration: 10 },
    ];
    const result = detectNetworkFaultUnhandled(
      makePreState(),
      makePostState({ networkRequests: requests }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result?.networkFaultContext?.affectedEndpoints).toEqual(['/api/todos']);
  });

  it('does not false-positive retry storm from high-frequency HMR pings (#149 follow-up)', () => {
    const hmrPings = Array.from({ length: 100 }, () => ({
      method: 'GET',
      path: '/@vite/client',
      status: 200,
      duration: 5,
    }));
    const result = detectNetworkFaultUnhandled(
      makePreState(),
      makePostState({ networkRequests: hmrPings, mutationObserverWindowMs: 5000 }),
      OFFLINE_FAULT, 10, 30000,
    );
    expect(result?.networkFaultContext?.retryStormDetected).toBe(false);
  });
});
