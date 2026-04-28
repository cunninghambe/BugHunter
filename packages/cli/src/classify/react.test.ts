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

  it('returns empty array for non-React errors', () => {
    const errors = [makeError('TypeError: Cannot read property of undefined')];
    const detections = classifyReactErrors(errors, '/page');
    expect(detections).toHaveLength(0);
  });
});
