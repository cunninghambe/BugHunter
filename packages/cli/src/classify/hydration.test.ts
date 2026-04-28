// Tests for hydration_mismatch CDP path (§4.11 / T17).
// The camofox path is already covered by react.test.ts (classifyReactErrors).
// These tests cover:
//   1. React 16 pattern detection added in T17.
//   2. CDP console error → hydration_mismatch classification.
//   3. Non-hydration CDP console errors do not emit hydration_mismatch.

import { describe, it, expect } from 'vitest';
import { isHydrationError, classifyReactErrors } from './react.js';
import type { ConsoleError } from '../types.js';

function makeError(text: string): ConsoleError {
  return { level: 'error', text };
}

describe('isHydrationError — React 16 pattern (T17 addition)', () => {
  it('detects "Did not expect server HTML to contain" (React 16)', () => {
    expect(isHydrationError('Warning: Did not expect server HTML to contain a <div> in <div>.')).toBe(true);
  });

  it('is case-insensitive for "Did not expect server HTML to contain"', () => {
    expect(isHydrationError('did not expect server html to contain a text node')).toBe(true);
  });
});

describe('CDP console error → hydration_mismatch classification', () => {
  it('React 18 message emits hydration_mismatch', () => {
    const errors = [makeError('Hydration failed because the initial UI does not match what was rendered on the server.')];
    const detections = classifyReactErrors(errors, '/');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('hydration_mismatch');
  });

  it('React 17 message emits hydration_mismatch', () => {
    const errors = [makeError('Text content does not match server-rendered HTML.')];
    const detections = classifyReactErrors(errors, '/');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('hydration_mismatch');
  });

  it('React 16 message emits hydration_mismatch', () => {
    const errors = [makeError('Warning: Did not expect server HTML to contain a <div> in <div>.')];
    const detections = classifyReactErrors(errors, '/home');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('hydration_mismatch');
    expect(detections[0].pageRoute).toBe('/home');
  });

  it('non-hydration console error does not emit hydration_mismatch', () => {
    const errors = [makeError('TypeError: Cannot read properties of null')];
    const detections = classifyReactErrors(errors, '/');
    // classifyReactErrors filters non-React errors; this should be empty
    expect(detections.filter(d => d.kind === 'hydration_mismatch')).toHaveLength(0);
  });

  it('mixed CDP errors: only hydration patterns become hydration_mismatch', () => {
    const errors = [
      makeError('Hydration failed because the initial UI does not match what was rendered on the server.'),
      makeError('Warning: Each child in a list should have a unique "key" prop.'),
    ];
    const detections = classifyReactErrors(errors, '/list');
    expect(detections).toHaveLength(2);
    expect(detections[0].kind).toBe('hydration_mismatch');
    expect(detections[1].kind).toBe('react_error');
  });

  it('empty CDP console errors produces no detections', () => {
    expect(classifyReactErrors([], '/page')).toHaveLength(0);
  });
});
