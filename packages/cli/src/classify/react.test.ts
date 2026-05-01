// Tests for react classifier — T20 hydration_mismatch refinement.

import { describe, it, expect } from 'vitest';
import { classifyReactErrors, isHydrationError, isReactError } from './react.js';
import type { ConsoleError } from '../types.js';

function makeError(text: string, stack?: string): ConsoleError {
  return { level: 'error', text, stack };
}

describe('isHydrationError', () => {
  it('detects "Hydration failed because"', () => {
    expect(isHydrationError('Hydration failed because the initial UI does not match')).toBe(true);
  });
  it('detects "Text content does not match server-rendered HTML"', () => {
    expect(isHydrationError('Text content does not match server-rendered HTML.')).toBe(true);
  });
  it('detects "Did not match. Server: ... Client: ..."', () => {
    expect(isHydrationError('Did not match. Server: "hello" Client: "world"')).toBe(true);
  });
  it('does not match generic react error', () => {
    expect(isHydrationError('Warning: Each child in a list should have a key')).toBe(false);
  });
});

describe('classifyReactErrors', () => {
  it('emits hydration_mismatch for hydration-specific patterns', () => {
    const errors = [makeError('Hydration failed because the initial UI does not match')];
    const detections = classifyReactErrors(errors, '/dashboard');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('hydration_mismatch');
    expect(detections[0].pageRoute).toBe('/dashboard');
  });

  it('emits react_error for non-hydration React warnings', () => {
    const errors = [makeError('Warning: Each child in a list should have a unique "key" prop.')];
    const detections = classifyReactErrors(errors, '/list');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('react_error');
  });

  it('mixes hydration_mismatch and react_error in the same batch', () => {
    const errors = [
      makeError('Hydration failed because the initial UI does not match'),
      makeError('Warning: Invalid hook call.'),
    ];
    const detections = classifyReactErrors(errors, '/page');
    expect(detections).toHaveLength(2);
    expect(detections[0].kind).toBe('hydration_mismatch');
    expect(detections[1].kind).toBe('react_error');
  });

  it('returns console_error for non-React errors (V24 fallthrough)', () => {
    const errors = [makeError('TypeError: Cannot read property of undefined')];
    const detections = classifyReactErrors(errors, '/page');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('console_error');
    expect(detections[0].rootCause).toBe('TypeError: Cannot read property of undefined');
  });

  it('emits console_error with stack trace when provided (V24 fallthrough)', () => {
    const errors = [makeError('Unchecked error', 'at foo.ts:1:1')];
    const detections = classifyReactErrors(errors, '/checkout');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('console_error');
    expect(detections[0].stackTrace).toBe('at foo.ts:1:1');
  });

  it('mixes all three kinds in a single batch (V24 extended)', () => {
    const errors = [
      makeError('Hydration failed because the initial UI does not match'),
      makeError('Warning: Each child in a list should have a unique "key" prop.'),
      makeError('TypeError: Cannot read property of undefined'),
    ];
    const detections = classifyReactErrors(errors, '/page');
    expect(detections).toHaveLength(3);
    expect(detections[0].kind).toBe('hydration_mismatch');
    expect(detections[1].kind).toBe('react_error');
    expect(detections[2].kind).toBe('console_error');
  });
});
