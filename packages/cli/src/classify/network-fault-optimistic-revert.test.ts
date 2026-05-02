import { describe, it, expect } from 'vitest';
import { detectOptimisticNoRevert } from './network-fault-optimistic-revert.js';
import type { OptimisticSnapshot } from './network-fault-optimistic-revert.js';
import type { PreState, PostState, NetworkFaultSpec } from '../types.js';

function makePreState(): PreState {
  return { url: 'http://localhost:3000/todos', title: 'Todos', consoleErrorCount: 0 };
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

describe('detectOptimisticNoRevert', () => {
  it('returns null when no optimistic snapshot provided', () => {
    const result = detectOptimisticNoRevert(makePreState(), makePostState(), OFFLINE_FAULT, null, 10);
    expect(result).toBeNull();
  });

  it('returns null when optimistic snapshot is empty (no optimistic update)', () => {
    const snapshot: OptimisticSnapshot = { snapshot: '', capturedAtOffsetMs: 200 };
    const result = detectOptimisticNoRevert(makePreState(), makePostState(), OFFLINE_FAULT, snapshot, 10);
    expect(result).toBeNull();
  });

  it('returns null when domErrorTextDetected (app showed error)', () => {
    const snapshot: OptimisticSnapshot = { snapshot: '<div>Todo added!</div>', capturedAtOffsetMs: 200 };
    const result = detectOptimisticNoRevert(
      makePreState(),
      makePostState({ domErrorTextDetected: true }),
      OFFLINE_FAULT, snapshot, 10,
    );
    expect(result).toBeNull();
  });

  it('returns null when URL changed (app navigated on error)', () => {
    const snapshot: OptimisticSnapshot = { snapshot: '<div>Todo added!</div>', capturedAtOffsetMs: 200 };
    const result = detectOptimisticNoRevert(
      makePreState(),
      makePostState({ url: 'http://localhost:3000/error' }),
      OFFLINE_FAULT, snapshot, 10,
    );
    expect(result).toBeNull();
  });

  it('returns null when network error console log present', () => {
    const snapshot: OptimisticSnapshot = { snapshot: '<div>Todo added!</div>', capturedAtOffsetMs: 200 };
    const result = detectOptimisticNoRevert(
      makePreState(),
      makePostState({ consoleErrors: [{ level: 'error', text: 'fetch failed: network error' }] }),
      OFFLINE_FAULT, snapshot, 10,
    );
    expect(result).toBeNull();
  });

  it('fires when optimistic UI was shown and not reverted', () => {
    const snapshot: OptimisticSnapshot = { snapshot: '<div class="todo-item">New todo</div>', capturedAtOffsetMs: 200 };
    const result = detectOptimisticNoRevert(makePreState(), makePostState(), OFFLINE_FAULT, snapshot, 10);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('network_fault_optimistic_no_revert');
    expect(result?.networkFaultContext?.proof).toBe('optimistic_state_persisted');
  });
});
