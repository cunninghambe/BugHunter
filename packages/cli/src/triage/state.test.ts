// AC-10 (partial): triage reducer transitions.
import { describe, it, expect } from 'vitest';
import { triageReducer, makeInitialState } from './state.js';
import type { BugCluster } from '../types.js';

function makeClusters(count: number): BugCluster[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cluster-${i}`,
    kind: 'console_error',
    signatureKey: `sig-${i}`,
    rootCause: `Error ${i}`,
    clusterSize: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
  })) as unknown as BugCluster[];
}

describe('makeInitialState', () => {
  it('initializes with selectedIdx=0 and no modal', () => {
    const clusters = makeClusters(3);
    const state = makeInitialState(clusters);
    expect(state.selectedIdx).toBe(0);
    expect(state.modalKind).toBe('none');
    expect(state.inputField).toBeNull();
    expect(state.patternDraft).toBe('');
    expect(state.reasonDraft).toBe('');
    expect(state.explanationCache.size).toBe(0);
  });
});

describe('triageReducer navigation', () => {
  it('SELECT_NEXT advances selectedIdx', () => {
    const state = makeInitialState(makeClusters(3));
    const next = triageReducer(state, { type: 'SELECT_NEXT' });
    expect(next.selectedIdx).toBe(1);
  });

  it('SELECT_NEXT wraps at end', () => {
    const clusters = makeClusters(3);
    let state = makeInitialState(clusters);
    state = triageReducer(state, { type: 'SELECT_LAST' });
    const wrapped = triageReducer(state, { type: 'SELECT_NEXT' });
    expect(wrapped.selectedIdx).toBe(0);
  });

  it('SELECT_PREV moves selectedIdx back', () => {
    const clusters = makeClusters(3);
    let state = makeInitialState(clusters);
    state = triageReducer(state, { type: 'SELECT_NEXT' });
    const prev = triageReducer(state, { type: 'SELECT_PREV' });
    expect(prev.selectedIdx).toBe(0);
  });

  it('SELECT_PREV wraps at beginning', () => {
    const clusters = makeClusters(3);
    const state = makeInitialState(clusters);
    const wrapped = triageReducer(state, { type: 'SELECT_PREV' });
    expect(wrapped.selectedIdx).toBe(2);
  });

  it('SELECT_FIRST jumps to 0', () => {
    const clusters = makeClusters(3);
    let state = makeInitialState(clusters);
    state = triageReducer(state, { type: 'SELECT_LAST' });
    const first = triageReducer(state, { type: 'SELECT_FIRST' });
    expect(first.selectedIdx).toBe(0);
  });

  it('SELECT_LAST jumps to last', () => {
    const clusters = makeClusters(5);
    const state = makeInitialState(clusters);
    const last = triageReducer(state, { type: 'SELECT_LAST' });
    expect(last.selectedIdx).toBe(4);
  });

  it('handles empty cluster list without error', () => {
    const state = makeInitialState([]);
    const next = triageReducer(state, { type: 'SELECT_NEXT' });
    expect(next.selectedIdx).toBe(0);
    const prev = triageReducer(state, { type: 'SELECT_PREV' });
    expect(prev.selectedIdx).toBe(0);
  });
});

describe('triageReducer modal transitions', () => {
  it('OPEN_VERDICT_MODAL sets modalKind to verdict', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'OPEN_VERDICT_MODAL' });
    expect(result.modalKind).toBe('verdict');
  });

  it('OPEN_SUPPRESS_MODAL sets modalKind, patternDraft, inputField', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, {
      type: 'OPEN_SUPPRESS_MODAL',
      patternDraft: 'bugIdentity:sig-0',
    });
    expect(result.modalKind).toBe('suppress');
    expect(result.patternDraft).toBe('bugIdentity:sig-0');
    expect(result.reasonDraft).toBe('');
    expect(result.inputField).toBe('pattern');
  });

  it('OPEN_HELP sets modalKind to help', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'OPEN_HELP' });
    expect(result.modalKind).toBe('help');
  });

  it('CLOSE_MODAL resets modal state', () => {
    let state = makeInitialState(makeClusters(1));
    state = triageReducer(state, { type: 'OPEN_VERDICT_MODAL' });
    const closed = triageReducer(state, { type: 'CLOSE_MODAL' });
    expect(closed.modalKind).toBe('none');
    expect(closed.inputField).toBeNull();
  });

  it('START_EXPLAIN_LOADING sets modalKind to explain-loading', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'START_EXPLAIN_LOADING' });
    expect(result.modalKind).toBe('explain-loading');
  });

  it('SET_EXPLAIN_RESULT stores in explanationCache', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, {
      type: 'SET_EXPLAIN_RESULT',
      bugIdentity: 'sig-0',
      markdown: '## What is happening\n\nSomething bad.',
    });
    expect(result.explanationCache.get('sig-0')).toBe('## What is happening\n\nSomething bad.');
  });

  it('SHOW_EXPLAIN_DETAIL sets modalKind to explain-detail', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'SHOW_EXPLAIN_DETAIL' });
    expect(result.modalKind).toBe('explain-detail');
  });
});

describe('triageReducer draft fields', () => {
  it('SET_PATTERN_DRAFT updates patternDraft', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'SET_PATTERN_DRAFT', value: 'kind:foo' });
    expect(result.patternDraft).toBe('kind:foo');
  });

  it('SET_REASON_DRAFT updates reasonDraft', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'SET_REASON_DRAFT', value: 'it is noise' });
    expect(result.reasonDraft).toBe('it is noise');
  });

  it('SET_STATUS updates the status field', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'SET_STATUS', message: 'Explaining…' });
    expect(result.status).toBe('Explaining…');
  });

  it('SET_INPUT_FIELD switches active field', () => {
    const state = makeInitialState(makeClusters(1));
    const result = triageReducer(state, { type: 'SET_INPUT_FIELD', field: 'reason' });
    expect(result.inputField).toBe('reason');
  });
});
