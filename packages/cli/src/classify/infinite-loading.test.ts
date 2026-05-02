import { describe, it, expect } from 'vitest';
import { detectInfiniteLoading } from './infinite-loading.js';
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
    mutationObserverWindowMs: 30000,
    ...overrides,
  };
}

const OFFLINE_FAULT: NetworkFaultSpec = { kind: 'offline' };

describe('detectInfiniteLoading', () => {
  it('returns null when pre-state already had a spinner (EC-7: spinner is permanent design)', () => {
    const result = detectInfiniteLoading(makePreState(), makePostState(), OFFLINE_FAULT, true, true);
    expect(result).toBeNull();
  });

  it('returns null when no spinner present post-action', () => {
    const result = detectInfiniteLoading(makePreState(), makePostState(), OFFLINE_FAULT, false, false);
    expect(result).toBeNull();
  });

  it('returns null when error UI is shown (app handled the fault)', () => {
    const result = detectInfiniteLoading(
      makePreState(),
      makePostState({ domErrorTextDetected: true }),
      OFFLINE_FAULT, false, true,
    );
    expect(result).toBeNull();
  });

  it('returns null when URL changed (app navigated on error)', () => {
    const result = detectInfiniteLoading(
      makePreState(),
      makePostState({ url: 'http://localhost:3000/error' }),
      OFFLINE_FAULT, false, true,
    );
    expect(result).toBeNull();
  });

  it('fires when new spinner appeared and persists after asyncMaxWaitMs', () => {
    const result = detectInfiniteLoading(makePreState(), makePostState(), OFFLINE_FAULT, false, true);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('infinite_loading');
    expect(result?.networkFaultContext?.proof).toBe('spinner_persists');
    expect(result?.networkFaultContext?.faultVariant).toBe('offline');
  });
});
