import { describe, it, expect } from 'vitest';
import { isReadOnlyTool, isReadOnlyAction, MutatingActionRejectedError } from './read-only.js';
import type { Action, ToolMeta } from '../types.js';

function makeTool(method: string, sideEffectClass: string): Pick<ToolMeta, 'method' | 'sideEffectClass'> {
  return { method, sideEffectClass } as Pick<ToolMeta, 'method' | 'sideEffectClass'>;
}

function makeCatalog(entries: Array<[string, Pick<ToolMeta, 'method' | 'sideEffectClass'>]>): Map<string, Pick<ToolMeta, 'method' | 'sideEffectClass'>> {
  return new Map(entries);
}

describe('isReadOnlyTool', () => {
  it('GET + safe → true', () => {
    expect(isReadOnlyTool(makeTool('GET', 'safe'))).toBe(true);
  });

  it('HEAD + safe → true', () => {
    expect(isReadOnlyTool(makeTool('HEAD', 'safe'))).toBe(true);
  });

  it('OPTIONS + safe → true', () => {
    expect(isReadOnlyTool(makeTool('OPTIONS', 'safe'))).toBe(true);
  });

  it('GET + mutating → false (anti-pattern DELETE via GET)', () => {
    expect(isReadOnlyTool(makeTool('GET', 'mutating'))).toBe(false);
  });

  it('POST + safe → false', () => {
    expect(isReadOnlyTool(makeTool('POST', 'safe'))).toBe(false);
  });

  it('PUT + safe → false', () => {
    expect(isReadOnlyTool(makeTool('PUT', 'safe'))).toBe(false);
  });

  it('PATCH + mutating → false', () => {
    expect(isReadOnlyTool(makeTool('PATCH', 'mutating'))).toBe(false);
  });

  it('DELETE + safe → false', () => {
    expect(isReadOnlyTool(makeTool('DELETE', 'safe'))).toBe(false);
  });
});

describe('isReadOnlyAction', () => {
  const safeGetTool = makeTool('GET', 'safe');
  const postTool = makeTool('POST', 'mutating');
  const catalog = makeCatalog([
    ['tool-get-safe', safeGetTool],
    ['tool-post-mutating', postTool],
  ]);
  const empty = makeCatalog([]);

  it('render kind → always true', () => {
    const action: Action = { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' };
    expect(isReadOnlyAction(action, empty)).toBe(true);
  });

  it('navigate kind → always true', () => {
    const action: Action = { kind: 'navigate', via: 'ui', expectedOutcome: 'unknown', palette: 'happy', selector: '/about' };
    expect(isReadOnlyAction(action, empty)).toBe(true);
  });

  it('click with undefined toolId → false (conservative)', () => {
    const action: Action = { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: '#btn' };
    expect(isReadOnlyAction(action, catalog)).toBe(false);
  });

  it('click with safe GET toolId → true', () => {
    const action: Action = { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: '#btn', toolId: 'tool-get-safe' };
    expect(isReadOnlyAction(action, catalog)).toBe(true);
  });

  it('submit with POST toolId → false', () => {
    const action: Action = { kind: 'submit', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: 'form', toolId: 'tool-post-mutating' };
    expect(isReadOnlyAction(action, catalog)).toBe(false);
  });

  it('api_call with safe GET toolId → true', () => {
    const action: Action = { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'happy', toolId: 'tool-get-safe', input: {} };
    expect(isReadOnlyAction(action, catalog)).toBe(true);
  });

  it('api_call with unknown toolId → false', () => {
    const action: Action = { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'happy', toolId: 'tool-unknown', input: {} };
    expect(isReadOnlyAction(action, catalog)).toBe(false);
  });
});

describe('MutatingActionRejectedError', () => {
  it('extends Error', () => {
    const err = new MutatingActionRejectedError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has code MUTATING_ACTION_REJECTED', () => {
    const err = new MutatingActionRejectedError('test');
    expect(err.code).toBe('MUTATING_ACTION_REJECTED');
  });

  it('preserves message', () => {
    const err = new MutatingActionRejectedError('read-only mode: refusing action');
    expect(err.message).toBe('read-only mode: refusing action');
  });

  it('name is MutatingActionRejectedError', () => {
    const err = new MutatingActionRejectedError('x');
    expect(err.name).toBe('MutatingActionRejectedError');
  });
});
