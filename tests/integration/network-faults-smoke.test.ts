// Integration smoke test: v0.20 network-fault injection detectors.
//
// Tests the three detector functions directly against synthetic pre/post states
// that represent each buggy route in fixtures/network-faults-bad/server.js.
//
// Does NOT require a live browser or camofox-mcp. The full end-to-end smoke
// (camofox network_fault tool + live fixture server) requires:
//   CAMOFOX_NETWORK_FAULT=1 npx vitest run tests/integration/network-faults-smoke
//
// This file covers the detector-logic layer:
//   - network_fault_optimistic_no_revert: proof=optimistic_state_persisted
//   - network_fault_unhandled:            proof=no_error_ui_on_error_fault
//   - infinite_loading:                   proof=spinner_persists
//   - network_fault_unhandled + retryStormDetected=true

import { describe, it, expect } from 'vitest';
import { detectNetworkFaultUnhandled } from '../../packages/cli/src/classify/network-fault-unhandled.js';
import { detectOptimisticNoRevert } from '../../packages/cli/src/classify/network-fault-optimistic-revert.js';
import type { OptimisticSnapshot } from '../../packages/cli/src/classify/network-fault-optimistic-revert.js';
import { detectInfiniteLoading } from '../../packages/cli/src/classify/infinite-loading.js';
import type { PreState, PostState, NetworkFaultSpec } from '../../packages/cli/src/types.js';

const BASE_URL = 'http://127.0.0.1:9995';
const OFFLINE_FAULT: NetworkFaultSpec = { kind: 'offline' };
const RETRY_STORM_THRESHOLD_RPS = 3;
const ASYNC_MAX_WAIT_MS = 5000;

function preState(route: string): PreState {
  return { url: `${BASE_URL}${route}`, title: 'test', consoleErrorCount: 0 };
}

function postState(route: string, overrides?: Partial<PostState>): PostState {
  return {
    url: `${BASE_URL}${route}`,
    title: 'test',
    consoleErrors: [],
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: ASYNC_MAX_WAIT_MS,
    ...overrides,
  };
}

describe('network-faults-smoke: network_fault_optimistic_no_revert', () => {
  it('fires when optimistic UI persists after offline fault on /optimistic', () => {
    const optimisticSnapshot: OptimisticSnapshot = {
      snapshot: '<li class="todo-item">New todo</li>',
      capturedAtOffsetMs: 200,
    };
    const result = detectOptimisticNoRevert(
      preState('/optimistic'),
      postState('/optimistic'),
      OFFLINE_FAULT,
      optimisticSnapshot,
      RETRY_STORM_THRESHOLD_RPS,
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('network_fault_optimistic_no_revert');
    expect(result?.networkFaultContext?.proof).toBe('optimistic_state_persisted');
    expect(result?.networkFaultContext?.faultVariant).toBe('offline');
  });

  it('does not fire when domErrorTextDetected (app showed error UI)', () => {
    const optimisticSnapshot: OptimisticSnapshot = {
      snapshot: '<li class="todo-item">New todo</li>',
      capturedAtOffsetMs: 200,
    };
    const result = detectOptimisticNoRevert(
      preState('/optimistic'),
      postState('/optimistic', { domErrorTextDetected: true }),
      OFFLINE_FAULT,
      optimisticSnapshot,
      RETRY_STORM_THRESHOLD_RPS,
    );
    expect(result).toBeNull();
  });
});

describe('network-faults-smoke: network_fault_unhandled', () => {
  it('fires when no error UI on /unhandled under offline fault', () => {
    const result = detectNetworkFaultUnhandled(
      preState('/unhandled'),
      postState('/unhandled'),
      OFFLINE_FAULT,
      RETRY_STORM_THRESHOLD_RPS,
      ASYNC_MAX_WAIT_MS,
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('network_fault_unhandled');
    expect(result?.networkFaultContext?.proof).toBe('no_error_ui_no_rollback');
    expect(result?.networkFaultContext?.faultVariant).toBe('offline');
    expect(result?.networkFaultContext?.retryStormDetected).toBe(false);
  });

  it('does not fire for non-error-handling fault (slow_3g)', () => {
    const result = detectNetworkFaultUnhandled(
      preState('/unhandled'),
      postState('/unhandled'),
      { kind: 'slow_3g' },
      RETRY_STORM_THRESHOLD_RPS,
      ASYNC_MAX_WAIT_MS,
    );
    expect(result).toBeNull();
  });
});

describe('network-faults-smoke: infinite_loading', () => {
  it('fires when loading spinner persists under offline fault on /loading', () => {
    const result = detectInfiniteLoading(
      preState('/loading'),
      postState('/loading'),
      OFFLINE_FAULT,
      false,
      true, // postHasSpinner — loading indicator still visible
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('infinite_loading');
    expect(result?.networkFaultContext?.proof).toBe('spinner_persists');
    expect(result?.networkFaultContext?.faultVariant).toBe('offline');
  });

  it('does not fire when pre-state already had a spinner (permanent design)', () => {
    const result = detectInfiniteLoading(
      preState('/loading'),
      postState('/loading'),
      OFFLINE_FAULT,
      true,  // preHadSpinner — spinner was there before the action
      true,
    );
    expect(result).toBeNull();
  });
});

describe('network-faults-smoke: retry storm on /retry-storm', () => {
  it('fires network_fault_unhandled with retryStormDetected=true under high RPS', () => {
    // Simulate 20 requests to the same endpoint within the observation window.
    // mutationObserverWindowMs = 5000ms → 20 / 5 = 4 RPS > threshold of 3.
    const networkRequests = Array.from({ length: 20 }, () => ({
      method: 'POST' as const,
      path: '/api/retry',
      status: 0,
      duration: 10,
    }));
    const result = detectNetworkFaultUnhandled(
      preState('/retry-storm'),
      postState('/retry-storm', { networkRequests }),
      OFFLINE_FAULT,
      RETRY_STORM_THRESHOLD_RPS,
      ASYNC_MAX_WAIT_MS,
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('network_fault_unhandled');
    expect(result?.networkFaultContext?.retryStormDetected).toBe(true);
    expect(result?.networkFaultContext?.observedRetryRateRps).toBeGreaterThan(RETRY_STORM_THRESHOLD_RPS);
  });
});
