// Tests for isMutatorValidationRejection helper — issue #111.

import { describe, it, expect } from 'vitest';
import { isMutatorValidationRejection } from './execute.js';
import type { TestCase } from '../types.js';
import type { SurfaceCallResult } from '../adapters/surface-mcp.js';

function makeAction(palette: TestCase['action']['palette']): TestCase['action'] {
  return { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette };
}

function makeTc(
  palette: TestCase['action']['palette'],
  fuzzMeta?: TestCase['fuzzMeta'],
): TestCase {
  return {
    id: 'tc-1',
    runId: 'run-1',
    role: 'user',
    page: '/test',
    expectedOutcome: 'success',
    palette,
    action: makeAction(palette),
    fuzzMeta,
  };
}

function makeResult(
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): SurfaceCallResult {
  return { ok: status < 400, status, body, headers, durationMs: 5, revisionAtCall: 1 };
}

describe('isMutatorValidationRejection', () => {
  it('mutator (fuzzMeta set) + 400 + ZodError shape body → true (suppress)', () => {
    const tc = makeTc('happy', { strategy: 'unicode', subSeed: 1, drawIndex: 0 });
    const result = makeResult(400, { issues: [{ message: 'Required' }] });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });

  it('mutator (fuzzMeta set) + 422 + {error: "invalid"} → true', () => {
    const tc = makeTc('happy', { strategy: 'boundary', subSeed: 2, drawIndex: 0 });
    const result = makeResult(422, { error: 'invalid input' });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });

  it('mutator + 500 + ZodError → false (5xx is a real bug)', () => {
    const tc = makeTc('fuzz', { strategy: 'shape', subSeed: 3, drawIndex: 0 });
    const result = makeResult(500, { issues: [{ message: 'Required' }] });
    expect(isMutatorValidationRejection(tc, result)).toBe(false);
  });

  it('mutator + 400 + empty body → false (server crash)', () => {
    const tc = makeTc('fuzz', { strategy: 'unicode', subSeed: 4, drawIndex: 0 });
    const result = makeResult(400, '');
    expect(isMutatorValidationRejection(tc, result)).toBe(false);
  });

  it('mutator + 400 + arbitrary HTML 404 page → false', () => {
    const tc = makeTc('null', { strategy: 'unicode', subSeed: 5, drawIndex: 0 });
    const result = makeResult(400, '<html><body>Not Found</body></html>');
    expect(isMutatorValidationRejection(tc, result)).toBe(false);
  });

  it('happy palette + 400 + ZodError → true (probe input was incomplete; not an app bug — Spoonworks calibration FP class May 2026)', () => {
    const tc = makeTc('happy');
    const result = makeResult(400, { issues: [{ message: 'Required' }] });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });

  it('header x-error-type: validation with 400 → true', () => {
    const tc = makeTc('edge', { strategy: 'boundary', subSeed: 6, drawIndex: 0 });
    const result = makeResult(400, { message: 'bad' }, { 'x-error-type': 'validation' });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });

  it('palette out_of_bounds (no fuzzMeta) + 400 + ZodError → true', () => {
    const tc = makeTc('out_of_bounds');
    const result = makeResult(400, { issues: [{ message: 'Value out of range' }] });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });

  it('mutator + 400 + null body → false (empty body = real bug)', () => {
    const tc = makeTc('fuzz', { strategy: 'unicode', subSeed: 7, drawIndex: 0 });
    const result = makeResult(400, null);
    expect(isMutatorValidationRejection(tc, result)).toBe(false);
  });

  it('mutator + 400 + {error: "bad request"} → true', () => {
    const tc = makeTc('null', { strategy: 'shape', subSeed: 8, drawIndex: 0 });
    const result = makeResult(400, { error: 'bad request' });
    expect(isMutatorValidationRejection(tc, result)).toBe(true);
  });
});
